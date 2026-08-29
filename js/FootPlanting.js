import * as THREE from 'three';
import { applyTwoBoneIK } from './TwoBoneIK.js';
import { getTerrainHeight, getTerrainNormal } from './Terrain.js';
import { resolveBones, RIG_PATTERNS } from './RigBones.js';

// Only the leg chain is needed here; the shared table also carries the spine,
// head and arms for the systems that drive those. Fred.glb uses the RAGE/GTA
// "SKEL_" convention, with Mixamo / Biped fallbacks per pattern.
const LEG_KEYS = ['hips', 'lThigh', 'lShin', 'lFoot', 'lToe', 'rThigh', 'rShin', 'rFoot', 'rToe'];

class FootState {
  constructor() {
    this.planted      = false;
    this.plantedPos   = new THREE.Vector3();
    this.liftTimer    = 0;
    this.blend        = 0;   // 0 = pure animation, 1 = fully planted
    this.smoothTarget = new THREE.Vector3();
    this.initialised  = false;
  }
}

export class FootPlanting {
  /**
   * @param {THREE.Object3D} characterRoot
   * @param {THREE.Bone[]}   bones  flat list of the character's bones
   */
  constructor(characterRoot, bones) {
    this.root    = characterRoot;
    this.allBones = bones;
    this.enabled = true;

    const { bones: resolved, missing } = resolveBones(bones, RIG_PATTERNS);
    this.bones = {};
    for (const key of LEG_KEYS) this.bones[key] = resolved[key];
    if (missing.length) console.warn('[FootPlanting] unresolved rig keys:', missing.join(', '));

    const report = Object.entries(this.bones)
      .map(([k, v]) => `${k}=${v?.name ?? 'MISSING'}`).join('  ');
    console.log('[FootPlanting]', report);

    this.leftFoot  = new FootState();
    this.rightFoot = new FootState();

    // Cached leg segment lengths, measured once from the bind pose
    this._legLen = { l: null, r: null };

    // Pelvis is offset absolutely from its rest position each frame — never
    // accumulated, since the retargeted clips carry no hips position track.
    this._hipsRestY    = this.bones.hips ? this.bones.hips.position.y : 0;
    this._pelvisOffset = 0;

    // Extra drop contributed by other systems (the landing dip in BodyLean).
    // Written before update() and folded into the same absolute assignment, so
    // two systems can share the pelvis without accumulating against each other.
    this.pelvisExtra = 0;

    this.LIFT_THRESHOLD = 0.07;  // metres above terrain before a foot unplants
    this.BLEND_RATE     = 9.0;   // how fast IK engages/releases
    this.PELVIS_RATE    = 6.0;
  }

  _measureLeg(side) {
    const cached = this._legLen[side];
    if (cached) return cached;

    const thigh = side === 'l' ? this.bones.lThigh : this.bones.rThigh;
    const shin  = side === 'l' ? this.bones.lShin  : this.bones.rShin;
    const foot  = side === 'l' ? this.bones.lFoot  : this.bones.rFoot;
    if (!thigh || !shin || !foot) return null;

    const a = new THREE.Vector3().setFromMatrixPosition(thigh.matrixWorld);
    const b = new THREE.Vector3().setFromMatrixPosition(shin.matrixWorld);
    const c = new THREE.Vector3().setFromMatrixPosition(foot.matrixWorld);

    const len = { upper: a.distanceTo(b), lower: b.distanceTo(c) };
    len.total = len.upper + len.lower;
    this._legLen[side] = len;
    return len;
  }

  /** Call after mixer.update() and after world matrices are current. */
  update(dt) {
    if (!this.enabled) return;
    if (!this.bones.lFoot || !this.bones.rFoot) return;

    this._solveLeg(dt, this.leftFoot,  'l', -1);
    this._solveLeg(dt, this.rightFoot, 'r',  1);
    this._adjustPelvis(dt);
  }

  _solveLeg(dt, state, side, lateral) {
    const thigh = side === 'l' ? this.bones.lThigh : this.bones.rThigh;
    const shin  = side === 'l' ? this.bones.lShin  : this.bones.rShin;
    const foot  = side === 'l' ? this.bones.lFoot  : this.bones.rFoot;
    if (!thigh || !shin || !foot) return;

    const leg = this._measureLeg(side);
    if (!leg || leg.total < 1e-4) return;

    const animPos  = new THREE.Vector3().setFromMatrixPosition(foot.matrixWorld);
    const groundY  = getTerrainHeight(animPos.x, animPos.z);
    const clearance = animPos.y - groundY;

    if (!state.initialised) {
      state.smoothTarget.copy(animPos);
      state.initialised = true;
    }

    // ── Contact detection ─────────────────────────────────────────────────
    const inContact = clearance < this.LIFT_THRESHOLD;

    if (inContact && !state.planted) {
      state.planted = true;
      state.plantedPos.set(animPos.x, groundY, animPos.z);
    } else if (!inContact && state.planted) {
      state.liftTimer += dt;
      if (state.liftTimer > 0.04) {   // small hysteresis against jitter
        state.planted   = false;
        state.liftTimer = 0;
      }
    } else {
      state.liftTimer = 0;
    }

    // Keep the lock anchored to the surface
    if (state.planted) {
      state.plantedPos.y = getTerrainHeight(state.plantedPos.x, state.plantedPos.z);
    }

    // ── Blend IK in while planted, out while airborne ─────────────────────
    const targetBlend = state.planted ? 1 : 0;
    state.blend += (targetBlend - state.blend) * Math.min(1, dt * this.BLEND_RATE);
    if (state.blend < 0.01) return;   // fully animated — skip IK entirely

    const goal = animPos.clone().lerp(state.plantedPos, state.blend);

    // ── Clamp so the leg never hyper-extends ──────────────────────────────
    const hipPos = new THREE.Vector3().setFromMatrixPosition(thigh.matrixWorld);
    const toGoal = goal.clone().sub(hipPos);
    const maxReach = leg.total * 0.98;
    if (toGoal.length() > maxReach) {
      toGoal.setLength(maxReach);
      goal.copy(hipPos).add(toGoal);
    }

    // ── Pole vector: knee leads forward, splayed slightly outward ─────────
    const fwd   = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    const pole  = hipPos.clone()
      .addScaledVector(fwd,   leg.total * 1.2)
      .addScaledVector(right, lateral * leg.total * 0.25);

    applyTwoBoneIK(thigh, shin, goal, pole);

    // ── Align the foot to the slope it is standing on ─────────────────────
    if (state.blend > 0.05) {
      const n = getTerrainNormal(goal.x, goal.z);
      const up = new THREE.Vector3(0, 1, 0);
      const align = new THREE.Quaternion().setFromUnitVectors(up, n);
      const world = foot.getWorldQuaternion(new THREE.Quaternion());
      world.premultiply(align.slerp(new THREE.Quaternion(), 1 - state.blend));
      if (foot.parent) {
        const pw = foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
        foot.quaternion.copy(pw.multiply(world));
      }
      foot.updateWorldMatrix(false, true);
    }
  }

  _adjustPelvis(dt) {
    const hips = this.bones.hips;
    if (!hips) return;

    const lPos = new THREE.Vector3().setFromMatrixPosition(this.bones.lFoot.matrixWorld);
    const rPos = new THREE.Vector3().setFromMatrixPosition(this.bones.rFoot.matrixWorld);

    // Drop the pelvis by however far the *lower* foot still needs to reach down,
    // so the character straddles slopes instead of floating.
    const lGap = getTerrainHeight(lPos.x, lPos.z) - lPos.y;
    const rGap = getTerrainHeight(rPos.x, rPos.z) - rPos.y;
    const target = -Math.max(0, Math.min(lGap, rGap));

    this._pelvisOffset += (target - this._pelvisOffset) * Math.min(1, dt * this.PELVIS_RATE);

    // The mixer may have written a pelvis height this frame (the retargeted
    // clips carry the gait bob and the crouch depth as a position track), so
    // the correction is added ON TOP of whatever the animation set — reading
    // it first, never overwriting it. With no position track the mixer leaves
    // the bind value and this degenerates to the old rest-based behaviour.
    const animY = hips.position.y;
    hips.position.y = animY + this._pelvisOffset + this.pelvisExtra;
    hips.updateWorldMatrix(false, true);
  }

  debugBones() {
    console.group('[FootPlanting] all bones');
    this.allBones.forEach(b => console.log(b.name));
    console.groupEnd();
  }
}
