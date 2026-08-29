# Motion Matching — how it works and how to extend it

This document is the map for the character's animation system: the motion
matcher, the clip library, the retargeter, and the idle/upper-body layer.
Read it top to bottom once; every section points at the code that does the
work.

---

## 1. The layer stack

Four systems write to the skeleton, in this order (each runs once per frame,
see the game loop in `js/main.js`):

```
1. MotionMatching   base layer — the legs + pelvis, a continuous clip query
2. IdleDirector     masked upper-body layer — torso/arms/head breaks, crossed
                    arms, wall hands; the base layer shows through the legs
3. Procedural       look-at, body lean, arm poses — weighted deltas applied
                    on top of whatever the two layers produced
4. FootPlanting     final IK pass — the feet pinned to the terrain, the pelvis
                    corrected by however far the lower foot had to reach
```

The layers mix because three.js's `PropertyMixer` accumulates a *weighted
average* per bone: the base layer at weight `1-w` and an upper layer at `w`
blend on the bones both animate, while a bone only the base animates (the
legs) keeps its pose exactly. `js/TransitionBlender.js` is the eased
crossfade engine shared by both layers; `js/AnimationLayers.js` adds the bone
mask.

## 2. The locomotion query (the core of the matcher)

`js/MotionMatching.js` replaces an 8-direction gait state machine with one
continuous query.

**Feature space.** Every locomotion clip in the library carries the features
the manifest tool *measured from its own root motion* (not assumed from the
file name):

| feature | meaning |
|---|---|
| `vx`, `vz` | average body-frame velocity direction — X = right, Z = forward |
| `speed` | its magnitude in m/s |
| `tier` | 0 idle · 1 walk · 2 run · 3 sprint · 4 crouch |

**The query** is the character's current body-frame velocity (the controller
computes it each frame), normalised to a direction, plus the speed tier and
the crouch flag. The body is free to face any way: the controller turns it
toward its travel direction at a limited rate, so in steady state the local
velocity points straight ahead and the forward loops win — while a turn sweeps
the local velocity through the whole circle and the matcher rides the
diagonal/strafe loops for the duration of the turn. One continuous query
replaces the direction state machine.

**Speed within a tier is continuous.** The winning clip is time-scaled to the
exact current speed (`clamp(speed / clip.speed, 0.55, 1.5)`), so accelerating
never waits for a gait swap. Tiers are *gated*, not costed — a sprint gait at
walking speed reads as slow motion, so tier boundaries are hard and the
crossfade at them does the work. Thresholds: walk < 0.25, run < 3.4, sprint <
6.0 m/s (sitting between the controller's target speeds of 2.4 / 4.4 / 7.2).

**Stability.** A query at ~12 Hz over a feature boundary would otherwise
alternate two clips forever. Three guards, in `js/MotionSelector.js`:
hysteresis (a challenger must be better by a factor, 0.82), dwell (a minimum
time between switches, 0.26 s), and boredom (a candidate accrues cost while
active — what makes the idle layer rotate through behaviours). The
`TransitionBlender` seeds the incoming clip with the outgoing one's gait
phase, so a mid-stride swap does not read as a stumble.

**Idle states** (`idle_loop` / `crouch_idle_loop`) are not queried — they play
directly when the tier is 0 (or 4 at rest).

## 3. One-shots: jumps and crouch

Jump and crouch bypass the query and drive clips by name.

**Jump phase machine** (`CharacterController` → `MotionMatching.setJumpPhase`):
`begin` (0.35 s) → `air` (fall) → `land` (0.75 s) → `none`. The take-off and
landing clips are themselves tiny matchers over the measured library:

- **Start:** `jump_start_{class}_{dir}_{foot}` — speed class (stand/walk/run/
  sprint), travel quadrant (F/B/LL/RL), alternating foot. Falls back to the
  `any` takes and then forward.
- **Air:** `jump_fall` — the 30 m cliff loop.
- **Land:** a long fall (air-time ≥ 1.6 s) ends in a `jump_land_roll`, a
  sprint-speed landing stumbles, otherwise the class ladder
  sprint→run→walk→stand × impact (light/heavy) × direction.

The jump clips are the library's *full-fall takes*: a Start clip is authored as
crouch + jump + the whole 15 m fall, a Land clip starts several metres in the
air. That is why their vertical motion is **not** baked as a pelvis track —
the controller owns the physics, and the retargeter clamps/bakes per role
(see §5). The take-off squat and the impact dip *are* in the clips (leg bend +
clamped pelvis drop), and `BodyLean` adds a small procedural dip on top.

**Crouch** is a KeyC toggle (grounded; an airborne toggle is buffered and
applied on landing). It plays the measured `transition_stand_to_crouch` /
`transition_crouch_to_stand` one-shots, suppresses the query for 0.55 s (long
enough for the squat/stand to finish — the clips then hold the new posture,
so the hand-off to the crouch loops is a same-posture crossfade), and caps
locomotion at 2.0 m/s to match the crouch gait. The crouch loops are a full
tier of their own (tier 4) with their own measured directions.

## 4. The clip library

`js/ClipLibrary.js` is the manifest: every playable clip with the features the
matcher queries, generated from the `Animations/` folder by
`tools/clip-manifest.mjs` (**`npm run clips`**, ~12 s). Currently **129 FBX
loaded → 120 playable entries**, 767 files cataloged, 9 excluded.

The tool:

1. **Classifies every FBX by file name** (the naming convention below).
2. **Loads and measures each playable clip headlessly**: body-frame velocity
   (direction + speed), the yaw range of the root (τ = 0.4 s low-pass), the
   pelvis vertical profile vs the rest height, and start/end pose distance
   (loopability).
3. **Applies curation rules** and emits the manifest plus a coverage report
   (tier × direction grid, with every exclusion and why):
   - loops that *rotate* the body (yaw range > 30°) are not matcher-usable —
     the query assumes the body faces its travel direction;
   - a clip whose max speed is > 4× its mean *and* > 5 m/s has broken
     keyframes (the `walk_lr/rl` pair, ~70 m/s) — excluded;
   - 20°-variant loops that sit < 12° from the same-tier clip they duplicate
     are excluded (the redundant sprints);
   - `_offset` loops are catalog-only variants of the same gait;
   - jump clips are trusted by name (their verticals are authored falls, so
     the spike screen would false-positive on free-fall acceleration).

`pelvisBobReference` (−0.024 m) is pinned in the manifest to the standing
idle loop's mean pelvis height, so "0" means "standing" for every bob value.

### Naming convention

All source clips are `M_Neutral_*` on the UEFN mannequin rig (Z-up, cm).
Recognised patterns, mapped to library keys:

| file pattern | library key | role |
|---|---|---|
| `Walk\|Run\|Sprint\|Crouch_Loop_F\|B\|FL\|FR\|BL\|BR\|LL\|LR\|RL\|RR` | `walk_f`, `run_fl`, … | loop (queried) |
| `…_Loop_F_(L\|R)_20` | `walk_f_l20`, … | loop (gap-filler angles) |
| `…_Loop_Strafe_…` | `run_strafe_…` | loop (queried) |
| `Stand_Idle_Loop` / `Crouch_Idle_Loop` | `idle_loop` / `crouch_idle_loop` | idle-loop |
| `Stand_Idle_Break_vNN` / `Crouch_Idle_Break_vNN` | `idle_break_01..06` / `crouch_idle_break_01..05` | idle-break (upper layer) |
| `Transition_X_to_Y[_Lfoot\|_Rfoot]` | `transition_stand_to_crouch`, `transition_walk_to_run_lfoot`, … | one-shot |
| `Jump_Loop_Fall` | `jump_fall` | jump-fall |
| `Jump_(F\|B\|LL\|RL)_Start_(Stand\|Walk\|Run\|Sprint)_(L\|R)foot` | `jump_start_walk_f_l`, … | jump-start |
| `Jump_(B\|LL\|RL)_Start_(L\|R)foot` | `jump_start_any_b_l`, … | jump-start (any speed) |
| `Jump_(F\|B\|LL\|RL)_Land_(Stand\|Walk\|Run\|Sprint)_(Light\|Heavy)[_(L\|R)foot]` | `jump_land_walk_light_f_l`, … | jump-land |
| `Jump_(F\|B\|LL\|RL)_Land_(Stumble\|Roll)_(L\|R)foot` | `jump_land_roll_l`, … | jump-land-special |

Everything else (pattern loops, pivots, traversal, aim-offsets, poses, curve
containers) is **cataloged but not loaded** — it stays visible in the report
for future modes (weaving, aiming) without paying for it at runtime.

## 5. Retargeting

`js/Retargeting.js` bakes every source clip onto Fred's skeleton at load time
(`AnimationDatabase.retarget`), so runtime cost is identical to ordinary
clips. The source rig and the target rig differ in axis convention (Z-up cm
vs Y-up m), units, *and* rest pose (A-pose vs arms down), so raw quaternion
copy is meaningless. The method:

- a global alignment **A** is measured from rest geometry (hips→head up axis,
  right-thigh→left-thigh left axis) on both rigs;
- each pose is the world-space **delta from the source's own rest**
  (`D = Sw_anim · Sw_rest⁻¹`), transported as `A·D·A⁻¹`;
- each bone is first anchored into the pose that *corresponds* to the source
  rest (the target holding the source's rest), so the A-pose/arms-down
  mismatch cancels instead of doubling; bones with no measured child (hands,
  feet) inherit their parent's correction;
- 20 bones map (`MANNEQUIN_BONE_MAP`); `spine_04/05` are unmapped on purpose
  (Fred's `SKEL_Spine3` is owned by the procedural torso twist).

**Pelvis bob.** Horizontal root motion is dropped (the controller owns
position), but the pelvis *vertical* is baked as a position track on
`SKEL_Pelvis_00`, relative to `pelvisBobReference`. Per-role rules
(`BOB_RULE` in `js/AnimationDatabase.js`):

| role | rule | why |
|---|---|---|
| loops, idles, breaks | `full` | the gait bob and crouch depth are the animation |
| crouch transitions | `full` | must reach (and leave) true crouch depth or it pops into the deeper crouch loops |
| jump start / land | `crouch` (clamped to ≤ 0) | the take-off rise and the airtime fall belong to physics; the squat and the impact dip are real and stay |
| jump fall | `none` | pure physics |

`FootPlanting` adds its slope correction **on top of** whatever the mixer
wrote each frame (it reads the animated Y first), so the two never fight.

## 6. Adding or curating clips — the workflow

1. **Drop the FBX into `Animations/`** with a name from the convention above.
   The mannequin rig is expected (the same 89-node Z-up rig the library uses).
2. **`npm run clips`** — regenerates `js/ClipLibrary.js` and prints the
   coverage report. Read it:
   - the new key should appear in the tier × direction grid;
   - every exclusion lists a reason (rotates / spikes / duplicate / offset);
   - `--verbose` prints the per-clip measurement line (speed, yaw range,
     vertical, loopability); `--dry-run` measures without writing.
3. **Decide what the new clip means for the matcher.** A loop needs a free
   grid cell (a direction × tier) — if it duplicates an existing cell within
   ~12° it will be excluded, which is usually correct. A one-shot (jump,
   transition, idle break) just needs its key to match what
   `MotionMatching`/`IdleDirector` request — search the code for the key
   pattern if you are unsure which names are driven.
4. **`npm test`** — the pipeline test boots the full stack against the real
   assets: it will retarget the new clip and fail loudly if the rig basis,
   the track names, or the bone map breaks.
5. **Run it and watch:** `npm start`, then use the HUD and the debug keys —
   `D` dumps the current query's costs as a table (the fastest way to see
   which clips are competing and why), `B` dumps bone names, `1–4` toggle
   the procedural systems. The HUD shows the active clip, its time scale,
   the speed tier, jump phase and air-time.

If a clip measures wrong (speed in the wrong tier, a direction off by 20°),
that is a problem *with the clip*, not the matcher — the library is the
ground truth and the matcher trusts it. Re-measure with `--verbose` before
touching weights.

## 7. Tuning knobs

Where the numbers live, for the things that will actually be tuned:

| knob | where | note |
|---|---|---|
| tier thresholds (0.25 / 3.4 / 6.0 m/s) | `MotionMatching.js` (`WALK_MIN`/`RUN_MIN`/`SPRINT_MIN`) + controller targets | sit between the controller's target speeds |
| blend durations | `MotionMatching.js` | locomotion 0.26 s, gait swap 0.30, jump 0.12, crouch 0.45 |
| hysteresis / dwell | `MotionMatching.js` | 0.82 / 0.26 s — lower them only if a gait feels late |
| time-scale limits | `MotionMatching.js` | 0.55–1.5 — beyond these the gait reads as slow-mo/blur |
| controller speeds / gravity / jump | `CharacterController.js` | walk 2.4, run 4.4, sprint 7.2, crouch 2.0 |
| jump phase lengths (0.35 / 0.75 s) | `CharacterController.js` | tuned to the measured take-off/landing takes |
| landing thresholds (roll 1.6 s, stumble 6.2 m/s) | `MotionMatching.js` | |
| idle break set + cooldown | `IdleDirector.js` | 5 s cooldown between takes |
| idle behaviour features/weights | `IdleDirector.js` (`UPPER_BODY_CANDIDATES`) | settle/move/wall |
| bone map, bob rules | `Retargeting.js` / `AnimationDatabase.js` | |
| bob reference height | manifest (`pelvisBobReference`) | pinned to the standing idle loop |

## 8. Tests

- `tests/unit.test.mjs` — the pure math: smoothing, the selector
  (hysteresis/dwell/boredom), the blender, the environment, look distribution.
- `tests/integration.test.mjs` — the procedural stack on a synthetic rig, and
  the module-surface guard (every module exports what it claims).
- `tests/pipeline.test.mjs` — the whole stack on the **real assets**: loads
  Fred + all 120 clips, retargets, and simulates 30 s of idling (breaks and
  crossed arms), walking (gait clips), walking into the wall (hands), a full
  jump (phase machine + pelvis dip), crouch enter/exit (transition + capped
  speed), and the landing matcher (roll/stumble/class/direction). This is the
  test that catches a wiring mistake rather than a logic one.

`npm test` runs all three; it must stay green on every change.
