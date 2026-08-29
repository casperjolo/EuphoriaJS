import * as THREE from 'three';

/**
 * Bone mapping for the UEFN mannequin source rig (Animations/*.FBX)
 *            → target Fred.glb rig (RAGE/GTA "SKEL_" convention)
 *
 * The mannequin carries fingers, twist joints, IK helpers and weapon sockets;
 * Fred has 27 bones and no fingers, so only the 20 locomotion joints map.
 *
 * - `pelvis` is the root of motion. Locomotion is driven procedurally by
 *   CharacterController, so the root's horizontal root motion is dropped, but
 *   its VERTICAL motion (gait bob, crouch depth) is baked as a position track
 *   on SKEL_Pelvis_00 — see bake() / `pelvisBob`.
 * - `spine_04/05` map to nothing: Fred's SKEL_Spine3_010 is owned by the
 *   procedural torso twist (see ProceduralPose).
 * - `neck_02`, the twist joints, `ball_l/r` (toes) and everything below the
 *   hand/foot are unmapped. Fred's SKEL_*_Foot_end_* are terminator markers
 *   hanging straight down from the ankle, roughly (0, -0.099, 0.008), not toe
 *   joints — the source's real toes point mostly forward, and treating them as
 *   a bone direction aligns "down" onto "forward" and torques the whole foot.
 */
export const MANNEQUIN_BONE_MAP = {
  'pelvis':       'SKEL_Pelvis_00',
  'spine_01':     'SKEL_Spine_Root_07',
  'spine_02':     'SKEL_Spine1_08',
  'spine_03':     'SKEL_Spine2_09',
  'neck_01':      'SKEL_Neck_1_019',
  'head':         'SKEL_Head_020',

  'clavicle_l':   'SKEL_L_Clavicle_011',
  'upperarm_l':   'SKEL_L_UpperArm_012',
  'lowerarm_l':   'SKEL_L_Forearm_013',
  'hand_l':       'SKEL_L_Hand_014',
  'clavicle_r':   'SKEL_R_Clavicle_015',
  'upperarm_r':   'SKEL_R_UpperArm_016',
  'lowerarm_r':   'SKEL_R_Forearm_017',
  'hand_r':       'SKEL_R_Hand_018',

  'thigh_l':      'SKEL_L_Thigh_01',
  'calf_l':       'SKEL_L_Calf_02',
  'foot_l':       'SKEL_L_Foot_03',
  'thigh_r':      'SKEL_R_Thigh_04',
  'calf_r':       'SKEL_R_Calf_05',
  'foot_r':       'SKEL_R_Foot_06',
};

// The earlier Blender "B-" source rig, kept for reference.
export const BONE_MAP = {
  'B-hips':       'SKEL_Pelvis_00',
  'B-spine':      'SKEL_Spine_Root_07',
  'B-spineProxy': 'SKEL_Spine1_08',
  'B-chest':      'SKEL_Spine2_09',
  'B-neck':       'SKEL_Neck_1_019',
  'B-head':       'SKEL_Head_020',
  'B-shoulderL':  'SKEL_L_Clavicle_011',
  'B-upperArmL':  'SKEL_L_UpperArm_012',
  'B-forearmL':   'SKEL_L_Forearm_013',
  'B-handL':      'SKEL_L_Hand_014',
  'B-shoulderR':  'SKEL_R_Clavicle_015',
  'B-upperArmR':  'SKEL_R_UpperArm_016',
  'B-forearmR':   'SKEL_R_Forearm_017',
  'B-handR':      'SKEL_R_Hand_018',
  'B-thighL':     'SKEL_L_Thigh_01',
  'B-shinL':      'SKEL_L_Calf_02',
  'B-footL':      'SKEL_L_Foot_03',
  'B-thighR':     'SKEL_R_Thigh_04',
  'B-shinR':      'SKEL_R_Calf_05',
  'B-footR':      'SKEL_R_Foot_06',
};

// Source-rig node names the basis measurement needs, per rig convention.
export const SOURCE_RIGS = {
  mannequin: { hips: 'pelvis', head: 'head', lThigh: 'thigh_l', rThigh: 'thigh_r', boneMap: MANNEQUIN_BONE_MAP },
  blender:   { hips: 'B-hips', head: 'B-head', lThigh: 'B-thighL', rThigh: 'B-thighR', boneMap: BONE_MAP },
};

function collectNodes(root) {
  const map = new Map();
  root.traverse(n => { if (!map.has(n.name)) map.set(n.name, n); });
  return map;
}

function depthOf(node, root) {
  let d = 0, p = node.parent;
  while (p && p !== root) { d++; p = p.parent; }
  return d;
}

/** Nearest descendant of `node` that is itself a mapped bone. */
function firstMappedDescendant(node, boneMap) {
  for (const c of node.children) if (boneMap[c.name]) return c;
  for (const c of node.children) {
    const r = firstMappedDescendant(c, boneMap);
    if (r) return r;
  }
  return null;
}

const _worldPos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

/**
 * Derive a rig's global orientation from its rest geometry.
 *
 * "Up" runs hips→head and "left" runs right-thigh→left-thigh, which holds for
 * any humanoid regardless of axis convention or units. Scale drops out via
 * normalise.
 */
function rigBasis(nodes, names) {
  const pos = n => { const o = nodes.get(n); return o ? _worldPos(o) : null; };
  const hips = pos(names.hips), head = pos(names.head);
  const lt   = pos(names.lThigh), rt = pos(names.rThigh);
  if (!hips || !head || !lt || !rt) return null;

  const up = head.clone().sub(hips);
  if (up.lengthSq() < 1e-9) return null;
  up.normalize();

  const left = lt.clone().sub(rt);
  if (left.lengthSq() < 1e-9) return null;
  left.addScaledVector(up, -left.dot(up)).normalize();   // orthogonalise

  const fwd = new THREE.Vector3().crossVectors(left, up).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(left, up, fwd)
  );
}

const _q  = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p  = new THREE.Vector3();
const _p2 = new THREE.Vector3();

/**
 * Rest-pose-aware delta retargeter.
 *
 * The rigs differ in three ways at once: global axis convention (the mannequin
 * is Z-up in centimetres, its pelvis bone's local +X is its up axis; Fred is
 * Y-up, in metres), units (cm vs m), and rest pose (the source rests in an
 * A-pose, Fred rests with his arms down). Copying local quaternions across is
 * therefore meaningless.
 *
 * A global rotation A aligns the two world frames, measured from rest geometry.
 * The animation is a world-space delta from the source's own rest pose,
 *
 *     D = Sw_anim · Sw_rest⁻¹
 *
 * transported into the target's frame as A · D · A⁻¹.
 *
 * The subtle part is what that delta is applied *to*. Anchoring on the target's
 * bind pose is wrong whenever the rest poses disagree: the source rests in an
 * A-pose, Fred rests with his arms down, so idle's "swing the arms down 90°"
 * lands on arms that are already down and doubles into crossed arms.
 *
 * So each bone is first rotated into the pose that *corresponds* to the source's
 * rest — the target holding the source's rest — by turning its rest bone
 * direction onto the source's, mapped through A:
 *
 *     R    = minimalRotation( d_target_rest,  A · d_source_rest )
 *     Rest = R · Tw_rest
 *     Tw   = (A · D · A⁻¹) · Rest
 *
 * Now D = identity reproduces the source's rest pose on the target, and every
 * pose is carried across as the physical pose rather than doubling. Bones with
 * no mapped child (hands, feet) have no direction of their own to measure, so
 * they inherit their nearest mapped ancestor's correction, which keeps them
 * rigidly attached to a limb that *was* corrected.
 *
 * Horizontal root motion is intentionally dropped (CharacterController owns
 * position), but the pelvis's VERTICAL motion is kept: the gait bob and the
 * crouch depth live in the root's position, and baking them as a position track
 * on SKEL_Pelvis_00 is what makes a crouch actually lower the character. The
 * reference height is configurable (`pelvisBobReference`) because the A-pose
 * rest sits higher than every gait; the manifest tool pins it to the standing
 * idle loop's mean height so "0" means "standing".
 *
 * Results are baked into new AnimationClips bound to the target's bone names,
 * so runtime cost is identical to an ordinary clip.
 */
export class Retargeter {
  /**
   * @param {THREE.Object3D} sourceRoot   the loaded source rig (any clip's scene)
   * @param {THREE.Object3D} targetRoot   Fred's scene
   * @param {object} [opts]
   * @param {object} [opts.boneMap]       source→target bone names (default mannequin)
   * @param {'mannequin'|'blender'} [opts.sourceRig]  basis measurement names
   */
  constructor(sourceRoot, targetRoot, opts = {}) {
    const rigDef = SOURCE_RIGS[opts.sourceRig ?? 'mannequin'];
    const boneMap = opts.boneMap ?? rigDef.boneMap;
    this.sourceRoot = sourceRoot;
    this.targetRoot = targetRoot;
    this.boneMap = boneMap;

    const srcNodes = collectNodes(sourceRoot);
    const dstNodes = collectNodes(targetRoot);

    sourceRoot.updateMatrixWorld(true);
    targetRoot.updateMatrixWorld(true);

    // ── Global frame alignment ────────────────────────────────────────────
    const srcBasis = rigBasis(srcNodes, rigDef);
    const dstBasis = rigBasis(dstNodes, {
      hips:   boneMap[rigDef.hips],    head:   boneMap[rigDef.head],
      lThigh: boneMap[rigDef.lThigh],  rThigh: boneMap[rigDef.rThigh],
    });

    let align;
    if (srcBasis && dstBasis) {
      align = dstBasis.clone().multiply(srcBasis.clone().invert());
      const e = new THREE.Euler().setFromQuaternion(align, 'YXZ');
      console.log('[Retargeter] global frame alignment (deg):',
        [e.x, e.y, e.z].map(v => (v * 180 / Math.PI).toFixed(1)).join(', '));
    } else {
      console.warn('[Retargeter] could not derive rig basis — using identity');
      align = new THREE.Quaternion();
    }
    this.align    = align;
    this.alignInv = align.clone().invert();

    // ── Pelvis vertical bookkeeping (see class comment) ───────────────────
    const srcPelvis = srcNodes.get(rigDef.hips);
    const srcHead   = srcNodes.get(rigDef.head);
    this._srcPelvis = srcPelvis ?? null;
    if (srcPelvis && srcHead) {
      this._srcRestPelvisPos = _worldPos(srcPelvis).clone();
      this._srcUp = _worldPos(srcHead).sub(this._srcRestPelvisPos).normalize();
    } else {
      this._srcRestPelvisPos = null;
      this._srcUp = new THREE.Vector3(0, 1, 0);
    }
    const dstPelvis = dstNodes.get(boneMap[rigDef.hips]);
    this._dstRestPelvisLocal = dstPelvis ? dstPelvis.position.clone() : null;

    // ── Per-bone correspondence anchors ───────────────────────────────────
    this.pairs = [];
    const missing = [];

    for (const [srcName, dstName] of Object.entries(boneMap)) {
      const sb = srcNodes.get(srcName);
      const db = dstNodes.get(dstName);
      if (!sb || !db) {
        missing.push(`${srcName} → ${dstName} (${!sb ? 'source' : 'target'} missing)`);
        continue;
      }
      this.pairs.push({
        srcName, dstName, sb, db,
        srcRestWorldInv: sb.getWorldQuaternion(new THREE.Quaternion()).invert(),
        dstRestWorld:    db.getWorldQuaternion(new THREE.Quaternion()),
        dstRestLocal:    db.quaternion.clone(),
        depth:           depthOf(db, targetRoot),
      });
    }

    // Parent-first ordering — required both for the local-space conversion and
    // so a bone can inherit its parent's correction below.
    this.pairs.sort((a, b) => a.depth - b.depth);

    // Each bone is rotated from its own bind pose into the pose corresponding
    // to the source's rest, so the A-pose/arms-down mismatch cancels instead of
    // doubling. A bone with no mapped child (hands, feet) has no direction of
    // its own to measure, so it inherits its nearest mapped ancestor's
    // correction — which keeps it rigidly attached to a limb that *was*
    // corrected. Falling back to identity there instead leaves the bone anchored
    // on the bind pose while its parent moved, and the delta doubles onto it:
    // that is what twisted the hands and feet downward.
    const byNode = new Map(this.pairs.map(p => [p.db, p]));
    let measured = 0, inherited = 0;

    for (const p of this.pairs) {
      let correction = null;

      const srcChild = firstMappedDescendant(p.sb, boneMap);
      const dstChild = srcChild ? dstNodes.get(boneMap[srcChild.name]) : null;
      if (srcChild && dstChild) {
        const srcDir = _worldPos(srcChild).sub(_worldPos(p.sb));
        const dstDir = _worldPos(dstChild).sub(_worldPos(p.db));
        if (srcDir.lengthSq() > 1e-9 && dstDir.lengthSq() > 1e-9) {
          srcDir.normalize().applyQuaternion(align);   // into the target's frame
          dstDir.normalize();
          correction = new THREE.Quaternion().setFromUnitVectors(dstDir, srcDir);
          measured++;
        }
      }

      if (!correction) {
        for (let n = p.db.parent; n; n = n.parent) {
          const ancestor = byNode.get(n);
          if (ancestor) { correction = ancestor.correction.clone(); inherited++; break; }
        }
      }

      p.correction = correction ?? new THREE.Quaternion();
      p.anchor     = p.dstRestWorld.clone().premultiply(p.correction);
    }

    console.log(`[Retargeter] mapped ${this.pairs.length}/${Object.keys(boneMap).length} bones ` +
                `(${measured} measured, ${inherited} inherited)`);
    if (missing.length) console.warn('[Retargeter] unmapped:', missing);
  }

  /** Restore the target skeleton to its bind pose. */
  restoreRest() {
    for (const p of this.pairs) p.db.quaternion.copy(p.dstRestLocal);
    if (this._dstRestPelvisLocal) {
      const pelvis = this.pairs.find(p => p.dstName === this.boneMap['pelvis'] ?? this.boneMap['B-hips']);
      if (pelvis) pelvis.db.position.copy(this._dstRestPelvisLocal);
    }
    this.targetRoot.updateMatrixWorld(true);
  }

  /**
   * Bake one source clip into a target-bound clip.
   *
   * @param {THREE.AnimationClip} clip
   * @param {number} [fps] sampling rate
   * @param {object} [opts]
   * @param {'full'|'crouch'|'none'} [opts.pelvisBob='none']
   *   - 'full':   bake the pelvis height relative to the reference (locomotion)
   *   - 'crouch': same, but clamped to ≤ 0 (take-off squats, landings, crouch
   *               transitions — never a launch rise or a mid-air hover)
   *   - 'none':   no position track (airborne clips — the controller owns Y)
   * @param {number} [opts.pelvisBobReference=0]
   *   Source pelvis height (m, along the character up axis, relative to the
   *   source rest) that is baked as zero. Pinned by the manifest tool to the
   *   standing idle loop's mean height, so 0 = standing, crouch ≈ -0.4.
   */
  bake(clip, fps = 30, opts = {}) {
    const bobMode = opts.pelvisBob ?? 'none';
    const bobRef  = opts.pelvisBobReference ?? 0;

    const mixer  = new THREE.AnimationMixer(this.sourceRoot);
    const action = mixer.clipAction(clip);
    action.play();

    const frames = Math.max(2, Math.ceil(clip.duration * fps) + 1);
    const times  = new Float32Array(frames);
    const values = new Map();
    for (const p of this.pairs) values.set(p.dstName, new Float32Array(frames * 4));
    let posValues = null;
    if (bobMode !== 'none' && this._srcPelvis && this._dstRestPelvisLocal) {
      posValues = new Float32Array(frames * 3);
    }

    for (let i = 0; i < frames; i++) {
      const t = Math.min(i / fps, clip.duration);
      times[i] = t;

      mixer.setTime(t);
      this.sourceRoot.updateMatrixWorld(true);

      // Pelvis vertical: (pos(t) - rest) · up, cm → m, relative to the
      // standing reference.
      if (posValues) {
        _p.setFromMatrixPosition(this._srcPelvis.matrixWorld);
        _p2.copy(this._srcRestPelvisPos);
        let dy = _p.clone().sub(_p2).dot(this._srcUp) * 0.01 - bobRef;
        if (bobMode === 'crouch') dy = Math.max(-0.35, Math.min(0, dy));
        posValues[i * 3 + 0] = this._dstRestPelvisLocal.x;
        posValues[i * 3 + 1] = this._dstRestPelvisLocal.y + dy;
        posValues[i * 3 + 2] = this._dstRestPelvisLocal.z;
      }

      for (const p of this.pairs) {
        // Tw = (A · D · A⁻¹) · anchor,  where D = Sw_anim · Sw_rest⁻¹
        p.sb.getWorldQuaternion(_q);
        _q.multiply(p.srcRestWorldInv);
        _q.premultiply(this.align);
        _q.multiply(this.alignInv);
        _q.multiply(p.anchor);

        // Back to local space via the (already posed) parent
        if (p.db.parent) {
          p.db.parent.updateWorldMatrix(true, false);
          p.db.parent.getWorldQuaternion(_q2).invert();
          _q.premultiply(_q2);
        }

        p.db.quaternion.copy(_q);
        p.db.updateWorldMatrix(false, false);

        const arr = values.get(p.dstName);
        arr[i * 4 + 0] = _q.x;
        arr[i * 4 + 1] = _q.y;
        arr[i * 4 + 2] = _q.z;
        arr[i * 4 + 3] = _q.w;
      }
    }

    action.stop();
    mixer.uncacheClip(clip);

    const tracks = [];
    for (const p of this.pairs) {
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${p.dstName}.quaternion`, times, values.get(p.dstName)
      ));
    }
    if (posValues) {
      const pelvisDst = this.boneMap['pelvis'] ?? this.boneMap['B-hips'];
      tracks.push(new THREE.VectorKeyframeTrack(
        `${pelvisDst}.position`, times, posValues
      ));
    }

    return new THREE.AnimationClip(clip.name, clip.duration, tracks);
  }
}
