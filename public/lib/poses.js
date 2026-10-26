// Pose presets: data-driven JSON (public/poses/*.json, plus <library>/poses/*.json for your own). Pure: schema
// check, bone and part detection from node names, and the transform ops a preset turns into. studio.js applies
// the ops; the Pose screen lists the presets.
//
// A preset file:
// { "id": "crouch", "name": "Crouch", "kind": "humanoid" | "car", "icon": "🧎", "description": "…",
//   "camera": { "turn": 30, "elevation": 13, "lens": 50 },          // optional camera hint
//   "bones": { "upperLeg.L": { "rotation": [-90, 0, 0] }, … },       // humanoid: canonical bone → euler degrees
//   "body": { "roll": 0, "pitch": 0, "yaw": 0, "lift": 0 },           // car (or anything): the whole model
//   "parts": { "door.L": { "rotation": [0, -60, 0] }, … },           // car: canonical part → transform
//   "requires": ["door.scissor"],                                     // only offered when these parts exist
//   "wheels": { "steer": 25, "spin": true },                          // car: steer the front wheels, spin them all
//   "shots": [{ "name": "front", "turn": 0 }, …] }                    // a multi-shot preset (turnaround)

export const KINDS = ['humanoid', 'car'];
export const CANON_BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulder.L', 'shoulder.R', 'upperArm.L', 'upperArm.R', 'lowerArm.L', 'lowerArm.R',
  'hand.L', 'hand.R', 'upperLeg.L', 'upperLeg.R', 'lowerLeg.L', 'lowerLeg.R', 'foot.L', 'foot.R'];
export const CANON_PARTS = ['wheel.FL', 'wheel.FR', 'wheel.RL', 'wheel.RR', 'door.L', 'door.R', 'door.scissor', 'door.gullwing', 'hood', 'trunk'];

// ponytail: bone naming follows Mixamo / Blender Rigify / common Warframe fan rigs; a rig with other names shows
// "no bones found for this pose". Add patterns here, no code elsewhere changes.
const BONE_PATTERNS = {
  hips: /^(mixamorig:?)?(hips|pelvis|root_m|cog)$/i,
  spine: /^(mixamorig:?)?(spine|spine_?0?1|spine1|torso)$/i,
  chest: /^(mixamorig:?)?(spine_?0?2|spine2|chest|upper_?chest)$/i,
  neck: /^(mixamorig:?)?neck(_?0?1)?$/i,
  head: /^(mixamorig:?)?head$/i,
  shoulder: /^(mixamorig:?)?(left|right|l|r)?[_.-]?(shoulder|clavicle)[_.-]?(left|right|l|r)?$/i,
  upperArm: /^(mixamorig:?)?(left|right|l|r)?[_.-]?(arm|upper_?arm|upperarm|humerus)[_.-]?(left|right|l|r)?$/i,
  lowerArm: /^(mixamorig:?)?(left|right|l|r)?[_.-]?(fore_?arm|lower_?arm|elbow)[_.-]?(left|right|l|r)?$/i,
  hand: /^(mixamorig:?)?(left|right|l|r)?[_.-]?hand[_.-]?(left|right|l|r)?$/i,
  upperLeg: /^(mixamorig:?)?(left|right|l|r)?[_.-]?(up_?leg|upper_?leg|thigh)[_.-]?(left|right|l|r)?$/i,
  lowerLeg: /^(mixamorig:?)?(left|right|l|r)?[_.-]?(leg|lower_?leg|shin|calf|knee)[_.-]?(left|right|l|r)?$/i,
  foot: /^(mixamorig:?)?(left|right|l|r)?[_.-]?foot[_.-]?(left|right|l|r)?$/i,
};
const sideOf = (name) => (/(^|[_.-])(left|l)([_.-]|$)|^left|left$|^mixamorig:?left/i.test(name) ? 'L' : /(^|[_.-])(right|r)([_.-]|$)|^right|right$|^mixamorig:?right/i.test(name) ? 'R' : null);

// Canonical bone → node name, from the rig's bone names.
export function detectBones(names) {
  const found = {};
  for (const name of names) {
    for (const [canon, re] of Object.entries(BONE_PATTERNS)) {
      if (!re.test(name)) continue;
      const sided = !['hips', 'spine', 'chest', 'neck', 'head'].includes(canon);
      const key = sided ? `${canon}.${sideOf(name) || 'L'}` : canon;
      if (!found[key]) found[key] = name;
    }
  }
  return found;
}

const PART_PATTERNS = {
  wheel: /wheel|tyre|tire|rim/i, door: /door/i, hood: /hood|bonnet/i, trunk: /trunk|boot|tailgate|hatch/i,
};
// Canonical part → node name, from mesh/node names and (for wheels) each node's centre [x, y, z] in model space
// (x: left negative, z: front positive, matching studio.js). Sided names (door_L, FL_wheel) win over positions.
export function detectParts(nodes) {
  const found = {};
  for (const { name, center = [0, 0, 0] } of nodes) {
    if (PART_PATTERNS.wheel.test(name)) {
      const fb = /(^|[_.-])(f|fl|fr|front)/i.test(name) ? 'F' : /(^|[_.-])(r|rl|rr|rear|back)([_.-]|$)/i.test(name) && !/front/i.test(name) ? 'R' : center[2] >= 0 ? 'F' : 'R';
      const lr = /fl|rl|(^|[_.-])(l|left)([_.-]|$)/i.test(name) ? 'L' : /fr|rr|(^|[_.-])(r|right)([_.-]|$)/i.test(name) && !/rear/i.test(name) ? 'R' : center[0] <= 0 ? 'L' : 'R';
      found[`wheel.${fb}${lr}`] ||= name;
    } else if (PART_PATTERNS.door.test(name)) {
      if (/scissor|lambo/i.test(name)) found['door.scissor'] ||= name;
      else if (/gullwing|gull|butterfly|falcon/i.test(name)) found['door.gullwing'] ||= name;
      else found[`door.${sideOf(name) || (center[0] <= 0 ? 'L' : 'R')}`] ||= name;
    } else if (PART_PATTERNS.hood.test(name)) found.hood ||= name;
    else if (PART_PATTERNS.trunk.test(name)) found.trunk ||= name;
  }
  return found;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isTransform = (t) => t && typeof t === 'object' && !Array.isArray(t) && Object.entries(t).every(([k, v]) => ['rotation', 'position'].includes(k) && isVec3(v));

// [] when the preset is valid, else the problems. Every bundled JSON must pass (test/poses.test.mjs).
export function validatePose(p) {
  const errors = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['not an object'];
  if (typeof p.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.id)) errors.push('id: lowercase letters, digits and dashes');
  if (typeof p.name !== 'string' || !p.name.trim()) errors.push('name: required');
  if (!KINDS.includes(p.kind)) errors.push(`kind: one of ${KINDS.join(', ')}`);
  if (p.icon !== undefined && typeof p.icon !== 'string') errors.push('icon: a string');
  if (p.description !== undefined && typeof p.description !== 'string') errors.push('description: a string');
  if (p.camera !== undefined && !(p.camera && typeof p.camera === 'object' && Object.entries(p.camera).every(([k, v]) => ['turn', 'elevation', 'lens'].includes(k) && isNum(v)))) errors.push('camera: { turn, elevation, lens } numbers');
  if (p.bones !== undefined) {
    if (!p.bones || typeof p.bones !== 'object') errors.push('bones: an object');
    else for (const [k, v] of Object.entries(p.bones)) { if (!CANON_BONES.includes(k)) errors.push(`bones.${k}: unknown bone`); if (!isTransform(v)) errors.push(`bones.${k}: { rotation: [x, y, z] }`); }
  }
  if (p.parts !== undefined) {
    if (!p.parts || typeof p.parts !== 'object') errors.push('parts: an object');
    else for (const [k, v] of Object.entries(p.parts)) { if (!CANON_PARTS.includes(k)) errors.push(`parts.${k}: unknown part`); if (!isTransform(v)) errors.push(`parts.${k}: { rotation, position }`); }
  }
  if (p.body !== undefined && !(p.body && typeof p.body === 'object' && Object.entries(p.body).every(([k, v]) => ['roll', 'pitch', 'yaw', 'lift'].includes(k) && isNum(v)))) errors.push('body: { roll, pitch, yaw, lift } numbers');
  if (p.wheels !== undefined && !(p.wheels && typeof p.wheels === 'object' && Object.entries(p.wheels).every(([k, v]) => (k === 'steer' && isNum(v)) || (k === 'spin' && typeof v === 'boolean')))) errors.push('wheels: { steer, spin }');
  if (p.requires !== undefined && !(Array.isArray(p.requires) && p.requires.every((r) => CANON_PARTS.includes(r)))) errors.push('requires: a list of parts');
  if (p.shots !== undefined && !(Array.isArray(p.shots) && p.shots.length >= 1 && p.shots.every((s) => s && typeof s.name === 'string' && isNum(s.turn)))) errors.push('shots: [{ name, turn }]');
  return errors;
}

// Whether a preset can be used on this model: { ok, missing } (parts a preset requires that the model lacks).
export function applicable(pose, found = {}) {
  const missing = (pose.requires || []).filter((r) => !found[r]);
  return { ok: missing.length === 0, missing };
}

/**
 * The transforms a preset applies. found: { bones: canonical → node name, parts: canonical → node name }.
 * → { nodes: [{ node, rotation?, position? }], body: { roll, pitch, yaw, lift }, wheels: { steer, spin, nodes: { front: [], all: [] } },
 *     camera, shots, unmatched: [canonical names the model has no node for] }
 */
export function poseOps(pose, found = { bones: {}, parts: {} }) {
  const nodes = [];
  const unmatched = [];
  for (const [canon, t] of Object.entries(pose.bones || {})) {
    const node = found.bones?.[canon];
    if (node) nodes.push({ node, ...t });
    else unmatched.push(canon);
  }
  for (const [canon, t] of Object.entries(pose.parts || {})) {
    const node = found.parts?.[canon];
    if (node) nodes.push({ node, ...t });
    else unmatched.push(canon);
  }
  const parts = found.parts || {};
  const wheels = pose.wheels ? {
    steer: pose.wheels.steer || 0, spin: Boolean(pose.wheels.spin),
    nodes: { front: ['wheel.FL', 'wheel.FR'].map((k) => parts[k]).filter(Boolean), all: ['wheel.FL', 'wheel.FR', 'wheel.RL', 'wheel.RR'].map((k) => parts[k]).filter(Boolean) },
  } : null;
  return { nodes, body: { roll: 0, pitch: 0, yaw: 0, lift: 0, ...pose.body }, wheels, camera: pose.camera || null, shots: pose.shots || null, unmatched };
}

// The still angles of a multi-shot preset from the scene's current turn (a plain preset: one shot at the turn).
export const shotAngles = (pose, turn) => (pose?.shots || [{ name: 'still', turn: 0 }]).map((s) => ({ name: s.name, angle: (((turn + s.turn) % 360) + 360) % 360 }));

// Presets for a model: its kind, and the ones whose required parts it has.
export function posesFor(list, kind, found = {}) {
  return list.filter((p) => p.kind === kind && applicable(p, found).ok);
}

// Adapters to the Phase 3 motion system (motion.js): canonical bones to Mixamo names, a car preset to a stance.
const MIXAMO = { hips: 'Hips', spine: 'Spine', chest: 'Spine2', neck: 'Neck', head: 'Head', shoulder: 'Shoulder', upperArm: 'Arm', lowerArm: 'ForeArm', hand: 'Hand', upperLeg: 'UpLeg', lowerLeg: 'Leg', foot: 'Foot' };
export function mixamoBones(pose) {
  const out = {};
  for (const [canon, t] of Object.entries(pose.bones || {})) {
    if (!t.rotation) continue;
    const [base, side] = canon.split('.');
    out[side ? `${side === 'L' ? 'Left' : 'Right'}${MIXAMO[base]}` : MIXAMO[base]] = t.rotation;
  }
  return out;
}
// Stance values (motion.js STANCE_DEFAULT keys) for a car preset. lift is metres, pitch degrees nose up.
export function carStance(pose) {
  const b = { roll: 0, pitch: 0, lift: 0, ...pose.body };
  const pitchDrop = Math.max(-0.1, Math.min(0.1, b.pitch * 0.01));
  const open = (k) => Math.max(0, Math.min(80, Math.abs((pose.parts?.[k]?.rotation || [0, 0, 0]).find((v) => v) || 0)));
  return {
    rideHeight: Math.max(-0.12, Math.min(0.2, b.lift)), frontDrop: pitchDrop, rearDrop: -pitchDrop,
    steer: Math.max(-40, Math.min(40, pose.wheels?.steer || 0)),
    doors: Math.max(open('door.L'), open('door.R'), open('door.scissor'), open('door.gullwing')), hood: open('hood'), trunk: open('trunk'),
  };
}
// Sorted, validated list from a set of parsed JSON files; invalid ones are reported, not thrown.
export function loadPoses(files) {
  const poses = [], bad = [];
  for (const { file, data } of files) { const e = validatePose(data); if (e.length) bad.push({ file, errors: e }); else poses.push(data); }
  const seen = new Map(); for (const p of poses) seen.set(p.id, p); // later files (your library) override bundled ids
  return { poses: [...seen.values()], bad };
}
