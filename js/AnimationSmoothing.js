import * as THREE from 'three';

/**
 * Shared smoothing maths.
 *
 * Everything procedural in this project is a weight that fades in and out, so
 * the easing and damping live here rather than being reinvented per system.
 * All of the time-based helpers are frame-rate independent: they use
 * `1 - exp(-rate * dt)`, which converges to the same place whether the frame
 * took 8 ms or 40 ms. A plain `v += (target - v) * rate * dt` does not — at low
 * frame rates it overshoots and oscillates.
 */

export const clamp = THREE.MathUtils.clamp;

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Hermite ease: zero slope at both ends, so a blend starts and stops softly. */
export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

/** Ken Perlin's smootherstep: zero first *and* second derivative at the ends. */
export function smootherstep(t) {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Exponential approach — the workhorse for procedural weights.
 * `rate` is roughly "how many e-folds per second": 6 settles in about half a
 * second, 15 snaps in about a fifth.
 */
export function damp(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Quaternion form of `damp`. Mutates and returns `q`. */
export function dampQuat(q, target, rate, dt) {
  return q.slerp(target, 1 - Math.exp(-rate * dt));
}

export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Shortest-path angle lerp, result wrapped to (-PI, PI]. */
export function lerpAngle(a, b, t) {
  return wrapAngle(a + wrapAngle(b - a) * clamp01(t));
}

/**
 * Progressive saturation: behaves like `x` for small inputs and asymptotes to
 * ±limit instead of cutting off. Used to share a look angle across spine, neck
 * and head — a hard clamp would hand the whole remainder to the next joint the
 * instant the previous one maxes out, which reads as a kink in the spine.
 *
 * `softClamp(x, l) / l = tanh(x / l)`, so the joint takes 76% of its range at
 * one limit's worth of input and only creeps the rest of the way.
 */
export function softClamp(x, limit) {
  if (limit <= 0) return 0;
  return limit * Math.tanh(x / limit);
}

/**
 * A scalar that chases a target with an exponential rate. Keeps the
 * "weight" state of every procedural system out of the systems themselves.
 */
export class SmoothedValue {
  constructor(value = 0, rate = 6) {
    this.value = value;
    this.target = value;
    this.rate = rate;
  }

  set(target, rate = this.rate) {
    this.target = target;
    this.rate = rate;
    return this;
  }

  snap(value) {
    this.value = this.target = value;
    return this;
  }

  update(dt) {
    this.value = damp(this.value, this.target, this.rate, dt);
    // Snap the tail: an exponential never quite arrives, and a weight of 0.004
    // is enough to keep an expensive IK pass alive for no visible reason.
    if (Math.abs(this.target - this.value) < 1e-4) this.value = this.target;
    return this.value;
  }

  /** True once settled within `eps` of the target. */
  settled(eps = 1e-3) {
    return Math.abs(this.target - this.value) <= eps;
  }
}

/**
 * Deterministic PRNG (mulberry32). Idle behaviour is deliberately randomised —
 * a fixed cycle looks like an animation, a random one looks like a person — but
 * the tests need it to repeat, so the seed is injectable.
 */
export class SeededRandom {
  constructor(seed = 0x2f6e2b1) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + (max - min) * this.next();
  }

  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  pick(arr) {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** True with probability `p`. */
  chance(p) {
    return this.next() < p;
  }
}
