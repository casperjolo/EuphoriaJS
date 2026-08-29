import * as THREE from 'three';
import { applyTwoBoneIK } from './TwoBoneIK.js';
import { refreshBoneMatrix } from './RigBones.js';
import { clamp01 } from './AnimationSmoothing.js';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/**
 * Two-bone arm IK that *blends* against the animated pose.
 *
 * Foot planting can afford to overwrite the leg outright because a planted foot
 * has one correct answer. A hand reaching for a wall does not — snapping the arm
 * from a swinging idle into a straight reach is exactly the pop this project
 * exists to avoid. So the solve is run to completion and then every joint it
 * touched is slerped back toward its animated rotation by `1 - weight`, which
 * makes the reach grow out of whatever the arms were already doing.
 *
 * The clavicle leads. Reaching for something far starts at the shoulder, not the
 * elbow, so a fraction of the root→goal rotation is applied there *before* the
 * IK runs, and the elbow then solves from the shoulder's new position.
 */

/**
 * @param {{clavicle?:THREE.Bone, upperArm:THREE.Bone, forearm:THREE.Bone, hand?:THREE.Bone}} arm
 * @param {THREE.Vector3} goal   world-space wrist target
 * @param {THREE.Vector3} pole   world-space elbow hint
 * @param {number} weight        0 = pure animation, 1 = pure IK
 * @param {object} [opts]
 * @param {number} [opts.clavicleLead=0.3]  fraction of the reach taken by the shoulder
 * @param {THREE.Quaternion} [opts.handWorld]  desired hand orientation, world space
 * @returns {THREE.Vector3|null} achieved wrist position, world space
 */
export function solveArm(arm, goal, pole, weight, opts = {}) {
  const w = clamp01(weight);
  if (w <= 0.001) return null;

  const chain = [];
  if (arm.clavicle) chain.push(arm.clavicle);
  chain.push(arm.upperArm, arm.forearm);
  if (arm.hand) chain.push(arm.hand);

  arm.upperArm.updateWorldMatrix(true, true);

  // ── Shoulder lead ─────────────────────────────────────────────────────────
  const lead = opts.clavicleLead ?? 0.3;
  if (arm.clavicle && lead > 0) {
    const shoulder = _v0.setFromMatrixPosition(arm.upperArm.matrixWorld);
    const current  = _v1.setFromMatrixPosition(arm.forearm.matrixWorld).sub(shoulder).normalize();
    const wanted   = _v2.copy(goal).sub(shoulder);
    if (wanted.lengthSq() > 1e-6) {
      wanted.normalize();
      _q0.setFromUnitVectors(current, wanted);
      _q1.identity().slerp(_q0, lead * w);
      // World-space delta → bone local.
      arm.clavicle.getWorldQuaternion(_q2);
      _q2.premultiply(_q1);
      if (arm.clavicle.parent) {
        arm.clavicle.parent.getWorldQuaternion(_q1).invert();
        _q2.premultiply(_q1);
      }
      arm.clavicle.quaternion.copy(_q2);
      refreshBoneMatrix(arm.clavicle);
      arm.upperArm.updateWorldMatrix(true, true);
    }
  }

  // ── Remember the animated pose, solve, then blend back toward it ──────────
  const animated = chain.map(b => ({ bone: b, q: b.quaternion.clone() }));

  applyTwoBoneIK(arm.upperArm, arm.forearm, goal, pole);

  if (arm.hand && opts.handWorld) {
    arm.hand.parent.getWorldQuaternion(_q0).invert();
    arm.hand.quaternion.copy(_q0.multiply(opts.handWorld));
  }

  for (const { bone, q } of animated) {
    const solved = bone.quaternion.clone();
    bone.quaternion.copy(q).slerp(solved, w);
    refreshBoneMatrix(bone);
  }

  return arm.hand
    ? new THREE.Vector3().setFromMatrixPosition(arm.hand.matrixWorld)
    : null;
}

/**
 * Build the world orientation that puts a hand's fingers along `fingersDir`
 * with its palm facing `palmDir`.
 *
 * Expressed as a rotation of the hand's *current* orientation rather than an
 * absolute target, so it works whatever pose the arm is in and needs no
 * knowledge of the rig's bind axes beyond the two local directions measured by
 * `measureHandFrame`.
 *
 * @param {THREE.Quaternion} handWorldQ  hand's current world rotation
 * @param {{fingersLocal:THREE.Vector3, palmLocal:THREE.Vector3}} frame
 * @param {THREE.Vector3} fingersDir  world
 * @param {THREE.Vector3} palmDir     world
 * @returns {THREE.Quaternion}
 */
export function handWorldQuatFromAxes(handWorldQ, frame, fingersDir, palmDir) {
  // 1. Turn the fingers onto their target.
  const fingersNow = _v0.copy(frame.fingersLocal).applyQuaternion(handWorldQ).normalize();
  _q0.setFromUnitVectors(fingersNow, _v1.copy(fingersDir).normalize());
  _q1.copy(_q0).multiply(handWorldQ);

  // 2. Roll about the fingers until the palm faces its target. The roll is
  //    measured on the plane perpendicular to the fingers, which is the only
  //    part of the palm direction a roll can actually change.
  const palmNow = _v2.copy(frame.palmLocal).applyQuaternion(_q1).normalize();
  const axis = _v1.copy(fingersDir).normalize();

  const pn = palmNow.clone().addScaledVector(axis, -palmNow.dot(axis)).normalize();
  const pd = palmDir.clone().addScaledVector(axis, -palmDir.dot(axis)).normalize();

  if (pn.lengthSq() > 1e-6 && pd.lengthSq() > 1e-6) {
    const sign = Math.sign(pn.clone().cross(pd).dot(axis)) || 1;
    const angle = Math.acos(THREE.MathUtils.clamp(pn.dot(pd), -1, 1)) * sign;
    _q2.setFromAxisAngle(axis, angle);
    _q1.premultiply(_q2);
  }

  return new THREE.Quaternion().copy(_q1);
}

/**
 * Measure a hand's local finger and palm directions from the geometry it
 * carries. Fred's hands are boxes, so "palm normal" is the thinnest axis —
 * which is measurable, unlike guessing at a naming convention.
 *
 * Falls back to (0,1,0)/(1,0,0), which is what a Y-down-the-arm bone looks like
 * on every rig this has been tried against.
 */
export function measureHandFrame(scene, handBone) {
  const fingersLocal = new THREE.Vector3(0, 1, 0);
  const palmLocal = new THREE.Vector3(1, 0, 0);

  const end = handBone.children.find(c => c.isBone);
  if (end && end.position.lengthSq() > 1e-8) {
    fingersLocal.copy(end.position).normalize();
  }

  // Fred parents each physics-body mesh to the bone it belongs to, so the
  // hand's own geometry is in its subtree. Fall back to the nearest mesh in the
  // scene for rigs that keep their meshes elsewhere.
  handBone.updateWorldMatrix(true, false);
  let best = null;
  handBone.traverse(n => { if (!best && n.isMesh && n.geometry) best = n; });

  if (!best) {
    const centre = new THREE.Vector3().setFromMatrixPosition(handBone.matrixWorld);
    let bestDist = 0.25;
    scene.traverse(n => {
      if (!n.isMesh || !n.geometry) return;
      n.updateWorldMatrix(true, false);
      const d = new THREE.Vector3().setFromMatrixPosition(n.matrixWorld).distanceTo(centre);
      if (d < bestDist) { bestDist = d; best = n; }
    });
  }
  if (!best) return { fingersLocal, palmLocal };

  best.geometry.computeBoundingBox();
  const bb = best.geometry.boundingBox;
  const toLocal = new THREE.Matrix4().copy(handBone.matrixWorld).invert().multiply(best.matrixWorld);

  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const v = new THREE.Vector3(
      i & 1 ? bb.max.x : bb.min.x,
      i & 2 ? bb.max.y : bb.min.y,
      i & 4 ? bb.max.z : bb.min.z
    ).applyMatrix4(toLocal);
    for (let k = 0; k < 3; k++) {
      if (v.getComponent(k) < min[k]) min[k] = v.getComponent(k);
      if (v.getComponent(k) > max[k]) max[k] = v.getComponent(k);
    }
  }

  const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  // The fingers axis is the *longest*; the palm normal is the thinnest of the
  // two remaining.
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  let fingerAxis = 0;
  for (let k = 1; k < 3; k++) {
    if (Math.abs(axes[k].dot(fingersLocal)) > Math.abs(axes[fingerAxis].dot(fingersLocal))) fingerAxis = k;
  }
  let palmAxis = -1, palmExtent = Infinity;
  for (let k = 0; k < 3; k++) {
    if (k === fingerAxis) continue;
    if (extent[k] < palmExtent) { palmExtent = extent[k]; palmAxis = k; }
  }
  if (palmAxis >= 0) palmLocal.copy(axes[palmAxis]);

  return { fingersLocal, palmLocal };
}
