import * as THREE from 'three';
import { boneDepth, refreshBoneMatrix } from './RigBones.js';
import { clamp01 } from './AnimationSmoothing.js';

const _identity = new THREE.Quaternion();
const _world = new THREE.Quaternion();
const _parentInv = new THREE.Quaternion();
const _tmp = new THREE.Quaternion();

/**
 * The procedural pose pass.
 *
 * Several systems want to bend the same skeleton at the same time — look-at
 * wants the neck, breathing wants the chest, the wall hands want the arms — and
 * they cannot each write bone quaternions independently or they would overwrite
 * one another. This is the single collection point: systems *contribute*
 * weighted rotations during the frame, and one pass applies them after the
 * mixer, in hierarchy order, so a child always sees its parent's finished pose.
 *
 * Contributions are re-declared every frame and never accumulate, which is the
 * same discipline `FootPlanting` uses for the pelvis: the mixer rewrites the
 * base pose each frame, so anything procedural has to be re-applied on top of
 * it rather than left lying around.
 *
 * That guarantee does not hold for every bone, though. `SKEL_Spine3_010` is
 * unmapped — the source rig has no fourth spine joint — so no clip animates it
 * and nothing resets it between frames. Left to itself, a look-at delta applied
 * there would spin the chest a little further every frame forever. So the pass
 * remembers what it wrote, and restores the rest pose on any bone that still
 * holds exactly that value: if the mixer had animated the bone, the value would
 * differ and the animated pose stays as the base.
 */
export class ProceduralPose {
  /**
   * @param {Object<string, THREE.Bone>} bones  resolved rig (see RigBones)
   */
  constructor(bones) {
    this.bones = bones;

    /** @type {Map<string, THREE.Quaternion>} bind/rest pose, per bone */
    this.rest = new Map();
    /** @type {Map<string, THREE.Quaternion>} what the last apply() wrote */
    this.written = new Map();
    for (const [key, bone] of Object.entries(bones)) {
      if (bone) this.rest.set(key, bone.quaternion.clone());
    }

    /** @type {Map<string, {world:THREE.Quaternion, local:THREE.Quaternion, target:THREE.Quaternion|null, targetWeight:number, hasWorld:boolean, hasLocal:boolean}>} */
    this.contrib = new Map();
    this._order = [];
    this.enabled = true;
  }

  _slot(key) {
    let s = this.contrib.get(key);
    if (!s) {
      s = {
        world: new THREE.Quaternion(),
        local: new THREE.Quaternion(),
        target: null,
        targetWeight: 0,
        hasWorld: false,
        hasLocal: false,
      };
      this.contrib.set(key, s);
    }
    return s;
  }

  /** Clear contributions for the new frame. */
  begin() {
    for (const s of this.contrib.values()) {
      s.world.identity();
      s.local.identity();
      s.target = null;
      s.targetWeight = 0;
      s.hasWorld = false;
      s.hasLocal = false;
    }
  }

  /**
   * Rotate a bone by a delta expressed in world space, scaled by `weight`.
   * World space is the right frame for look-at and lean: "yaw about the
   * character's up" means the same thing regardless of how the joint happens to
   * be oriented in its parent.
   */
  addWorldDelta(boneKey, deltaWorld, weight = 1) {
    const bone = this.bones[boneKey];
    if (!bone || weight <= 0.0005) return;
    const s = this._slot(boneKey);
    _tmp.copy(_identity).slerp(deltaWorld, clamp01(weight));
    s.world.premultiply(_tmp);
    s.hasWorld = true;
  }

  /**
   * Rotate a bone by a delta in its own local space, scaled by `weight`.
   * Local space is the right frame for a joint's own degrees of freedom —
   * breathing rolls the chest about the chest's own axes.
   */
  addLocalDelta(boneKey, deltaLocal, weight = 1) {
    const bone = this.bones[boneKey];
    if (!bone || weight <= 0.0005) return;
    const s = this._slot(boneKey);
    _tmp.copy(_identity).slerp(deltaLocal, clamp01(weight));
    s.local.multiply(_tmp);
    s.hasLocal = true;
  }

  /**
   * Pull a bone toward an absolute local rotation by `weight` — the way to hold
   * a pose (hands flat on a wall) rather than offset one.
   */
  blendLocalTo(boneKey, targetLocal, weight = 1) {
    const bone = this.bones[boneKey];
    if (!bone || weight <= 0.0005) return;
    const s = this._slot(boneKey);
    if (!s.target) s.target = new THREE.Quaternion();
    s.target.copy(targetLocal);
    s.targetWeight = clamp01(weight);
  }

  /** Apply everything, parent before child. */
  apply() {
    if (!this.enabled) return;

    this._order.length = 0;
    for (const [key, s] of this.contrib) {
      if (s.hasWorld || s.hasLocal || s.target) this._order.push(key);
    }
    if (this._order.length === 0) return;

    this._order.sort((a, b) => boneDepth(this.bones[a]) - boneDepth(this.bones[b]));

    for (const key of this._order) {
      const bone = this.bones[key];
      const s = this.contrib.get(key);

      // Undo last frame's write, but only if nothing has overwritten it since —
      // i.e. only on bones no clip animates. See the class comment.
      const last = this.written.get(key);
      if (last && bone.quaternion.equals(last)) {
        bone.quaternion.copy(this.rest.get(key));
        refreshBoneMatrix(bone);
      }

      if (s.hasWorld) {
        bone.getWorldQuaternion(_world);
        _world.premultiply(s.world);
        if (bone.parent) {
          bone.parent.getWorldQuaternion(_parentInv).invert();
          _world.premultiply(_parentInv);
        }
        bone.quaternion.copy(_world);
        refreshBoneMatrix(bone);
      }

      if (s.hasLocal) {
        bone.quaternion.multiply(s.local);
        refreshBoneMatrix(bone);
      }

      if (s.target) {
        bone.quaternion.slerp(s.target, s.targetWeight);
        refreshBoneMatrix(bone);
      }

      let w = this.written.get(key);
      if (!w) { w = new THREE.Quaternion(); this.written.set(key, w); }
      w.copy(bone.quaternion);
    }
  }
}
