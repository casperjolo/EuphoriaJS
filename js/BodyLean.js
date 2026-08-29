import * as THREE from 'three';
import { clamp, damp } from './AnimationSmoothing.js';

/**
 * Secondary motion: the body reacting to forces rather than to a clip.
 *
 * Motion matching gives the right *gait*; it cannot know that this particular
 * frame the character was shoved sideways by a wall or has just landed from two
 * metres up. Everything here is a reaction to a physical quantity the controller
 * already has — acceleration, landing, time spent standing still — applied as a
 * weighted rotation on top of the animated pose.
 *
 * The amplitudes are deliberately small. Lean reads as weight at a couple of
 * degrees and as slapstick at ten.
 *
 * One thing this deliberately does *not* do: roll the pelvis or turn the body
 * while idle. Foot planting locks the feet to the floor, so any rotation below
 * the waist has to be paid for by twisting the legs against those locks. The
 * idle weight shift therefore moves the chest and leaves the hips alone.
 */

const LEAN_PITCH_MAX   = 0.17;  // rad, full throttle
const LEAN_ROLL_MAX    = 0.085; // rad, full sideways shove
const BREATH_RATE      = 1.75;  // rad/s (~0.28 Hz, a resting breath)
const BREATH_AMP       = 0.016; // rad
const SWAY_RATE        = 0.7;   // rad/s
const SWAY_AMP         = 0.030; // rad
const LAND_DIP         = -0.10; // metres
const JUMP_DIP         = -0.045;

// Pelvis spring: stiff enough to recover inside a stride, soft enough that the
// landing does not look like a pogo stick.
const SPRING_K = 170;
const SPRING_C = 21;

const _qPitch = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _breath = new THREE.Quaternion();
const _pitchInv = new THREE.Quaternion();
const _axisX = new THREE.Vector3(1, 0, 0);

export class BodyLean {
  /**
   * @param {Object<string, THREE.Bone>} bones
   * @param {import('./ProceduralPose.js').ProceduralPose} pose
   */
  constructor(bones, pose) {
    this.bones = bones;
    this.pose = pose;
    this.enabled = true;

    this.leanPitch = 0;
    this.leanRoll = 0;
    this.idleWeight = 0;

    this.pelvisY = 0;
    this._pelvisVel = 0;

    this._t = 0;
    this._lastJumpPhase = 'none';
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   * @param {THREE.Object3D} ctx.root
   * @param {THREE.Vector3} ctx.forward  unit
   * @param {THREE.Vector3} ctx.right    unit
   * @param {number} ctx.accelForward    m/s² along the facing, +ve = speeding up
   * @param {number} ctx.accelLateral    m/s² to the right
   * @param {number} ctx.speed           m/s
   * @param {string} ctx.jumpPhase
   * @param {number} ctx.idleWeight      0..1, how settled he is
   */
  update(dt, ctx) {
    const { root, forward, right, accelForward, accelLateral, speed, jumpPhase, idleWeight } = ctx;
    this._t += dt;
    this.idleWeight = idleWeight;

    // ── Lean from acceleration ──────────────────────────────────────────────
    // Smoothed twice: once by the controller's own acceleration window and once
    // here, because a raw per-frame delta is mostly noise from the terrain snap.
    const pitchTarget = clamp(-accelForward / 14, -LEAN_PITCH_MAX, LEAN_PITCH_MAX);
    const rollTarget  = clamp(-accelLateral / 16, -LEAN_ROLL_MAX, LEAN_ROLL_MAX);
    this.leanPitch = damp(this.leanPitch, this.enabled ? pitchTarget : 0, 5.5, dt);
    this.leanRoll  = damp(this.leanRoll,  this.enabled ? rollTarget  : 0, 5.0, dt);

    // ── Landing / take-off ──────────────────────────────────────────────────
    let dipTarget = 0;
    if (jumpPhase === 'land') dipTarget = LAND_DIP;
    else if (jumpPhase === 'begin') dipTarget = JUMP_DIP;

    // A landing is an impulse, not a setpoint: kick the spring instead of
    // dragging it, so the recovery overshoots slightly back up.
    if (jumpPhase === 'land' && this._lastJumpPhase !== 'land') {
      this._pelvisVel = -1.15;
      this.pelvisY = Math.min(this.pelvisY, LAND_DIP * 0.4);
    }
    this._lastJumpPhase = jumpPhase;

    const spring = -SPRING_K * (this.pelvisY - dipTarget) - SPRING_C * this._pelvisVel;
    this._pelvisVel += spring * dt;
    this.pelvisY += this._pelvisVel * dt;
    this.pelvisY = clamp(this.pelvisY, -0.22, 0.06);

    if (!this.enabled || !this.pose) return;

    // ── Apply to the spine ──────────────────────────────────────────────────
    _qPitch.setFromAxisAngle(right, this.leanPitch);
    _qRoll.setFromAxisAngle(forward, this.leanRoll);
    _delta.copy(_qRoll).multiply(_qPitch);

    this.pose.addWorldDelta('spine1', _delta, 0.45);
    this.pose.addWorldDelta('spine2', _delta, 0.55);

    // The head holds still while the torso pitches — that is what makes a lean
    // read as balance rather than as a bow.
    this.pose.addWorldDelta('neck', _pitchInv.copy(_qPitch).invert(), 0.35);

    // ── Breathing ───────────────────────────────────────────────────────────
    // Scaled down while running: the gait is already moving the chest, and two
    // independent rhythms stacked on top of each other read as a stutter.
    const breathScale = (1 - 0.65 * clamp(speed / 4.5, 0, 1)) * (0.6 + 0.4 * idleWeight);
    const amp = BREATH_AMP * breathScale;
    _breath.setFromAxisAngle(_axisX, Math.sin(this._t * BREATH_RATE) * amp);
    this.pose.addLocalDelta('spine2', _breath, 0.7);
    this.pose.addLocalDelta('spine3', _breath, 0.9);

    // ── Idle weight shift ───────────────────────────────────────────────────
    if (this.idleWeight > 0.01) {
      const sway = Math.sin(this._t * SWAY_RATE) * SWAY_AMP * this.idleWeight;
      _qRoll.setFromAxisAngle(forward, sway);
      this.pose.addWorldDelta('spine1', _qRoll, 1);
      _qRoll.setFromAxisAngle(forward, -sway * 0.55);
      this.pose.addWorldDelta('spine2', _qRoll, 1);
      // Counter-tilt the head so the gaze stays level.
      _qRoll.setFromAxisAngle(forward, -sway * 0.6);
      this.pose.addWorldDelta('neck', _qRoll, 1);
    }
  }
}
