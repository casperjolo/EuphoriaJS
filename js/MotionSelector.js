import { clamp01 } from './AnimationSmoothing.js';

/**
 * Feature-space candidate selection with hysteresis, dwell time and boredom.
 *
 * Shared by the locomotion matcher and the upper-body layer, because both have
 * the same failure mode without it: a query evaluated every frame at a feature
 * boundary flips between two clips on consecutive frames, and the crossfade
 * never finishes — the character vibrates between two poses.
 *
 * Three guards, all cheap:
 *  - hysteresis: the incumbent only loses if the challenger is better by a
 *    margin, so a feature sitting exactly on a boundary cannot oscillate;
 *  - dwell: a minimum time between switches, so a blend always completes;
 *  - boredom: a candidate accumulates cost while it is active and sheds it
 *    while it is not, which is what makes a long idle cycle through several
 *    behaviours instead of locking onto one.
 */
export class Selector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.hysteresis=0.82] incumbent must beat challenger by this factor
   * @param {number} [opts.minDwell=0.3]    seconds between switches
   * @param {number} [opts.boredomRate=0]   cost/second accrued while active
   * @param {number} [opts.boredomMax=0]    ceiling on accrued boredom
   * @param {number} [opts.recoveryRate=0]  cost/second shed while inactive
   */
  constructor(opts = {}) {
    this.hysteresis   = opts.hysteresis   ?? 0.82;
    this.minDwell     = opts.minDwell     ?? 0.3;
    this.boredomRate  = opts.boredomRate  ?? 0;
    this.boredomMax   = opts.boredomMax   ?? 0;
    this.recoveryRate = opts.recoveryRate ?? 0;

    this.current = null;
    this.sinceSwitch = Infinity;
    /** @type {Map<string, number>} */
    this.boredom = new Map();
  }

  /**
   * @param {Array<{key:string, feats:Object<string,number>, bias?:number}>} candidates
   * @param {Object<string, number>} query      query features
   * @param {Object<string, number>} weights    per-feature weights (default 1)
   * @returns {{key:string, cost:number, changed:boolean, incumbentCost:number}}
   */
  select(candidates, query, weights = {}, dt = 0) {
    this.sinceSwitch += dt;

    // Boredom bookkeeping runs whether or not a switch happens.
    for (const c of candidates) {
      const b = this.boredom.get(c.key) ?? 0;
      const next = c.key === this.current
        ? Math.min(this.boredomMax, b + this.boredomRate * dt)
        : Math.max(0, b - this.recoveryRate * dt);
      this.boredom.set(c.key, next);
    }

    let best = null, bestCost = Infinity;
    let incumbentCost = Infinity;

    for (const c of candidates) {
      const cost = candidateCost(c, query, weights) + (this.boredom.get(c.key) ?? 0);
      if (c.key === this.current) incumbentCost = cost;
      if (cost < bestCost) { bestCost = cost; best = c.key; }
    }

    if (!best) return { key: this.current, cost: incumbentCost, changed: false, incumbentCost };

    // Hysteresis: keep the incumbent unless the challenger is clearly better.
    const threshold = this.current === best
      ? Infinity
      : (Number.isFinite(incumbentCost) ? incumbentCost * this.hysteresis : Infinity);

    const blockedByCost   = bestCost >= threshold;
    const blockedByDwell  = this.sinceSwitch < this.minDwell;

    if (this.current !== null && (blockedByCost || blockedByDwell)) {
      return { key: this.current, cost: incumbentCost, changed: false, incumbentCost };
    }

    const changed = this.current !== best;
    this.current = best;
    if (changed) this.sinceSwitch = 0;
    return { key: best, cost: bestCost, changed, incumbentCost };
  }

  force(key) {
    this.current = key;
    this.sinceSwitch = 0;
  }

  reset() {
    this.current = null;
    this.sinceSwitch = Infinity;
    this.boredom.clear();
  }
}

/**
 * Weighted squared distance between a candidate's features and the query,
 * plus any fixed bias. Squared distance keeps the metric smooth near zero
 * (unlike a plain sum of absolute errors, whose gradient is discontinuous at
 * the candidate, which is exactly where the query spends most of its time).
 */
export function candidateCost(candidate, query, weights = {}) {
  let cost = candidate.bias ?? 0;
  for (const k of Object.keys(candidate.feats)) {
    const w = weights[k] ?? 1;
    const d = candidate.feats[k] - (query[k] ?? 0);
    cost += w * d * d;
  }
  return cost;
}

/** Normalise a raw value into 0..1 across a range — feature preprocessing. */
export function feature01(value, lo, hi) {
  return clamp01((value - lo) / (hi - lo));
}
