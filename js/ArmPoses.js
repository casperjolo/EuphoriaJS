import * as THREE from 'three';
import { solveArm, handWorldQuatFromAxes, measureHandFrame } from './ArmIK.js';
import { clamp01 } from './AnimationSmoothing.js';

/**
 * Posed arm behaviours, solved rather than authored.
 *
 * The animation library has no arms-crossed clip — the only social take is a
 * hand gesture for talking — so the pose is built here from hand targets and the
 * same two-bone IK the wall hands use. Solving it has a second benefit: the arms
 * cross at whatever height and width this particular character's chest happens to
 * be, instead of at the height they were on whoever performed the mocap.
 *
 * Fred has no finger bones (27 bones, terminating at `SKEL_*_Hand_end_*`), so the
 * hands are posed as a unit: fingers across the body, palms down. There is no
 * finer detail to get wrong.
 */

const UP = new THREE.Vector3(0, 1, 0);
const _shoulder = new THREE.Vector3();
const _handQ = new THREE.Quaternion();

export class ArmPoses {
  /**
   * @param {object} deps
   * @param {Object<string, THREE.Bone>} deps.bones
   * @param {THREE.Object3D} deps.scene
   */
  constructor({ bones, scene }) {
    this.bones = bones;

    this.frames = {
      l: bones.lHand ? measureHandFrame(scene, bones.lHand) : null,
      r: bones.rHand ? measureHandFrame(scene, bones.rHand) : null,
    };

    this._chest = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._fingers = new THREE.Vector3();
    this._palm = new THREE.Vector3();
  }

  /**
   * Fold the arms. `weight` 0 leaves the animated pose untouched.
   *
   * @param {number} weight
   * @param {object} ctx  { forward, right }
   */
  updateCrossed(weight, ctx) {
    const w = clamp01(weight);
    if (w < 0.01) return;
    const { forward, right } = ctx;

    const b = this.bones;
    if (!b.lUpperArm || !b.rUpperArm || !b.spine3) return;

    b.spine3.updateWorldMatrix(true, true);
    this._chest.setFromMatrixPosition(b.spine3.matrixWorld);
    this._forward.copy(forward);
    this._right.copy(right);

    // Left hand rides on top, crossing to his right; right hand tucks under the
    // left arm. The vertical offset is what makes it read as folded rather than
    // as two hands meeting in the middle.
    this._side({
      key: 'l',
      goalOffset: { fwd: 0.20, lat: 0.14, up: 0.05 },
      elbow:      { lat: -0.22, up: -0.42, fwd: -0.06 },
      fingers:    { lat: 0.9, fwd: 0.22, up: 0.10 },
      w,
    });
    this._side({
      key: 'r',
      goalOffset: { fwd: 0.16, lat: -0.11, up: -0.07 },
      elbow:      { lat: 0.22, up: -0.40, fwd: -0.10 },
      fingers:    { lat: -0.9, fwd: 0.22, up: 0.02 },
      w,
    });
  }

  _side(spec) {
    const b = this.bones;
    const L = spec.key === 'l';
    const arm = {
      clavicle: L ? b.lClavicle : b.rClavicle,
      upperArm: L ? b.lUpperArm : b.rUpperArm,
      forearm:  L ? b.lForearm  : b.rForearm,
      hand:     L ? b.lHand     : b.rHand,
    };
    if (!arm.upperArm || !arm.forearm) return;

    const g = spec.goalOffset;
    this._goal.copy(this._chest)
      .addScaledVector(this._forward, g.fwd)
      .addScaledVector(this._right, g.lat)
      .addScaledVector(UP, g.up);

    arm.upperArm.updateWorldMatrix(true, false);
    const shoulder = _shoulder.setFromMatrixPosition(arm.upperArm.matrixWorld);

    const e = spec.elbow;
    this._pole.copy(shoulder)
      .addScaledVector(this._right, e.lat)
      .addScaledVector(UP, e.up)
      .addScaledVector(this._forward, e.fwd);

    let handWorld;
    if (arm.hand && this.frames[spec.key]) {
      const f = spec.fingers;
      this._fingers.copy(this._right).multiplyScalar(f.lat)
        .addScaledVector(this._forward, f.fwd)
        .addScaledVector(UP, f.up)
        .normalize();
      // Palm down for the hand on top, palm in for the one tucked underneath.
      this._palm.copy(UP).multiplyScalar(-1).addScaledVector(this._forward, spec.key === 'l' ? 0.25 : 0.45).normalize();
      arm.hand.getWorldQuaternion(_handQ);
      handWorld = handWorldQuatFromAxes(_handQ, this.frames[spec.key], this._fingers, this._palm);
    }

    solveArm(arm, this._goal, this._pole, spec.w, { clavicleLead: 0.35, handWorld });
  }
}
