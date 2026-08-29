import * as THREE from 'three';
import { getTerrainHeight } from './Terrain.js';
import { damp, lerpAngle } from './AnimationSmoothing.js';

const WALK_SPEED   = 2.4;  // m/s
const RUN_SPEED    = 4.4;
const SPRINT_SPEED = 7.2;
const ACCEL        = 12.0; // m/s² ground acceleration
const DECEL        = 18.0; // deceleration when no input
const GRAVITY      = -14.0;
const JUMP_IMPULSE =  6.5;
const GROUND_SNAP  =  0.35; // m — treat gaps smaller than this as still grounded

// GTA IV locomotion turns the whole body to face the direction of travel rather
// than strafing. _bodyYaw is that facing angle in the +Z-forward convention, so
// a yaw of φ means facing (sin φ, cos φ) — the character root is normalised to
// +Z forward in main.js, so this can be written straight to mesh.rotation.y.
const BODY_TURN_RATE = 7.0;

// Body radius for collision against the environment's boxes.
const BODY_RADIUS = 0.34;

// Below this speed and with no keys down, he counts as idle. The idle clock is
// what the upper-body layer reads, so it has to be honest: a character sliding
// to a halt is not standing still, and neither is one holding a key against a
// wall he cannot walk through.
const IDLE_SPEED = 0.18;

export class CharacterController {
  /**
   * @param {THREE.Object3D} mesh
   * @param {number} groundOffset  distance from the model's origin down to its
   *   feet. Fred's origin sits at hip height, so the root must ride this far
   *   above the terrain for the feet to land on it.
   * @param {import('./Environment.js').Environment} [environment]
   */
  constructor(mesh, groundOffset = 0, environment = null) {
    this.mesh = mesh;   // The character THREE.Object3D
    this.groundOffset = groundOffset;
    this.environment = environment;

    // State
    this.velocity   = new THREE.Vector3();
    this.onGround   = true;
    this.jumping    = false;
    this.jumpPhase  = 'none'; // 'none' | 'begin' | 'air' | 'land'
    this._jumpTimer = 0;

    // Body yaw (world)
    this._bodyYaw   = 0;

    // Seconds spent standing still with no input — drives the idle director.
    this.idleTime = 0;
    this.hasInput = false;

    // Smoothed horizontal acceleration in the character's own frame. Everything
    // secondary — the forward lean, the banking into a turn — reads this rather
    // than the raw per-frame velocity delta, which is mostly terrain-snap noise.
    // Plain scalars rather than a Vector2: the components are "forward" and
    // "lateral", not X and Z, and naming a vector after that invites exactly the
    // kind of axis mix-up that produces a silent NaN.
    this.accelForward = 0;
    this.accelLateral = 0;
    this._prevVelX = 0;
    this._prevVelZ = 0;

    // Normal of whatever he is pressed against this frame, if anything.
    this.contactNormal = null;

    // Keyboard state
    this._keys = {};
    this._setupInput();
  }

  _setupInput() {
    window.addEventListener('keydown', e => { this._keys[e.code] = true; });
    window.addEventListener('keyup',   e => { this._keys[e.code] = false; });
  }

  _key(...codes) { return codes.some(c => this._keys[c]); }

  /**
   * @param {number} dt
   * @param {number} cameraYaw
   * @returns {{localVel:THREE.Vector3, speed:number, jumpPhase:string,
   *            idleTime:number, hasInput:boolean, accelForward:number,
   *            accelLateral:number, contactNormal:THREE.Vector3|null}}
   */
  update(dt, cameraYaw) {
    // ── Input → desired world-space direction ────────────────────────────────
    let ix = 0, iz = 0;
    if (this._key('KeyW', 'ArrowUp'))    iz -= 1;
    if (this._key('KeyS', 'ArrowDown'))  iz += 1;
    if (this._key('KeyA', 'ArrowLeft'))  ix -= 1;
    if (this._key('KeyD', 'ArrowRight')) ix += 1;

    const isSprinting = this._key('ShiftLeft', 'ShiftRight');
    const isJumping   = this._key('Space');

    const hasInput = ix !== 0 || iz !== 0;
    this.hasInput = hasInput;

    // Camera-relative world direction
    const sinCY = Math.sin(cameraYaw);
    const cosCY = Math.cos(cameraYaw);
    const worldDirX = ix * cosCY + iz * sinCY;
    const worldDirZ = ix * (-sinCY) + iz * cosCY;

    const inputLen = Math.sqrt(worldDirX * worldDirX + worldDirZ * worldDirZ);
    const normX = inputLen > 0.001 ? worldDirX / inputLen : 0;
    const normZ = inputLen > 0.001 ? worldDirZ / inputLen : 0;

    // ── Target speed ─────────────────────────────────────────────────────────
    let targetSpeed = 0;
    if (hasInput) {
      if (isSprinting) targetSpeed = SPRINT_SPEED;
      else             targetSpeed = this._key('KeyW','ArrowUp') || this._key('KeyS','ArrowDown') ? RUN_SPEED : WALK_SPEED;
    }

    // ── Ground movement ───────────────────────────────────────────────────────
    if (this.onGround) {
      const currentSpeed = Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2);

      if (hasInput) {
        const accel = ACCEL * dt;
        this.velocity.x += (normX * targetSpeed - this.velocity.x) * Math.min(1, accel / Math.max(0.01, targetSpeed));
        this.velocity.z += (normZ * targetSpeed - this.velocity.z) * Math.min(1, accel / Math.max(0.01, targetSpeed));

        // Turn body toward movement direction
        if (inputLen > 0.1) {
          const desiredYaw = Math.atan2(normX, normZ);
          this._bodyYaw = lerpAngle(this._bodyYaw, desiredYaw, BODY_TURN_RATE * dt);
        }
      } else {
        // Decelerate
        const decel = DECEL * dt;
        const spd = Math.max(0, currentSpeed - decel);
        if (currentSpeed > 0.001) {
          const scale = spd / currentSpeed;
          this.velocity.x *= scale;
          this.velocity.z *= scale;
        }
        // Standing still, the body is left exactly where it is. The camera is
        // free to orbit all the way around him without dragging his facing with
        // it — he only ever turns when actually moving, to face his travel
        // direction. Foot planting locks his feet to the ground, so idle
        // rotation would also twist the legs against those locks.
      }

      // Jump initiation
      if (isJumping && this.jumpPhase === 'none') {
        this.velocity.y  = JUMP_IMPULSE;
        this.onGround    = false;
        this.jumping     = true;
        this.jumpPhase   = 'begin';
        this._jumpTimer  = 0;
      }
    }

    // ── Gravity + vertical ────────────────────────────────────────────────────
    if (!this.onGround || this.velocity.y > 0) {
      this.velocity.y += GRAVITY * dt;
    }

    // ── Apply velocity to position ─────────────────────────────────────────────
    this.mesh.position.x += this.velocity.x * dt;
    this.mesh.position.z += this.velocity.z * dt;
    this.mesh.position.y += this.velocity.y * dt;

    // ── Solid geometry ────────────────────────────────────────────────────────
    // Pushed out of the box, then the velocity component driving him into it is
    // removed — otherwise he keeps accelerating against the wall and slides up
    // the moment he steps sideways off it.
    this.contactNormal = null;
    if (this.environment) {
      const normal = this.environment.resolveCharacter(this.mesh.position, BODY_RADIUS);
      if (normal) {
        const into = this.velocity.x * normal.x + this.velocity.z * normal.z;
        if (into < 0) {
          this.velocity.x -= into * normal.x;
          this.velocity.z -= into * normal.z;
        }
        this.contactNormal = normal;
      }
    }

    // ── Terrain collision ──────────────────────────────────────────────────────
    // Walking over rolling terrain constantly lifts the root a few centimetres
    // clear of the surface. Without a snap tolerance every bump reads as a fall,
    // which retriggers the landing animation over and over.
    const groundY = getTerrainHeight(this.mesh.position.x, this.mesh.position.z) + this.groundOffset;
    const gap     = this.mesh.position.y - groundY;
    const wasAir  = !this.onGround;

    if (gap <= 0) {
      this.mesh.position.y = groundY;
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onGround = true;
    } else if (!this.jumping && this.velocity.y <= 0 && gap < GROUND_SNAP) {
      this.mesh.position.y = groundY;   // stick to slopes
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // ── Jump phase machine ─────────────────────────────────────────────────────
    this._jumpTimer += dt;

    if (this.onGround && wasAir && (this.jumpPhase === 'air' || this.jumping)) {
      this.jumpPhase  = 'land';
      this._jumpTimer = 0;
      this.jumping    = false;
    }
    if (this.jumpPhase === 'begin' && this._jumpTimer > 0.25) {
      this.jumpPhase = 'air'; this._jumpTimer = 0;
    }
    if (this.jumpPhase === 'land' && this._jumpTimer > 0.45) {
      this.jumpPhase = 'none';
    }
    // Walking off a real ledge (not a bump) also reads as airborne
    if (!this.onGround && this.jumpPhase === 'none' && gap > GROUND_SNAP) {
      this.jumpPhase = 'air';
    }

    // ── Rotate mesh ────────────────────────────────────────────────────────────
    this.mesh.rotation.y = this._bodyYaw;

    // ── Acceleration in the character's frame ──────────────────────────────────
    const speed = Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2);
    const invDt = 1 / Math.max(dt, 1e-4);
    const rawX = (this.velocity.x - this._prevVelX) * invDt;
    const rawZ = (this.velocity.z - this._prevVelZ) * invDt;
    this._prevVelX = this.velocity.x;
    this._prevVelZ = this.velocity.z;

    // Facing (sin φ, cos φ), right (cos φ, -sin φ).
    const sinB = Math.sin(this._bodyYaw), cosB = Math.cos(this._bodyYaw);
    const aFwd = rawX * sinB + rawZ * cosB;
    const aLat = rawX * cosB - rawZ * sinB;
    this.accelForward = damp(this.accelForward, aFwd, 9, dt);
    this.accelLateral = damp(this.accelLateral, aLat, 9, dt);

    // ── Idle clock ─────────────────────────────────────────────────────────────
    const settled = !hasInput && this.onGround && speed < IDLE_SPEED && this.jumpPhase === 'none';
    this.idleTime = settled ? this.idleTime + dt : 0;

    // ── Compute character-local velocity for motion matching ──────────────────
    const invBodyQ = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0, -this._bodyYaw, 0)
    );
    // Undoing the body yaw already lands velocity in the character's own frame,
    // where +Z is forward — matching the clip manifest. No further flip.
    const worldVel = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const localVel = worldVel.applyQuaternion(invBodyQ);

    return {
      localVel,
      speed,
      jumpPhase: this.jumpPhase,
      idleTime: this.idleTime,
      hasInput,
      accelForward: this.accelForward,
      accelLateral: this.accelLateral,
      contactNormal: this.contactNormal,
    };
  }

  getBodyYaw() { return this._bodyYaw; }
}
