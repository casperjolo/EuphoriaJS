/**
 * clip-manifest.mjs — the animation asset workflow.
 *
 * Scans `Animations/`, classifies every FBX by its naming convention, loads
 * the clips the player actually uses, MEASURES their motion headless
 * (local velocity, speed, body rotation, vertical drop, loopability) and
 * generates `js/ClipLibrary.js` — the feature-tagged clip manifest that
 * AnimationDatabase loads and MotionMatching queries.
 *
 * Workflow when adding or swapping animations:
 *   1. Drop the FBX into the right Animations/ subfolder (same rig as the
 *      rest of the set: the UEFN mannequin, pelvis/spine_01/thigh_l/...).
 *   2. `npm run clips`  (regenerates js/ClipLibrary.js + prints a report)
 *   3. Read the report: direction/speed coverage grid, clips that were
 *      rejected (and why), clips the classifier could not place.
 *   4. `npm test` and playtest.
 *
 * The measurements are what make the manifest honest: a clip's (vx, vz)
 * feature is the average of its OWN body-frame velocity, sampled from the
 * file, not guessed from its name. A loop that rotates the body (box walks,
 * arcs, circle strafes) is measured as rotating and excluded from the
 * locomotion candidates — the matcher must never play a clip whose baked
 * body turn would fight the controller's own facing.
 *
 * Usage:
 *   node tools/clip-manifest.mjs            # measure the loaded set (default)
 *   node tools/clip-manifest.mjs --all      # also measure every cataloged file
 *   node tools/clip-manifest.mjs --dry-run  # measure + report, write nothing
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'js', 'ClipLibrary.js');

// ── headless browser-ish globals (same pattern as tests/harness.mjs) ─────────
globalThis.self = globalThis;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
}
if (!globalThis.ProgressEvent) {
  globalThis.ProgressEvent = class {
    constructor(type, init = {}) {
      this.type = type; this.lengthComputable = !!init.lengthComputable;
      this.loaded = init.loaded ?? 0; this.total = init.total ?? 0;
    }
  };
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === 'string' ? new URL(input, base).href : input, init);
  }
};

// ── Conventions ───────────────────────────────────────────────────────────────
// The source rig is the UEFN mannequin, Z-up, centimetres. Its REST pose
// (measured, not assumed — see measureFrame): pelvis local +X = up,
// local -Y = forward, local +Z = right; the character faces -Y in file space.
//
// Character convention everywhere downstream (target frame, Fred):
//   +Z forward, +X right, +Y up.  Local velocity = (vx = right, vz = forward).
const CM = 0.01;
const SAMPLE_FPS = 20;
const YAW_LOWPASS_TAU = 0.4;   // seconds — gait twist oscillates faster, turns don't
const ROTATE_LIMIT_DEG = 30;   // lowpassed facing range above this => "rotates"
const SPIKE_RATIO = 4.0;       // max/mean speed above this => broken keyframes
const LOOP_ENDPOINT_DEG = 8;   // start/end pose closer than this => clean loop
const DUPLICATE_DEG = 12;      // 20° variants closer than this to an existing cell are duplicates

// ── Name classification ───────────────────────────────────────────────────────
// Tiers: 0 idle · 1 walk · 2 run · 3 sprint · 4 crouch. Jump/transition clips
// are one-shots addressed by the phase machine, not the continuous query.
const DIRS = { F: [0, 1], B: [0, -1], FL: [-0.707, 0.707], FR: [0.707, 0.707],
               LL: [-1, 0], LR: [-0.707, -0.707], RL: [0.707, -0.707], RR: [1, 0] };
const TIER_OF = { Walk: 1, Run: 2, Sprint: 3, Crouch: 4 };

/**
 * Classify one file name. Returns a descriptor or null for files that are not
 * character clips (curve containers, etc.).
 */
function classify(relPath) {
  const name = path.basename(relPath, '.FBX');
  let m;

  // M_Neutral_Transition_X_to_Y[_Lfoot]
  if ((m = name.match(/^M_Neutral_Transition_(\w+)_to_(\w+)(_(L|R)foot)?$/))) {
    const [ , from, to ] = m;
    const key = `transition_${from.toLowerCase()}_to_${to.toLowerCase()}${m[3] ? '_' + m[3][0].toLowerCase() : ''}`;
    return { key, group: 'transition', role: 'transition', tier: null, keySuffix: '' };
  }
  // M_Neutral_Jump_*
  if ((m = name.match(/^M_Neutral_Jump_(Loop_Fall)$/))) {
    return { key: 'jump_fall', group: 'jump', role: 'jump-fall', tier: null };
  }
  if ((m = name.match(/^M_Neutral_Jump_(F|B|LL|RL)_Start_(Stand|Walk|Run|Sprint)_(L|R)foot$/))) {
    const [ , dir, cls, foot ] = m;
    return { key: `jump_start_${cls.toLowerCase()}_${dir.toLowerCase()}_${foot.toLowerCase()}`,
             group: 'jump', role: 'jump-start', tier: null, meta: { dir: dir.toLowerCase(), speedClass: cls.toLowerCase(), foot: foot.toLowerCase() } };
  }
  if ((m = name.match(/^M_Neutral_Jump_(B|LL|RL)_Start_(L|R)foot$/))) {
    const [ , dir, foot ] = m;
    return { key: `jump_start_any_${dir.toLowerCase()}_${foot.toLowerCase()}`,
             group: 'jump', role: 'jump-start', tier: null, meta: { dir: dir.toLowerCase(), speedClass: 'any', foot: foot.toLowerCase() } };
  }
  if ((m = name.match(/^M_Neutral_Jump_(F|B|LL|RL)_Land_(Stand|Walk|Run|Sprint)_(Light|Heavy)(_(L|R)foot)?$/))) {
    const [ , dir, cls, heavy, , foot ] = m;
    const k = `jump_land_${cls.toLowerCase()}_${heavy.toLowerCase()}_${dir.toLowerCase()}${foot ? '_' + foot.toLowerCase() : ''}`;
    return { key: k, group: 'jump', role: 'jump-land', tier: null,
             meta: { dir: dir.toLowerCase(), speedClass: cls.toLowerCase(), impact: heavy.toLowerCase(), foot: foot ? foot.toLowerCase() : null } };
  }
  if ((m = name.match(/^M_Neutral_Jump_(F|B|LL|RL)_Land_(Stumble|Roll)_(L|R)foot$/))) {
    const [ , dir, kind, foot ] = m;
    return { key: `jump_land_${kind.toLowerCase()}_${foot.toLowerCase()}`,
             group: 'jump', role: 'jump-land-special', tier: null,
             meta: { dir: dir.toLowerCase(), kind: kind.toLowerCase(), foot: foot.toLowerCase() } };
  }
  if (/^M_Neutral_Jump_/.test(name)) {
    // Off/Cliff/Across take-offs — available but not driven by the phase machine.
    return { key: slug(name), group: 'jump', role: 'jump-unused', tier: null, catalogOnly: true };
  }
  // M_Neutral_Stand_Idle_Loop / M_Neutral_Crouch_Idle_Loop / *_Idle_Break_vNN
  if ((m = name.match(/^M_Neutral_(Stand|Crouch)_Idle_Loop$/))) {
    const c = m[1].toLowerCase();
    return { key: c === 'stand' ? 'idle_loop' : 'crouch_idle_loop', group: 'idle', role: 'idle-loop', tier: c === 'stand' ? 0 : 4 };
  }
  if ((m = name.match(/^M_Neutral_(Stand|Crouch)_Idle_Break_v(\d+)$/))) {
    const c = m[1].toLowerCase();
    return { key: `${c === 'stand' ? 'idle' : 'crouch_idle'}_break_${m[2]}`, group: 'idle', role: 'idle-break', tier: c === 'stand' ? 0 : 4 };
  }
  if (/^M_Neutral_.*Turn/.test(name) || /^M_Neutral_Idle_turn/.test(name)) {
    return { key: slug(name), group: 'turn', role: 'turn-in-place', tier: null, catalogOnly: true };
  }
  // Locomotion loops: M_Neutral_<Tier>_Loop_<DIR>[_offset][_backstep]
  if ((m = name.match(/^M_Neutral_(Walk|Run|Sprint|Crouch)_Loop_(F|B|FL|FR|BL|BR|LL|LR|RL|RR)(_offset)?$/))) {
    const [ , t, d ] = m;
    if (m[3]) {
      return { key: `${t.toLowerCase()}_${d.toLowerCase()}_offset`, group: 'locomotion', role: 'loop',
               tier: TIER_OF[t], catalogOnly: true, reason: 'offset variant of the same gait' };
    }
    return { key: `${t.toLowerCase()}_${d.toLowerCase()}`, group: 'locomotion', role: 'loop', tier: TIER_OF[t], meta: { dir: d.toLowerCase() } };
  }
  // 20°-off forward loops: M_Neutral_<Tier>_Loop_F_(L|R)_20
  if ((m = name.match(/^M_Neutral_(Walk|Run|Sprint|Crouch)_Loop_F_(L|R)_20$/))) {
    const [ , t, side ] = m;
    return { key: `${t.toLowerCase()}_f_${side.toLowerCase()}20`, group: 'locomotion', role: 'loop', tier: TIER_OF[t], meta: { dir: side === 'L' ? 'f_l20' : 'f_r20' } };
  }
  // Strafe loops: M_Neutral_Run_Loop_Strafe_<DIR>
  if ((m = name.match(/^M_Neutral_(Walk|Run|Sprint|Crouch)_Loop_Strafe_(\w+)$/))) {
    const [ , t, d ] = m;
    return { key: `${t.toLowerCase()}_strafe_${d.toLowerCase()}`, group: 'locomotion', role: 'loop', tier: TIER_OF[t], meta: { dir: d.toLowerCase() } };
  }
  // Pattern loops (box / diamond / hourglass / prism / arc / circle) — the
  // classic Euphoria obstacle-weaving set. They rotate the body, so the matcher
  // cannot use them; cataloged for the future weaving mode.
  if ((m = name.match(/^M_Neutral_(Walk|Run|Sprint|Crouch)_(Box|Diamond|Hourglass|Prism|Arc|Circle)_/))) {
    return { key: slug(name), group: 'pattern', role: 'pattern', tier: TIER_OF[m[1]] ?? null, catalogOnly: true };
  }
  if (/^M_Neutral_(Walk|Run|Sprint|Crouch)_(Pivot|Spin|Shuffle|Reface)_.*/.test(name)) {
    return { key: slug(name), group: 'maneuver', role: 'maneuver', tier: null, catalogOnly: true };
  }
  // M_Neutral_Crouch_Start/Stop — not driven (the phase machine owns crouch entry).
  if (/^M_Neutral_(Walk|Run|Sprint|Crouch)_(Start|Stop)_/.test(name)) {
    return { key: slug(name), group: 'maneuver', role: 'start-stop', tier: null, catalogOnly: true };
  }
  if (name.startsWith('M_Neutral_Traversal_')) {
    return { key: slug(name), group: 'traversal', role: 'one-shot', tier: null, catalogOnly: true };
  }
  if (name.startsWith('M_Neutral_AO_')) {
    return { key: slug(name), group: 'aim', role: 'aim-offset', tier: null, catalogOnly: true };
  }
  if (name.startsWith('M_Neutral_Lean_Pose') || /_Pose_/.test(name)) {
    return { key: slug(name), group: 'pose', role: 'pose', tier: null, catalogOnly: true };
  }
  if (name.includes('CurveContainer') || name.includes('Curve')) {
    return { key: slug(name), group: 'data', role: 'data', tier: null, catalogOnly: true, reason: 'curve container, not an animation' };
  }
  return { key: slug(name), group: 'unclassified', role: 'unknown', tier: null, catalogOnly: true, unknown: true };
}

const slug = s => 'mneutral_' + s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

// ── Measurement ───────────────────────────────────────────────────────────────
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

function wrap(a) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }

/**
 * Rest-pose frame of the source rig, measured from geometry:
 * up = hips→head, left = right-thigh→left-thigh, forward = left×up.
 * Everything is world (file) space; the character's facing at any later time
 * is the pelvis world quaternion applied to the rest facing.
 */
function measureFrame(obj) {
  const pelvis = obj.getObjectByName('pelvis');
  const head   = obj.getObjectByName('head');
  const thighL = obj.getObjectByName('thigh_l');
  const thighR = obj.getObjectByName('thigh_r');
  if (!pelvis || !head || !thighL || !thighR) return null;

  const hips = _v.setFromMatrixPosition(pelvis.matrixWorld).clone();
  const hd   = _v2.setFromMatrixPosition(head.matrixWorld).clone();
  const lt   = _v3.setFromMatrixPosition(thighL.matrixWorld).clone();
  const rt   = _v.setFromMatrixPosition(thighR.matrixWorld).clone();

  const up = hd.sub(hips).normalize();
  const left = lt.sub(rt);
  left.addScaledVector(up, -left.dot(up)).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();

  const qRest = pelvis.getWorldQuaternion(new THREE.Quaternion());
  // Facing/right in the pelvis's LOCAL frame (invariant across clips);
  // facing at any later time is the pelvis world quaternion applied to them.
  const qRestInv = new THREE.Quaternion().copy(qRest).invert();
  const fwdLocal  = new THREE.Vector3().copy(fwd).applyQuaternion(qRestInv);
  const rightLocal = new THREE.Vector3().copy(right).applyQuaternion(qRestInv);

  return { pelvis, up, fwd, right, qRest, fwdLocal, rightLocal,
           restPelvisPos: hips, restPelvisQuat: qRest };
}

/**
 * Sample one clip. Returns the measured features used by the manifest and the
 * sanity flags used to reject bad candidates.
 */
function measure(obj, clip, frame) {
  const mixer  = new THREE.AnimationMixer(obj);
  const action = mixer.clipAction(clip);
  action.play();

  const dur = clip.duration;
  const n   = Math.max(2, Math.floor(dur * SAMPLE_FPS));
  const dt  = 1 / SAMPLE_FPS;

  let prev = null, prevPrev = null;
  let sumVX = 0, sumVZ = 0, count = 0, maxSpd = 0;
  let yawEMA = null, yawMin = Infinity, yawMax = -Infinity;
  const facing = new THREE.Vector3();
  const rightNow = new THREE.Vector3();

  for (let i = 0; i <= n; i++) {
    const t = Math.min(i * dt, dur);
    mixer.setTime(t);
    obj.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(frame.pelvis.matrixWorld);

    frame.pelvis.getWorldQuaternion(_q);
    // facing(t) = qWorld(t) · fwdLocal, in file space.
    facing.copy(frame.fwdLocal).applyQuaternion(_q);
    const yaw = Math.atan2(facing.x, facing.y);            // horizontal angle in file space
    if (yawEMA === null) yawEMA = yaw;
    else yawEMA += wrap(yaw - yawEMA) * (1 - Math.exp(-dt / YAW_LOWPASS_TAU));
    yawMin = Math.min(yawMin, yawEMA); yawMax = Math.max(yawMax, yawEMA);

    if (prev && prevPrev) {
      const v = new THREE.Vector3().copy(p).sub(prevPrev).multiplyScalar(SAMPLE_FPS / 2); // cm/s
      // Character frame at this instant: vz = along facing, vx = along right.
      rightNow.copy(frame.rightLocal).applyQuaternion(_q);
      const vz = v.dot(facing) * CM;
      const vx = v.dot(rightNow) * CM;
      sumVX += vx; sumVZ += vz; count++;
      maxSpd = Math.max(maxSpd, Math.hypot(vx, vz));
    }
    prevPrev = prev;
    prev = p;
  }

  // Vertical range must be measured against the UP axis, not file Y.
  let upMin = Infinity, upMax = -Infinity;
  for (let i = 0; i <= n; i++) {
    const t = Math.min(i * dt, dur);
    mixer.setTime(t);
    obj.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(frame.pelvis.matrixWorld);
    const dy = p.clone().sub(frame.restPelvisPos).dot(frame.up) * CM;
    upMin = Math.min(upMin, dy); upMax = Math.max(upMax, dy);
  }

  // Loopability: start vs end pose (pelvis + a limb).
  const thigh = obj.getObjectByName('thigh_l');
  const poseAt = t => {
    mixer.setTime(t); obj.updateMatrixWorld(true);
    const q = frame.pelvis.getWorldQuaternion(new THREE.Quaternion());
    const q2 = thigh ? thigh.getWorldQuaternion(new THREE.Quaternion()) : null;
    return { q, q2 };
  };
  const a = poseAt(0), b = poseAt(dur);
  const endpointDeg = a.q.angleTo(b.q) * 57.3 + (a.q2 ? a.q2.angleTo(b.q2) * 57.3 : 0);

  action.stop();
  mixer.uncacheClip(clip);

  const meanVX = count ? sumVX / count : 0;
  const meanVZ = count ? sumVZ / count : 0;
  const meanSpeed = Math.hypot(meanVX, meanVZ);
  const dir = meanSpeed > 0.05
    ? { vx: meanVX / meanSpeed, vz: meanVZ / meanSpeed }
    : { vx: 0, vz: 0 };
  const dirAngle = Math.atan2(dir.vx, dir.vz) * 57.3;

  return {
    duration: +dur.toFixed(2),
    speed: +meanSpeed.toFixed(2),
    maxSpeed: +maxSpd.toFixed(2),
    vx: +dir.vx.toFixed(3),
    vz: +dir.vz.toFixed(3),
    dirAngle: +dirAngle.toFixed(0),
    yawRangeDeg: +((yawMax - yawMin) * 57.3).toFixed(0),
    vertMin: +upMin.toFixed(3),
    vertMax: +upMax.toFixed(3),
    loopable: endpointDeg < LOOP_ENDPOINT_DEG,
    endpointDeg: +endpointDeg.toFixed(1),
  };
}

// ── Discover + classify ───────────────────────────────────────────────────────
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.FBX')) yield p;
  }
}

const all = [...walk(path.join(ROOT, 'Animations'))]
  .map(p => p.replace(/\\/g, '/').replace(ROOT + '/', ''))
  .sort();

const records = [];
for (const rel of all) {
  const c = classify(rel);
  records.push({ rel, ...c });
}

const wantAll  = process.argv.includes('--all');
const dryRun   = process.argv.includes('--dry-run');
const verbose  = process.argv.includes('--verbose');

// The loaded set = everything not marked catalogOnly.
const toLoad   = records.filter(r => !r.catalogOnly);
const toCatal  = records.filter(r => r.catalogOnly && !wantAll);

// ── Measure (parallel batches) ────────────────────────────────────────────────
const BATCH = 8;
let done = 0;
const t0 = Date.now();

async function measureBatch(items) {
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    await Promise.all(batch.map(async rec => {
      try {
        const obj = await new Promise((res, rej) => new FBXLoader().load(rec.rel, res, undefined, rej));
        const clip = obj.animations?.[0];
        if (!clip) throw new Error('no animation track');
        const frame = measureFrame(obj);
        if (!frame) throw new Error('rig nodes missing (not the mannequin?)');
        rec.measured = measure(obj, clip, frame);
        rec.restPelvis = {
          x: +frame.restPelvisPos.x.toFixed(2),
          y: +frame.restPelvisPos.y.toFixed(2),
          z: +frame.restPelvisPos.z.toFixed(2),
        };
      } catch (err) {
        rec.error = err.message;
      } finally {
        done++;
        if (done % 20 === 0 || done === items.length) {
          const sec = ((Date.now() - t0) / 1000).toFixed(0);
          process.stdout.write(`\r  measured ${done}/${items.length} clips (${sec}s)   `);
        }
      }
    }));
  }
}

console.log(`clip-manifest — ${all.length} FBX files`);
console.log(`  loaded set: ${toLoad.length}   cataloged (name only): ${toCatal.length}${wantAll ? '  (measuring all)' : ''}`);
await measureBatch([...toLoad, ...(wantAll ? toCatal : [])]);
console.log('');

// ── Selection rules ───────────────────────────────────────────────────────────
// Loop candidates must not rotate the body and must not have broken keyframes.
for (const r of toLoad) {
  if (r.role === 'loop' && r.measured) {
    if (r.measured.yawRangeDeg > ROTATE_LIMIT_DEG) {
      r.status = 'excluded'; r.reason = `rotates body ${r.measured.yawRangeDeg}° (controller owns facing)`;
    } else if (r.measured.maxSpeed > SPIKE_RATIO * Math.max(0.5, r.measured.speed) && r.measured.maxSpeed > 5) {
      r.status = 'excluded'; r.reason = `velocity spike ${r.measured.maxSpeed} m/s (broken keyframes)`;
    }
  }
}
// 20° variants: only keep them if they actually fill a direction gap.
for (const r of toLoad) {
  if (!r.status && r.meta?.dir && (r.meta.dir === 'f_l20' || r.meta.dir === 'f_r20') && r.measured) {
    const twins = toLoad.filter(o => o !== r && o.tier === r.tier && o.role === 'loop' && !o.status
      && o.measured && Math.abs(o.measured.dirAngle - r.measured.dirAngle) < DUPLICATE_DEG);
    if (twins.length) {
      r.status = 'excluded';
      r.reason = `direction ${r.measured.dirAngle}° duplicates ${twins[0].key} (${twins[0].measured.dirAngle}°)`;
    }
  }
}
// Missing measurements exclude.
for (const r of toLoad) {
  if (!r.status && !r.measured) { r.status = 'excluded'; r.reason = r.error ?? 'not measured'; }
}
// Vertical reference: the retargeter bakes the pelvis' height RELATIVE TO REST,
// but the A-pose rest sits higher than any gait, so "relative to rest" would
// sink a walk 20 cm under a stand. Instead the reference is the standing idle
// loop's mean height: idle bobs around 0, walk/run/sprint settle a few cm
// lower (their natural stance), crouch settles ~35 cm lower, and the jump
// crouches go negative. Every clip shares the same bind, so one reference
// works for all of them.
const refEntry = toLoad.find(r => r.key === 'idle_loop' && r.measured);
const pelvisBobReference = refEntry
  ? +((refEntry.measured.vertMin + refEntry.measured.vertMax) / 2).toFixed(3)
  : 0;
// Explicit roles are trusted.
for (const r of toLoad) if (!r.status) r.status = 'included';

const included = toLoad.filter(r => r.status === 'included');
const excluded = toLoad.filter(r => r.status === 'excluded');

// ── Coverage report ───────────────────────────────────────────────────────────
const TIER_NAMES = { 0: 'idle', 1: 'walk', 2: 'run', 3: 'sprint', 4: 'crouch' };
console.log('coverage (locomotion candidates per tier × octant):');
const OCTANTS = ['F', 'FR', 'R', 'BR', 'B', 'BL', 'L', 'FL'];
const octantOf = a => OCTANTS[Math.round((((a % 360) + 360) % 360) / 45) % 8];
for (const tier of [1, 2, 3, 4]) {
  const cells = new Map();
  for (const r of included) {
    if (r.tier !== tier || !r.measured) continue;
    const cell = octantOf(r.measured.dirAngle);
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell).push(r.key);
  }
  const line = OCTANTS.map(o => `${o}:${cells.get(o)?.length ?? 0}`).join(' ');
  console.log(`  ${TIER_NAMES[tier].padEnd(7)} ${line}`);
}
if (verbose) {
  console.log(`\nper-clip candidates (pelvisBobReference = ${pelvisBobReference} m):`);
  for (const r of included) {
    if (!r.measured) continue;
    const tag = r.tier !== null ? `[${TIER_NAMES[r.tier]}]` : `[${r.role}]`.padEnd(9);
    console.log(`  ${tag} ${r.key.padEnd(26)} angle ${String(r.measured.dirAngle).padStart(4)}°  speed ${String(r.measured.speed).padStart(5)} m/s  max ${String(r.measured.maxSpeed).padStart(5)}  yawR ${String(r.measured.yawRangeDeg).padStart(3)}°  vert [${r.measured.vertMin}, ${r.measured.vertMax}]  loop=${r.measured.loopable}  dur ${r.measured.duration}`);
  }
}
const jumpStarts = included.filter(r => r.role === 'jump-start');
const jumpLands  = included.filter(r => r.role === 'jump-land' || r.role === 'jump-land-special');
console.log(`  jump    start:${jumpStarts.length}  fall:${included.filter(r => r.role === 'jump-fall').length}  land:${jumpLands.length}`);
console.log(`  idle    ${included.filter(r => r.role === 'idle-loop' || r.role === 'idle-break' || r.role === 'crouch_idle_loop').length}`);
console.log(`  transitions ${included.filter(r => r.role === 'transition').length}`);

if (excluded.length) {
  console.log(`\nexcluded from the player set (${excluded.length}):`);
  for (const r of excluded) console.log(`  ${r.key.padEnd(28)} ${r.reason}`);
}
const unclassified = records.filter(r => r.unknown);
if (unclassified.length) {
  console.log(`\nUNCLASSIFIED — review and extend classify() (${unclassified.length}):`);
  for (const r of unclassified.slice(0, 20)) console.log(`  ${r.rel}`);
  if (unclassified.length > 20) console.log(`  …and ${unclassified.length - 20} more`);
}

// Rest-pose uniformity across the measured set (the retargeter assumes one bind).
const rests = included.map(r => r.restPelvis).filter(Boolean);
if (rests.length > 1) {
  const spread = k => +(Math.max(...rests.map(o => o[k])) - Math.min(...rests.map(o => o[k]))).toFixed(3);
  const s = { x: spread('x'), y: spread('y'), z: spread('z') };
  if (Math.max(s.x, s.y, s.z) > 0.5) {
    console.log(`\nWARNING: rest pelvis position varies across clips (${s}) — the retargeter uses one reference rig; check the assets.`);
  }
}

// ── Emit js/ClipLibrary.js ────────────────────────────────────────────────────
const entryOf = r => {
  const e = {
    key: r.key,
    path: r.rel,
    group: r.group,
    role: r.role,
    tier: r.tier,
    feats: r.measured
      ? { vx: r.measured.vx, vz: r.measured.vz, speed: r.measured.speed }
      : { vx: 0, vz: 0, speed: 0 },
    duration: r.measured ? r.measured.duration : null,
  };
  if (r.meta) e.meta = r.meta;
  if (r.measured) e.measured = {
    dirAngle: r.measured.dirAngle,
    maxSpeed: r.measured.maxSpeed,
    yawRange: r.measured.yawRangeDeg,
    vert: [r.measured.vertMin, r.measured.vertMax],
    loopable: r.measured.loopable,
  };
  return e;
};

const catalogOf = r => ({
  key: r.key, path: r.rel, group: r.group, role: r.role, tier: r.tier,
  reason: r.reason ?? 'not used by the player motion matcher',
  measured: r.measured ? { speed: r.measured.speed, dirAngle: r.measured.dirAngle, yawRange: r.measured.yawRangeDeg } : null,
});

const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
const header = `// GENERATED by tools/clip-manifest.mjs — do not edit by hand.
// Regenerate: npm run clips   (re-measures Animations/ and rewrites this file)
//
// The player motion library. \`entries\` is what AnimationDatabase loads and
// MotionMatching queries; \`catalog\` documents the rest of Animations/ so the
// coverage of the folder is always visible.
//
// Feature conventions: feats.vx / feats.vz are the clip's AVERAGE body-frame
// velocity (X = right, Z = forward) measured from the file, normalised;
// feats.speed is its magnitude in m/s. Tiers: 0 idle, 1 walk, 2 run,
// 3 sprint, 4 crouch. Jump clips are addressed by the phase machine via meta.
// measured.* are the sanity stats the generator used (direction angle,
// body-turn range, vertical drop relative to rest).

export const CLIP_LIBRARY = {
  generated: '${stamp}',
  // Pelvis height (m) that the retargeter bakes as zero — see the tool.
  pelvisBobReference: ${pelvisBobReference},
  entries: [
`;
let body = '';
for (const r of included) body += `    ${JSON.stringify(entryOf(r))},\n`;
body += '  ],\n\n  catalog: [\n';
const catalogRecs = [...excluded.map(r => ({ ...r, reason: r.reason })), ...records.filter(r => r.catalogOnly)];
for (const r of catalogRecs) body += `    ${JSON.stringify(catalogOf(r))},\n`;
body += '  ],\n};\n';

if (!dryRun) {
  fs.writeFileSync(OUT, header + body);
  console.log(`\nwrote ${path.relative(ROOT, OUT)}  (${included.length} entries, ${catalogRecs.length} cataloged)`);
} else {
  console.log('\ndry run — nothing written');
}

await new Promise(r => server.close(r));
