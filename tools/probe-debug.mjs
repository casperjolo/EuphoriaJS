import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
const ROOT = '/home/user/EuphoriaJS';
globalThis.self = globalThis;
globalThis.URL.createObjectURL ??= () => 'b';
globalThis.URL.revokeObjectURL ??= () => {};
globalThis.ProgressEvent ??= class { constructor(t, i={}) { this.type=t; this.loaded=i.loaded??0; this.total=i.total??0; } };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const RR = globalThis.Request;
globalThis.Request = class extends RR { constructor(i, init) { super(typeof i === 'string' ? new URL(i, base).href : i, init); } };

async function dbg(rel) {
  const obj = await new Promise((res, rej) => new FBXLoader().load(rel, res, undefined, rej));
  const clip = obj.animations[0];
  const mixer = new THREE.AnimationMixer(obj);
  mixer.clipAction(clip).play();
  obj.updateMatrixWorld(true);
  const get = n => obj.getObjectByName(n);
  const wp = n => new THREE.Vector3().setFromMatrixPosition(get(n).matrixWorld);
  const pelvis = get('pelvis');
  const hips = wp('pelvis'), hd = wp('head'), lt = wp('thigh_l'), rt = wp('thigh_r');
  const up = hd.clone().sub(hips).normalize();
  const left = lt.clone().sub(rt);
  left.addScaledVector(up, -left.dot(up)).normalize();
  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
  const qRest = pelvis.getWorldQuaternion(new THREE.Quaternion());
  const fwdLocal = qRest.clone().invert().multiply(fwd);
  console.log(`\n## ${rel}`);
  console.log('  up   ', up.toArray().map(v=>v.toFixed(3)).join(', '));
  console.log('  left ', left.toArray().map(v=>v.toFixed(3)).join(', '));
  console.log('  fwd  ', fwd.toArray().map(v=>v.toFixed(3)).join(', '));
  console.log('  qRest', qRest.toArray().map(v=>v.toFixed(3)).join(', '));
  console.log('  parent:', pelvis.parent?.name, 'parentQ:', pelvis.parent ? pelvis.parent.getWorldQuaternion(new THREE.Quaternion()).toArray().map(v=>v.toFixed(3)).join(', ') : 'none');
  const n = Math.floor(clip.duration * 20);
  let sxf = 0, szf = 0, count = 0, prev = null, prevPrev = null;
  const p = new THREE.Vector3(), v = new THREE.Vector3(), facing = new THREE.Vector3(), rnow = new THREE.Vector3();
  const q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), q3 = new THREE.Quaternion();
  for (let i = 0; i <= n; i++) {
    mixer.setTime(Math.min(i / 20, clip.duration));
    obj.updateMatrixWorld(true);
    p.setFromMatrixPosition(pelvis.matrixWorld);
    pelvis.getWorldQuaternion(q);
    q2.copy(fwdLocal).premultiply(q);
    facing.copy(q2);
    if (prev && prevPrev) {
      v.copy(p).sub(prevPrev).multiplyScalar(10); // cm/s
      q3.copy(fwdLocal).premultiply(q);
      sxf += v.dot(q3) * 0.01;   // wait: facing = q2 = q·fwdLocal
      szf += v.dot(facing) * 0.01;
      count++;
    }
    prevPrev = prev; prev = p.clone();
  }
  console.log(`  mean local: vx(right)${(sxf/count).toFixed(2)}  vz(fwd)${(szf/count).toFixed(2)}  angle ${Math.atan2(sxf/count, szf/count).toFixed(1)} rad`);
}
await dbg('Animations/Walk/M_Neutral_Walk_Loop_F.FBX');
await dbg('Animations/Walk/M_Neutral_Walk_Loop_B.FBX');
await dbg('Animations/Walk/M_Neutral_Walk_Loop_LL.FBX');
await new Promise(r => server.close(r));
