import * as THREE from 'three';
import { GLTFLoader }  from 'three/addons/loaders/GLTFLoader.js';
import { createTerrain, getTerrainHeight } from './Terrain.js';
import { AnimationDatabase }  from './AnimationDatabase.js';
import { MotionMatching }     from './MotionMatching.js';
import { FootPlanting }       from './FootPlanting.js';
import { GTACamera }          from './GTACamera.js';
import { CharacterController } from './CharacterController.js';
import { Environment }        from './Environment.js';
import { RIG_PATTERNS, resolveBones } from './RigBones.js';
import { ProceduralPose }     from './ProceduralPose.js';
import { LookAtSystem }       from './LookAtSystem.js';
import { BodyLean }           from './BodyLean.js';
import { ArmPoses }           from './ArmPoses.js';
import { WallHands }          from './WallHands.js';
import { AnimationLayer, upperBodyMask } from './AnimationLayers.js';
import { IdleDirector }       from './IdleDirector.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const hud          = document.getElementById('hud');
const loading      = document.getElementById('loading');
const progressFill = document.getElementById('progress-fill');
const progressLabel= document.getElementById('progress-label');

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
// No tone mapping: the white void has to stay pure white, and a filmic curve
// would roll it off to grey and muddy the flat studio shading.
renderer.toneMapping       = THREE.NoToneMapping;
document.body.appendChild(renderer.domElement);

// ── Scene ─────────────────────────────────────────────────────────────────────
// Euphoria tech-demo staging: the floor dissolves into a pure white void well
// before its edge, so there is no horizon and no sense of place.
const VOID_COLOR = 0xffffff;
const scene  = new THREE.Scene();
scene.background = new THREE.Color(VOID_COLOR);
// Exponential falloff rather than linear: linear fog saturates at its far plane
// and leaves a hard horizon line across the floor.
scene.fog        = new THREE.FogExp2(VOID_COLOR, 0.019);

// ── Camera ────────────────────────────────────────────────────────────────────
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 200);
const gtaCam = new GTACamera(camera);

// ── Lights ────────────────────────────────────────────────────────────────────
// Neutral studio key light — white, not warm, so the greys stay grey. It rides
// with the character (see the loop) because a fixed shadow camera this tight
// would drop the shadow as soon as you walked out of it.
const SUN_OFFSET = new THREE.Vector3(6, 14, 8);
const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.copy(SUN_OFFSET);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far  = 40;
sun.shadow.camera.left = sun.shadow.camera.bottom = -8;
sun.shadow.camera.right = sun.shadow.camera.top   =  8;
sun.shadow.bias = -0.0005;
sun.shadow.radius = 3;
scene.add(sun);
scene.add(sun.target);

// Bright ambient bounce off the white surround, so shading stays soft and open
// rather than dropping to black in the shadows.
const fill = new THREE.HemisphereLight(0xffffff, 0x8e8e94, 0.85);
scene.add(fill);

// ── Terrain ───────────────────────────────────────────────────────────────────
const terrainMesh = createTerrain(scene);
terrainMesh.castShadow = false;

// ── Solid geometry ────────────────────────────────────────────────────────────
// Grey primitives in the void. They are here to be reacted to: the controller
// collides with them, the camera arm pulls in around them, and the hands find
// them.
const environment = new Environment(scene);
gtaCam.setCollidables([terrainMesh, ...environment.meshes]);

// ── Pointer lock (mouse look) ─────────────────────────────────────────────────
let pointerLocked = false;
renderer.domElement.addEventListener('click', () => {
  renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
});
document.addEventListener('mousemove', e => {
  if (!pointerLocked) return;
  gtaCam.onMouseMove(e.movementX, e.movementY);
});

// ── Resize ────────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Asset loading ─────────────────────────────────────────────────────────────
async function loadAll() {
  // Load Fred
  const gltfLoader = new GLTFLoader();
  const fredGLTF = await new Promise((res, rej) =>
    gltfLoader.load('NaturalMotion/Characters/Fred.glb', res, undefined, rej)
  );

  const fredScene = fredGLTF.scene;

  // Fred is a ragdoll rig: each bone carries its own physics-body mesh rather
  // than one skinned mesh, so collect the bones directly from the hierarchy.
  const bones = [];
  fredScene.traverse(node => {
    if (node.isBone) bones.push(node);
    if (node.isMesh) {
      node.castShadow    = true;
      node.receiveShadow = true;
      node.frustumCulled = false;
    }
  });
  console.log(`[main] Fred: ${bones.length} bones`);

  // Measure how far the feet sit below the model origin in the rest pose, so
  // the root can be lifted by that much and the feet land on the terrain.
  fredScene.updateMatrixWorld(true);
  let lowest = Infinity;
  for (const name of ['SKEL_L_Foot_end_021', 'SKEL_R_Foot_end_022']) {
    const b = bones.find(x => x.name === name);
    if (b) lowest = Math.min(lowest, new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).y);
  }
  const groundOffset = Number.isFinite(lowest) ? -lowest : 0;
  console.log(`[main] ground offset: ${groundOffset.toFixed(3)}m`);

  // Fred's mesh faces -Z at zero rotation, but the controller, the camera and
  // the IK pole vectors all speak the usual +Z-forward convention. Rather than
  // scatter a 180° offset through each of them, normalise it once here: the
  // model is turned to face +Z inside a wrapper, and everything downstream
  // drives the wrapper, whose +Z is genuinely forward.
  const character = new THREE.Group();
  character.name = 'CharacterRoot';
  fredScene.rotation.y = Math.PI;
  character.add(fredScene);

  // Place character at terrain height
  const startX = 0, startZ = 0;
  character.position.set(startX, getTerrainHeight(startX, startZ) + groundOffset, startZ);
  scene.add(character);
  window.__fredScene = fredScene;   // debug
  window.__character = character;   // debug

  // Load animations
  const db = new AnimationDatabase();
  await db.load((done, tot) => {
    progressFill.style.width = (done / tot) * 100 + '%';
    progressLabel.textContent = `${done} / ${tot} animations`;
  });

  // Bake every clip from the source FBX rig onto Fred's skeleton
  progressLabel.textContent = 'retargeting…';
  await new Promise(r => requestAnimationFrame(r)); // let the label paint
  db.retarget(fredScene, (done, tot) => {
    progressLabel.textContent = `retargeting ${done} / ${tot}`;
  });

  return { fredScene, character, bones, db, groundOffset };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let fredScene, character, bones, db, groundOffset;

  try {
    ({ fredScene, character, bones, db, groundOffset } = await loadAll());
  } catch (err) {
    hud.textContent = `Load error: ${err.message}`;
    console.error(err);
    return;
  }

  loading.classList.add('hidden');

  // ── Animation mixer ────────────────────────────────────────────────────────
  const mixer = new THREE.AnimationMixer(fredScene);
  const mm    = new MotionMatching(mixer, db);

  // ── Rig ────────────────────────────────────────────────────────────────────
  const { bones: rig, missing } = resolveBones(bones, RIG_PATTERNS);
  if (missing.length) console.warn('[main] unresolved rig keys:', missing.join(', '));

  // One collection point for everything procedural, so the systems cannot
  // overwrite each other's bone writes.
  const pose = new ProceduralPose(rig);

  const look     = new LookAtSystem(rig, { seed: 0x51ee7 });
  look.attachPose(pose);
  const bodyLean = new BodyLean(rig, pose);
  const armPoses = new ArmPoses({ bones: rig, scene: fredScene });
  const wallHands= new WallHands({ environment, bones: rig, scene: fredScene });

  // ── Foot planting ──────────────────────────────────────────────────────────
  let footPlanting = null;
  if (bones.length) {
    footPlanting = new FootPlanting(character, bones);
    window._footPlanting = footPlanting; // for debug key
  }

  // ── Character controller ───────────────────────────────────────────────────
  const controller = new CharacterController(character, groundOffset, environment);

  // ── Upper-body layer + idle director ───────────────────────────────────────
  const upperLayer = new AnimationLayer(mixer, upperBodyMask(rig), { name: 'upper-body', defaultBlend: 0.7 });
  const director = new IdleDirector({ db, layer: upperLayer, locomotion: mm, look, armPoses });

  window.__gtaCam = gtaCam;
  window.__controller = controller;
  window.__systems = { pose, look, bodyLean, armPoses, wallHands, upperLayer, director, environment, rig };

  // ── Debug keys ─────────────────────────────────────────────────────────────
  // Toggles, so each system can be watched on and off against the same clip.
  const toggles = {
    Digit1: ['look',    () => look.enabled,      v => (look.enabled = v)],
    Digit2: ['idle',    () => director.enabled,  v => (director.enabled = v)],
    Digit3: ['hands',   () => wallHands.enabled, v => (wallHands.enabled = v)],
    Digit4: ['lean',    () => bodyLean.enabled,  v => (bodyLean.enabled = v)],
  };
  // Latest controller output, kept here so the debug keys can query with it.
  let lastQuery = { localVel: new THREE.Vector3(), speed: 0, crouch: false };
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyB' && window._footPlanting) window._footPlanting.debugBones();
    if (e.code === 'KeyD') mm.dumpCosts(lastQuery.localVel, lastQuery.speed, lastQuery.crouch);
    const t = toggles[e.code];
    if (t) {
      t[2](!t[1]());
      console.log(`[main] ${t[0]} ${t[1]() ? 'on' : 'off'}`);
    }
  });

  // ── Scratch vectors (the loop must not allocate) ───────────────────────────
  const forward = new THREE.Vector3();
  const right   = new THREE.Vector3();
  const camFwd  = new THREE.Vector3();
  const headPos = new THREE.Vector3();

  // ── State for HUD ──────────────────────────────────────────────────────────
  let frameCount = 0, fpsTime = 0, fps = 0;
  let gameT = 0;   // monotonic game clock (the director's cooldowns run on it)

  // ── Game loop ──────────────────────────────────────────────────────────────
  const clock = new THREE.Clock();

  renderer.setAnimationLoop(() => {
    const dt  = Math.min(clock.getDelta(), 0.05); // cap at 50ms

    // FPS counter
    frameCount++;
    fpsTime += dt;
    if (fpsTime >= 0.5) { fps = Math.round(frameCount / fpsTime); frameCount = 0; fpsTime = 0; }

    // 1. Update camera (get desired yaw)
    const cameraYaw = gtaCam.update(dt, character.position);

    // 2. Controller update
    const c = controller.update(dt, cameraYaw);
    const { localVel, speed, jumpPhase } = c;
    gameT += dt;

    // 3. Motion matching — locomotion, then the upper-body layer on top.
    //    Both only decide here; their weights are advanced in step 4, because
    //    the mixer reads them during its own update.
    //
    //    Crouch and jump phases are one-shots addressed by name (the query is
    //    suppressed while they own the base layer); everything else is the
    //    continuous (vx, vz) query, which no-ops during them anyway.
    mm.setCrouch(c.crouching);
    mm.setJumpPhase(jumpPhase, { speed, localVel, airTime: c.airTime });
    mm.update(dt, localVel, speed, c.crouching);
    lastQuery.localVel.copy(localVel);
    lastQuery.speed = speed;
    lastQuery.crouch = c.crouching;

    director.update(dt, {
      speed,
      idleTime: c.idleTime,
      onGround: controller.onGround,
      crouch: c.crouching,
      wallEngaged: wallHands.engaged,
      now: gameT,
    });

    // 4. Advance every blend curve, then the mixer
    upperLayer.update(dt);
    mm.advance(dt);
    mixer.update(dt);

    // 5. Compute world matrices so IK can read bone positions
    character.updateWorldMatrix(true, true);

    // Keep the key light centred on the character so its tight shadow camera
    // travels with him instead of leaving the shadow behind at the origin.
    sun.position.copy(character.position).add(SUN_OFFSET);
    sun.target.position.copy(character.position);
    sun.target.updateMatrixWorld();

    // 6. Foot planting IK
    if (footPlanting) footPlanting.pelvisExtra = bodyLean.pelvisY;
    footPlanting?.update(dt);

    // 7. Procedural pose: look-at and body lean contribute, then one pass
    //    applies them in hierarchy order.
    forward.set(0, 0, 1).applyQuaternion(character.quaternion);
    right.set(1, 0, 0).applyQuaternion(character.quaternion);
    camera.getWorldDirection(camFwd);
    if (rig.head) headPos.setFromMatrixPosition(rig.head.matrixWorld);
    else headPos.copy(character.position).setY(character.position.y + 1.6);

    pose.begin();
    look.update(dt, {
      root: character,
      headPos,
      cameraForward: camFwd,
      cameraPos: camera.position,
      speed,
      bodyYaw: controller.getBodyYaw(),
    });
    bodyLean.update(dt, {
      root: character,
      forward,
      right,
      accelForward: c.accelForward,
      accelLateral: c.accelLateral,
      speed,
      jumpPhase,
      idleWeight: Math.min(1, c.idleTime / 4),
    });
    pose.apply();

    // 8. Solved arm behaviours, after the torso has been posed: the hands go
    //    where the wall is, or fold across the chest.
    wallHands.update(dt, {
      root: character,
      forward,
      right,
      speed,
      onGround: controller.onGround,
      groundY: getTerrainHeight(character.position.x, character.position.z),
    });
    director.applyPoses({ forward, right });

    // Where the hands are is where the eyes go — one frame behind, which is
    // closer to how attention actually works anyway.
    look.focusOverride = wallHands.hasFocus ? wallHands.focusPoint : null;

    // 9. Render
    renderer.render(scene, camera);

    // 10. HUD
    const lx = localVel.x.toFixed(2).padStart(6);
    const lz = localVel.z.toFixed(2).padStart(6);
    const sp = speed.toFixed(2).padStart(5);
    const px = character.position.x.toFixed(1);
    const pz = character.position.z.toFixed(1);
    const off = s => (s ? 'on ' : 'off');
    const tierName = ['idle', 'walk', 'run', 'sprint', 'crouch'][
      c.crouching ? 4 : speed < 0.25 ? 0 : speed < 3.4 ? 1 : speed < 6.0 ? 2 : 3];
    hud.innerHTML = [
      `FPS:  ${fps}`,
      `Legs: ${mm.getCurrentKey() ?? '—'}  ×${mm.getTimeScale().toFixed(2)}`,
      `Arms: ${director.current}${upperLayer.currentKey ? ` (${upperLayer.currentKey})` : ''}`,
      `Gaze: ${look.targetMode}  yaw ${(look.yaw * 57.3).toFixed(0)}°`,
      `Hand: ${wallHands.status()}`,
      `Idle: ${c.idleTime.toFixed(1)}s`,
      `Spd:  ${sp} m/s   Tier: ${tierName}   LVel: ${lx} / ${lz}`,
      `Pos:  ${px}, ${pz}   Jump: ${jumpPhase}${c.airTime > 0 ? ` (${c.airTime.toFixed(2)}s)` : ''}   ${c.crouching ? 'CROUCH ' : ''}Ground: ${controller.onGround ? 'yes' : 'no'}`,
      '',
      'WASD — move   Shift — sprint   Space — jump   C — crouch',
      'Click — lock mouse   B — dump bones   D — dump match costs',
      `1 look ${off(look.enabled)}  2 idle ${off(director.enabled)}  3 hands ${off(wallHands.enabled)}  4 lean ${off(bodyLean.enabled)}`,
    ].join('\n');
  });
})();
