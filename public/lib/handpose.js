// Pose by hand: two-bone IK for arms and legs, mirror left/right, the hips offset, simple keyframes, and the pose
// read back into motion.pose (Euler degrees per standard bone on top of the rest pose: the same data the presets,
// rig.js and every render use). Bone names are motion.js BONES (Mixamo without the prefix).
import * as THREE from 'three';
import { mixamoBones, MIXAMO } from './poses.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
// Same rest record as rig.js: the transform a bone had when first touched.
const rest = (o) => (o.userData.rest ||= { p: o.position.clone(), q: o.quaternion.clone() });

// What a grab handle drives: an IK chain (upper, mid, end), the whole body, or a rotate ring.
export const CHAINS = {
  LeftHand: ['LeftArm', 'LeftForeArm', 'LeftHand'], RightHand: ['RightArm', 'RightForeArm', 'RightHand'],
  LeftFoot: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'], RightFoot: ['RightUpLeg', 'RightLeg', 'RightFoot'],
};
export const RINGS = ['Head', 'Neck', 'Spine2', 'Spine'];
export const LABELS = { LeftHand: 'Left hand', RightHand: 'Right hand', LeftFoot: 'Left foot', RightFoot: 'Right foot', Hips: 'Whole body', Head: 'Head', Neck: 'Neck', Spine2: 'Upper back', Spine: 'Lower back' };
/** Pose by hand needs a skeleton with arms and legs; map is mapBones() output. */
export const canPoseByHand = (map = {}) => ['Hips', ...Object.values(CHAINS).flat()].every((b) => map[b]);

// Mirror: Left* ↔ Right*. A local rotation mirrors as [x, -y, -z], the convention every bundled preset uses
// (A-pose is LeftArm [0,0,-45] / RightArm [0,0,45]). ponytail: assumes mirrored bone axes like Mixamo rigs.
export const mirrorName = (n) => (n.startsWith('Left') ? `Right${n.slice(4)}` : n.startsWith('Right') ? `Left${n.slice(5)}` : n);
export const mirrorEuler = ([x, y, z]) => [x, -y || 0, -z || 0];
/** Copy these bones' rotations to the other side. */
export function mirrorBones(bones, names) {
  const out = { ...bones };
  for (const n of names) {
    const o = mirrorName(n);
    if (o === n) continue;
    if (bones[n]) out[o] = mirrorEuler(bones[n]); else delete out[o];
  }
  return out;
}
/** The whole pose flipped left for right. */
export function mirrorPose(bones) {
  const out = {};
  for (const [n, v] of Object.entries(bones)) out[mirrorName(n)] = mirrorEuler(v);
  return out;
}

// --- bones in three.js ---
const worldPos = (o) => o.getWorldPosition(new THREE.Vector3());
function setWorldQuat(bone, qWorld) {
  const pq = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
  bone.quaternion.copy(pq.invert().multiply(qWorld));
  bone.updateMatrixWorld(true);
}
// Turn a bone (about its own head) so a world direction `from` points along `to`.
function aim(bone, from, to) {
  const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  setWorldQuat(bone, q.multiply(bone.getWorldQuaternion(new THREE.Quaternion())));
}

/**
 * Two-bone IK: bend [upper, mid, end] so end reaches target (world space). Bone lengths never change; an
 * out-of-reach target straightens the limb towards it. The joint keeps bending the way it already bends; a
 * straight limb bends towards `pole` (world direction). keepEnd keeps the hand or foot's world rotation (or
 * pass the world quaternion to hold).
 * Returns where the end landed.
 */
export function solveTwoBone([upper, mid, end], target, { pole = new THREE.Vector3(0, 0, 1), keepEnd = true } = {}) {
  upper.updateWorldMatrix(true, true);
  const endQ = keepEnd?.isQuaternion ? keepEnd : end.getWorldQuaternion(new THREE.Quaternion());
  const a = worldPos(upper), b = worldPos(mid), c = worldPos(end);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const toT = target.clone().sub(a);
  const dir = toT.lengthSq() > 1e-12 ? toT.clone().normalize() : c.clone().sub(a).normalize();
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-6, l1 + l2 - 1e-6);
  const side = (v) => v.clone().sub(dir.clone().multiplyScalar(v.dot(dir)));
  let bend = side(b.clone().sub(a));
  if (bend.length() < l1 * 1e-3) bend = side(pole);
  if (bend.lengthSq() < 1e-12) bend = side(new THREE.Vector3(0, 1, 0)).lengthSq() > 1e-12 ? side(new THREE.Vector3(0, 1, 0)) : side(new THREE.Vector3(1, 0, 0));
  bend.normalize();
  const cos = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const joint = a.clone().addScaledVector(dir, cos * l1).addScaledVector(bend, Math.sqrt(1 - cos * cos) * l1);
  aim(upper, b.clone().sub(a), joint.clone().sub(a));
  const goal = a.clone().addScaledVector(dir, d);
  const b2 = worldPos(mid);
  aim(mid, worldPos(end).sub(b2), goal.sub(b2));
  if (keepEnd) setWorldQuat(end, endQ);
  return worldPos(end);
}

/** A bone's rotation as stored in motion.pose: Euler degrees on top of its rest rotation. */
export function readBone(bone) {
  const e = new THREE.Euler().setFromQuaternion(rest(bone).q.clone().invert().multiply(bone.quaternion));
  return [e.x, e.y, e.z].map((r) => Math.round(r * R2D * 10) / 10 || 0);
}
export function writeBone(bone, deg) {
  bone.quaternion.copy(rest(bone).q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deg[0] * D2R, deg[1] * D2R, deg[2] * D2R)));
}
/** byStd: { Standard: bone }. Only bones that moved, so a fresh pose stays empty. */
export function readPose(byStd) {
  const out = {};
  for (const [k, b] of Object.entries(byStd)) { const v = readBone(b); if (v.some(Boolean)) out[k] = v; }
  return out;
}

/**
 * Move the hips (the whole body) by off: metres in `space` (the studio pivot, so the body moves the same on any
 * model whatever its armature scale). null or zeros puts the hips back at rest.
 */
export function applyHips(space, hips, off) {
  hips.position.copy(rest(hips).p);
  if (!off || !off.some(Boolean)) return;
  hips.parent.updateWorldMatrix(true, false);
  const m = new THREE.Matrix4().copy(hips.parent.matrixWorld).invert().multiply(space.matrixWorld);
  hips.position.add(new THREE.Vector3(...off).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m)));
}
/** A world-space move as metres in `space`. */
export function toSpace(space, worldDelta) {
  space.updateWorldMatrix(true, false);
  return worldDelta.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(space.matrixWorld.clone().invert()));
}

// --- keyframes: [{ t: seconds, bones, hips }] played as a loop ---
export const LOOP = 4;
const round = (n) => Math.round(n * 100) / 100;
/** Add (or replace, within 0.05 s) a key at t. */
export function addKey(keys = [], t, { bones = {}, hips = null } = {}) {
  const at = round(THREE.MathUtils.clamp(t, 0, LOOP));
  return [...keys.filter((k) => Math.abs(k.t - at) >= 0.05), { t: at, bones, hips }].sort((a, b) => a.t - b.t);
}
const lerpAngle = (a, b, f) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;
/** The pose at time t: eased between the keys either side, the last key easing back to the first. */
export function keyPose(keys, t, length = LOOP) {
  if (!keys?.length) return null;
  const ks = [...keys].sort((x, y) => x.t - y.t);
  if (ks.length === 1) return { bones: { ...ks[0].bones }, hips: ks[0].hips || null };
  const u = ((t % length) + length) % length;
  const i = ks.findLastIndex((k) => k.t <= u);
  const a = i < 0 ? ks.at(-1) : ks[i];
  const b = i < 0 ? ks[0] : ks[(i + 1) % ks.length];
  const span = ((b.t - a.t) % length + length) % length || length;
  let f = ((u - a.t) % length + length) % length / span;
  f = f * f * (3 - 2 * f);
  const bones = {};
  for (const n of new Set([...Object.keys(a.bones), ...Object.keys(b.bones)])) {
    const p = a.bones[n] || [0, 0, 0], q = b.bones[n] || [0, 0, 0];
    bones[n] = p.map((v, k) => Math.round(lerpAngle(v, q[k], f) * 10) / 10);
  }
  const ha = a.hips || [0, 0, 0], hb = b.hips || [0, 0, 0];
  const hips = ha.map((v, k) => v + (hb[k] - v) * f);
  return { bones, hips: hips.some(Boolean) ? hips : null };
}

// --- saving: a pose file like public/poses/*.json (canonical bones), so it lists with the other presets ---
const CANON = Object.fromEntries(Object.entries(MIXAMO).map(([c, mx]) => [mx, c]));
export const poseId = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'my-pose';
/** { bones: { Standard: [x,y,z] }, hips } → a preset object. Bones presets don't have (Spine1, toes) are left out. */
export function toPreset(name, { bones = {}, hips = null } = {}) {
  const out = {};
  for (const [std, rotation] of Object.entries(bones)) {
    const [, side, base] = /^(Left|Right)?(.*)$/.exec(std);
    const c = CANON[base];
    if (c) out[side ? `${c}.${side[0]}` : c] = { rotation };
  }
  if (hips?.some(Boolean)) out.hips = { ...out.hips, position: hips.map((v) => Math.round(v * 1000) / 1000) };
  return { id: poseId(name), name: String(name).trim().slice(0, 60) || 'My pose', kind: 'humanoid', icon: '⭐', description: 'Your own pose, made by hand', bones: out };
}
/** A preset back into motion.pose fields. */
export const fromPreset = (p) => ({ bones: mixamoBones(p), hips: p.bones?.hips?.position || null });
