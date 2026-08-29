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
 * active and decays once it is not, so the same five features produce a
 * different order every time — talk, then fold the arms, then back to watching
 * the room — without a single scripted sequence.
 *
 * It also arbitrates between the *authored* and the *procedural* upper body. The
 * talk take is a clip, blended over the locomotion layer through a bone mask;
 * the folded arms are solved, because no such clip exists. Both come out of the
 * same query, so they cannot fight.
 */

/** Feature weights. `wall` dominates: reacting to the environment outranks
 *  fidgeting, which is the whole point of the layer. */
const FEATURE_WEIGHTS = { settle: 1.0, move: 3.0, wall: 6.0 };

export const UPPER_BODY_CANDIDATES = [
  // Nothing on top: the locomotion clip shows through to the fingertips.
  { key: 'rest',  feats: { settle: 0.00, move: 0.00, wall: 0 }, clip: null,   pose: null },
  // The one social take in the library, masked to the upper body.
  { key: 'talk',  feats: { settle: 0.45, move: 0.00, wall: 0 }, clip: 'talk', pose: null },
  // Solved, not authored — see ArmPoses.
  { key: 'cross', feats: { settle: 1.00, move: 0.00, wall: 0 }, clip: null,   pose: 'crossed' },
  // Hands on whatever is in front of him.
  { key: 'wall',  feats: { settle: 0.25, move: 0.35, wall: 1 }, clip: null,   pose: 'wall' },
];

const SETTLE_SECONDS = 12;   // idle time that maps to settle = 1
const MOVING_SPEED   = 2.2;  // speed that maps to move = 1

export class IdleDirector {
  /**
   * @param {object} deps
   * @param {import('./AnimationDatabase.js').AnimationDatabase} deps.db
   * @param {import('./AnimationLayers.js').AnimationLayer} deps.layer
   * @param {import('./MotionMatching.js').MotionMatching} deps.locomotion
   * @param {import('./LookAtSystem.js').LookAtSystem} deps.look
   * @param {ArmPoses} deps.armPoses
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
    this.currentCandidate = UPPER_BODY_CANDIDATES[0];
    this.gazeMode = 'follow';
    this._playingClip = null;
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
   * @param {number} ctx.wallEngaged  0..1, from WallHands
   */
  update(dt, ctx) {
    const settle = feature01(ctx.idleTime, 0, SETTLE_SECONDS);
    const move = feature01(ctx.speed, 0, MOVING_SPEED);
    const wall = ctx.wallEngaged > 0.5 ? 1 : 0;

    const result = this.selector.select(
      this.enabled ? UPPER_BODY_CANDIDATES : [UPPER_BODY_CANDIDATES[0]],
      { settle, move, wall },
      FEATURE_WEIGHTS,
      dt
    );

    const candidate = UPPER_BODY_CANDIDATES.find(c => c.key === result.key) ?? UPPER_BODY_CANDIDATES[0];
    this.current = candidate.key;
    this.currentCandidate = candidate;

    // ── Authored upper body: play the masked clip, fade the layer in ────────
    if (candidate.clip) {
      const clip = this.db.get(candidate.clip);
      if (clip) {
        if (this._playingClip !== candidate.clip) {
          this.layer.play(clip, { key: candidate.clip, blendIn: 0.7, blendOut: 0.7, matchPhase: false });
          this._playingClip = candidate.clip;
        }
        this.blend.set(1, 3.0);
      } else {
        this.blend.set(0, 3.0);
      }
    } else {
      if (this._playingClip) {
        this.layer.release(0.6);
        this._playingClip = null;
      }
      this.blend.set(0, 3.0);
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
    // after the matcher has finished changing its mind.
    const folding = candidate.pose === 'crossed' && wall === 0;
    this.crossed.set(folding ? 1 : 0, folding ? 1.6 : 2.4);
    this.crossed.update(dt);

    // ── Attention ───────────────────────────────────────────────────────────
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
}
