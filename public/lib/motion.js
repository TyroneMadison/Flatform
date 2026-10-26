// Poses, car stances and animation preview, as pure data and maths so studio.js, the Blender job and the tests agree.
// Model type is detected from the bounds, the skeleton and the part names, and the user can override it.
// Car defaults are a no-op: a car with the Stock stance and no clip playing renders exactly as before.

export const MODEL_TYPES = { auto: 'Auto', car: 'Car', humanoid: 'Humanoid' };

const CAR_WORDS = /wheel|tire|tyre|rim|door|hood|bonnet|trunk|boot|bumper|windshield|windscreen|headlight|taillight|grille|mirror|caliper/i;
const BODY_WORDS = /head|helmet|chest|torso|arm|leg|hand|foot|shoulder|spine|hip|pelvis|neck|syandana/i;

/** size: {x,y,z} of the model bounds (length on z or x). boneNames, partNames: strings. override: 'car'|'humanoid'|'auto'. */
export function detectModelType({ size = null, boneNames = [], partNames = [] } = {}, override = 'auto') {
  if (override === 'car' || override === 'humanoid') return { type: override, reason: 'Set by you' };
  const mapped = mapBones(boneNames);
  if (Object.keys(mapped).length >= 6) return { type: 'humanoid', reason: 'Has a humanoid skeleton' };
  const car = partNames.filter((n) => CAR_WORDS.test(n)).length;
  const body = partNames.filter((n) => BODY_WORDS.test(n)).length;
  if (car > body && car >= 2) return { type: 'car', reason: 'Part names look like a car' };
  if (body > car && body >= 2) return { type: 'humanoid', reason: 'Part names look like a body' };
  if (size) {
    const length = Math.max(size.x, size.z);
    if (size.y > length * 1.2) return { type: 'humanoid', reason: 'Taller than it is long' };
  }
  return { type: 'car', reason: 'Default' };
}

// Standard humanoid skeleton (Mixamo names without the "mixamorig:" prefix).
export const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];

// Common variants (Blender rigify/metarig, Unreal, Unity humanoid, generic) mapped to the standard names.
export const RETARGET = {
  hips: 'Hips', pelvis: 'Hips', root_hips: 'Hips', spine: 'Spine', spine_01: 'Spine', spine01: 'Spine', spine1: 'Spine1', spine_02: 'Spine1', spine02: 'Spine1',
  spine2: 'Spine2', spine_03: 'Spine2', spine03: 'Spine2', chest: 'Spine2', upperchest: 'Spine2', neck: 'Neck', neck_01: 'Neck', head: 'Head',
  leftshoulder: 'LeftShoulder', clavicle_l: 'LeftShoulder', shoulder_l: 'LeftShoulder', leftarm: 'LeftArm', upperarm_l: 'LeftArm', upper_arm_l: 'LeftArm', leftupperarm: 'LeftArm',
  leftforearm: 'LeftForeArm', lowerarm_l: 'LeftForeArm', forearm_l: 'LeftForeArm', leftlowerarm: 'LeftForeArm', lefthand: 'LeftHand', hand_l: 'LeftHand',
  rightshoulder: 'RightShoulder', clavicle_r: 'RightShoulder', shoulder_r: 'RightShoulder', rightarm: 'RightArm', upperarm_r: 'RightArm', upper_arm_r: 'RightArm', rightupperarm: 'RightArm',
  rightforearm: 'RightForeArm', lowerarm_r: 'RightForeArm', forearm_r: 'RightForeArm', rightlowerarm: 'RightForeArm', righthand: 'RightHand', hand_r: 'RightHand',
  leftupleg: 'LeftUpLeg', thigh_l: 'LeftUpLeg', leftupperleg: 'LeftUpLeg', leftleg: 'LeftLeg', calf_l: 'LeftLeg', shin_l: 'LeftLeg', leftlowerleg: 'LeftLeg',
  leftfoot: 'LeftFoot', foot_l: 'LeftFoot', lefttoebase: 'LeftToeBase', ball_l: 'LeftToeBase', toe_l: 'LeftToeBase', lefttoes: 'LeftToeBase',
  rightupleg: 'RightUpLeg', thigh_r: 'RightUpLeg', rightupperleg: 'RightUpLeg', rightleg: 'RightLeg', calf_r: 'RightLeg', shin_r: 'RightLeg', rightlowerleg: 'RightLeg',
  rightfoot: 'RightFoot', foot_r: 'RightFoot', righttoebase: 'RightToeBase', ball_r: 'RightToeBase', toe_r: 'RightToeBase', righttoes: 'RightToeBase',
};
const normBone = (n) => String(n).replace(/^mixamorig\d*[:_]?/i, '').replace(/^(bip01|b|def|org)[ _.-]/i, '').replace(/[.](l|r)$/i, '_$1').replace(/[ .-]/g, '_').toLowerCase();
export function retargetName(name) {
  const n = normBone(name);
  if (RETARGET[n]) return RETARGET[n];
  const compact = n.replace(/_/g, '');
  return RETARGET[compact] || BONES.find((b) => b.toLowerCase() === compact) || null;
}
/** { Standard: 'source bone name' } for every bone that maps. */
export function mapBones(names) {
  const out = {};
  for (const n of names) { const std = retargetName(n); if (std && !out[std]) out[std] = n; }
  return out;
}

// Auto-rig fallback: the user clicks these landmarks on the mesh when detection can't find them.
export const REQUIRED_MARKERS = ['chin', 'leftWrist', 'rightWrist', 'leftElbow', 'rightElbow', 'leftKnee', 'rightKnee', 'groin'];
export function validateMarkers(markers = {}) {
  const missing = REQUIRED_MARKERS.filter((k) => !Array.isArray(markers[k]) || markers[k].length !== 3 || markers[k].some((v) => !Number.isFinite(v)));
  const problems = [];
  if (!missing.length) {
    if (!(markers.chin[1] > markers.groin[1])) problems.push('The chin must be above the groin');
    if (!(markers.leftKnee[1] < markers.groin[1] && markers.rightKnee[1] < markers.groin[1])) problems.push('The knees must be below the groin');
  }
  return { ok: !missing.length && !problems.length, missing, problems };
}

// Humanoid pose presets: Euler degrees [x, y, z] per standard bone, applied on top of the rest pose.
const P = (o) => o;
export const POSES = {
  tpose: { label: 'T-pose', bones: P({}) },
  apose: { label: 'A-pose', bones: P({ LeftArm: [0, 0, -45], RightArm: [0, 0, 45] }) },
  idle: { label: 'Idle', bones: P({ LeftArm: [0, 0, -75], RightArm: [0, 0, 75], LeftForeArm: [0, -10, 0], RightForeArm: [0, 10, 0], Spine: [3, 0, 0] }) },
  combat: { label: 'Combat-ready', bones: P({ Spine: [12, 15, 0], LeftArm: [40, 0, -60], RightArm: [40, 0, 60], LeftForeArm: [0, -80, 0], RightForeArm: [0, 80, 0], LeftUpLeg: [-20, 0, -8], RightUpLeg: [10, 0, 8], LeftLeg: [30, 0, 0], RightLeg: [25, 0, 0] }) },
  hero: { label: 'Hero stance', bones: P({ Spine2: [-5, 0, 0], Head: [-5, 10, 0], LeftArm: [0, 20, -70], RightArm: [0, -20, 70], LeftForeArm: [0, -60, 0], RightForeArm: [0, 60, 0], LeftUpLeg: [0, 0, -12], RightUpLeg: [0, 0, 12] }) },
  wave: { label: 'Wave', emote: true, bones: P({ LeftArm: [0, 0, -75], RightArm: [0, 0, -40], RightForeArm: [0, 0, -70] }) },
  salute: { label: 'Salute', emote: true, bones: P({ LeftArm: [0, 0, -75], RightArm: [-60, 0, 0], RightForeArm: [0, 140, 0], RightHand: [0, 0, 20] }) },
  armsCrossed: { label: 'Arms crossed', emote: true, bones: P({ LeftArm: [20, 60, -70], RightArm: [20, -60, 70], LeftForeArm: [0, -110, 0], RightForeArm: [0, 110, 0] }) },
  kneel: { label: 'Kneel', emote: true, bones: P({ Hips: [0, 0, 0], LeftUpLeg: [-90, 0, 0], LeftLeg: [90, 0, 0], RightUpLeg: [0, 0, 0], RightLeg: [90, 0, 0], LeftArm: [0, 0, -70], RightArm: [0, 0, 70] }) },
};
export function poseBones(id, custom = {}) {
  if (!POSES[id]) throw new Error(`Unknown pose ${id}`);
  return { ...POSES[id].bones, ...custom };
}
export const serializePose = (p) => JSON.stringify({ preset: p.preset, bones: p.bones || {} });
export function deserializePose(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const preset = POSES[o?.preset] ? o.preset : 'tpose';
  const bones = {};
  for (const [k, v] of Object.entries(o?.bones || {})) if (BONES.includes(k) && Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) bones[k] = v.map((n) => Math.max(-180, Math.min(180, n)));
  return { preset, bones };
}

// Car stance. rideHeight in metres (negative = lowered), steer in degrees (left positive), doors/hood/trunk in degrees open.
export const STANCE_DEFAULT = { rideHeight: 0, frontDrop: 0, rearDrop: 0, steer: 0, doors: 0, hood: 0, trunk: 0 };
export const STANCES = {
  stock: { label: 'Stock', values: {} },
  lowered: { label: 'Lowered', values: { rideHeight: -0.04 } },
  lifted: { label: 'Lifted', values: { rideHeight: 0.08 } },
  steerLeft: { label: 'Wheels turned left', values: { steer: 25 } },
  steerRight: { label: 'Wheels turned right', values: { steer: -25 } },
  drop: { label: 'Suspension drop', values: { frontDrop: -0.03, rearDrop: -0.03 } },
  doorsOpen: { label: 'Doors open', values: { doors: 65 }, needs: 'door' },
  hoodOpen: { label: 'Hood open', values: { hood: 50 }, needs: 'hood' },
  trunkOpen: { label: 'Trunk open', values: { trunk: 55 }, needs: 'trunk' },
};
export const STANCE_LIMITS = { rideHeight: [-0.12, 0.2], frontDrop: [-0.1, 0.1], rearDrop: [-0.1, 0.1], steer: [-40, 40], doors: [0, 80], hood: [0, 80], trunk: [0, 80] };
const clamp = (v, [a, b]) => Math.max(a, Math.min(b, v));
export function applyStance(current = {}, id = 'stock') {
  if (!STANCES[id]) throw new Error(`Unknown stance ${id}`);
  const out = { ...STANCE_DEFAULT, ...current, ...STANCES[id].values };
  if (id === 'stock') return { ...STANCE_DEFAULT };
  for (const k of Object.keys(STANCE_LIMITS)) out[k] = clamp(Number(out[k]) || 0, STANCE_LIMITS[k]);
  return out;
}
export const isStock = (s = {}) => Object.keys(STANCE_DEFAULT).every((k) => !(s[k] || 0));

// Part tags: a piece key tagged as door, hood, trunk or wheel (with a hinge pivot and axis for the openers).
export const TAGS = { wheelFront: 'Front wheel', wheelRear: 'Rear wheel', door: 'Door', hood: 'Hood', trunk: 'Trunk' };
export function guessTag(name) {
  const n = String(name).toLowerCase();
  if (/(wheel|tire|tyre|rim)/.test(n)) return /(rear|back|_r[lr]\b|\br[lr]\b)/.test(n) ? 'wheelRear' : 'wheelFront';
  if (/door/.test(n)) return 'door';
  if (/(hood|bonnet)/.test(n)) return 'hood';
  if (/(trunk|boot|tailgate)/.test(n)) return 'trunk';
  return null;
}
/** Stance presets to show: the openers only when a matching part is tagged. tags: { pieceKey: { tag } } */
export function availableStances(tags = {}) {
  const have = new Set(Object.values(tags).map((t) => t?.tag));
  return Object.entries(STANCES).filter(([, s]) => !s.needs || have.has(s.needs)).map(([id, s]) => ({ id, label: s.label }));
}

// Animation clips per model type.
export const CLIPS = {
  humanoid: { idle: 'Idle', walk: 'Walk', run: 'Run', wave: 'Wave', salute: 'Salute', armsCrossed: 'Arms crossed', kneel: 'Kneel' },
  car: { wheelSpin: 'Wheel spin', steerSweep: 'Steer sweep', driveBy: 'Drive-by', doors: 'Door open/close' },
};
export const clipsFor = (type) => Object.entries(CLIPS[type] || CLIPS.car).map(([id, label]) => ({ id, label }));

/** Wheel rotation in radians after t seconds at speed km/h on a wheel of the given radius (m). */
export const wheelAngle = (t, speedKmh, radius = 0.33) => ((speedKmh / 3.6) * t) / radius;
/** Rotation per frame (radians). */
export const wheelStep = (fps, speedKmh, radius = 0.33) => wheelAngle(1 / fps, speedKmh, radius);

/**
 * One frame of a car clip at time t (seconds) for a clip of `length` seconds. Returns transform deltas:
 * { x, roll, wheel, steer, doors }. x is metres across the frame (drive-by), roll in degrees.
 */
export function carClipFrame(clip, t, { length = 4, speed = 30, radius = 0.33, width = 12 } = {}) {
  const u = ((t % length) + length) % length / length;
  const base = { x: 0, roll: 0, wheel: 0, steer: 0, doors: 0 };
  if (clip === 'wheelSpin') return { ...base, wheel: wheelAngle(t, speed, radius) };
  if (clip === 'steerSweep') return { ...base, steer: 30 * Math.sin(u * Math.PI * 2) };
  if (clip === 'doors') return { ...base, doors: 65 * (0.5 - 0.5 * Math.cos(u * Math.PI * 2)) };
  if (clip === 'driveBy') {
    const x = -width / 2 + width * u;
    return { ...base, x, wheel: wheelAngle(t, speed, radius), roll: 1.5 * Math.sin(u * Math.PI) };
  }
  return base;
}

/** Humanoid loop: bone Euler degrees at time t for idle/walk/run (procedural, no clip files needed). */
export function humanoidClipFrame(clip, t, { speed = 1 } = {}) {
  const w = t * speed * Math.PI * 2;
  if (clip === 'walk' || clip === 'run') {
    const a = clip === 'run' ? 45 : 25;
    const f = clip === 'run' ? 1.6 : 1;
    const s = Math.sin(w * f);
    return { LeftUpLeg: [a * s, 0, 0], RightUpLeg: [-a * s, 0, 0], LeftLeg: [Math.max(0, -a * s), 0, 0], RightLeg: [Math.max(0, a * s), 0, 0],
      LeftArm: [-a * 0.8 * s, 0, -75], RightArm: [a * 0.8 * s, 0, 75], Spine: [clip === 'run' ? 10 : 3, 0, 0] };
  }
  if (clip === 'idle') return { ...POSES.idle.bones, Spine1: [1.5 * Math.sin(w * 0.25), 0, 0] };
  if (POSES[clip]) return POSES[clip].bones;
  return {};
}
