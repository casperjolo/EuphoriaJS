import * as THREE from 'three';
import { describe, assert, assertClose, assertLt, assertGt, assertRigFinite } from './harness.mjs';
import { AnimationDatabase } from '../js/AnimationDatabase.js';
import { MotionMatching } from '../js/MotionMatching.js';
import { FootPlanting } from '../js/FootPlanting.js';
import { CharacterController } from '../js/CharacterController.js';
import { Environment } from '../js/Environment.js';
import { RIG_PATTERNS, resolveBones } from '../js/RigBones.js';
import { ProceduralPose } from '../js/ProceduralPose.js';
import { LookAtSystem } from '../js/LookAtSystem.js';
import { BodyLean } from '../js/BodyLean.js';
import { ArmPoses } from '../js/ArmPoses.js';
import { WallHands } from '../js/WallHands.js';
import { AnimationLayer, upperBodyMask } from '../js/AnimationLayers.js';
import { IdleDirector } from '../js/IdleDirector.js';
import { getTerrainHeight } from '../js/Terrain.js';

const DT = 1 / 60;

/**
 * The whole stack, driven exactly the way `main.js` drives it, against the real
 * Fred rig and the real retargeted clips. This is the test that would catch a
 * wiring mistake rather than a logic one.
 */
export async function bootWorld(glTFLoader) {
  const scene = new THREE.Scene();

  const fredGLTF = await new Promise((res, rej) =>
    glTFLoader.load('NaturalMotion/Characters/Fred.glb', res, undefined, rej));
  const fredScene = fredGLTF.scene;

  const bones = [];
  fredScene.traverse(n => { if (n.isBone) bones.push(n); });

  fredScene.updateMatrixWorld(true);
  let lowest = Infinity;
  for (const name of ['SKEL_L_Foot_end_021', 'SKEL_R_Foot_end_022']) {
    const b = bones.find(x => x.name === name);
    if (b) lowest = Math.min(lowest, new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).y);
  }
  const groundOffset = Number.isFinite(lowest) ? -lowest : 0;

  const character = new THREE.Group();
  character.name = 'CharacterRoot';
  fredScene.rotation.y = Math.PI;
  character.add(fredScene);
  character.position.set(0, getTerrainHeight(0, 0) + groundOffset, 0);
  scene.add(character);

  const db = new AnimationDatabase();
  await db.load();
  db.retarget(fredScene);
  if (db.clips.size === 0) throw new Error('no clips retargeted');

  const environment = new Environment(scene);
  const mixer = new THREE.AnimationMixer(fredScene);
  const mm = new MotionMatching(mixer, db);
  const { bones: rig, missing } = resolveBones(bones, RIG_PATTERNS);
  assert(missing.length === 0, `unresolved rig keys: ${missing.join(', ')}`);

  const pose = new ProceduralPose(rig);
  const look = new LookAtSystem(rig, { seed: 99 });
  look.attachPose(pose);
  const bodyLean = new BodyLean(rig, pose);
  const armPoses = new ArmPoses({ bones: rig, scene: fredScene });
  const wallHands = new WallHands({ environment, bones: rig, scene: fredScene });
  const footPlanting = new FootPlanting(character, bones);
  const controller = new CharacterController(character, groundOffset, environment);
  const upperLayer = new AnimationLayer(mixer, upperBodyMask(rig), { name: 'upper-body', defaultBlend: 0.7 });
  const director = new IdleDirector({ db, layer: upperLayer, locomotion: mm, look, armPoses });

  let gameT = 0;
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const headPos = new THREE.Vector3();

  /** One frame, in main.js's order. */
  const step = (ctx = {}) => {
    const cameraYaw = ctx.cameraYaw ?? 0;
    const c = controller.update(DT, cameraYaw);
    const { localVel, speed, jumpPhase } = c;
    gameT += DT;

    mm.setCrouch(c.crouching);
    mm.setJumpPhase(jumpPhase, { speed, localVel, airTime: c.airTime });
    mm.update(DT, localVel, speed, c.crouching);

    director.update(DT, {
      speed,
      idleTime: c.idleTime,
      onGround: controller.onGround,
      crouch: c.crouching,
      wallEngaged: wallHands.engaged,
      now: gameT,
    });

    upperLayer.update(DT);
    mm.advance(DT);
    mixer.update(DT);

    character.updateWorldMatrix(true, true);

    footPlanting.pelvisExtra = bodyLean.pelvisY;
    footPlanting.update(DT);

    forward.set(0, 0, 1).applyQuaternion(character.quaternion);
    right.set(1, 0, 0).applyQuaternion(character.quaternion);
    camFwd.set(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), cameraYaw);
    headPos.setFromMatrixPosition(rig.head.matrixWorld);

    pose.begin();
    look.update(DT, {
      root: character, headPos,
      cameraForward: camFwd,
      cameraPos: new THREE.Vector3(0, 1.6, 3),
      speed,
      bodyYaw: controller.getBodyYaw(),
    });
    bodyLean.update(DT, {
      root: character, forward, right,
      accelForward: c.accelForward,
      accelLateral: c.accelLateral,
      speed, jumpPhase,
      idleWeight: Math.min(1, c.idleTime / 4),
    });
    pose.apply();

    wallHands.update(DT, {
      root: character, forward, right, speed,
      onGround: controller.onGround,
      groundY: getTerrainHeight(character.position.x, character.position.z),
    });
    director.applyPoses({ forward, right });
    look.focusOverride = wallHands.hasFocus ? wallHands.focusPoint : null;

    character.updateWorldMatrix(true, true);
    return c;
  };

  return {
    scene, fredScene, character, bones, rig, db, mm, mixer, controller, director,
    upperLayer, wallHands, look, bodyLean, footPlanting, environment, groundOffset, step,
  };
}

export function registerPipeline(loaderFactory) {
  describe('pipeline (real assets)', it => {
    let world;
    const glTFLoader = loaderFactory();

    it('loads Fred, the clip library and retargets every clip', async () => {
      world = await bootWorld(glTFLoader);
      assertGt(world.bones.length, 20, `${world.bones.length} bones`);
      assertGt(world.db.clips.size, 100, `${world.db.clips.size} clips loaded`);
      assert(!!world.db.get('idle_break_01'), 'the idle breaks are in the library');
      assert(!!world.db.get('jump_fall'), 'the airborne clip is in the library');
      assert(!!world.db.get('crouch_idle_loop'), 'the crouched idle is in the library');

      // Retargeted clips are bound to Fred's bone names, not the source rig's,
      // and the locomotion clips carry the baked pelvis-bob position track.
      const idle = world.db.get('idle_loop');
      assert(idle.tracks.length === 21, `${idle.tracks.length} tracks (20 joints + pelvis position)`);
      assert(idle.tracks.every(t => t.name.startsWith('SKEL_')), 'bound to SKEL_* bones');
      assert(idle.tracks.some(t => t.name === 'SKEL_Pelvis_00.position'), 'pelvis bob baked');
      assertClose(idle.duration, 10.0, 0.3, 'idle duration preserved');

      // A crouched clip bakes its depth as a *lowering*, never a rise.
      const crouch = world.db.get('transition_stand_to_crouch');
      const pos = crouch.tracks.find(t => t.name === 'SKEL_Pelvis_00.position');
      const bindY = idle.tracks.find(t => t.name === 'SKEL_Pelvis_00.position').values[1];
      const minY = Math.min(...Array.from(pos.values).filter((_, i) => i % 3 === 1));
      assertLt(minY, bindY - 0.3, `crouch lowers the pelvis (min ${minY.toFixed(3)} vs bind ${bindY.toFixed(3)})`);
      const maxY = Math.max(...Array.from(pos.values).filter((_, i) => i % 3 === 1));
      assertLt(maxY, bindY + 1e-6, `crouch never rises (max ${maxY.toFixed(3)})`);
    });

    it('thirty seconds of standing still: legs idle, upper body finds something to do', async () => {
      // The break takes only offer once the character is fully settled
      // (settle = 1 at 12 s), so the window has to be longer than that.
      const seen = new Set();
      let sawUpperLayer = false;
      let sawBreakOnLayer = false;
      let sawCrossed = 0;

      for (let i = 0; i < 1800; i++) {
        world.step();
        seen.add(world.director.current);
        const k = world.upperLayer.currentKey;
        if (k) sawUpperLayer = true;
        if (k && /^(idle_break|crouch_idle_break)/.test(k)) sawBreakOnLayer = true;
        sawCrossed = Math.max(sawCrossed, world.director.crossed.value);
        if (i % 60 === 0) assertRigFinite(world.fredScene, `idle frame ${i}`);
      }

      assert(seen.has('rest'), 'started at rest');
      assert(seen.has('break') || seen.has('cross'), `idle behaviours ran: ${[...seen].join(', ')}`);
      assert(sawUpperLayer, 'an idle behaviour reached the upper-body layer');
      assert(sawBreakOnLayer, 'an idle break clip played on the masked layer');
      assertGt(sawCrossed, 0.5, 'arms folded at some point');
      assert(world.controller.idleTime > 29, `idle clock ran (${world.controller.idleTime.toFixed(1)}s)`);
      assert(world.mm.getCurrentKey() === 'idle_loop', `legs stayed idle, got ${world.mm.getCurrentKey()}`);
    });

    it('movement cancels the idle behaviour and picks a locomotion clip', async () => {
      world.controller._keys.KeyW = true;

      // Sampled mid-stride: from the spawn he reaches the wall in about 1.6 s
      // and stops, so the clip at the *end* of a long run is idle again.
      const clips = new Set();
      let topSpeed = 0;
      for (let i = 0; i < 90; i++) {
        const c = world.step({ cameraYaw: 0 });
        clips.add(world.mm.getCurrentKey());
        topSpeed = Math.max(topSpeed, c.speed);
      }
      delete world.controller._keys.KeyW;

      assertClose(world.controller.idleTime, 0, 1e-9, 'idle clock reset');
      assert([...clips].some(k => /^(run|walk)_/.test(k)), `locomotion clips played: ${[...clips].join(', ')}`);
      assertGt(topSpeed, 3, `got up to speed (${topSpeed.toFixed(2)} m/s)`);
      assertGt(-world.controller.mesh.position.z, 2, 'moved toward -Z');
      assert(['rest', 'wall'].includes(world.director.current),
        `upper body stopped fidgeting, got ${world.director.current}`);
      assertRigFinite(world.fredScene, 'running');
    });

    it('walking into the wall stops him and puts his hands on it', async () => {
      // Put him square-on to the wall with a couple of metres to walk.
      world.character.position.set(0, world.groundOffset, -3.0);
      world.controller.velocity.set(0, 0, 0);
      world.controller._bodyYaw = Math.PI;
      world.controller._keys.KeyW = true;

      let touched = false;
      let minZ = Infinity;
      for (let i = 0; i < 600; i++) {
        world.step({ cameraYaw: 0 });
        if (world.controller.contactNormal) touched = true;
        minZ = Math.min(minZ, world.character.position.z);
        if (i % 60 === 0) assertRigFinite(world.fredScene, `wall frame ${i}`);
      }
      delete world.controller._keys.KeyW;

      const wall = world.environment.colliders.find(c => c.name === 'wall');
      assert(touched, 'reported contact with the wall');
      assertGt(minZ, wall.max.z, `never passed through (closest ${minZ.toFixed(2)}, face at ${wall.max.z})`);
      assertGt(world.wallHands.engaged, 0.6, `hands went up, engaged ${world.wallHands.engaged}`);
      assert(world.wallHands.hasFocus, 'and he looks at them');
    });

    it('a jump runs the full phase machine and dips the pelvis on landing', async () => {
      world.character.position.set(0, world.groundOffset, 0);
      world.controller.velocity.set(0, 0, 0);
      world.controller.idleTime = 0;

      world.controller._keys.Space = true;
      const phases = new Set();
      let deepest = 0;
      for (let i = 0; i < 240; i++) {
        const c = world.step();
        phases.add(c.jumpPhase);
        deepest = Math.min(deepest, world.bodyLean.pelvisY);
        if (i > 2) delete world.controller._keys.Space;
      }

      assert(phases.has('begin'), 'take-off');
      assert(phases.has('air'), 'airborne');
      assert(phases.has('land'), 'landing');
      assert(phases.has('none'), 'recovered');
      assertLt(deepest, -0.02, `pelvis dipped on landing (deepest ${deepest.toFixed(3)} m)`);
      assertRigFinite(world.fredScene, 'jump');
    });

    it('crouch enters and leaves through the measured transition, at capped speed', async () => {
      world.character.position.set(0, world.groundOffset, 0);
      world.controller.velocity.set(0, 0, 0);
      world.controller.crouching = false;
      world.controller.idleTime = 0;
      world.director.enabled = false;   // keep the upper body out of the picture

      world.controller._requestCrouchToggle();   // grounded → immediate
      for (let i = 0; i < 150; i++) world.step();
      assert(world.controller.crouching, 'crouched');
      assert(world.mm.getCurrentKey() === 'crouch_idle_loop',
        `crouch idle played, got ${world.mm.getCurrentKey()}`);

      world.controller._keys.KeyW = true;
      let sawCrouchGait = false;
      let topSpeed = 0;
      for (let i = 0; i < 150; i++) {
        world.step();
        if (/^crouch_/.test(world.mm.getCurrentKey() ?? '')) sawCrouchGait = true;
        topSpeed = Math.max(topSpeed, Math.hypot(world.controller.velocity.x, world.controller.velocity.z));
      }
      delete world.controller._keys.KeyW;
      assert(sawCrouchGait, 'a crouch gait played while moving');
      assertLt(topSpeed, 2.3, `crouch speed capped (${topSpeed.toFixed(2)} m/s)`);

      for (let i = 0; i < 60; i++) world.step();
      world.controller._requestCrouchToggle();
      for (let i = 0; i < 150; i++) world.step();
      assert(!world.controller.crouching, 'back to standing');
      assert(world.mm.getCurrentKey() === 'idle_loop',
        `standing idle again, got ${world.mm.getCurrentKey()}`);
      world.director.enabled = true;
    });

    it('landing selection uses fall height and impact speed', async () => {
      const pickLand = ctx => {
        world.mm.setJumpPhase('none', {});
        world.mm.setJumpPhase('land', ctx);
        for (let i = 0; i < 20; i++) world.mm.advance(DT);
        return world.mm.getCurrentKey();
      };
      const pickStart = ctx => {
        world.mm.setJumpPhase('none', {});
        world.mm.setJumpPhase('begin', ctx);
        for (let i = 0; i < 20; i++) world.mm.advance(DT);
        return world.mm.getCurrentKey();
      };
      const fwd = new THREE.Vector3(0, 0, 1);
      const back = new THREE.Vector3(0, 0, -1);

      assert(/^jump_land_roll_/.test(pickLand({ speed: 1, localVel: fwd, airTime: 1.8 })),
        'a long fall ends in a roll');
      assert(/^jump_land_stumble_/.test(pickLand({ speed: 6.5, localVel: fwd, airTime: 0.5 })),
        'a sprint-speed landing stumbles');
      assert(/^jump_land_walk_light_f_/.test(pickLand({ speed: 2, localVel: fwd, airTime: 0.5 })),
        'a walking landing is a walk landing');
      assert(/^jump_land_stand_light_f_/.test(pickLand({ speed: 0.2, localVel: fwd, airTime: 0.5 })),
        'a standing landing is a stand landing');
      assert(/^jump_land_.*_b_/.test(pickLand({ speed: 0.2, localVel: back, airTime: 0.5 })),
        'a backward landing uses the backward take');

      assert(/^jump_start_stand_f_/.test(pickStart({ speed: 0, localVel: fwd })),
        'a standing start is a standing start');
      assert(/^jump_start_run_f_/.test(pickStart({ speed: 4, localVel: fwd })),
        'a running start is a running start');
      world.mm.setJumpPhase('none', {});
      for (let i = 0; i < 60; i++) world.step();
    });

    it('every system can be switched off without breaking the others', async () => {
      world.look.enabled = false;
      world.director.enabled = false;
      world.wallHands.enabled = false;
      world.bodyLean.enabled = false;
      for (let i = 0; i < 120; i++) world.step();
      assertRigFinite(world.fredScene, 'all off');
      assert(world.mm.getCurrentKey() !== null, 'locomotion still running');
    });
  });
}
