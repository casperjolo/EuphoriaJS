import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Retargeter } from './Retargeting.js';

// Each entry: { key, path, vx, vz, tier }
// vx/vz are normalised velocity in character-local space (+Z = forward, +X = right)
// tier: 0=idle, 1=walk, 2=run, 3=sprint, 4=jump, 5=turn, 6=social
//
// Tiers above 3 are never offered to the locomotion matcher — they belong to the
// upper-body layer (see IdleDirector), which masks them to the torso and arms.
const CLIP_MANIFEST = [
  // ── Idles ──────────────────────────────────────────────────────────────────
  { key: 'idle',            vx:  0,     vz:  0,    tier: 0, path: 'Animations/Male/Idles/HumanM@Idle01.fbx' },
  { key: 'idle2',           vx:  0,     vz:  0,    tier: 0, path: 'Animations/Male/Idles/HumanM@Idle02.fbx' },
  // ── Walks ──────────────────────────────────────────────────────────────────
  { key: 'walk_fwd',        vx:  0,     vz:  1,    tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_Forward.fbx' },
  { key: 'walk_bwd',        vx:  0,     vz: -1,    tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_Backward.fbx' },
  { key: 'walk_left',       vx: -1,     vz:  0,    tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_Left.fbx' },
  { key: 'walk_right',      vx:  1,     vz:  0,    tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_Right.fbx' },
  { key: 'walk_fwd_left',   vx: -0.707, vz:  0.707,tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_ForwardLeft.fbx' },
  { key: 'walk_fwd_right',  vx:  0.707, vz:  0.707,tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_ForwardRight.fbx' },
  { key: 'walk_bwd_left',   vx: -0.707, vz: -0.707,tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_BackwardLeft.fbx' },
  { key: 'walk_bwd_right',  vx:  0.707, vz: -0.707,tier: 1, path: 'Animations/Male/Movement/Walk/HumanM@Walk01_BackwardRight.fbx' },
  // ── Runs ───────────────────────────────────────────────────────────────────
  { key: 'run_fwd',         vx:  0,     vz:  1,    tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_Forward.fbx' },
  { key: 'run_bwd',         vx:  0,     vz: -1,    tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_Backward.fbx' },
  { key: 'run_left',        vx: -1,     vz:  0,    tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_Left.fbx' },
  { key: 'run_right',       vx:  1,     vz:  0,    tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_Right.fbx' },
  { key: 'run_fwd_left',    vx: -0.707, vz:  0.707,tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_ForwardLeft.fbx' },
  { key: 'run_fwd_right',   vx:  0.707, vz:  0.707,tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_ForwardRight.fbx' },
  { key: 'run_bwd_left',    vx: -0.707, vz: -0.707,tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_BackwardLeft.fbx' },
  { key: 'run_bwd_right',   vx:  0.707, vz: -0.707,tier: 2, path: 'Animations/Male/Movement/Run/HumanM@Run01_BackwardRight.fbx' },
  // ── Sprints ────────────────────────────────────────────────────────────────
  { key: 'sprint_fwd',      vx:  0,     vz:  1,    tier: 3, path: 'Animations/Male/Movement/Sprint/HumanM@Sprint01_Forward.fbx' },
  { key: 'sprint_left',     vx: -1,     vz:  0,    tier: 3, path: 'Animations/Male/Movement/Sprint/HumanM@Sprint01_Left.fbx' },
  { key: 'sprint_right',    vx:  1,     vz:  0,    tier: 3, path: 'Animations/Male/Movement/Sprint/HumanM@Sprint01_Right.fbx' },
  { key: 'sprint_fwd_left', vx: -0.707, vz:  0.707,tier: 3, path: 'Animations/Male/Movement/Sprint/HumanM@Sprint01_ForwardLeft.fbx' },
  { key: 'sprint_fwd_right',vx:  0.707, vz:  0.707,tier: 3, path: 'Animations/Male/Movement/Sprint/HumanM@Sprint01_ForwardRight.fbx' },
  // ── Jump ───────────────────────────────────────────────────────────────────
  { key: 'jump_begin',      vx:  0,     vz:  0,    tier: 4, path: 'Animations/Male/Movement/Jump/HumanM@Jump01 - Begin.fbx' },
  { key: 'jump_fall',       vx:  0,     vz:  0,    tier: 4, path: 'Animations/Male/Movement/Jump/HumanM@Fall01.fbx' },
  { key: 'jump_land',       vx:  0,     vz:  0,    tier: 4, path: 'Animations/Male/Movement/Jump/HumanM@Jump01 - Land.fbx' },
  // ── Turns ──────────────────────────────────────────────────────────────────
  { key: 'turn_left',       vx: -1,     vz:  0,    tier: 5, path: 'Animations/Male/Movement/Turn/HumanM@Turn01_Left.fbx' },
  { key: 'turn_right',      vx:  1,     vz:  0,    tier: 5, path: 'Animations/Male/Movement/Turn/HumanM@Turn01_Right.fbx' },
  // ── Social ─────────────────────────────────────────────────────────────────
  { key: 'talk',            vx:  0,     vz:  0,    tier: 6, path: 'Animations/Male/Social/Conversation/HumanM@Talk01.fbx' },
];

// Strip armature/object prefix from FBX track names so they bind to Fred's skeleton
function fixClipTracks(clip) {
  const fixed = clip.tracks.map(track => {
    let name = track.name;
    // FBX sometimes exports as "Armature|BoneName.property" or "ObjectName|BoneName.property"
    const pipe = name.indexOf('|');
    if (pipe !== -1) name = name.slice(pipe + 1);
    if (name === track.name) return track;
    const T = track.clone();
    T.name = name;
    return T;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, fixed);
}

export class AnimationDatabase {
  constructor() {
    this.clips = new Map();   // key → THREE.AnimationClip (retargeted)
    this.manifest = CLIP_MANIFEST;
    this.refRig = null;       // one FBX Object3D, used as the retarget source rig
  }

  async load(onProgress) {
    const loader = new FBXLoader();
    let done = 0;
    const total = CLIP_MANIFEST.length;

    const loadOne = ({ key, path }) =>
      new Promise(resolve => {
        loader.load(
          path,
          obj => {
            if (obj.animations && obj.animations.length > 0) {
              // Every clip ships with the same rig; keep one copy as the
              // retarget source. It is never added to the scene.
              if (!this.refRig) this.refRig = obj;
              const clip = fixClipTracks(obj.animations[0]);
              clip.name = key;
              this.clips.set(key, clip);
            } else {
              console.warn(`No animation in ${path}`);
            }
            done++;
            onProgress?.(done, total);
            resolve();
          },
          undefined,
          err => {
            console.warn(`Failed: ${path}`, err);
            done++;
            onProgress?.(done, total);
            resolve();
          }
        );
      });

    // Load priority clips first (idle + walk_fwd + run_fwd), then the rest in parallel
    const priority = ['idle', 'walk_fwd', 'run_fwd'];
    const rest = CLIP_MANIFEST.filter(m => !priority.includes(m.key));
    const prioManifest = CLIP_MANIFEST.filter(m => priority.includes(m.key));

    await Promise.all(prioManifest.map(loadOne));
    await Promise.all(rest.map(loadOne));
  }

  /**
   * Bake every loaded clip onto the target skeleton. Must run before the clips
   * are handed to a mixer, since the raw clips are bound to the source rig's
   * bone names and would otherwise resolve to nothing.
   */
  retarget(targetRoot, onProgress) {
    if (!this.refRig) {
      console.error('[AnimationDatabase] no reference rig — cannot retarget');
      return;
    }
    const rt = new Retargeter(this.refRig, targetRoot);
    let done = 0;
    const total = this.clips.size;

    for (const [key, clip] of [...this.clips]) {
      this.clips.set(key, rt.bake(clip));
      onProgress?.(++done, total);
    }

    rt.restoreRest();
    console.log(`[AnimationDatabase] retargeted ${total} clips`);
  }

  get(key) { return this.clips.get(key) ?? null; }

  // Return all manifest entries that have a loaded clip
  available() {
    return this.manifest.filter(m => this.clips.has(m.key));
  }
}
