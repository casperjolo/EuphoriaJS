import * as THREE from 'three';
import { TransitionBlender } from './TransitionBlender.js';
import { Selector } from './MotionSelector.js';

// Speed thresholds (m/s)
const WALK_MIN   = 0.15;
const RUN_MIN    = 2.6;
const SPRINT_MIN = 4.8;

// Blend durations (seconds). Locomotion blends are the visible ones: too short
// and the crossfade reads as a snap, too long and the feet slide because the
// outgoing clip is still driving the legs while the new one takes over.
const BLEND_QUICK  = 0.14;
const BLEND_NORMAL = 0.26;
const BLEND_JUMP   = 0.12;

// A clip must be better than the incumbent by this factor to take over. Without
// it, a strafe held at 45° sits exactly between two clips and the matcher
// alternates every query, so neither crossfade ever completes.
const HYSTERESIS = 0.82;
const MIN_DWELL  = 0.26;

const FEATURE_WEIGHTS = { vx: 1.0, vz: 1.0, tier: 4.0 };

function speedTier(speed) {
  if (speed < WALK_MIN)   return 0; // idle
  if (speed < RUN_MIN)    return 1; // walk
  if (speed < SPRINT_MIN) return 2; // run
  return 3;                          // sprint
}

/**
 * Locomotion motion matching.
 *
 * Each clip carries a feature vector — local velocity direction `(vx, vz)` plus
 * a speed tier — and the query picks the cheapest one. The interesting part is
 * what keeps the result stable: hysteresis plus a minimum dwell (see
 * `MotionSelector`), and eased rather than linear crossfades with gait-phase
 * continuity (see `TransitionBlender`).
 *
 * Also acts as the *base* animation layer: `setLayerWeight` scales every clip it
 * plays, which is how the upper-body layer takes over the torso and arms while
 * the legs keep running underneath.
 */
export class MotionMatching {
  constructor(mixer, database) {
    this.mixer = mixer;
    this.db    = database;

    this.blender = new TransitionBlender(mixer, { defaultBlend: BLEND_NORMAL });
    this.selector = new Selector({ hysteresis: HYSTERESIS, minDwell: MIN_DWELL });

    this._queryTimer = 1;            // run the first query immediately
    this._QUERY_INTERVAL = 0.08;     // ~12 Hz; a per-frame query is wasted work
  }

  /** Base layer weight — driven down while an upper-body layer is blended in. */
  setLayerWeight(w) {
    this.blender.masterWeight = w;
  }

  /**
   * Advance the in-flight crossfades. Must be called every frame, before
   * `mixer.update()` — the mixer reads the weights it sets.
   */
  advance(dt) {
    this.blender.update(dt);
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} localVel  character-local velocity (X=right, Z=forward)
   * @param {number} speed            scalar m/s
   */
  update(dt, localVel, speed) {
    this._queryTimer += dt;
    if (this._queryTimer < this._QUERY_INTERVAL) return;
    this._queryTimer = 0;

    const key = this._query(localVel, speed);
    if (!key) return;
    this._play(key, BLEND_NORMAL);
  }

  /** Jump states bypass the query and drive the clip directly. */
  forceTransition(key, blendIn = BLEND_QUICK) {
    if (this.selector.current === key) return;
    this.selector.force(key);
    this._play(key, blendIn ?? BLEND_JUMP, blendIn ?? BLEND_JUMP);
  }

  _query(localVel, speed) {
    const tier = speedTier(speed);
    const len = Math.sqrt(localVel.x * localVel.x + localVel.z * localVel.z);
    const dvx = len > 0.001 ? localVel.x / len : 0;
    const dvz = len > 0.001 ? localVel.z / len : 0;

    // Locomotion only. Jump clips are driven by the phase machine and turn
    // clips are not currently selectable — their tier would cost them the query
    // anyway, but filtering keeps the intent explicit rather than incidental.
    const candidates = this.db.available().filter(e => e.tier <= 3);
    if (candidates.length === 0) return null;

    const result = this.selector.select(
      candidates.map(toFeatureCandidate),
      { vx: dvx, vz: dvz, tier },
      FEATURE_WEIGHTS,
      this._QUERY_INTERVAL
    );
    return result.key;
  }

  _play(key, blendIn = BLEND_NORMAL, blendOut = BLEND_NORMAL) {
    if (this.blender.currentKey === key && !this.blender.isBlending) return;
    const clip = this.db.get(key);
    if (!clip) return;
    this.blender.play(clip, { key, blendIn, blendOut, matchPhase: true });
  }

  stopAll() {
    this.blender.stopAll();
    this.selector.reset();
  }

  getCurrentKey() { return this.blender.currentKey ?? this.selector.current; }
}

/**
 * Manifest entries are `{ key, vx, vz, tier }`; the selector wants
 * `{ key, feats }`. Memoised on the entry so the 12 Hz query does not
 * re-allocate a candidate object per clip per query.
 */
const _candidateCache = new WeakMap();
function toFeatureCandidate(entry) {
  let c = _candidateCache.get(entry);
  if (!c) {
    c = { key: entry.key, feats: { vx: entry.vx, vz: entry.vz, tier: entry.tier } };
    _candidateCache.set(entry, c);
  }
  return c;
}
