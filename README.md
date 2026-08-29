# EuphoriaJS
- NaturalMotion's Euphoria Engine on the Web.
  <img width="2172" height="724" alt="image" src="https://github.com/user-attachments/assets/54443d67-993d-4250-ab5a-00120184ebd8" />

GTA IV-styled third-person locomotion in Three.js: motion matching, procedural
two-bone IK, and foot planting over deformable terrain — plus a second animation
layer and a set of procedural behaviours that react to the room: he looks where
you look, leans into acceleration, gets restless when you leave him standing, and
puts his hands on a wall instead of walking through it.

## Running

Any static server works — ES modules and the FBX/GLB loaders need HTTP, not `file://`.

```bash
npx serve -l 5173 .
```

Then open <http://localhost:5173>.

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Move (camera-relative) |
| `Shift` | Sprint |
| `Space` | Jump |
| Mouse | Over-the-shoulder look (click to lock the pointer) |
| `1` `2` `3` `4` | Toggle look-at / idle layer / wall hands / body lean |
| `B` | Dump bone names to the console |

Walk into the grey wall ahead of the spawn and stop: the hands come up onto it.
Leave him alone for five seconds and he starts looking around; a few seconds
later he folds his arms.

## Architecture

| File | Role |
| --- | --- |
| [`js/main.js`](js/main.js) | Bootstrap, asset loading, frame loop |
| [`js/Retargeting.js`](js/Retargeting.js) | Bakes the source FBX rig onto Fred's skeleton |
| [`js/AnimationDatabase.js`](js/AnimationDatabase.js) | Clip manifest, FBX loading, retarget pass |
| [`js/MotionMatching.js`](js/MotionMatching.js) | Locomotion layer: picks the best clip for the current velocity |
| [`js/MotionSelector.js`](js/MotionSelector.js) | Feature query shared by both layers: cost, hysteresis, dwell, boredom |
| [`js/TransitionBlender.js`](js/TransitionBlender.js) | Eased crossfades, gait-phase continuity, layer master weight |
| [`js/AnimationLayers.js`](js/AnimationLayers.js) | Bone masks and the masked upper-body layer |
| [`js/IdleDirector.js`](js/IdleDirector.js) | Upper-body layer: what the arms and attention are doing |
| [`js/CharacterController.js`](js/CharacterController.js) | Input, acceleration, gravity, jump state machine, wall collision, idle clock |
| [`js/Environment.js`](js/Environment.js) | Box colliders, analytic raycast, character push-out |
| [`js/FootPlanting.js`](js/FootPlanting.js) | Ground contact detection, foot locking, pelvis drop |
| [`js/ProceduralPose.js`](js/ProceduralPose.js) | One ordered pass for every procedural bone write |
| [`js/LookAtSystem.js`](js/LookAtSystem.js) | Gaze target selection and spine/neck/head distribution |
| [`js/BodyLean.js`](js/BodyLean.js) | Acceleration lean, breathing, idle sway, landing dip |
| [`js/ArmPoses.js`](js/ArmPoses.js) | Folded arms, solved from hand targets |
| [`js/ArmIK.js`](js/ArmIK.js) | Blended arm IK and palm/finger alignment |
| [`js/WallHands.js`](js/WallHands.js) | Finds a surface in front of him and settles a hand on it |
| [`js/TwoBoneIK.js`](js/TwoBoneIK.js) | Analytical two-bone IK solver |
| [`js/RigBones.js`](js/RigBones.js) | Bone resolution by naming convention |
| [`js/AnimationSmoothing.js`](js/AnimationSmoothing.js) | Easing, damping, seeded RNG |
| [`js/GTACamera.js`](js/GTACamera.js) | Spring-arm over-the-shoulder camera |
| [`js/Terrain.js`](js/Terrain.js) | Floor plane, height field, normals |

### Animation retargeting

The animation library and the character do not share a skeleton, and the
mismatch runs deeper than bone names:

| | Source (`Animations/*.fbx`) | Target (`Fred.glb`) |
| --- | --- | --- |
| Naming | `B-thighL` (Blender) | `SKEL_L_Thigh_01` (RAGE) |
| Up axis | `+Z` | `+Y` |
| Units | centimetres | metres |
| Rest pose | T-pose | arms down |

`Retargeting.js` resolves all four at load time. A global rotation `A` is
measured from each rig's own geometry — "up" runs hips→head, "left" runs
right-thigh→left-thigh — which holds for any humanoid and makes units cancel.
Animation is then carried across as a world-space delta from the source's rest
pose, `D = Sw_anim · Sw_rest⁻¹`, transported into the target frame as
`A · D · A⁻¹`.

The subtle part is what that delta is applied *to*. Anchoring on Fred's bind
pose is wrong whenever the rest poses disagree: idle's "swing the arms down 90°"
would land on arms that are already down and double into crossed arms. So each
bone is first rotated into the pose *corresponding* to the source's rest by
turning its rest bone direction onto the source's:

```
R      = minimalRotation(d_target_rest, A · d_source_rest)
anchor = R · Tw_rest
Tw     = (A · D · A⁻¹) · anchor
```

A bone measures `R` from its own direction to its child. Leaf bones — the hands,
whose only children are unmapped fingers, and the feet — have no such direction,
so they inherit their nearest mapped ancestor's correction and stay rigidly
attached to a limb that *was* corrected. Falling back to identity there instead
leaves the bone anchored on the bind pose while its parent moves, and the delta
doubles onto it: that twists the hands and feet downward.

Fred's `SKEL_*_Foot_end_*` bones are deliberately unmapped. They are terminator
markers hanging straight down from the ankle, roughly `(0, -0.099, 0.008)`, not
toe joints — the source rig's real toes point mostly forward. Treating them as a
bone direction aligns "down" onto "forward" and torques the whole foot.

Only quaternion tracks are emitted, so the centimetre/metre scale difference
never reaches the target. Everything is baked into ordinary `AnimationClip`s, so
runtime cost is the same as any other clip.

### Facing convention

Fred's mesh faces `-Z` at zero rotation, but the controller, the camera and the
IK pole vectors all speak the usual `+Z`-forward convention. Aiming his `+Z` axis
along the travel direction leaves him running backwards. Rather than scatter a
180° offset through each consumer, `main.js` normalises it once: the model is
turned to face `+Z` inside a `CharacterRoot` wrapper, and everything downstream
drives the wrapper, whose `+Z` is genuinely forward. Retargeting is unaffected —
the baked clips store bone-local rotations, and a rotation applied to the root
cancels out of the world-to-local conversion.

`_bodyYaw` is that facing angle: yaw `φ` means facing `(sin φ, cos φ)`.

The body only ever turns while moving, to face its travel direction. Standing
still it is left exactly where it is, so the camera can orbit all the way around
without dragging his facing along — and foot planting, which locks his feet to
the ground, is never asked to twist the legs against those locks.

### Motion matching

Each clip is tagged with a feature vector — local velocity direction `(vx, vz)`
plus a speed tier (idle/walk/run/sprint). The query runs at ~12 Hz and picks the
minimum-cost clip by weighted distance, then crossfades. Jump states bypass the
query and drive the clip directly.

A per-frame query is unstable in a way that is easy to miss: a strafe held at
exactly 45° sits on the boundary between two clips, so the matcher alternates
every frame and neither crossfade ever completes — the character vibrates
between two poses. `MotionSelector` guards against it twice. **Hysteresis**: the
incumbent only loses if the challenger is cheaper by a margin. **Dwell**: a
minimum time between switches, so a blend always finishes. Both layers use it.

### Transitions

`fadeIn`/`fadeOut` in three.js ramp weight *linearly*, which leaves a visible
corner at each end of a blend. `TransitionBlender` drives the weights itself on a
smootherstep curve and tracks everything in flight, so any number of clips can
overlap. It also seeds the incoming clip with the outgoing one's normalised
time — a gait that restarts at `t=0` mid-stride reads as a stumble even under a
crossfade.

### The upper-body layer

`PropertyMixer.accumulate` is a running weighted average, which means a stock
mixer already blends two actions on the same bone in proportion to their
weights, and leaves a bone only one of them animates untouched. That is all a
masked layer needs: the clip is filtered down to a bone mask on the way in, the
base layer runs at `1-f` and the upper layer at `f`, and the legs keep running
while the torso and arms do something else.

The layer is driven by its own matcher (`IdleDirector`) over a small feature
space — how long he has been still, whether he is moving, whether there is
something in front of him worth touching. What makes a long idle vary is
**boredom**: a candidate accrues cost while it is active and sheds it while it is
not, so the same five features produce a different order every time. He talks,
then folds his arms, then goes back to watching the room, with no scripted
sequence anywhere.

The one social take in the library is a clip; the folded arms are *solved*,
because no such clip exists. Both come out of the same query, so they cannot
fight. Fred has no finger bones — 27 bones, terminating at `SKEL_*_Hand_end_*` —
so a hand is posed as a unit and there is no finer detail to get wrong.

### Procedural pose

Several systems want the same joints at once, so they do not write bones
directly: they contribute weighted rotations to `ProceduralPose`, which applies
them after the mixer in hierarchy order, parent before child.

One subtlety is worth recording. The mixer rewrites every bone it animates each
frame, so a delta applied on top cannot accumulate — but `SKEL_Spine3_010` is
*mapped to nothing* (the source rig has only three spine joints), so no clip
touches it and nothing resets it. A look-at delta there would spin the chest a
little further every frame, forever. The pass therefore remembers what it wrote
and restores the rest pose on any bone still holding exactly that value; where
the mixer *did* animate the bone, the value differs and the animated pose stays
as the base.

### Looking around

A gaze angle is *shared* across joints rather than given to one of them. A hard
clamp per joint hands the whole remainder to the next joint the instant the
previous one maxes out — a kink travelling up the spine as the target sweeps
past — so `softClamp` saturates instead: the head leads, the neck joins in as
the angle grows, and the chest only turns for a genuinely large look.

The gaze is never perfectly still. Interest points are held for a random dwell
and then *jumped* to (a saccade, not a glide), with low-amplitude drift
underneath, and the head counter-rotates against body yaw so the eyes stay on
target while the body turns. He looks where the camera looks while you are
playing, and picks his own points of interest — including, occasionally, the
camera — once he has been standing still long enough.

### Reacting to the environment

The grey primitives are collidable (`Environment`: box colliders, analytic slab
raycast, circle push-out), so the controller stops at them and the camera arm
pulls in around them rather than rendering through them.

`WallHands` then uses the same boxes. Each hand probes its own ray from its own
shoulder, so a pillar in front of the left shoulder gets one hand and not two;
the reach is *measured off the rig* rather than guessed, because an arm that
cannot reach a surface should not pretend to touch it. Contact engages inside
that reach and releases at 1.25× it, so standing on the boundary does not
strobe, and the IK result is slerped against the animated pose instead of
written over it — the reach grows out of whatever the arms were already doing.
Palms face the wall with the fingers up it, the wrist stands 45 mm off the
surface so the hand does not sink in, and the hands stay inside the footprint so
they never float off the edge of a narrow pillar.

Secondary motion (`BodyLean`) is the same idea applied to forces rather than
geometry: the torso pitches into acceleration and banks into a turn, the pelvis
dips on landing through a spring rather than a keyframe, breathing runs at rest
and quiets down while the gait is doing the work, and the chest sways when he is
idle. The amplitudes are a couple of degrees — lean reads as weight at two and
as slapstick at ten. It deliberately does *not* roll the pelvis or turn the body
while idle, for the same reason the body does not turn to face the camera: foot
planting locks the feet, and anything below the waist has to be paid for by
twisting the legs against those locks.

### Foot planting

After the mixer writes each pose, feet within 7 cm of the ground are locked to
the surface and the leg is re-solved with analytical two-bone IK, blending in
over ~0.1 s and releasing on lift-off. The foot is then aligned to the terrain
normal, and the pelvis drops by however far the lower foot still needs to reach
so the character straddles slopes instead of floating.

## Staging

The scene is dressed like the original Euphoria tech demos: a slightly dark grey
floor dissolving into a pure white void, with no landscape to read as a place.
Fog is exponential rather than linear, since linear fog saturates at its far
plane and leaves a hard horizon line drawn across the floor. Tone mapping is off
so the void stays pure white instead of being rolled off to grey.

The grey boxes are not scenery. They are the collidable set from
[`Environment.js`](js/Environment.js), placed so that the wall is a few strides
ahead of the spawn: something to bump into, put a hand on and pull the camera in
around, without becoming a place. The layout is a plain table at the top of that
file.

The rolling terrain is still in the code behind `RELIEF` in
[`Terrain.js`](js/Terrain.js) — raise it above `0` to bring the hills back and
watch the foot planting adapt to slopes.

The key light rides with the character. Its shadow camera is tight enough to
keep the shadow crisp, which means a fixed light would drop the shadow entirely
as soon as you walked out of that box.

## Testing

```bash
npm install       # three, as a dev dependency
npm test
```

There is no browser and no GPU involved. three.js runs headless as long as
nothing touches WebGL, so the tests drive the *real* modules against the *real*
assets: the harness stands up a static server on localhost and teaches `Request`
to resolve relative URLs against it, which keeps `AnimationDatabase`'s HTTP load
path intact instead of swapping in a disk-reading stub that shares no code with
production.

What that catches is wiring, not just logic. `node --check` passes on a module
that calls a function it never imported, and that mistake shipped once in
`FootPlanting` before the pipeline test existed; the suite now constructs every
system and simulates frames through the whole stack — ten seconds of idle, a
walk into the wall, a jump — asserting on bone quaternions, clip selection and
where the hands actually end up.

## Assets

`Fred.glb` is a ragdoll rig: each bone carries its own physics-body mesh rather
than a single skinned mesh, so bones are collected straight from the hierarchy.
