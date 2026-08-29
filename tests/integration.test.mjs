import * as THREE from 'three';
import {
  describe, assert, assertClose, assertLt, assertGt, assertRigFinite, makeRig,
} from './harness.mjs';
import { resolveBones, RIG_PATTERNS } from '../js/RigBones.js';
import { ProceduralPose } from '../js/ProceduralPose.js';
import { LookAtSystem } from '../js/LookAtSystem.js';
import { BodyLean } from '../js/BodyLean.js';
import { ArmPoses } from '../js/ArmPoses.js';
import { WallHands } from '../js/WallHands.js';
import { Environment } from '../js/Environment.js';
import { AnimationLayer, upperBodyMask, maskedClip, UPPER_BODY_KEYS } from '../js/AnimationLayers.js';
import { FootPlanting } from '../js/FootPlanting.js';

const DT = 1 / 60;

/** Rig + every system that writes to it, wired the way main.js wires them. */
function buildStack() {
  const { root, bones } = makeRig();
  const { bones: rig, missing } = resolveBones(bones, RIG_PATTERNS);
  assert(missing.length === 0, `unresolved rig keys: ${missing.join(', ')}`);

  const scene = new THREE.Scene();
  scene.add(root);
  const environment = new Environment(scene);

  const pose = new ProceduralPose(rig);
  const look = new LookAtSystem(rig, { seed: 7 });
  look.attachPose(pose);
  const bodyLean = new BodyLean(rig, pose);
  const armPoses = new ArmPoses({ bones: rig, scene: root });
  const wallHands = new WallHands({ environment, bones: rig, scene: root });

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const headPos = new THREE.Vector3();

  /** One frame of the procedural half of the loop. */
  const step = (ctx = {}) => {
    root.updateMatrixWorld(true);
    forward.set(0, 0, 1).applyQuaternion(root.quaternion);
    right.set(1, 0, 0).applyQuaternion(root.quaternion);
    headPos.setFromMatrixPosition(rig.head.matrixWorld);

    pose.begin();
    look.update(DT, {
      root,
      headPos,
      cameraForward: ctx.cameraForward ?? forward.clone().negate(),
      cameraPos: ctx.cameraPos ?? new THREE.Vector3(0, 1.6, 3),
      speed: ctx.speed ?? 0,
      bodyYaw: ctx.bodyYaw ?? root.rotation.y,
    });
    bodyLean.update(DT, {
      root, forward, right,
      accelForward: ctx.accelForward ?? 0,
      accelLateral: ctx.accelLateral ?? 0,
      speed: ctx.speed ?? 0,
      jumpPhase: ctx.jumpPhase ?? 'none',
      idleWeight: ctx.idleWeight ?? 0,
    });
    pose.apply();

    wallHands.update(DT, {
      root, forward, right,
      speed: ctx.speed ?? 0,
      onGround: ctx.onGround ?? true,
      groundY: 0,
    });
    if (ctx.crossed) armPoses.updateCrossed(ctx.crossed, { forward, right });

    root.updateMatrixWorld(true);
  };

  return { root, bones, rig, pose, look, bodyLean, armPoses, wallHands, environment, step, forward, right, headPos };
}

const worldPos = bone => new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);

// ── Rig resolution ────────────────────────────────────────────────────────────
describe('RigBones', it => {
  it('resolves every rig key on Fred-like names', () => {
    const { bones } = makeRig();
    const { bones: rig, missing } = resolveBones(bones, RIG_PATTERNS);
    assert(missing.length === 0, `missing: ${missing.join(', ')}`);
    for (const key of ['hips', 'spine3', 'neck', 'head', 'lHand', 'rHand', 'lThigh', 'rFoot']) {
      assert(!!rig[key], `${key} resolved`);
    }
  });

  it('falls back to Mixamo names', () => {
    const fake = ['Hips', 'mixamorig:LeftArm', 'LeftHand'].map(n => {
      const b = new THREE.Bone(); b.name = n; return b;
    });
    const { bones: rig } = resolveBones(fake, RIG_PATTERNS);
    assert(rig.hips?.name === 'Hips', 'hips');
    assert(rig.lUpperArm?.name === 'mixamorig:LeftArm', 'left arm');
  });
});

// ── Procedural pose pass ──────────────────────────────────────────────────────
describe('ProceduralPose', it => {
  it('a world-space yaw delta rotates the bone about the world up axis', () => {
    const { rig, pose, root } = buildStack();
    const before = rig.head.quaternion.clone();
    pose.begin();
    pose.addWorldDelta('head', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5), 1);
    pose.apply();
    root.updateMatrixWorld(true);

    const e = new THREE.Euler().setFromQuaternion(rig.head.quaternion, 'YXZ');
    assertClose(e.y, 0.5, 1e-6, 'yaw applied');
    assert(before.y === 0, 'started at identity');
  });

  it('weight 1 is the full delta, weight 0 is none', () => {
    const { rig, pose } = buildStack();
    const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);

    pose.begin();
    pose.addWorldDelta('neck', delta, 0);
    pose.apply();
    assertClose(new THREE.Euler().setFromQuaternion(rig.neck.quaternion, 'YXZ').y, 0, 1e-9, 'no weight, no change');

    pose.begin();
    pose.addWorldDelta('neck', delta, 0.5);
    pose.apply();
    const half = new THREE.Euler().setFromQuaternion(rig.neck.quaternion, 'YXZ').y;
    assertGt(half, 0.2, 'partial weight');
    assertLt(half, 0.35, 'partial weight');
  });

  it('applies parents before children, so a child inherits the parent turn', () => {
    const { rig, pose, root } = buildStack();
    const delta = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    pose.begin();
    pose.addWorldDelta('spine2', delta, 1);
    pose.apply();
    root.updateMatrixWorld(true);

    const yawOf = q => new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    const spineWorld = rig.spine2.getWorldQuaternion(new THREE.Quaternion());
    const headWorld = rig.head.getWorldQuaternion(new THREE.Quaternion());
    // The head did not move locally, so its world rotation is the spine's turn.
    assertClose(yawOf(headWorld), yawOf(spineWorld), 1e-6, 'head carried along');
    assertClose(yawOf(headWorld), 0.4, 1e-6, 'by exactly the delta applied');
  });
});

// ── Look-at on a rig ──────────────────────────────────────────────────────────
describe('LookAtSystem', it => {
  it('turns the head toward a target on the character\'s left', () => {
    const s = buildStack();
    s.look.focusOverride = new THREE.Vector3(2.5, s.headPos.y, -1);
    for (let i = 0; i < 90; i++) s.step();

    const e = new THREE.Euler().setFromQuaternion(s.rig.head.quaternion, 'YXZ');
    assertGt(e.y, 0.1, `head yawed left, got ${e.y}`);
    assertRigFinite(s.root, 'look-at');
  });

  it('turns the head the other way for a target on the right', () => {
    const s = buildStack();
    s.look.focusOverride = new THREE.Vector3(-2.5, s.headPos.y, -1);
    for (let i = 0; i < 90; i++) s.step();
    const e = new THREE.Euler().setFromQuaternion(s.rig.head.quaternion, 'YXZ');
    assertLt(e.y, -0.1, `head yawed right, got ${e.y}`);
  });

  it('shares a big look with the neck and chest', () => {
    const s = buildStack();
    s.look.focusOverride = new THREE.Vector3(4, s.headPos.y, -0.5);
    for (let i = 0; i < 120; i++) s.step();
    const yaw = b => new THREE.Euler().setFromQuaternion(b.quaternion, 'YXZ').y;
    assertGt(yaw(s.rig.head), 0.3, 'head');
    assertGt(yaw(s.rig.neck), 0.05, 'neck follows');
    assertGt(yaw(s.rig.spine2) + yaw(s.rig.spine3), 0.02, 'chest follows');
    assertRigFinite(s.root, 'big look');
  });

  it('disabled leaves the skeleton alone', () => {
    const s = buildStack();
    s.look.enabled = false;
    s.look.focusOverride = new THREE.Vector3(3, 1.6, -1);
    for (let i = 0; i < 60; i++) s.step();
    assertClose(s.rig.head.quaternion.x, 0, 1e-9, 'untouched');
    assertClose(s.rig.head.quaternion.y, 0, 1e-9, 'untouched');
  });

  it('scan mode wanders and finds new interest points', () => {
    const s = buildStack();
    s.look.setMode('scan');
    const seen = new Set();
    for (let i = 0; i < 600; i++) {
      s.step();
      seen.add(`${s.look.gaze.x.toFixed(1)},${s.look.gaze.z.toFixed(1)}`);
    }
    assertGt(seen.size, 20, `gaze moved around (${seen.size} distinct points)`);
    assert(s.look.targetMode.startsWith('scan'), `mode reported as ${s.look.targetMode}`);
    assertRigFinite(s.root, 'scan');
  });
});

// ── Secondary motion ──────────────────────────────────────────────────────────
describe('BodyLean', it => {
  it('leans forward when accelerating', () => {
    const s = buildStack();
    for (let i = 0; i < 40; i++) s.step({ accelForward: 8 });
    // A forward lean is a nose-down pitch about the character's right axis.
    const e = new THREE.Euler().setFromQuaternion(s.rig.spine2.quaternion, 'XYZ');
    assertGt(Math.abs(e.x), 0.02, 'spine pitched');
    assertLt(s.bodyLean.leanPitch, 0, 'pitched forward (negative about +X right)');
  });

  it('dips the pelvis on landing and recovers', () => {
    const s = buildStack();
    s.step({ jumpPhase: 'land' });
    for (let i = 0; i < 6; i++) s.step({ jumpPhase: 'land' });
    assertLt(s.bodyLean.pelvisY, -0.01, `dipped, got ${s.bodyLean.pelvisY}`);

    for (let i = 0; i < 240; i++) s.step({ jumpPhase: 'none' });
    assertClose(s.bodyLean.pelvisY, 0, 0.01, 'recovered');
  });

  it('keeps breathing without drifting away', () => {
    const s = buildStack();
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < 900; i++) {
      s.step({ idleWeight: 1 });
      minY = Math.min(minY, s.bodyLean.pelvisY);
      maxY = Math.max(maxY, s.bodyLean.pelvisY);
    }
    assertClose(s.bodyLean.pelvisY, 0, 0.005, 'pelvis stays put while idle');
    assert(maxY - minY < 0.02, `no drift (${maxY - minY})`);
    assertRigFinite(s.root, 'breathing');
  });
});

// ── Folded arms ───────────────────────────────────────────────────────────────
describe('ArmPoses', it => {
  it('brings the hands to the folded-arm targets', () => {
    const s = buildStack();
    for (let i = 0; i < 90; i++) s.step({ crossed: 1 });

    // The targets ArmPoses solves for, recomputed from the posed chest.
    const chest = worldPos(s.rig.spine3);
    const fwd = new THREE.Vector3(0, 0, 1), rt = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 1, 0);
    const targetL = chest.clone().addScaledVector(fwd, 0.20).addScaledVector(rt, 0.14).addScaledVector(up, 0.05);
    const targetR = chest.clone().addScaledVector(fwd, 0.16).addScaledVector(rt, -0.11).addScaledVector(up, -0.07);

    const l = worldPos(s.rig.lHand), r = worldPos(s.rig.rHand);
    assertLt(l.distanceTo(targetL), 0.07, `left hand reached its target (${l.distanceTo(targetL).toFixed(3)} m off)`);
    assertLt(r.distanceTo(targetR), 0.07, `right hand reached its target (${r.distanceTo(targetR).toFixed(3)} m off)`);
    assertGt(l.x, r.x, 'left hand has crossed to the right of the right hand');
    assertGt(l.z, 0.05, 'both in front of the chest');
    assertRigFinite(s.root, 'crossed arms');
  });

  it('weight 0 leaves the arms where they were', () => {
    const s = buildStack();
    // Isolate the arms: breathing and look-at also move the chest, and with
    // them running "unmoved" would be the wrong thing to assert.
    s.look.enabled = false;
    s.bodyLean.enabled = false;
    s.wallHands.enabled = false;
    const before = worldPos(s.rig.lHand).clone();
    for (let i = 0; i < 60; i++) s.step({ crossed: 0 });
    assertClose(worldPos(s.rig.lHand).distanceTo(before), 0, 1e-9, 'unmoved');
  });
});

// ── Hands on the wall ─────────────────────────────────────────────────────────
describe('WallHands', it => {
  /** Stand the rig in front of the wall, facing it. */
  function atWall(s, z = -5.35, yaw = Math.PI) {
    s.root.position.set(0, 0, z);
    s.root.rotation.y = yaw;
    s.root.updateMatrixWorld(true);
  }

  it('engages when a wall is in front and within reach', () => {
    const s = buildStack();
    atWall(s);
    for (let i = 0; i < 90; i++) s.step({ bodyYaw: Math.PI });
    assertGt(s.wallHands.engaged, 0.6, `engaged, got ${s.wallHands.engaged}`);
    assertGt(s.wallHands.reach.l, 0.4, `reach measured from the rig (${s.wallHands.reach.l.toFixed(2)} m)`);
    assertLt(s.wallHands.reach.l, 0.8, 'and is a plausible arm length');
    assertRigFinite(s.root, 'wall hands');
  });

  it('puts the hand on the surface, not inside it', () => {
    const s = buildStack();
    atWall(s);
    for (let i = 0; i < 120; i++) s.step({ bodyYaw: Math.PI });

    const wall = s.environment.colliders.find(c => c.name === 'wall');
    const handZ = worldPos(s.rig.lHand).z;
    // Near face of the wall is at max.z; the wrist should stand just off it.
    assertGt(handZ, wall.max.z - 0.01, `hand is not sunk into the wall (${handZ} vs ${wall.max.z})`);
    assertLt(handZ, wall.max.z + 0.09, `hand is on the surface, not floating (${handZ})`);

    const handX = worldPos(s.rig.lHand).x;
    assertGt(handX, wall.min.x, 'within the wall footprint');
    assertLt(handX, wall.max.x, 'within the wall footprint');
  });

  it('releases when he steps back', () => {
    const s = buildStack();
    atWall(s);
    for (let i = 0; i < 90; i++) s.step({ bodyYaw: Math.PI });
    assertGt(s.wallHands.engaged, 0.6, 'engaged first');

    atWall(s, -2.5);
    for (let i = 0; i < 180; i++) s.step({ bodyYaw: Math.PI });
    assertLt(s.wallHands.engaged, 0.05, `released, got ${s.wallHands.engaged}`);
  });

  it('ignores a wall it is not facing', () => {
    const s = buildStack();
    atWall(s, -5.35, 0);         // facing away from the wall
    for (let i = 0; i < 120; i++) s.step({ bodyYaw: 0 });
    assertLt(s.wallHands.engaged, 0.05, `no grab behind him, got ${s.wallHands.engaged}`);
  });

  it('lets go when he walks off', () => {
    const s = buildStack();
    atWall(s);
    for (let i = 0; i < 60; i++) s.step({ bodyYaw: Math.PI });
    assertGt(s.wallHands.engaged, 0.3, 'engaged');
    for (let i = 0; i < 240; i++) s.step({ bodyYaw: Math.PI, speed: 4 });
    assertLt(s.wallHands.engaged, 0.05, 'hands came off at a run');
  });

  it('exposes a focus point between the hands', () => {
    const s = buildStack();
    atWall(s);
    for (let i = 0; i < 90; i++) s.step({ bodyYaw: Math.PI });
    assert(s.wallHands.hasFocus, 'has a focus point');
    assertLt(s.wallHands.focusPoint.z, -5.3, 'focus is toward the wall');
  });
});

// ── Layer masking ─────────────────────────────────────────────────────────────
describe('AnimationLayers', it => {
  const track = name => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]);

  it('masks a clip down to the upper body', () => {
    const { bones: rig } = resolveBones(makeRig().bones, RIG_PATTERNS);
    const mask = upperBodyMask(rig);
    assert(mask.has('SKEL_Head_020'), 'head is in the mask');
    assert(!mask.has('SKEL_L_Thigh_01'), 'thigh is not');
    assert(UPPER_BODY_KEYS.length === 13, `mask covers ${UPPER_BODY_KEYS.length} joints`);

    const clip = new THREE.AnimationClip('test', 1, [
      track('SKEL_Pelvis_00'), track('SKEL_Head_020'), track('SKEL_L_Hand_014'), track('SKEL_R_Foot_06'),
    ]);
    const masked = maskedClip(clip, mask);
    const names = masked.tracks.map(t => t.name.split('.')[0]).sort();
    assert(names.join(',') === 'SKEL_Head_020,SKEL_L_Hand_014', `kept ${names.join(',')}`);
  });

  it('caches the masked clip per mask', () => {
    const { bones: rig } = resolveBones(makeRig().bones, RIG_PATTERNS);
    const mask = upperBodyMask(rig);
    const clip = new THREE.AnimationClip('t', 1, [track('SKEL_Head_020')]);
    assert(maskedClip(clip, mask) === maskedClip(clip, mask), 'same object back');
  });

  it('plays a masked clip through the layer and honours its weight', () => {
    const { bones, root } = makeRig();
    const { bones: rig } = resolveBones(bones, RIG_PATTERNS);
    const mixer = new THREE.AnimationMixer(root);
    const layer = new AnimationLayer(mixer, upperBodyMask(rig), { name: 'test' });

    const clip = new THREE.AnimationClip('social', 1, [
      track('SKEL_Head_020'), track('SKEL_L_Thigh_01'),
    ]);
    layer.play(clip, { blendIn: 0.2 });
    layer.setWeight(0.7);
    for (let i = 0; i < 30; i++) layer.update(DT);

    const action = layer.blender.entries[0].action;
    assertClose(action.getEffectiveWeight(), 0.7, 1e-9, 'master weight applied');
    // Only the head track survived the mask, so the thigh binding is untouched.
    assert(layer.blender.entries[0].clip.tracks.length === 1, 'one track after masking');
  });
});

// ── Module surface ────────────────────────────────────────────────────────────
describe('module surface', it => {
  it('every module in js/ imports and exports what it claims', async () => {
    const expected = {
      './AnimationDatabase.js': ['AnimationDatabase'],
      './AnimationLayers.js':   ['AnimationLayer', 'upperBodyMask', 'maskedClip', 'UPPER_BODY_KEYS'],
      './AnimationSmoothing.js':['damp', 'softClamp', 'SmoothedValue', 'SeededRandom', 'lerpAngle'],
      './ArmIK.js':             ['solveArm', 'handWorldQuatFromAxes', 'measureHandFrame'],
      './ArmPoses.js':          ['ArmPoses'],
      './BodyLean.js':          ['BodyLean'],
      './CharacterController.js': ['CharacterController'],
      './Environment.js':       ['Environment', 'BoxCollider'],
      './FootPlanting.js':      ['FootPlanting'],
      './GTACamera.js':         ['GTACamera'],
      './IdleDirector.js':      ['IdleDirector', 'UPPER_BODY_CANDIDATES'],
      './LookAtSystem.js':      ['LookAtSystem', 'distributeLook', 'LOOK_LIMITS'],
      './MotionMatching.js':    ['MotionMatching'],
      './MotionSelector.js':    ['Selector', 'candidateCost', 'feature01'],
      './ProceduralPose.js':    ['ProceduralPose'],
      './Retargeting.js':       ['Retargeter', 'BONE_MAP'],
      './RigBones.js':          ['RIG_PATTERNS', 'resolveBones', 'boneDepth', 'refreshBoneMatrix'],
      './Terrain.js':           ['createTerrain', 'getTerrainHeight', 'getTerrainNormal', 'RELIEF'],
      './TransitionBlender.js': ['TransitionBlender'],
      './TwoBoneIK.js':         ['applyTwoBoneIK', 'solveTwoBoneIK', 'rotateBoneToward'],
      './WallHands.js':         ['WallHands'],
    };

    for (const [spec, names] of Object.entries(expected)) {
      const mod = await import(`../js/${spec.slice(2)}`);
      for (const n of names) {
        assert(n in mod, `${spec} should export ${n}`);
      }
    }
  });

  it('FootPlanting constructs against a real bone list', () => {
    // Guards the wiring that a syntax check cannot see: the module resolves its
    // rig through the shared table rather than a local copy.
    const { bones } = makeRig();
    const fp = new FootPlanting(new THREE.Group(), bones);
    for (const key of ['hips', 'lFoot', 'rFoot', 'lThigh', 'rShin']) {
      assert(!!fp.bones[key], `${key} resolved`);
    }
    assertClose(fp.pelvisExtra, 0, 1e-12, 'pelvis hook starts at zero');
  });
});

// ── Camera spring arm ─────────────────────────────────────────────────────────
describe('GTACamera', it => {
  it('pulls the arm in instead of rendering through a wall', async () => {
    const { GTACamera } = await import('../js/GTACamera.js');
    const scene = new THREE.Scene();
    const env = new Environment(scene);
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 200);
    const cam = new GTACamera(camera);
    cam.setCollidables(env.meshes);

    // Standing with his back to the wall, the default 3.2 m arm would put the
    // camera on the far side of it.
    const characterPos = new THREE.Vector3(0, 1.0, -5.3);
    cam.yaw = Math.PI;                 // looking away from the wall
    for (let i = 0; i < 90; i++) cam.update(DT, characterPos);

    const arm = camera.position.distanceTo(characterPos);
    assertLt(arm, 2.0, `arm pulled in to ${arm.toFixed(2)} m`);
    assertGt(camera.position.z, -6.2, 'camera stayed this side of the wall');
    assert(Number.isFinite(camera.position.x + camera.position.y + camera.position.z), 'finite position');
  });

  it('keeps the full arm in the open', async () => {
    const { GTACamera } = await import('../js/GTACamera.js');
    const scene = new THREE.Scene();
    const env = new Environment(scene);
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 200);
    const cam = new GTACamera(camera);
    cam.setCollidables(env.meshes);

    const characterPos = new THREE.Vector3(0, 1.0, 8);   // far from everything
    for (let i = 0; i < 120; i++) cam.update(DT, characterPos);
    const arm = camera.position.distanceTo(characterPos);
    assertGt(arm, 2.8, `full arm out at ${arm.toFixed(2)} m`);
  });
});
