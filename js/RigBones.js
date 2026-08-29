/**
 * Bone resolution by naming convention.
 *
 * Fred.glb uses the RAGE/GTA "SKEL_" convention. Every pattern list carries
 * Mixamo and Biped fallbacks so a different character can be dropped in without
 * touching the systems that drive it — the same table serves foot planting,
 * look-at, the arm IK and the wall hands.
 */
export const RIG_PATTERNS = {
  hips:      ['SKEL_Pelvis_00',      'Hips', 'Pelvis', 'mixamorig:Hips'],

  spineRoot: ['SKEL_Spine_Root_07',  'Spine',  'mixamorig:Spine'],
  spine1:    ['SKEL_Spine1_08',      'Spine1', 'mixamorig:Spine1'],
  spine2:    ['SKEL_Spine2_09',      'Spine2', 'mixamorig:Spine2'],
  // Not animated by any clip (the source rig has only three spine joints), so
  // procedural torso twist owns it outright.
  spine3:    ['SKEL_Spine3_010',     'Spine3', 'mixamorig:Spine3'],

  neck:      ['SKEL_Neck_1_019',     'Neck', 'mixamorig:Neck'],
  head:      ['SKEL_Head_020',       'Head', 'mixamorig:Head'],

  lClavicle: ['SKEL_L_Clavicle_011', 'LeftShoulder',  'mixamorig:LeftShoulder'],
  lUpperArm: ['SKEL_L_UpperArm_012', 'LeftArm',       'mixamorig:LeftArm'],
  lForearm:  ['SKEL_L_Forearm_013',  'LeftForeArm',   'mixamorig:LeftForeArm'],
  lHand:     ['SKEL_L_Hand_014',     'LeftHand',      'mixamorig:LeftHand'],

  rClavicle: ['SKEL_R_Clavicle_015', 'RightShoulder', 'mixamorig:RightShoulder'],
  rUpperArm: ['SKEL_R_UpperArm_016', 'RightArm',      'mixamorig:RightArm'],
  rForearm:  ['SKEL_R_Forearm_017',  'RightForeArm',  'mixamorig:RightForeArm'],
  rHand:     ['SKEL_R_Hand_018',     'RightHand',     'mixamorig:RightHand'],

  lThigh:    ['SKEL_L_Thigh_01',     'LeftUpLeg',  'mixamorig:LeftUpLeg'],
  lShin:     ['SKEL_L_Calf_02',      'LeftLeg',    'mixamorig:LeftLeg'],
  lFoot:     ['SKEL_L_Foot_03',      'LeftFoot',   'mixamorig:LeftFoot'],
  lToe:      ['SKEL_L_Foot_end_021', 'LeftToeBase','mixamorig:LeftToeBase'],

  rThigh:    ['SKEL_R_Thigh_04',     'RightUpLeg',  'mixamorig:RightUpLeg'],
  rShin:     ['SKEL_R_Calf_05',      'RightLeg',    'mixamorig:RightLeg'],
  rFoot:     ['SKEL_R_Foot_06',      'RightFoot',   'mixamorig:RightFoot'],
  rToe:      ['SKEL_R_Foot_end_022', 'RightToeBase','mixamorig:RightToeBase'],
};

/** Exact names first, then a case-insensitive substring match as a last resort. */
export function findBone(bones, patterns) {
  const byName = new Map(bones.map(b => [b.name, b]));
  for (const name of patterns) {
    if (byName.has(name)) return byName.get(name);
  }
  const lower = patterns.map(p => p.toLowerCase());
  return bones.find(b => lower.some(p => b.name.toLowerCase().includes(p))) ?? null;
}

/**
 * Resolve every entry of `patterns` against a flat bone list.
 * @returns {{ bones: Object<string, THREE.Bone|null>, missing: string[] }}
 */
export function resolveBones(bones, patterns = RIG_PATTERNS) {
  const out = {};
  const missing = [];
  for (const key of Object.keys(patterns)) {
    out[key] = findBone(bones, patterns[key]);
    if (!out[key]) missing.push(key);
  }
  return { bones: out, missing };
}

/** Depth in the hierarchy — procedural passes must run parent before child. */
export function boneDepth(bone) {
  let d = 0;
  for (let p = bone.parent; p; p = p.parent) d++;
  return d;
}

/**
 * Recompose one bone's world matrix from its (just written) local transform.
 *
 * Procedural passes write bone-local rotations directly and then need the world
 * matrices to be true before the *next* bone in the chain is solved.
 * `updateWorldMatrix(false, true)` would rebuild the whole subtree for every
 * bone — O(n²) across a pass — and this is O(1), valid as long as the parent's
 * matrix is already current, which is what processing parent-before-child buys.
 */
export function refreshBoneMatrix(bone) {
  bone.updateMatrix();
  if (bone.parent) bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
  else bone.matrixWorld.copy(bone.matrix);
}
