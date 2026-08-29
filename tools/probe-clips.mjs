/**
 * Probe script v2 — load representative FBX clips headless and report,
 * measured on the PELVIS (the node that actually moves and turns):
 *  - path length (cm), closed/open
 *  - pelvis world yaw travel (deg) — is the body turning?
 *  - local velocity (m/s) in the character's own frame (+X right, +Y up, +Z fwd)
 *  - endpoint pose similarity (loopability of the gait)
 *
 * Usage: node tools/probe-clips.mjs [substring ...]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

globalThis.self = globalThis;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL = () => {};
}
if (!globalThis.ProgressEvent) {
  globalThis.ProgressEvent = class { constructor(t, i = {}) { this.type = t; this.lengthComputable = !!i.lengthComputable; this.loaded = i.loaded ?? 0; this.total = i.total ?? 0; } };
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) { super(typeof input === 'string' ? new URL(input, base).href : input, init); }
};

const want = process.argv.slice(2);
const CM = 0.01;

const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function wrap(a) { return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; }

async function probe(relPath) {
  const obj = await new Promise((res, rej) => new FBXLoader().load(relPath, res, undefined, rej));
  const clip = obj.animations?.[0];
  if (!clip) { console.log(`\n### ${relPath}\n  (no animation)`); return; }

  const mixer = new THREE.AnimationMixer(obj);
  const action = mixer.clipAction(clip);
  action.play();

  const dur = clip.duration;
  const fps = 30;
  const n = Math.floor(dur * fps);

  const pelvis = obj.getObjectByName('pelvis');
  const head = obj.getObjectByName('head');
  if (!pelvis) { console.log(`\n### ${relPath}\n  (no pelvis node)`); return; }

  // Character up vector in file space at t=0 (hips→head), for the local frame.
  const upFile = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld)
    .sub(new THREE.Vector3().setFromMatrixPosition(pelvis.matrixWorld)).normalize();

  let pathLen = 0;
  let prev = null, prevPrev = null;
  let yaw0 = null, yawEnd = 0, yawTravel = 0, lastYaw = 0;
  const lv = [];      // local (x right, z fwd) velocities, m/s
  const lvWorld = []; // world (file frame) velocities, cm/s
  let pelvisY0 = 0, pelvisYmin = Infinity, pelvisYmax = -Infinity;

  const p = new THREE.Vector3(), p2 = new THREE.Vector3(), wv = new THREE.Vector3();
  const q = new THREE.Quaternion(), qi = new THREE.Quaternion();
  const fwdFile = new THREE.Vector3(), rightFile = new THREE.Vector3();
  const facingSum = new THREE.Vector3();

  for (let i = 0; i <= n; i++) {
    const t = Math.min(i / fps, dur);
    mixer.setTime(t);
    obj.updateMatrixWorld(true);
    p.setFromMatrixPosition(pelvis.matrixWorld);
    if (i === 0) {
      pelvisY0 = p.y;
      fwdFile.copy(upFile).cross(new THREE.Vector3(1, 0, 0)); // placeholder, refined below
    }
    pelvisYmin = Math.min(pelvisYmin, p.y);
    pelvisYmax = Math.max(pelvisYmax, p.y);
    if (prev) {
      pathLen += p.distanceTo(prev);
      if (prevPrev) {
        wv.copy(p).sub(prevPrev).multiplyScalar(fps / 2); // cm/s central difference
        lvWorld.push(wv.clone());
        // Local frame = the pelvis's own facing at this instant (UE rest: +X fwd, -Y right).
        pelvis.getWorldQuaternion(q);
        fwdFile.set(0, -1, 0).applyQuaternion(q);
        rightFile.set(0, 0, 1).applyQuaternion(q);
        lv.push({ x: wv.dot(rightFile) * CM, z: wv.dot(fwdFile) * CM });
      }
    }
    prevPrev = prev; prev = p.clone();
    pelvis.getWorldQuaternion(q);
    // Body yaw = direction the pelvis faces (local +X), projected onto the
    // horizontal plane perpendicular to the character up. Tracked as a signed
    // angle so continuous turns accumulate instead of wrapping.
    fwdFile.set(0, -1, 0).applyQuaternion(q);
    fwdFile.addScaledVector(upFile, -fwdFile.dot(upFile));
    if (fwdFile.lengthSq() > 1e-12) fwdFile.normalize();
    const y = Math.atan2(fwdFile.x, fwdFile.y); // angle in the file's horizontal plane
    if (i === 0) { yaw0 = y; lastYaw = y; }
    else { yawTravel += Math.abs(wrap(y - lastYaw)); lastYaw = y; }
    if (i === n) yawEnd = y;
    facingSum.add(fwdFile);
  }
  const meanLX = mean(lv.map(v => v.x)), meanLZ = mean(lv.map(v => v.z));
  const speeds = lv.map(v => Math.hypot(v.x, v.z));
  const meanAngle = Math.atan2(meanLX, meanLZ);
  const angStd = Math.sqrt(mean(lv.map(v => { const a = Math.atan2(v.x, v.z) - meanAngle; return a * a; })));
  const wmean = new THREE.Vector3();
  for (const v of lvWorld) wmean.add(v);
  wmean.multiplyScalar(1 / (lvWorld.length || 1));

  // Loopability: pelvis world quaternion + position endpoints (pose only, so
  // compare quaternions and the limb: thigh_l world quat)
  const thigh = obj.getObjectByName('thigh_l');
  const endDiff = (t) => {
    mixer.setTime(t); obj.updateMatrixWorld(true);
    return { q: pelvis.getWorldQuaternion(new THREE.Quaternion()), t: thigh ? thigh.getWorldQuaternion(new THREE.Quaternion()) : null };
  };
  const a = endDiff(0), b = endDiff(dur);
  const qDist = a.q.angleTo(b.q) * 57.3;
  const tDist = a.t ? a.t.angleTo(b.t) * 57.3 : -1;

  action.stop(); mixer.uncacheClip(clip);

  const deg = r => (r * 180 / Math.PI).toFixed(0);
  const upAxis = upFile.x * upFile.x > 0.9 ? 'X' : upFile.y * upFile.y > 0.9 ? 'Y' : 'Z';
  console.log(`\n### ${path.relative(ROOT, relPath)}`);
  console.log(`  ${dur.toFixed(2)} s  up=${upAxis}  path=${(pathLen * CM).toFixed(2)} m  pelvisΔY=${((pelvisYmax - pelvisYmin) * CM).toFixed(2)} m`);
  console.log(`  yaw: ${deg(wrap(yawEnd - yaw0))}° net, ${deg(yawTravel)}° travel`);
  // Compass: F=0 R=90 B=180 L=270, file-frame F=(0,-1,0) R=(-1,0,0).
  const F = new THREE.Vector3(0, -1, 0), R = new THREE.Vector3(-1, 0, 0);
  const compass = v => ((Math.atan2(v.dot(R), v.dot(F)) * 57.3 % 360) + 360) % 360;
  const dirName = a => ['F','FR','R','BR','B','BL','L','FL'][Math.round(a / 45) % 8];
  const face = facingSum.clone(); face.z = 0;
  const faceC = face.lengthSq() > 1e-9 ? compass(face) : NaN;
  const velC = wmean.lengthSq() > 1e-9 ? compass(new THREE.Vector3(wmean.x, wmean.y, 0)) : NaN;
  console.log(`  world vel (file cm/s): (${wmean.x.toFixed(0)}, ${wmean.y.toFixed(0)}, ${wmean.z.toFixed(0)})`);
  console.log(`  body facing ${Number.isFinite(faceC) ? dirName(faceC) + ' (' + faceC.toFixed(0) + '°)' : '—'}   travel dir ${Number.isFinite(velC) ? dirName(velC) + ' (' + velC.toFixed(0) + '°)' : '—'}`);
  console.log(`  local vel (m/s): mean(${meanLX.toFixed(2)}, fwd ${meanLZ.toFixed(2)})  max ${Math.max(0, ...speeds).toFixed(2)}  angle ${deg(meanAngle)}° ± ${deg(angStd)}°`);
  console.log(`  endpoint pelvis rot diff ${qDist.toFixed(1)}°  thigh ${tDist.toFixed(1)}°`);
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.FBX')) yield p;
  }
}
let files = [...walk(path.join(ROOT, 'Animations'))].map(p => path.relative(ROOT, p));
if (want.length) files = files.filter(f => want.some(w => f.toLowerCase().includes(w.toLowerCase())));

const DEFAULTS = [
  'Walk_Loop_F.FBX', 'Walk_Loop_FL.FBX', 'Walk_Loop_F_L_20.FBX', 'Walk_Box_F_Lfoot.FBX',
  'Walk_Diamond_F_Lfoot.FBX', 'Walk_Arc_F_Small_L.FBX', 'Walk_Arc_F_Tight_L.FBX',
  'Walk_Circle_Strafe_L.FBX', 'Walk_Spin_LL_to_F_Lfoot.FBX', 'Walk_Shuffle_LR_to_LL_Lfoot.FBX',
  'Walk_Pivot_F_B_Lfoot.FBX', 'Run_Loop_F.FBX', 'Run_Loop_Strafe_FL.FBX',
  'Sprint_Loop_F.FBX', 'Sprint_Loop_FR.FBX', 'Sprint_Loop_F_L_20.FBX',
  'Crouch_Loop_F.FBX', 'Crouch_Loop_FL.FBX', 'Crouch_Loop_F_L_20.FBX',
  'Stand_Idle_Loop.FBX', 'Stand_Turn_090_L.FBX', 'Idle_turn_left.FBX', 'Walk_Turn_L_090_Lfoot.FBX',
  'Jump_F_Start_Walk_Lfoot.FBX', 'Jump_F_Start_Run_Lfoot.FBX', 'Jump_Loop_Fall.FBX',
  'Jump_F_Land_Walk_Heavy_Lfoot.FBX', 'Jump_F_Land_Sprint_Light_Lfoot.FBX',
  'Transition_Walk_to_Run_Lfoot.FBX', 'Crouch_Transition_Stand_to_Crouch.FBX',
  'Jump_F_Land_Roll_Lfoot.FBX', 'Walk_Loop_RR_offset.FBX',
];
const toProbe = want.length ? files : files.filter(f => DEFAULTS.some(d => f.endsWith(d)));
console.log(`probing ${toProbe.length} clips`);
for (const f of toProbe) {
  try { await probe(f); }
  catch (err) { console.log(`\n### ${f}\n  ERROR: ${err.message}`); }
}
await new Promise(r => server.close(r));
