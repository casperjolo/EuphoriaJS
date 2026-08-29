import * as THREE from 'three';
import { clamp01, lerp, smootherstep } from './AnimationSmoothing.js';

/**
 * Eased action blending.
 *
 * three.js's own `fadeIn`/`fadeOut` ramp weight *linearly*, which is visible as
 * a corner at both ends of a transition — the pose starts moving abruptly and
 * stops abruptly. This drives the weights itself with a smootherstep curve and
 * keeps a list of everything currently in flight, so any number of actions can
 * overlap and the shared bones get a proper weighted blend between them.
 *
 * It works because `PropertyMixer.accumulate` is a running weighted average:
 * two actions playing on the same bone at weights w and 1-w blend to exactly
 * that ratio, while a bone only one of them animates keeps its own value. That
 * is what makes masked layers (see AnimationLayers) possible on a stock mixer.
 */
export class TransitionBlender {
  /**
   * @param {THREE.AnimationMixer} mixer
   * @param {object} [opts]
   * @param {number} [opts.defaultBlend=0.28]  seconds for a crossfade
   * @param {(t:number)=>number} [opts.ease]   weight curve, 0→1
   */
  constructor(mixer, opts = {}) {
    this.mixer = mixer;
    this.defaultBlend = opts.defaultBlend ?? 0.28;
    this.ease = opts.ease ?? smootherstep;

    /** @type {Array<{key:string, clip:THREE.AnimationClip, action:THREE.AnimationAction, weight:number, from:number, to:number, t:number, dur:number}>} */
    this.entries = [];

    // Master weight scales every entry — how an animation *layer* is faded as a
    // whole without disturbing the crossfades happening inside it.
    this.masterWeight = 1;
  }

  /** Key of the entry that is currently the strongest, or null when silent. */
  get currentKey() {
    let best = null;
    for (const e of this.entries) if (!best || e.weight > best.weight) best = e;
    return best && best.weight > 0.02 ? best.key : null;
  }

  get isBlending() {
    return this.entries.some(e => e.dur > 0 && e.t < e.dur);
  }

  /**
   * Crossfade to `clip`. Anything already playing fades out over `blendOut`.
   *
   * @param {THREE.AnimationClip} clip
   * @param {object} [opts]
   * @param {string} [opts.key=clip.name]
   * @param {number} [opts.blendIn]
   * @param {number} [opts.blendOut]
   * @param {number} [opts.timeScale]
   * @param {boolean} [opts.matchPhase]  start where the outgoing clip left off
   */
  play(clip, opts = {}) {
    const key = opts.key ?? clip.name;
    const blendIn  = opts.blendIn  ?? this.defaultBlend;
    const blendOut = opts.blendOut ?? this.defaultBlend;

    const existing = this.entries.find(e => e.key === key);
    if (existing) {
      // Already playing (or mid-fade-out): retarget the fade instead of
      // stacking a second action on the same clip.
      existing.from = existing.weight;
      existing.to   = 1;
      existing.t    = 0;
      existing.dur  = blendIn;
      existing.action.paused = false;
      return existing;
    }

    // Fade out whatever is up.
    let outgoing = null;
    for (const e of this.entries) {
      if (e.to !== 0) {
        e.from = e.weight;
        e.to   = 0;
        e.t    = 0;
        e.dur  = blendOut;
        if (!outgoing || e.weight > outgoing.weight) outgoing = e;
      }
    }

    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.timeScale = opts.timeScale ?? 1;

    // Gait phase continuity: a locomotion clip that restarts at t=0 mid-stride
    // reads as a stumble even under a crossfade. Seeding the new action with
    // the outgoing one's phase keeps the feet in step.
    if (opts.matchPhase !== false && outgoing && outgoing.clip.duration > 0) {
      const phase = (outgoing.action.time % outgoing.clip.duration) / outgoing.clip.duration;
      action.time = phase * clip.duration;
    }

    action.setEffectiveWeight(0);
    action.play();

    const entry = { key, clip, action, weight: 0, from: 0, to: 1, t: 0, dur: blendIn };
    this.entries.push(entry);
    return entry;
  }

  /** Fade everything out over `dur`. */
  fadeOutAll(dur = this.defaultBlend) {
    for (const e of this.entries) {
      if (e.to !== 0) { e.from = e.weight; e.to = 0; e.t = 0; e.dur = dur; }
    }
  }

  stopAll() {
    for (const e of this.entries) e.action.stop();
    this.entries.length = 0;
  }

  /** Advance the weight curves. Must run *before* `mixer.update()`. */
  update(dt) {
    for (const e of this.entries) {
      if (e.dur > 0) {
        e.t += dt;
        const k = clamp01(e.t / e.dur);
        e.weight = lerp(e.from, e.to, this.ease(k));
        if (k >= 1) { e.weight = e.to; e.dur = 0; }
      }
      e.action.setEffectiveWeight(e.weight * this.masterWeight);
    }

    // Retire finished fade-outs so the mixer is not evaluating dead actions.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.to === 0 && e.dur === 0 && e.weight <= 0.0005) {
        e.action.stop();
        this.entries.splice(i, 1);
      }
    }
  }
}
