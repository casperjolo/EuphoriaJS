import * as THREE from 'three';

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();

/**
 * Analytical two-bone IK.
 * Returns the solved knee (mid-joint) world position.
 *
 * @param {THREE.Vector3} root      - World position of upper bone base (thigh)
 * @param {THREE.Vector3} target    - Desired world position of end effector (ankle)
 * @param {number}        upperLen  - Length of upper bone (thigh → knee)
 * @param {number}        lowerLen  - Length of lower bone (knee → ankle)
 * @param {THREE.Vector3} poleHint  - World-space hint for knee direction
 * @param {THREE.Vector3} outMid    - OUTPUT: solved knee world position
 */
export function solveTwoBoneIK(root, target, upperLen, lowerLen, poleHint, outMid) {
  const rootToTarget = _v0.subVectors(target, root);
  const dist = Math.min(rootToTarget.length(), upperLen + lowerLen - 0.0001);

  if (dist < 0.0001) {
    outMid.copy(root);
    return;
  }

  const dir = _v1.copy(rootToTarget).normalize();

  // Law of cosines: angle at root between (root→target) and (root→knee)
  const cosA = THREE.MathUtils.clamp(
    (upperLen * upperLen + dist * dist - lowerLen * lowerLen) / (2 * upperLen * dist),
    -1, 1
  );
  const angleA = Math.acos(cosA);

  // Build bend axis from pole hint
  const toPole = _v2.subVectors(poleHint, root);
  // Remove component along dir
  toPole.addScaledVector(dir, -toPole.dot(dir));

  let bendAxis;
  if (toPole.lengthSq() > 0.0001) {
    bendAxis = new THREE.Vector3().crossVectors(dir, toPole).normalize();
  } else {
    // Fallback: pick any perpendicular
    bendAxis = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (bendAxis.lengthSq() < 0.0001) bendAxis.crossVectors(dir, new THREE.Vector3(1, 0, 0));
    bendAxis.normalize();
  }

  // Rotate dir by -angleA around bendAxis → gives upper bone direction
  const upperDir = dir.clone().applyAxisAngle(bendAxis, -angleA);
  outMid.copy(root).addScaledVector(upperDir, upperLen);
}

/**
 * Rotate a bone so that it points from its world position toward worldTarget.
 * The bone's "forward" axis is determined by the direction to its first Bone child.
 */
export function rotateBoneToward(bone, worldTarget) {
  // Find first bone child
  const child = bone.children.find(c => c.isBone);
  if (!child) return;

  bone.updateWorldMatrix(true, false);

  const boneWorld = _v0.setFromMatrixPosition(bone.matrixWorld);
  child.updateWorldMatrix(true, false);
  const childWorld = _v1.setFromMatrixPosition(child.matrixWorld);

  const currentDir = _v2.subVectors(childWorld, boneWorld);
  if (currentDir.lengthSq() < 0.00001) return;
  currentDir.normalize();

  const desiredDir = new THREE.Vector3().subVectors(worldTarget, boneWorld);
  if (desiredDir.lengthSq() < 0.00001) return;
  desiredDir.normalize();

  // Quaternion delta in world space
  const delta = _q0.setFromUnitVectors(currentDir, desiredDir);

  // Apply delta pre-multiplied into bone's world quaternion, then back to local
  const worldQ = bone.getWorldQuaternion(_q1);
  worldQ.premultiply(delta);

  if (bone.parent) {
    const parentWorldQ = bone.parent.getWorldQuaternion(_q0);
    bone.quaternion.copy(parentWorldQ.invert().multiply(worldQ));
  } else {
    bone.quaternion.copy(worldQ);
  }
  bone.updateWorldMatrix(false, true);
}

/**
 * Full two-bone IK pass: applies rotations to upperBone + lowerBone.
 *
 * @param {THREE.Bone} upperBone  - Thigh bone
 * @param {THREE.Bone} lowerBone  - Shin bone
 * @param {THREE.Vector3} target  - World position of desired foot
 * @param {THREE.Vector3} pole    - World-space pole (knee hint)
 */
export function applyTwoBoneIK(upperBone, lowerBone, target, pole) {
  upperBone.updateWorldMatrix(true, true);

  const rootPos = new THREE.Vector3().setFromMatrixPosition(upperBone.matrixWorld);

  // Measure lengths from current pose
  const midPos  = new THREE.Vector3().setFromMatrixPosition(lowerBone.matrixWorld);
  const endBone = lowerBone.children.find(c => c.isBone);
  const endPos  = endBone
    ? new THREE.Vector3().setFromMatrixPosition(endBone.matrixWorld)
    : midPos.clone().addScaledVector(new THREE.Vector3(0, -1, 0), 0.4);

  const upperLen = rootPos.distanceTo(midPos);
  const lowerLen = midPos.distanceTo(endPos);

  const solvedMid = new THREE.Vector3();
  solveTwoBoneIK(rootPos, target, upperLen, lowerLen, pole, solvedMid);

  rotateBoneToward(upperBone, solvedMid);
  upperBone.updateWorldMatrix(false, true);
  rotateBoneToward(lowerBone, target);
  lowerBone.updateWorldMatrix(false, true);
}
