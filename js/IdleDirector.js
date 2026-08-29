import { Selector, feature01 } from './MotionSelector.js';
import { SmoothedValue, SeededRandom } from './AnimationSmoothing.js';

/**
 * The idle director — a second motion matching layer, for the upper body.
 *
 * The locomotion matcher answers "what are the legs doing". This one answers
 * "what is he doing with his arms and his attention", over the same kind of
 * feature space: how long he has been standing still, whether he is moving, and
 * whether there is something in front of him worth touching.
 *
 * Running it as a matcher rather than a hand-written state machine is what makes
 * the long idle interesting. Boredom accrues against whichever behaviour is
 * active and decays once it is not, so the same features produce a different
 * order every time — a fidget take, then fold the arms, then back to watching
 * the room — without a single scripted sequence.
 *
 * The fidget takes are the library's full-body idle breaks (idle_break_01..06
 * standing, crouch_idle_break_01..05 crouched), played on this masked layer:
 * the base layer keeps the pelvis and legs on the idle loop while the masked
 * layer plays the break's torso, arms and head. They were measured to be
 * pelvis-static and pose-cyclic, so looping them on the layer is clean and
 * there is nothing to fight in the legs. The standing and crouched sets are
 * distinct because a standing take blended over a crouched body would pop the
 * torso; the director always draws from the set that matches the crouch state
 * and aborts a take that has become the wrong one.
 *
 * A take is a one-shot, so once the selector offers the break candidate the
 * DIRECTOR owns it for the clip's duration — the selector keeps deciding in the
 * background (rest vs wall only, so its state is ready when the take ends), but
 * it cannot flip away mid-take. Free-flipping a one-shot the way the old loop
 * did crossfades the layer in and out every second, and the fade never
 * finishes.
 *
 * It also arbitrates between the *authored* and the *procedural* upper body.
 * The breaks are clips, blended over the locomotion layer through a bone mask;
 * the crossed arms and the hand-on-wall are solved, because no such clips
 * exist. All of it comes out of the same query, so it cannot fight.
 */

/** Feature weights. `wall` dominates: reacting to the environment outranks
 *  fidgeting, which is the whole point of the layer. */
const FEATURE_WEIGHTS = { settle: 1.0, move: 3.0, wall: 6.0 };

/** The break library, per crouch state — keys resolved against the database. */
const BREAK_CLIPS = {
  false: ['idle_break_01', 'idle_break_02', 'idle_break_03',
          'idle_break_04', 'idle_break_05', 'idle_break_06'],
  true:  ['crouch_idle_break_01', 'crouch_idle_break_02', 'crouch_idle_break_03',
          'crouch_idle_break_04', 'crouch_idle_break_05'],
};
const BREAK_COOLDOWN = 5.0;    // s of no-breaks after one, so idles breathe between takes
const BREAK_BIAS     = 1.5;    // cost added to the break candidate while it is out

/**
 * The behaviours the upper body can settle into. `clip` is resolved against the
 * animation database; `pose` is a solved target for ArmPoses. The break
 * candidate's clip is chosen at play time (a random take from the set that
 * matches the crouch state), which is why it carries no fixed clip.
 */
export const UPPER_BODY_CANDIDATES = [
  // Nothing on top: the locomotion clip shows through to the fingertips.
  { key: 'rest',  feats: { settle: 0.00, move: 0.00, wall: 0 }, clip: null,   pose: null },
  // A full-body fidget take, masked to the upper body.
  { key: 'break', feats: { settle: 0.55, move: 0.00, wall: 0 }, clip: null,   pose: null },
  // Solved, not authored — see ArmPoses.
  { key: 'cross', feats: { settle: 1.00, move: 0.00, wall: 0 }, clip: null,   pose: 'crossed' },
  // Hands on whatever is in front of him.
  { key: 'wall',  feats: { settle: 0.25, move: 0.35, wall: 1 }, clip: null,   pose: 'wall' },
];

const REST = UPPER_BODY_CANDIDATES[0];

const SETTLE_SECONDS = 12;   // idle time that maps to settle = 1
const MOVING_SPEED   = 2.2;  // speed that maps to move = 1

export class IdleDirector {
  /**
   * @param {object} deps
   * @param {import('./AnimationDatabase.js').AnimationDatabase} deps.db
   * @param {import('./AnimationLayers.js').AnimationLayer} deps.layer
   * @param {import('./MotionMatching.js').MotionMatching} deps.locomotion
   * @param {import('./LookAtSystem.js').LookAtSystem} deps.look
   * @param {object} deps.armPoses
   * @param {number} [deps.seed]
   */
  constructor({ db, layer, locomotion, look, armPoses, seed }) {
    this.db = db;
    this.layer = layer;
    this.locomotion = locomotion;
    this.look = look;
    this.armPoses = armPoses;
    this.rng = new SeededRandom(seed ?? 0x1d1e);
    this.enabled = true;

    this.selector = new Selector({
      hysteresis: 0.70,
      minDwell: 1.2,
      boredomRate: 0.13,
      boredomMax: 1.6,
      recoveryRate: 0.45,
    });

    // How much of the upper body the layer owns, and how folded the arms are.
    this.blend = new SmoothedValue(0, 3.0);
    this.crossed = new SmoothedValue(0, 2.0);

    this.current = 'rest';
    this.currentCandidate = REST;
    this.gazeMode = 'follow';

    // Break state: which take is on screen, how long it has run, and when the
    // break candidate may re-enter the pool.
    this._playingClip = null;
    this._breakCrouch = false;
    this._breakT = 0;
    this._breakUntil = 0;
    this._lastBreak = null;
  }

  /**
   * Decide. Runs before the mixer, because it sets the action weights the mixer
   * is about to read.
   *
   * @param {number} dt
   * @param {object} ctx
   * @param {number} ctx.speed
   * @param {number} ctx.idleTime   seconds since he last moved
   * @param {boolean} ctx.onGround
   * @param {boolean} ctx.crouch    is the character crouched (break set selector)
   * @param {number} ctx.wallEngaged  0..1, from WallHands
   * @param {number} ctx.now  game clock, for the break cooldown
   */
  update(dt, ctx) {
    const now = ctx.now ?? 0;
    const settle = feature01(ctx.idleTime, 0, SETTLE_SECONDS);
    const move = feature01(ctx.speed, 0, MOVING_SPEED);
    const wall = ctx.wallEngaged > 0.5 ? 1 : 0;

    // ── A take is on screen: the director owns the layer ────────────────────
    // The selector keeps running in the background on the non-clip candidates
    // so its boredom bookkeeping and current state are ready for the hand-off,
    // but it cannot flip the layer out from under a one-shot mid-take.
    if (this._playingClip) {
      this._breakT += dt;
      const entry = this.db.entryFor(this._playingClip);
      const dur = entry?.duration ?? 3;
      const wrongCrouch = this._breakCrouch !== !!ctx.crouch;
      // A fidget take is a standing-still behaviour: the moment he moves or
      // leaves the ground it is aborted, not played out over the walk.
      const moving = ctx.speed > 1.2 || !ctx.onGround;
      if (wrongCrouch || this._breakT >= dur || moving) {
        this._endTake(now, moving || wrongCrouch);
      }
    }

    if (this._playingClip) {
      // ── A take is on screen: the director owns the layer ──────────────────
      // The selector keeps running in the background on the non-clip candidates
      // so its boredom bookkeeping and current state are ready for the hand-off,
      // but it cannot flip the layer out from under a one-shot mid-take.
      this.selector.select(
        this.enabled ? [REST, UPPER_BODY_CANDIDATES[3]] : [REST],
        { settle, move, wall }, FEATURE_WEIGHTS, dt
      );
      this.current = 'break';
      this.currentCandidate = UPPER_BODY_CANDIDATES[1];
      this.blend.set(1, 3.0);
    } else {
      // ── No take: the normal match ─────────────────────────────────────────
      // The break candidate is only offerable after its cooldown, and crossed
      // arms are never offered while a take's fade-out is still settling.
      const breakOfferable = now >= this._breakUntil;
      const pool = (this.enabled ? UPPER_BODY_CANDIDATES : [REST])
        .filter(c => c.key !== 'break' || breakOfferable);
      for (const c of pool) c.bias = (c.key === 'break' && !breakOfferable) ? BREAK_BIAS : 0;

      const result = this.selector.select(pool, { settle, move, wall }, FEATURE_WEIGHTS, dt);
      const candidate = pool.find(c => c.key === result.key) ?? REST;
      this.current = candidate.key;
      this.currentCandidate = candidate;

      if (candidate.key === 'break') {
        const clip = this._pickBreak(!!ctx.crouch);
        if (clip) {
          this.layer.play(clip, { key: clip.name, blendIn: 0.7, blendOut: 0.7, matchPhase: false });
          this._playingClip = clip.name;
          this._breakCrouch = !!ctx.crouch;
          this._breakT = 0;
          this.blend.set(1, 3.0);
        } else {
          // Library missed: pull the candidate out so it does not re-query
          // every 83 ms of its life against an absent clip.
          this._breakUntil = now + BREAK_COOLDOWN;
          this.blend.set(0, 3.0);
        }
      } else if (candidate.clip) {
        const clip = this.db.get(candidate.clip);
        if (clip) {
          if (this.layer.currentKey !== candidate.clip) {
            this.layer.play(clip, { key: candidate.clip, blendIn: 0.7, blendOut: 0.7, matchPhase: false });
          }
          this.blend.set(1, 3.0);
        } else {
          this.blend.set(0, 3.0);
        }
      } else {
        this.layer.release(0.6);
        this.blend.set(0, 3.0);
      }
    }

    const blend = this.blend.update(dt);

    // Exact weighted blend: the mixer normalises per bone by total weight, so
    // base (1-f) against layer (f) gives a blend fraction of f on the masked
    // bones and leaves the legs on the base clip alone.
    this.layer.setWeight(blend);
    this.locomotion.setLayerWeight(1 - blend * 0.92);

    // ── Procedural upper body ───────────────────────────────────────────────
    // A hand on a wall outranks folded arms, and the two write the same joints,
    // so the fold starts releasing the moment a surface is found rather than
    // after the matcher has finished changing its mind. The fold never plays
    // over a take — the take owns the arms.
    const folding = this.current === 'cross' && wall === 0;
    this.crossed.set(folding ? 1 : 0, folding ? 1.6 : 2.4);
    this.crossed.update(dt);

    // ── Attention ──────────────────────────────────────────────────────────
    this.gazeMode = settle > 0.35 && !wall ? 'scan' : 'follow';
    if (this.look) this.look.setMode(this.gazeMode);
  }

  /**
   * Apply the solved poses. Runs after the mixer and after look-at, so the arms
   * fold around the torso the look has already turned.
   */
  applyPoses(ctx) {
    if (this.crossed.value > 0.01 && this.armPoses) {
      this.armPoses.updateCrossed(this.crossed.value, ctx);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  _endTake(now, abort) {
    this.layer.release(0.6);
    this._playingClip = null;
    this._breakUntil = now + BREAK_COOLDOWN;
    if (abort) this.selector.force(REST.key);
  }

  _pickBreak(crouch) {
    const set = BREAK_CLIPS[crouch];
    if (!set) return null;
    // Never the same take twice in a row — a repeated take reads as a stuck
    // loop, and the set is large enough that skipping costs nothing.
    let available = set
      .filter(key => this.db.get(key))
      .map(key => ({ key, clip: this.db.get(key) }));
    if (available.length > 1) available = available.filter(a => a.key !== this._lastBreak);
    if (available.length === 0) return null;
    const pick = available[Math.floor(this.rng.next() * available.length) % available.length];
    this._lastBreak = pick.key;
    return pick.clip;
  }
}
