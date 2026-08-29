import * as THREE from 'three';
import { describe, assert, assertClose, assertLt, assertGt } from './harness.mjs';
import {
  damp, smoothstep, smootherstep, softClamp, wrapAngle, lerpAngle,
  SmoothedValue, SeededRandom,
} from '../js/AnimationSmoothing.js';
import { Selector, candidateCost } from '../js/MotionSelector.js';
import { TransitionBlender } from '../js/TransitionBlender.js';
import { Environment, BoxCollider } from '../js/Environment.js';
import { distributeLook, LOOK_LIMITS } from '../js/LookAtSystem.js';

// ── Smoothing ─────────────────────────────────────────────────────────────────
describe('AnimationSmoothing', it => {
  it('easing curves start and end at 0 and 1', () => {
    for (const f of [smoothstep, smootherstep]) {
      assertClose(f(0), 0, 1e-12);
      assertClose(f(1), 1, 1e-12);
      assertClose(f(0.5), 0.5, 1e-12, 'midpoint');
    }
  });

  it('softClamp saturates at the limit without ever exceeding it', () => {
    for (const x of [0, 0.1, 0.5, 1, 2, 10, 100]) {
      assertLt(softClamp(x, 0.8), 0.8 + 1e-9, 'below limit');
    }
    // Near-linear for small inputs, which is what keeps a small look natural.
    assertClose(softClamp(0.05, 0.8), 0.05, 0.001, 'small angle passthrough');
    // Monotonic.
    let prev = -Infinity;
    for (let x = -3; x <= 3; x += 0.25) {
      const v = softClamp(x, 0.8);
      assertGt(v, prev - 1e-12, 'monotonic');
      prev = v;
    }
  });

  it('damp is frame-rate independent', () => {
    const oneStep = damp(0, 1, 6, 1 / 30);
    let twoSteps = 0;
    twoSteps = damp(twoSteps, 1, 6, 1 / 60);
    twoSteps = damp(twoSteps, 1, 6, 1 / 60);
    assertClose(twoSteps, oneStep, 1e-12, 'two half-steps equal one full step');
  });

  it('wrapAngle keeps the result in (-PI, PI]', () => {
    for (const a of [-20, -7, -3.2, 0, 3.2, 7, 20, 1000]) {
      const w = wrapAngle(a);
      assert(w > -Math.PI - 1e-9 && w <= Math.PI + 1e-9, `wrap(${a}) = ${w}`);
    }
    // 3*PI wraps to the seam itself; either sign is the same angle.
    assertClose(Math.abs(wrapAngle(Math.PI * 3)), Math.PI, 1e-9);
  });

  it('lerpAngle takes the short way round', () => {
    // From 170° to -170° is 20° across the seam, not 340° the long way.
    const r = lerpAngle(THREE.MathUtils.degToRad(170), THREE.MathUtils.degToRad(-170), 0.5);
    assertClose(Math.abs(r), Math.PI, 1e-6, 'halfway across the seam');
  });

  it('SmoothedValue arrives and snaps its tail', () => {
    const v = new SmoothedValue(0, 8);
    v.set(1, 8);
    for (let i = 0; i < 240; i++) v.update(1 / 60);
    assertClose(v.value, 1, 1e-4, 'reached target');
    assert(v.settled(1e-3), 'settled');
  });

  it('SeededRandom is deterministic and in range', () => {
    const a = new SeededRandom(123), b = new SeededRandom(123);
    for (let i = 0; i < 50; i++) {
      const x = a.next(), y = b.next();
      assertClose(x, y, 0, 'same seed, same stream');
      assert(x >= 0 && x < 1, `in [0,1): ${x}`);
    }
    const c = new SeededRandom(456);
    let differs = false;
    const a2 = new SeededRandom(123);
    for (let i = 0; i < 20; i++) if (c.next() !== a2.next()) differs = true;
    assert(differs, 'different seeds diverge');
  });
});

// ── Feature selection ─────────────────────────────────────────────────────────
describe('MotionSelector', it => {
  const candidates = [
    { key: 'a', feats: { x: 0 } },
    { key: 'b', feats: { x: 1 } },
  ];

  it('picks the nearest candidate', () => {
    const s = new Selector({ hysteresis: 1, minDwell: 0 });
    assert(s.select(candidates, { x: 0.1 }, {}, 1).key === 'a', 'near a');
    const s2 = new Selector({ hysteresis: 1, minDwell: 0 });
    assert(s2.select(candidates, { x: 0.9 }, {}, 1).key === 'b', 'near b');
  });

  it('hysteresis keeps the incumbent against a marginally better challenger', () => {
    const s = new Selector({ hysteresis: 0.8, minDwell: 0 });
    s.select(candidates, { x: 0.0 }, {}, 1);           // a, cost 0
    // x=0.52: incumbent a costs 0.2704, challenger b costs 0.2304. Better, but
    // not inside the 20% margin (0.2163), so the incumbent holds.
    const r = s.select(candidates, { x: 0.52 }, {}, 1);
    assert(r.key === 'a' && r.changed === false, `held, got ${r.key}`);
    // x=0.6: b costs 0.16 against a margin of 0.252 — now it takes over.
    const r2 = s.select(candidates, { x: 0.6 }, {}, 1);
    assert(r2.key === 'b', 'switched when clearly better');
  });

  it('dwell blocks a switch that arrives too soon', () => {
    const s = new Selector({ hysteresis: 1, minDwell: 0.5 });
    s.select(candidates, { x: 0 }, {}, 0.1);          // a
    const r = s.select(candidates, { x: 1 }, {}, 0.1); // only 0.1 s later
    assert(r.key === 'a', 'blocked by dwell');
    const r2 = s.select(candidates, { x: 1 }, {}, 1.0);
    assert(r2.key === 'b', 'allowed after the dwell elapsed');
  });

  it('boredom eventually rotates the winner', () => {
    const s = new Selector({
      hysteresis: 1, minDwell: 0,
      boredomRate: 0.5, boredomMax: 5, recoveryRate: 0.5,
    });
    const three = [
      { key: 'a', feats: { x: 0 } },
      { key: 'b', feats: { x: 0.01 } },
      { key: 'c', feats: { x: 0.02 } },
    ];
    const seen = new Set();
    for (let i = 0; i < 60; i++) seen.add(s.select(three, { x: 0 }, {}, 1).key);
    assertGt(seen.size, 1, `cycled through ${[...seen].join(',')}`);
  });

  it('cost is squared distance plus bias', () => {
    assertClose(candidateCost({ feats: { a: 1 }, bias: 2 }, { a: 3 }, { a: 2 }), 2 + 2 * 4, 1e-12);
  });
});

// ── Eased blending ────────────────────────────────────────────────────────────
function dummyClip(name, duration = 1) {
  const obj = new THREE.Object3D();
  const track = new THREE.QuaternionKeyframeTrack(
    '.quaternion',
    [0, duration],
    [0, 0, 0, 1, 0.7071, 0, 0, 0.7071]
  );
  const clip = new THREE.AnimationClip(name, duration, [track]);
  return { obj, clip };
}

describe('TransitionBlender', it => {
  it('eases weight from 0 to 1 and settles', () => {
    const { obj, clip } = dummyClip('a', 1);
    const mixer = new THREE.AnimationMixer(obj);
    const b = new TransitionBlender(mixer, { defaultBlend: 0.3 });
    b.play(clip, { key: 'a' });

    let prev = -1;
    for (let i = 0; i < 30; i++) {
      b.update(1 / 60);
      const w = b.entries[0].weight;
      assertGt(w, prev - 1e-12, 'monotonic');
      prev = w;
    }
    assertClose(b.entries[0].weight, 1, 1e-9, 'fully faded in');
    assertClose(b.entries[0].action.getEffectiveWeight(), 1, 1e-9, 'applied to the action');
  });

  it('crossfades: both actions hold ~0.5 halfway through', () => {
    const a = dummyClip('a', 1), c = dummyClip('c', 1);
    const mixer = new THREE.AnimationMixer(a.obj);
    const b = new TransitionBlender(mixer, { defaultBlend: 0.4 });
    b.play(a.clip, { key: 'a' });
    for (let i = 0; i < 60; i++) b.update(1 / 60);

    b.play(c.clip, { key: 'c' });
    for (let i = 0; i < 12; i++) b.update(1 / 60);   // 0.2 s of a 0.4 s fade

    const wa = b.entries.find(e => e.key === 'a').weight;
    const wc = b.entries.find(e => e.key === 'c').weight;
    assertClose(wa, 0.5, 0.01, 'outgoing at half');
    assertClose(wc, 0.5, 0.01, 'incoming at half');

    for (let i = 0; i < 60; i++) b.update(1 / 60);
    assertClose(b.entries.length, 1, 0, 'fade-out retired');
    assert(b.entries[0].key === 'c', 'incoming survived');
  });

  it('matches gait phase when asked', () => {
    const a = dummyClip('a', 1), c = dummyClip('c', 2);
    const mixer = new THREE.AnimationMixer(a.obj);
    const b = new TransitionBlender(mixer, { defaultBlend: 0.3 });
    const ea = b.play(a.clip, { key: 'a' });
    ea.action.time = 0.25;                            // a quarter through
    b.play(c.clip, { key: 'c', matchPhase: true });
    const ec = b.entries.find(e => e.key === 'c');
    assertClose(ec.action.time, 0.5, 1e-6, 'a quarter of the new clip too');
  });

  it('master weight scales every action', () => {
    const { obj, clip } = dummyClip('a', 1);
    const mixer = new THREE.AnimationMixer(obj);
    const b = new TransitionBlender(mixer, { defaultBlend: 0.2 });
    b.play(clip, { key: 'a' });
    b.masterWeight = 0.4;
    for (let i = 0; i < 30; i++) b.update(1 / 60);
    assertClose(b.entries[0].action.getEffectiveWeight(), 0.4, 1e-9);
  });
});

// ── Environment ───────────────────────────────────────────────────────────────
describe('Environment', it => {
  const scene = new THREE.Scene();
  const env = new Environment(scene);
  const wall = env.colliders.find(c => c.name === 'wall');

  it('builds the stage set with colliders and meshes', () => {
    assertGt(env.colliders.length, 3, 'several obstacles');
    assert(env.meshes.length === env.colliders.length, 'mesh per collider');
    assert(!!wall, 'the wall exists');
  });

  it('raycast finds the wall ahead with the right normal', () => {
    const hit = env.raycast(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 0, -1), 10);
    assert(!!hit, 'hit something');
    assert(hit.box.name === 'wall', `hit the wall, got ${hit.box.name}`);
    // The wall is centred on z=-6 and 0.4 deep, so the face turned toward the
    // spawn is at -5.8.
    assertClose(hit.distance, 5.8, 1e-6, 'distance to the near face');
    assertClose(hit.normal.z, 1, 1e-9, 'normal faces back at us');
  });

  it('raycast misses when pointed away or short', () => {
    assert(env.raycast(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 0, 1), 4) === null, 'away');
    assert(env.raycast(new THREE.Vector3(0, 1.4, 0), new THREE.Vector3(0, 0, -1), 3) === null, 'too short');
  });

  it('raycast finds a pillar off to the side on a diagonal', () => {
    const dir = new THREE.Vector3(-0.3, 0, -1).normalize();
    const hit = env.raycast(new THREE.Vector3(-2.2, 1.4, 0.6), dir, 4);
    assert(!!hit, 'found the pillar');
    assert(hit.box.name === 'pillarA', `hit pillarA, got ${hit.box.name}`);
    assertLt(hit.distance, 3, 'within range');
  });

  it('resolveCircle pushes the character clear of the wall', () => {
    const pos = new THREE.Vector3(0, 0.95, -5.9);      // overlapping the wall face
    const normal = env.resolveCharacter(pos, 0.34);
    assert(!!normal, 'reported a contact');
    assertClose(normal.z, 1, 1e-9, 'pushed back along +Z');
    assertClose(pos.z, -5.8 + 0.34, 1e-6, 'resting exactly one radius out');
    assertGt(pos.z, -5.8, 'no longer inside');
  });

  it('resolveCircle leaves clear space alone', () => {
    const pos = new THREE.Vector3(0, 0.95, -4.0);
    const before = pos.clone();
    assert(env.resolveCharacter(pos, 0.34) === null, 'no contact');
    assertClose(pos.z, before.z, 1e-12, 'unmoved');
  });

  it('resolveCircle escapes from inside via the shallowest face', () => {
    const box = new BoxCollider(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1), 'test');
    const pos = new THREE.Vector3(0.9, 1, 0);          // 0.1 from the +X face
    const hit = box.resolveCircle(pos, 0.3);
    assert(!!hit, 'contact');
    assertClose(hit.normal.x, 1, 1e-9, 'out through +X');
    assertGt(pos.x, 1.0, 'pushed outside');
  });
});

// ── Look distribution ─────────────────────────────────────────────────────────
describe('distributeLook', it => {
  it('is zero for a target straight ahead', () => {
    const d = distributeLook(0, 0);
    for (const k of ['headYaw', 'neckYaw', 'spineYaw', 'headPitch', 'neckPitch', 'spinePitch']) {
      assertClose(d[k], 0, 1e-12, k);
    }
  });

  it('never exceeds a joint limit', () => {
    for (const yaw of [-3, -1, -0.3, 0.3, 1, 3]) {
      const d = distributeLook(yaw, yaw * 0.4);
      assertLt(Math.abs(d.headYaw), LOOK_LIMITS.headYaw + 1e-9, 'head yaw');
      assertLt(Math.abs(d.neckYaw), LOOK_LIMITS.neckYaw + 1e-9, 'neck yaw');
      assertLt(Math.abs(d.spineYaw), LOOK_LIMITS.spineYaw + 1e-9, 'spine yaw');
    }
  });

  it('shares the angle: the head leads, the rest follows', () => {
    const d = distributeLook(1.6, 0);
    assertGt(d.headYaw, 0.7, 'head takes the bulk');
    assertGt(d.neckYaw, 0.2, 'neck joins in');
    assertGt(d.spineYaw, 0.1, 'chest turns for a big look');
    assertLt(d.headYaw + d.neckYaw + d.spineYaw, 1.6 + 1e-9, 'total does not overshoot');
  });

  it('is monotonic and antisymmetric', () => {
    let prev = -Infinity;
    for (let y = -2; y <= 2; y += 0.1) {
      const v = distributeLook(y, 0).headYaw;
      assertGt(v, prev - 1e-12, 'monotonic in yaw');
      prev = v;
    }
    const a = distributeLook(0.9, 0.3), b = distributeLook(-0.9, -0.3);
    assertClose(a.headYaw, -b.headYaw, 1e-12, 'mirrored');
  });

  it('a small look stays almost entirely in the head', () => {
    const d = distributeLook(0.12, 0);
    assertGt(d.headYaw, 0.11, 'head takes it');
    // Sharing is progressive rather than thresholded, so the neck takes a
    // sliver of the remainder — three orders of magnitude below the head.
    assertLt(Math.abs(d.neckYaw), 0.002, 'neck barely moves');
    assertLt(Math.abs(d.spineYaw), 1e-5, 'chest stays put');
    assertLt(Math.abs(d.neckYaw / d.headYaw), 0.02, 'and is negligible beside it');
  });
});
