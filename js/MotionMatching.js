import { TransitionBlender } from './TransitionBlender.js';
import { Selector } from './MotionSelector.js';

/**
 * Locomotion motion matching — the base animation layer.
 *
 * Feature space
 * -------------
 * Each locomotion clip carries the features the manifest tool measured from
 * its own root motion:
 *
 *   (vx, vz)   average body-frame velocity direction (X = right, Z = forward)
 *   speed      its magnitude in m/s
 *   tier       0 idle · 1 walk · 2 run · 3 sprint · 4 crouch
 *
 * The query is the character's CURRENT body-frame velocity, normalised, plus
 * the speed tier (and the crouch flag). The body is free to face any way —
 * the controller turns it toward its travel direction at a limited rate, so
 * in steady state the local velocity is straight ahead and the forward loops
 * win, while a turn sweeps the local velocity through the whole circle and
 * the matcher rides the diagonal/strafe loops for the duration of the turn.
 * That is the entire trick: one continuous query replaces the 8-direction
 * state machine.
 *
 * Speed within a tier is continuous: the winning clip is time-scaled to the
 * exact current speed (clamped to sane limits), so accelerating never waits
 * for a gait swap. Tiers are *gated*, not costed — a sprint gait played at
 * walking speed reads as slow motion, so the tier boundary is hard and the
 * crossfade at it does the work.
 *
 * Stability
 * ---------
 * A query every ~83 ms over a feature boundary would otherwise alternate
 * between two clips and the crossfade would never finish. `Selector`
 * (hysteresis + dwell) guards against it; `TransitionBlender` eases the
 * crossfades and seeds the incoming clip with the outgoing one's gait phase.
 *
 * One-shots
 * ---------
 * Jump phases and the crouch transitions bypass the query and drive a clip
 * directly (see `setJumpPhase` / `setCrouch`). Jump start and landing are
 * themselves tiny matchers over the measured library: speed class ×
 * travel quadrant × foot, with roll/stumble for big falls.
 *
 * This object is also the *base* layer: `setLayerWeight` scales everything it
 * plays, which is how the masked upper-body layer takes over the torso and
 * arms while the legs keep moving underneath.
 */

// Speed thresholds (m/s) — sit between the controller's target speeds
// (walk 2.4 / run 4.4 / sprint 7.2).
export const WALK_MIN   = 0.25;
export const RUN_MIN    = 3.4;
export const SPRINT_MIN = 6.0;

// Blend durations (s). Locomotion blends are the visible ones: too short and
// the crossfade reads as a snap, too long and the feet slide because the
// outgoing clip is still driving the legs while the new one takes over.
const BLEND_NORMAL = 0.26;
const BLEND_IDLE   = 0.30;
const BLEND_JUMP   = 0.12;
const BLEND_TIER   = 0.30;   // gait swaps (walk↔run) get a beat more
const BLEND_CROUCH = 0.45;

// A clip must be better than the incumbent by this factor to take over.
const HYSTERESIS = 0.82;
const MIN_DWELL  = 0.26;

// The (vx, vz) direction does all the work within a tier; the weights only
// matter if the feature space ever gains more dimensions.
const FEATURE_WEIGHTS = { vx: 1.0, vz: 1.0 };

const QUERY_INTERVAL = 0.08;  // ~12 Hz; a per-frame query is wasted work

// Time-scale limits: outside these the gait reads as slow motion / a blur.
const TIME_SCALE_MIN = 0.55;
const TIME_SCALE_MAX = 1.5;

// Landing selection thresholds.
const LAND_HEAVY_SPEED  = 3.5;   // m/s — above this the landing is "heavy"
const STUMBLE_SPEED     = 6.2;   // m/s — a sprint-speed landing stumbles
const ROLL_AIRTIME      = 1.6;   // s of fall — long falls end in a roll

export function speedTier(speed, crouch = false) {
  if (crouch) return 4;
  if (speed < WALK_MIN)   return 0;
  if (speed < RUN_MIN)    return 1;
  if (speed < SPRINT_MIN) return 2;
  return 3;
}

/**
 * Coarsen a body-frame velocity into the quadrant the jump library knows:
 * the take-off and landing clips come in F / B / LL / RL variants only, so
 * the right-side quadrants collapse onto F / B.
 */
export function velocityQuadrant(localVel) {
  const x = localVel.x, z = localVel.z;
  if (z >= Math.abs(x)) return 'f';
  if (z <= -Math.abs(x)) return 'b';
  if (x < 0) return z >= 0 ? 'll' : 'rl';
  return z >= 0 ? 'f' : 'b';
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class MotionMatching {
  constructor(mixer, database) {
    this.mixer = mixer;
    this.db    = database;

    this.blender = new TransitionBlender(mixer, { defaultBlend: BLEND_NORMAL });
    this.selector = new Selector({ hysteresis: HYSTERESIS, minDwell: MIN_DWELL });

    this._queryTimer = 1;         // run the first query immediately
    this._crouch     = false;
    this._hold       = 0;         // seconds the query stays suppressed (one-shots)
    this._lastJumpPhase = 'none';
    this._jumpCount   = 0;
    this._timeScale   = 1;
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

  getCurrentKey() { return this.blender.currentKey ?? this.selector.current; }
  getTimeScale()  { return this._timeScale; }
  isCrouching()   { return this._crouch; }

  /**
   * Enter or leave the crouch. Plays the measured transition clip as a
   * one-shot; the query resumes after it has done its work. The controller is
   * the source of truth — it only toggles this when grounded (or on landing).
   */
  setCrouch(on) {
    on = !!on;
    if (on === this._crouch) return;
    this._crouch = on;
    const key = on ? 'transition_stand_to_crouch' : 'transition_crouch_to_stand';
    if (!this.db.get(key)) return;
    this.selector.reset();
    this._play(key, { blendIn: BLEND_CROUCH, blendOut: BLEND_CROUCH, matchPhase: false, timeScale: 1 });
    this._hold = 0.55;
  }

  /**
   * Drive the jump phase machine. `ctx`: { speed, localVel, airTime }.
   * Called with the controller's current phase every frame; only acts on
   * transitions, so the repeated calls are free.
   */
  setJumpPhase(phase, ctx = {}) {
    if (phase === this._lastJumpPhase) return;
    const prev = this._lastJumpPhase;
    this._lastJumpPhase = phase;

    if (phase === 'begin') {
      this._jumpCount++;
      this.selector.reset();
      this._hold = 0;   // the query is off anyway while a jump phase is active
      this._play(this._pickJumpStart(ctx.speed, ctx.localVel),
                 { blendIn: BLEND_JUMP, timeScale: 1 });
    } else if (phase === 'air') {
      this._play('jump_fall', { blendIn: 0.15, timeScale: 1, matchPhase: false });
    } else if (phase === 'land') {
      this._play(this._pickJumpLand(ctx), { blendIn: BLEND_JUMP, timeScale: 1, matchPhase: false });
    } else if (phase === 'none' && prev !== 'none') {
      // Back on the ground: let the query resume immediately, and give it a
      // clean selector state (the jump clips are not query candidates).
      this.selector.reset();
      this._queryTimer = 1;
    }
  }

  /**
   * Continuous query. Safe to call unconditionally every frame — it no-ops
   * while a jump phase or a crouch transition owns the base layer.
   *
   * @param {number} dt
   * @param {import('three').Vector3} localVel  character-local velocity (X=right, Z=forward)
   * @param {number} speed            scalar m/s
   * @param {boolean} crouch
   */
  update(dt, localVel, speed, crouch = false) {
    this._crouch = crouch;
    this._hold = Math.max(0, this._hold - dt);

    const jumping = this._lastJumpPhase !== 'none';
    if (jumping || this._hold > 0) return;

    this._queryTimer += dt;
    if (this._queryTimer < QUERY_INTERVAL) return;
    this._queryTimer = 0;

    const tier = speedTier(speed, crouch);

    // Idle states play their loop directly — nothing to query.
    if (tier === 0) { this._playIdle('idle_loop', speed); return; }
    if (tier === 4 && speed < WALK_MIN) { this._playIdle('crouch_idle_loop', speed); return; }

    const candidates = this.db.available()
      .filter(e => e.role === 'loop' && e.tier === tier);
    if (candidates.length === 0) return;

    const len = Math.sqrt(localVel.x * localVel.x + localVel.z * localVel.z);
    const dvx = len > 0.001 ? localVel.x / len : 0;
    const dvz = len > 0.001 ? localVel.z / len : 0;

    const result = this.selector.select(
      candidates.map(toFeatureCandidate),
      { vx: dvx, vz: dvz },
      FEATURE_WEIGHTS,
      QUERY_INTERVAL
    );

    // Hysteresis held the incumbent: nothing to play, but the gait speed may
    // have changed, so its time scale still needs tracking.
    if (!result.changed) {
      this._trackTimeScale(result.key, speed);
      return;
    }

    const entry = this.db.entryFor(result.key);
    const gaitSwap = entry && entry.tier !== (this.db.entryFor(this.getCurrentKey())?.tier ?? entry.tier);
    this._play(result.key, {
      blendIn: gaitSwap ? BLEND_TIER : BLEND_NORMAL,
      timeScale: this._timeScaleFor(entry, speed),
    });
  }

  stopAll() {
    this.blender.stopAll();
    this.selector.reset();
  }

  /**
   * Dump the current query's costs — the tuning workbench.
   * `node --check` cannot find a bad weight; this lets a human see which clips
   * are competing and why.
   */
  dumpCosts(localVel, speed, crouch = false) {
    const tier = speedTier(speed, crouch);
    const rows = [];
    for (const e of this.db.available()) {
      if (e.role !== 'loop' || e.tier !== tier) continue;
      const c = { key: e.key, feats: { vx: e.feats.vx, vz: e.feats.vz } };
      const len = Math.hypot(localVel.x, localVel.z);
      const q = len > 0.001 ? { vx: localVel.x / len, vz: localVel.z / len } : { vx: 0, vz: 0 };
      rows.push({ key: e.key, dirDeg: Math.round(Math.atan2(e.feats.vx, e.feats.vz) * 57.3), cost: candidateCostValue(c, q, FEATURE_WEIGHTS) });
    }
    rows.sort((a, b) => a.cost - b.cost);
    console.table(rows.slice(0, 8));
    return rows;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  _timeScaleFor(entry, speed) {
    if (!entry || entry.feats.speed < 0.05) return 1;
    return clamp(speed / entry.feats.speed, TIME_SCALE_MIN, TIME_SCALE_MAX);
  }

  _trackTimeScale(key, speed) {
    const entry = this.db.entryFor(key);
    const ts = this._timeScaleFor(entry, speed);
    this._timeScale = ts;
    const ent = this.blender.entries.find(e => e.key === key);
    if (ent) ent.action.timeScale = ts;
  }

  _playIdle(key, speed) {
    this._timeScale = 1;
    if (this.blender.currentKey === key) {
      const ent = this.blender.entries.find(e => e.key === key);
      if (ent) ent.action.timeScale = 1;
      return;
    }
    this.selector.force(key);
    this._play(key, { blendIn: BLEND_IDLE, matchPhase: true, timeScale: 1 });
  }

  _pickJumpStart(speed, localVel) {
    const dir  = velocityQuadrant(localVel);
    const foot = this._jumpCount % 2 === 0 ? 'l' : 'r';
    const cls  = speed < 0.6 ? 'stand' : speed < RUN_MIN ? 'walk' : speed < SPRINT_MIN ? 'run' : 'sprint';
    const wanted = [`jump_start_${cls}_${dir}_${foot}`, `jump_start_any_${dir}_${foot}`,
                    `jump_start_${cls}_f_${foot}`, `jump_start_stand_f_${foot}`];
    for (const key of wanted) if (this.db.get(key)) return key;
    return 'jump_start_stand_f_l';
  }

  _pickJumpLand({ speed, localVel, airTime }) {
    const dir  = velocityQuadrant(localVel);
    const foot = this._jumpCount % 2 === 0 ? 'l' : 'r';

    // The spectacular landings first: a long fall ends in a roll, a
    // sprint-speed landing stumbles.
    if (airTime >= ROLL_AIRTIME) {
      const roll = `jump_land_roll_${foot}`;
      if (this.db.get(roll)) return roll;
    }
    if (speed >= STUMBLE_SPEED) {
      const stumble = `jump_land_stumble_${foot}`;
      if (this.db.get(stumble)) return stumble;
    }

    const cls    = speed < 0.6 ? 'stand' : speed < RUN_MIN ? 'walk' : speed < SPRINT_MIN ? 'run' : 'sprint';
    const impact = speed < LAND_HEAVY_SPEED ? 'light' : 'heavy';

    // Sprint landings only exist forward; everything else has a clip per
    // direction, and forward landings come in left/right foot variants.
    const ladder = cls === 'sprint' ? ['sprint', 'run', 'walk', 'stand']
                                    : [cls, 'run', 'walk', 'stand'];
    for (const c of ladder) {
      if (dir === 'f') {
        const key = `jump_land_${c}_${impact}_f_${foot}`;
        if (this.db.get(key)) return key;
      } else if (c === 'stand') {
        const key = `jump_land_stand_${impact}_${dir}_${foot}`;
        if (this.db.get(key)) return key;
      } else {
        const key = `jump_land_${c}_${impact}_${dir}`;
        if (this.db.get(key)) return key;
      }
    }
    return 'jump_land_walk_light_f_l';
  }

  _play(key, { blendIn = BLEND_NORMAL, blendOut = BLEND_NORMAL, matchPhase = true, timeScale = 1 } = {}) {
    const clip = this.db.get(key);
    if (!clip) return;

    if (this.blender.currentKey === key) {
      // Already up: only the gait speed may have changed.
      this._timeScale = timeScale;
      const ent = this.blender.entries.find(e => e.key === key);
      if (ent) ent.action.timeScale = timeScale;
      return;
    }

    this._timeScale = timeScale;
    this.blender.play(clip, { key, blendIn, blendOut, matchPhase, timeScale });
  }
}

// ── Feature candidate shim ────────────────────────────────────────────────────
/**
 * Manifest entries are `{ key, feats }`; the selector wants
 * `{ key, feats }` too, but over the locomotion subset only. Memoised on the
 * entry so the 12 Hz query does not re-allocate a candidate object per clip.
 */
const _candidateCache = new WeakMap();
function toFeatureCandidate(entry) {
  let c = _candidateCache.get(entry);
  if (!c) {
    c = { key: entry.key, feats: { vx: entry.feats.vx, vz: entry.feats.vz } };
    _candidateCache.set(entry, c);
  }
  return c;
}

// Local copy so the debug dump does not reach across modules for a plain
// function (the selector's is exported too, but this keeps the dump honest
// about what it computes).
function candidateCostValue(candidate, query, weights) {
  let cost = candidate.bias ?? 0;
  for (const k of Object.keys(candidate.feats)) {
    const w = weights[k] ?? 1;
    const d = candidate.feats[k] - (query[k] ?? 0);
    cost += w * d * d;
  }
  return cost;
}
