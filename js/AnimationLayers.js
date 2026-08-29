import * as THREE from 'three';
import { TransitionBlender } from './TransitionBlender.js';

/**
 * Masked animation layers.
 *
 * A layer is an ordinary set of actions on the same mixer, with two additions:
 * the clip is filtered down to a bone mask before it is handed over, and the
 * whole layer carries a master weight.
 *
 * The stock mixer already does the hard part. `PropertyMixer.accumulate` is a
 * running weighted average, so with the base layer at 1-w and an upper-body
 * layer at w, a bone both layers animate lands on the weighted blend of the two
 * poses, while a bone only the base animates (the legs) keeps the base pose
 * exactly — the mask is what makes the blend partial instead of global.
 */

/** Rig keys that belong to the upper body, per RigBones. */
export const UPPER_BODY_KEYS = [
  'spine1', 'spine2', 'spine3',
  'neck', 'head',
  'lClavicle', 'lUpperArm', 'lForearm', 'lHand',
  'rClavicle', 'rUpperArm', 'rForearm', 'rHand',
];

/**
 * Build a bone-name mask from rig keys.
 * @param {Object<string, THREE.Bone|null>} resolved  output of resolveBones()
 * @param {string[]} keys
 * @returns {Set<string>}
 */
export function boneMaskFromRig(resolved, keys) {
  const mask = new Set();
  for (const k of keys) {
    const bone = resolved[k];
    if (bone) mask.add(bone.name);
  }
  return mask;
}

const _maskCache = new WeakMap();

/**
 * Filter a clip down to the bones in `mask`, cached per (clip, mask) pair.
 * Tracks are cloned rather than mutated so the unmasked clip stays usable by
 * the base layer.
 */
export function maskedClip(clip, mask) {
  let byMask = _maskCache.get(clip);
  if (!byMask) { byMask = new Map(); _maskCache.set(clip, byMask); }
  const cached = byMask.get(mask);
  if (cached) return cached;

  const tracks = [];
  for (const track of clip.tracks) {
    const boneName = track.name.split('.')[0];
    if (mask.has(boneName)) tracks.push(track);
  }
  const out = new THREE.AnimationClip(`${clip.name}#masked`, clip.duration, tracks);
  out.trim();
  byMask.set(mask, out);
  return out;
}

export class AnimationLayer {
  /**
   * @param {THREE.AnimationMixer} mixer
   * @param {Set<string>} mask   bone names this layer is allowed to touch
   * @param {object} [opts]
   * @param {number} [opts.defaultBlend]
   */
  constructor(mixer, mask, opts = {}) {
    this.name = opts.name ?? 'layer';
    this.mask = mask;
    this.blender = new TransitionBlender(mixer, { defaultBlend: opts.defaultBlend ?? 0.45 });
    this.weight = 1;
    this.enabled = true;
  }

  setWeight(w) {
    this.weight = w;
    this.blender.masterWeight = this.enabled ? w : 0;
  }

  /**
   * @param {THREE.AnimationClip} clip  full-body clip; masked on the way in
   */
  play(clip, opts = {}) {
    if (!this.enabled) return null;
    const masked = maskedClip(clip, this.mask);
    if (masked.tracks.length === 0) {
      console.warn(`[${this.name}] mask matched no tracks in ${clip.name}`);
      return null;
    }
    return this.blender.play(masked, opts);
  }

  release(dur = 0.4) {
    this.blender.fadeOutAll(dur);
  }

  stop() {
    this.blender.stopAll();
  }

  update(dt) {
    this.blender.masterWeight = this.enabled ? this.weight : 0;
    this.blender.update(dt);
  }

  get currentKey() { return this.blender.currentKey; }
  get isBlending() { return this.blender.isBlending; }
}

/** Convenience: the standard upper-body mask for a resolved rig. */
export function upperBodyMask(resolved) {
  return boneMaskFromRig(resolved, UPPER_BODY_KEYS);
}
