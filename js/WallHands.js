import * as THREE from 'three';
import { solveArm, handWorldQuatFromAxes, measureHandFrame } from './ArmIK.js';
import { SmoothedValue, clamp } from './AnimationSmoothing.js';

/**
 * Hand placement against collidable geometry.
 *
 * A character standing nose-to-wall with his arms swinging through the plaster
 * is the fastest way to break the illusion that he occupies the same space as
 * the obstacle. So when a wall is in front of him, within reach and roughly
 * squared to his facing, each hand finds the surface and settles on it — palm
 * to the wall, fingers up, elbows dropped back.
 *
 * Everything about it is continuous. Each hand probes its own ray, so a pillar
 * only in front of the left shoulder gets one hand, not two. Each carries its
 * own smoothed weight with hysteresis on the range (engage at the measured arm
 * reach, release at 1.25× that), so standing exactly at the boundary does not
 * strobe. And
 * the IK result is slerped against the animated pose rather than written over
 * it, so the reach grows out of the idle instead of snapping into place.
 */

// Reach is measured off the rig at construction, not guessed: an arm that
// cannot reach the surface should not pretend to touch it, and a fully
// straightened arm straining at nothing reads worse than no reach at all.
const REACH_SCALE  = 0.95;   // of the measured arm length
const CLAV_SHARE   = 0.35;   // how much shoulder protraction adds
const RELEASE_SLACK= 1.25;   // hysteresis: let go further out than we grab
const SURFACE_GAP  = 0.045;  // hold the wrist this far off the wall
const HAND_SPREAD  = 0.16;   // half the distance between the hands
const FACING_MIN   = 0.55;   // dot(facing, -normal) — how square-on the wall must be
const MAX_SPEED    = 1.6;    // m/s; a sprint into a wall is not a lean
const EDGE_MARGIN  = 0.10;   // keep hands this far inside the box footprint

const UP = new THREE.Vector3(0, 1, 0);
const _handQ = new THREE.Quaternion();
const _tmpV = new THREE.Vector3();

export class WallHands {
  /**
   * @param {object} deps
   * @param {import('./Environment.js').Environment} deps.environment
   * @param {Object<string, THREE.Bone>} deps.bones   resolved rig
   * @param {THREE.Object3D} deps.scene               for measuring the hand geometry
   */
  constructor({ environment, bones, scene }) {
    this.env = environment;
    this.bones = bones;
    this.enabled = true;

    this.sides = {
      l: this._makeSide('l'),
      r: this._makeSide('r'),
    };

    // How far each hand can actually get from its shoulder.
    this.reach = {
      l: this._measureReach('l'),
      r: this._measureReach('r'),
    };

    // Measured once, from the geometry the hand bone carries: which local axis
    // runs down the fingers and which is the palm normal.
    this.frames = {
      l: bones.lHand ? measureHandFrame(scene, bones.lHand) : null,
      r: bones.rHand ? measureHandFrame(scene, bones.rHand) : null,
    };

    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._pole = new THREE.Vector3();
    this._fingers = new THREE.Vector3();
    this._palm = new THREE.Vector3();
    this._shoulder = new THREE.Vector3();
    this._plane = new THREE.Vector3();

    // Midpoint of the hands that are actually on something — where the eyes go.
    this.focusPoint = new THREE.Vector3();
    this.hasFocus = false;
    this._focusCount = 0;
  }

  /** clavicle→upper arm→forearm→hand, measured from the bind pose. */
  _measureReach(side) {
    const b = this.bones;
    const clav  = side === 'l' ? b.lClavicle : b.rClavicle;
    const upper = side === 'l' ? b.lUpperArm : b.rUpperArm;
    const fore  = side === 'l' ? b.lForearm  : b.rForearm;
    const hand  = side === 'l' ? b.lHand     : b.rHand;
    if (!upper || !fore || !hand) return 0.55;

    hand.updateWorldMatrix(true, false);
    const at = o => _tmpV.setFromMatrixPosition(o.matrixWorld).clone();
    const span = at(upper).distanceTo(at(fore)) + at(fore).distanceTo(at(hand));
    const clavLen = clav ? at(clav).distanceTo(at(upper)) : 0;
    return (span + clavLen * CLAV_SHARE) * REACH_SCALE;
  }

  _makeSide(side) {
    return {
      side,
      weight: new SmoothedValue(0, 3.5),
      contact: false,
      distance: Infinity,
      boxName: null,
    };
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   * @param {THREE.Object3D} ctx.root
   * @param {THREE.Vector3} ctx.forward   unit, character facing
   * @param {THREE.Vector3} ctx.right     unit
   * @param {number} ctx.speed
   * @param {boolean} ctx.onGround
   * @param {number} ctx.groundY
   */
  update(dt, ctx) {
    const { forward, right, speed, onGround, groundY } = ctx;
    const active = this.enabled && onGround && speed < MAX_SPEED;
    this._focusCount = 0;
    this.hasFocus = false;

    for (const key of ['l', 'r']) {
      const st = this.sides[key];
      const arm = this._arm(key);
      if (!arm) continue;

      st.boxName = null;

      const reach = this.reach[key] ?? 0.55;
      const hit = active ? this._probe(arm, forward, st, reach) : null;
      const inRange = !!hit && hit.distance < (st.contact ? reach * RELEASE_SLACK : reach);
      st.contact = inRange;

      // Fast in, a little slower out: committing to a surface reads as
      // deliberate, letting go reads as a decision rather than a dropout.
      st.weight.set(inRange ? 1 : 0, inRange ? 3.5 : 2.2);
      const w = st.weight.update(dt);
      if (w < 0.01) continue;

      if (!hit) continue;
      const wrist = this._solve(arm, st, hit, forward, right, groundY, w);
      if (wrist && w > 0.4) {
        this.focusPoint.add(wrist);
        this._focusCount++;
      }
    }

    if (this._focusCount > 0) {
      this.focusPoint.multiplyScalar(1 / this._focusCount).addScaledVector(forward, -0.35);
      this.hasFocus = true;
    }
  }

  _arm(key) {
    const b = this.bones;
    const clav = key === 'l' ? b.lClavicle : b.rClavicle;
    const upper = key === 'l' ? b.lUpperArm : b.rUpperArm;
    const fore = key === 'l' ? b.lForearm : b.rForearm;
    const hand = key === 'l' ? b.lHand : b.rHand;
    if (!upper || !fore) return null;
    return { clavicle: clav, upperArm: upper, forearm: fore, hand };
  }

  /** Ray from the shoulder along the facing; the wall must be square-on. */
  _probe(arm, forward, st, reach) {
    arm.upperArm.updateWorldMatrix(true, false);
    this._origin.setFromMatrixPosition(arm.upperArm.matrixWorld).addScaledVector(forward, 0.05);

    const hit = this.env.raycast(this._origin, forward, reach * RELEASE_SLACK);
    if (!hit) { st.distance = Infinity; return null; }

    st.distance = hit.distance;
    // Only a wall he is actually facing — brushing past something to the side
    // should not reach out and grab it.
    if (forward.dot(hit.normal) > -FACING_MIN) return null;

    st.boxName = hit.box.name;
    return hit;
  }

  _solve(arm, st, hit, forward, right, groundY, weight) {
    const n = hit.normal;
    const box = hit.box;

    // Horizontal direction along the wall surface.
    this._tangent.crossVectors(UP, n);
    if (this._tangent.lengthSq() < 1e-8) this._tangent.set(1, 0, 0);
    else this._tangent.normalize();

    arm.upperArm.updateWorldMatrix(true, false);
    this._shoulder.setFromMatrixPosition(arm.upperArm.matrixWorld);

    // Project the shoulder onto the wall plane, so the hand lands opposite the
    // shoulder rather than wherever an angled ray happened to land.
    const planeOffset = this._plane.subVectors(this._shoulder, hit.point).dot(n);
    this._goal.copy(this._shoulder).addScaledVector(n, -planeOffset);

    // Chest-ish height, but never above a low wall's top edge and never near
    // the floor.
    const chestY = this._shoulder.y - 0.02;
    const handY = clamp(chestY, groundY + 0.45, Math.max(groundY + 0.5, box.top - 0.12));
    this._goal.y = handY;

    // Spread the hands apart along the wall, and keep them inside its footprint
    // so a hand never ends up floating off the edge of a narrow pillar.
    const lateral = (st.side === 'l' ? -1 : 1) * HAND_SPREAD;
    this._goal.addScaledVector(this._tangent, lateral);
    this._goal.x = clamp(this._goal.x, box.min.x + EDGE_MARGIN, box.max.x - EDGE_MARGIN);
    this._goal.z = clamp(this._goal.z, box.min.z + EDGE_MARGIN, box.max.z - EDGE_MARGIN);

    // Stand the wrist off the surface: the hand has thickness, and a wrist
    // exactly on the plane sinks the mesh into the wall.
    this._goal.addScaledVector(n, SURFACE_GAP);

    // Elbow back, down and slightly out — the natural brace, and it keeps the
    // elbow from driving through the wall behind the hand.
    this._pole.copy(this._shoulder)
      .addScaledVector(forward, -0.28)
      .addScaledVector(UP, -0.34)
      .addScaledVector(right, (st.side === 'l' ? -1 : 1) * 0.18);

    let handWorld;
    if (arm.hand && this.frames[st.side]) {
      // Fingers up the wall, palm into it.
      this._fingers.copy(UP).addScaledVector(this._tangent, (st.side === 'l' ? 1 : -1) * 0.18).normalize();
      this._palm.copy(n).multiplyScalar(-1);
      arm.hand.getWorldQuaternion(_handQ);
      handWorld = handWorldQuatFromAxes(_handQ, this.frames[st.side], this._fingers, this._palm);
    }

    return solveArm(arm, this._goal, this._pole, weight, { clavicleLead: 0.25, handWorld });
  }

  /** For the HUD: how engaged each hand is. */
  status() {
    const f = v => (v * 100).toFixed(0).padStart(3);
    const l = this.sides.l, r = this.sides.r;
    if (l.weight.value < 0.01 && r.weight.value < 0.01) return '—';
    return `${l.boxName ?? '-'} L${f(l.weight.value)}% R${f(r.weight.value)}%`;
  }

  get engaged() {
    return Math.max(this.sides.l.weight.value, this.sides.r.weight.value);
  }
}
