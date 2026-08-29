import * as THREE from 'three';
import {
  clamp, clamp01, damp, SeededRandom, softClamp, SmoothedValue, wrapAngle,
} from './AnimationSmoothing.js';

/**
 * Procedural look-at: gaze target selection, then distribution across the
 * spine, neck and head.
 *
 * Two things make this read as a person rather than a turret.
 *
 * First, the angle is *shared*. A single joint taking the whole 90° looks
 * broken, and a hard clamp per joint hands the entire remainder to the next
 * joint the instant the previous one maxes out — a visible kink travelling up
 * the spine as the target sweeps past. `softClamp` saturates instead, so the
 * head leads, the neck joins in as the angle grows and the chest only turns for
 * a genuinely large look.
 *
 * Second, the gaze is never perfectly still. Interest points are held for a
 * random dwell and then jumped to (a saccade, not a glide), with low-amplitude
 * drift underneath, and the head counter-rotates against body yaw so the eyes
 * stay on target while the body turns — the vestibulo-ocular reflex, which is
 * the single most convincing cue that a head is being aimed rather than swung.
 */

export const LOOK_LIMITS = {
  headYaw:    0.80,   // ~46°
  neckYaw:    0.42,   // ~24°
  spineYaw:   0.34,   // ~19°
  headPitch:  0.46,   // ~26°
  neckPitch:  0.22,
  spinePitch: 0.12,
};

/**
 * Share a look angle across joints, each saturating progressively.
 * Pure — this is the part worth testing.
 *
 * @param {number} yaw    radians, +ve = target to the character's left
 * @param {number} pitch  radians, +ve = target above the head
 * @param {object} [limits]
 */
export function distributeLook(yaw, pitch, limits = LOOK_LIMITS) {
  const headYaw   = softClamp(yaw, limits.headYaw);
  const neckYaw   = softClamp(yaw - headYaw, limits.neckYaw);
  const spineYaw  = softClamp(yaw - headYaw - neckYaw, limits.spineYaw);

  const headPitch  = softClamp(pitch, limits.headPitch);
  const neckPitch  = softClamp(pitch - headPitch, limits.neckPitch);
  const spinePitch = softClamp(pitch - headPitch - neckPitch, limits.spinePitch);

  return {
    headYaw, neckYaw, spineYaw,
    headPitch, neckPitch, spinePitch,
    // What no joint could take — the caller can decide to turn the body.
    residualYaw:   yaw   - headYaw   - neckYaw   - spineYaw,
    residualPitch: pitch - headPitch - neckPitch - spinePitch,
  };
}

const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _local = new THREE.Vector3();
const _rootQ = new THREE.Quaternion();
const _rootQInv = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();
const _delta = new THREE.Quaternion();

export class LookAtSystem {
  /**
   * @param {Object<string, THREE.Bone>} bones  resolved rig
   * @param {object} [opts]
   * @param {number} [opts.seed]
   */
  constructor(bones, opts = {}) {
    this.bones = bones;
    this.rng = new SeededRandom(opts.seed ?? 0x51ee7);
    this.pose = null;              // set by main via attachPose()
    this.enabled = true;

    this.mode = 'follow';          // 'follow' | 'scan'
    this.weight = new SmoothedValue(1, 6);

    this.gaze = new THREE.Vector3(0, 1.6, -4);   // world-space point of interest
    this._desired = new THREE.Vector3();
    // When set, this wins over both modes — used to look at the wall a hand is
    // resting on, which is where a person's attention actually is.
    this.focusOverride = null;
    this._saccade = 0;                          // seconds of fast tracking left
    this._dwell = 1.5;
    this._driftT = 0;

    this.lastBodyYaw = 0;
    this.stabilisation = 0.65;    // how much of the body's turn the head undoes

    // Reported for the HUD and the idle director.
    this.yaw = 0;
    this.pitch = 0;
    this.targetMode = 'follow';
  }

  attachPose(pose) { this.pose = pose; }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    // A mode change is a new thought: pick somewhere to look, quickly.
    this._dwell = 0;
    this.targetMode = mode;
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   * @param {THREE.Object3D} ctx.root           character root (+Z forward)
   * @param {THREE.Vector3}  ctx.headPos        world position of the head
   * @param {THREE.Vector3}  ctx.cameraForward  unit vector the player is looking along
   * @param {THREE.Vector3}  ctx.cameraPos
   * @param {number}         ctx.speed          m/s
   * @param {number}         ctx.bodyYaw
   */
  update(dt, ctx) {
    const { root, headPos, cameraForward, cameraPos, speed, bodyYaw } = ctx;

    // ── Where to look ───────────────────────────────────────────────────────
    if (this.focusOverride) {
      this._desired.copy(this.focusOverride);
      this.targetMode = 'focus';
    } else if (this.mode === 'scan') {
      this._updateInterest(dt, headPos, root, cameraPos, bodyYaw);
    } else {
      this.targetMode = 'follow';
      this._desired.copy(headPos).addScaledVector(cameraForward, 5.5).setY(headPos.y + 0.15);
    }

    // Never let the gaze sit exactly on the head: the angle would be undefined.
    if (this._desired.distanceToSquared(headPos) < 0.25) {
      this._desired.copy(headPos).addScaledVector(cameraForward, 2);
    }

    // Low-amplitude drift so a held gaze is not a freeze-frame.
    this._driftT += dt;
    this._desired.x += Math.sin(this._driftT * 0.9) * 0.05;
    this._desired.y += Math.sin(this._driftT * 1.3 + 1.7) * 0.035;

    // ── Track it ────────────────────────────────────────────────────────────
    // Saccades are fast, tracking is slow: a real eye jumps to a new target in
    // ~40 ms and then holds. Gliding there at a constant rate reads as a
    // rotating security camera.
    const rate = this._saccade > 0 ? 16 : 3.2;
    this._saccade = Math.max(0, this._saccade - dt);
    this.gaze.x = damp(this.gaze.x, this._desired.x, rate, dt);
    this.gaze.y = damp(this.gaze.y, this._desired.y, rate, dt);
    this.gaze.z = damp(this.gaze.z, this._desired.z, rate, dt);

    // ── Angle in the character's own frame ──────────────────────────────────
    root.getWorldQuaternion(_rootQ);
    _toTarget.subVectors(this.gaze, headPos);
    _local.copy(_toTarget).applyQuaternion(_rootQInv.copy(_rootQ).invert());

    const flat = Math.hypot(_local.x, _local.z);
    let yaw = Math.atan2(_local.x, _local.z);
    let pitch = Math.atan2(_local.y, Math.max(0.0001, flat));

    // While moving, people look where they are going: clamp the sweep so the
    // head does not swing round at the camera mid-sprint.
    const moving = clamp01(speed / 2.5);
    const yawLimit = 1.9 - 0.75 * moving;
    yaw = clamp(yaw, -yawLimit, yawLimit);
    pitch = clamp(pitch, -0.75, 0.75);

    // Head stabilisation against body rotation.
    const bodyDelta = wrapAngle(bodyYaw - this.lastBodyYaw);
    this.lastBodyYaw = bodyYaw;
    yaw -= bodyDelta * this.stabilisation;

    this.yaw = yaw;
    this.pitch = pitch;

    // ── Apply ───────────────────────────────────────────────────────────────
    if (!this.pose || !this.enabled) return;

    this.weight.set(this.enabled ? 1 : 0, 6);
    const w = this.weight.update(dt);
    if (w < 0.01) return;

    const d = distributeLook(yaw, pitch);

    _up.set(0, 1, 0).applyQuaternion(_rootQ);
    _right.set(1, 0, 0).applyQuaternion(_rootQ);

    this._applyJoint('spine2', d.spineYaw * 0.6, d.spinePitch * 0.6, w);
    this._applyJoint('spine3', d.spineYaw * 0.4, d.spinePitch * 0.4, w);
    this._applyJoint('neck',   d.neckYaw, d.neckPitch, w);
    this._applyJoint('head',   d.headYaw, d.headPitch, w);
  }

  /** Yaw about the character's up, then pitch about its right, scaled by weight. */
  _applyJoint(boneKey, yaw, pitch, weight) {
    if (!this.bones[boneKey]) return;
    _qYaw.setFromAxisAngle(_up, yaw * weight);
    _qPitch.setFromAxisAngle(_right, pitch * weight);
    _delta.copy(_qPitch).multiply(_qYaw);
    this.pose.addWorldDelta(boneKey, _delta, 1);
  }

  /** Procedural interest points: the "looking around" behaviour. */
  _updateInterest(dt, headPos, root, cameraPos, bodyYaw) {
    this._dwell -= dt;
    if (this._dwell > 0) return;

    this._dwell = this.rng.range(1.0, 2.8);
    this._saccade = 0.22;

    if (this.rng.chance(0.22)) {
      // Glance at the viewer. Demos are watched; people notice being looked at.
      this._desired.copy(cameraPos).setY(headPos.y + 0.1);
      this.targetMode = 'scan:camera';
      return;
    }

    this.targetMode = 'scan:around';
    const yawOffset = this.rng.range(-2.3, 2.3);
    const dist = this.rng.range(2.5, 9);
    const height = headPos.y + this.rng.range(-0.7, 1.2);
    // Body-relative, so "look around" means around *him*, not around the world.
    const yaw = bodyYaw + yawOffset;
    this._desired.set(
      root.position.x + Math.sin(yaw) * dist,
      height,
      root.position.z + Math.cos(yaw) * dist
    );
  }
}
