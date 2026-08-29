/**
 * Headless test harness.
 *
 * The project has no build step and no test framework, and pulling one in for a
 * demo whose only runtime dependency is three.js would be a poor trade. So this
 * is a ~100 line runner: `test()` registers, `run()` executes, failures print a
 * diff and set the exit code.
 *
 * What it buys is that the animation systems are exercised for real — the actual
 * modules, the actual assets, the actual mixer — rather than a reimplementation
 * of them. Two things make that possible outside a browser:
 *
 *  - three.js runs headless as long as nothing touches WebGL. Loaders, the
 *    mixer, quaternions and the retargeter are all pure JS.
 *  - `AnimationDatabase` fetches its clips over HTTP, so the harness stands up a
 *    static server on localhost and teaches `Request` to resolve relative URLs
 *    against it. That keeps the browser load path intact instead of swapping in
 *    a disk-reading stub that shares no code with production.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Browser-ish globals ───────────────────────────────────────────────────────
export function installGlobals() {
  globalThis.self = globalThis;
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
  }
  // FileLoader reports download progress with a DOM ProgressEvent.
  if (!globalThis.ProgressEvent) {
    globalThis.ProgressEvent = class ProgressEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.lengthComputable = !!init.lengthComputable;
        this.loaded = init.loaded ?? 0;
        this.total = init.total ?? 0;
      }
    };
  }
  // CharacterController and main.js bind input listeners at construction.
  if (!globalThis.window) {
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
  }
  if (!globalThis.document) {
    globalThis.document = { addEventListener() {} };
  }
}

/** Static file server for the repo, plus relative-URL resolution for loaders. */
export async function startAssetServer() {
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
  globalThis.Request = class PatchedRequest extends RealRequest {
    constructor(input, init) {
      super(typeof input === 'string' ? new URL(input, base).href : input, init);
    }
  };

  return { base, close: () => new Promise(r => server.close(r)) };
}

// ── Tiny test runner ──────────────────────────────────────────────────────────
const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function describe(suite, fn) {
  const outer = suite;
  const inner = (name, f) => test(`${outer} › ${name}`, f);
  fn(inner);
}

export async function run() {
  let passed = 0;
  const failures = [];
  const t0 = Date.now();

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
    }
  }

  const ms = Date.now() - t0;
  console.log('');
  if (failures.length === 0) {
    console.log(`\x1b[32m${passed} passed\x1b[0m in ${ms} ms`);
  } else {
    console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed in ${ms} ms`);
    process.exitCode = 1;
  }
  return failures.length;
}

// ── Assertions ────────────────────────────────────────────────────────────────
export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

export function assertClose(actual, expected, eps, msg) {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg || 'value'}: expected ${expected} ±${eps}, got ${actual}`);
  }
}

export function assertLt(a, b, msg) {
  if (!(a < b)) throw new Error(`${msg || 'value'}: expected < ${b}, got ${a}`);
}

export function assertGt(a, b, msg) {
  if (!(a > b)) throw new Error(`${msg || 'value'}: expected > ${b}, got ${a}`);
}

export function assertFiniteVec(v, msg) {
  for (const k of ['x', 'y', 'z']) {
    if (!Number.isFinite(v[k])) throw new Error(`${msg || 'vector'}.${k} is ${v[k]}`);
  }
}

export function assertFiniteQuat(q, msg) {
  for (const k of ['x', 'y', 'z', 'w']) {
    if (!Number.isFinite(q[k])) throw new Error(`${msg || 'quaternion'}.${k} is ${q[k]}`);
  }
}

// ── Synthetic rig ─────────────────────────────────────────────────────────────
/**
 * A bone hierarchy with Fred's names and proportions, for tests that need a
 * skeleton but not the 700 KB of GLB. Offsets are the measured bind-pose values.
 */
export function makeRig() {
  const B = (name, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    return b;
  };

  const root = new THREE.Group();
  root.name = 'CharacterRoot';

  const hips = B('SKEL_Pelvis_00', 0, 0.95, 0);
  const spineRoot = B('SKEL_Spine_Root_07', 0, 0.093, 0);
  const spine1 = B('SKEL_Spine1_08', 0, 0.085, 0);
  const spine2 = B('SKEL_Spine2_09', 0, 0.086, 0);
  const spine3 = B('SKEL_Spine3_010', 0, 0.113, 0);
  const neck = B('SKEL_Neck_1_019', 0, 0.248, 0);
  const head = B('SKEL_Head_020', 0, 0.113, 0);
  const headEnd = B('SKEL_Head_end_025', 0, 0.204, 0);

  const arm = (side, sgn) => {
    const clav = B(`SKEL_${side}_Clavicle_01${side === 'L' ? 1 : 5}`, sgn * 0.032, 0.218, -0.036);
    const upper = B(`SKEL_${side}_UpperArm_01${side === 'L' ? 2 : 6}`, sgn * 0.168, 0, 0);
    const fore = B(`SKEL_${side}_Forearm_01${side === 'L' ? 3 : 7}`, 0, -0.274, 0);
    const hand = B(`SKEL_${side}_Hand_01${side === 'L' ? 4 : 8}`, 0, -0.259, 0);
    const handEnd = B(`SKEL_${side}_Hand_end_02${side === 'L' ? 3 : 4}`, 0, -0.1, 0);
    hand.add(handEnd);
    fore.add(hand);
    upper.add(fore);
    clav.add(upper);
    return clav;
  };

  const leg = (side, idx) => {
    const thigh = B(`SKEL_${side}_Thigh_0${idx}`, (side === 'L' ? -1 : 1) * 0.096, 0, 0);
    const shin = B(`SKEL_${side}_Calf_0${idx + 1}`, 0, -0.407, 0);
    const foot = B(`SKEL_${side}_Foot_0${idx + 2}`, 0, -0.413, 0);
    // Fred numbers the terminators globally, not per side: L=021, R=022.
    const toe = B(side === 'L' ? 'SKEL_L_Foot_end_021' : 'SKEL_R_Foot_end_022', 0, -0.1, 0);
    foot.add(toe);
    shin.add(foot);
    thigh.add(shin);
    return thigh;
  };

  spine3.add(arm('L', -1), arm('R', 1), neck);
  neck.add(head);
  head.add(headEnd);
  spine2.add(spine3);
  spine1.add(spine2);
  spineRoot.add(spine1);
  hips.add(spineRoot, leg('L', 1), leg('R', 4));
  root.add(hips);
  root.updateMatrixWorld(true);

  const bones = [];
  root.traverse(n => { if (n.isBone) bones.push(n); });
  return { root, bones };
}

/** Assert no bone in the hierarchy has drifted into NaN. */
export function assertRigFinite(root, msg) {
  root.traverse(n => {
    if (!n.isBone) return;
    for (const k of ['x', 'y', 'z', 'w']) {
      if (!Number.isFinite(n.quaternion[k])) throw new Error(`${msg}: ${n.name}.quaternion.${k} = ${n.quaternion[k]}`);
    }
    for (const k of ['x', 'y', 'z']) {
      if (!Number.isFinite(n.position[k])) throw new Error(`${msg}: ${n.name}.position.${k} = ${n.position[k]}`);
    }
  });
}
