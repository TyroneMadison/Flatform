// Applies motion.js to a loaded model in the studio: car stance (ride height, steer, doors/hood/trunk), wheel spin
// and drive-by from a clip, humanoid poses on an existing skeleton. Every tagged mesh and bone keeps its rest
// transform, so Stock with no clip restores the model exactly as loaded.
import * as THREE from 'three';
import { STANCE_DEFAULT, carClipFrame, humanoidClipFrame, poseBones, mapBones, guessTag, detectModelType } from './motion.js';
import { listPieces } from './paint.js';
import { applyHips, keyPose } from './handpose.js';

const D2R = Math.PI / 180;
const rest = (o) => (o.userData.rest ||= { p: o.position.clone(), q: o.quaternion.clone() });
const restore = (o) => { const r = rest(o); o.position.copy(r.p); o.quaternion.copy(r.q); };

// Rotate a mesh about an axis (pivot-space direction) through a point (pivot-space), from its rest transform.
function rotateAbout(studio, mesh, axisPivot, pointPivot, angle) {
  const parent = mesh.parent;
  studio.pivot.updateMatrixWorld(true);
  const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(studio.pivot.matrixWorld);
  const axis = axisPivot.clone().transformDirection(toParent);
  const point = pointPivot.clone().applyMatrix4(toParent);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const r = rest(mesh);
  mesh.position.copy(r.p).sub(point).applyQuaternion(q).add(point);
  mesh.quaternion.copy(q).multiply(r.q);
}
function boxInPivot(studio, mesh) {
  const r = rest(mesh);
  const keep = { p: mesh.position.clone(), q: mesh.quaternion.clone() };
  mesh.position.copy(r.p); mesh.quaternion.copy(r.q);
  studio.pivot.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(studio.pivot.matrixWorld).invert();
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
  mesh.position.copy(keep.p); mesh.quaternion.copy(keep.q);
  return box;
}

/** Tags for every whole-mesh piece: the user's, else a guess from the name. */
export function tagsFor(model, saved = {}) {
  const out = {};
  for (const p of listPieces(model)) {
    if (p.group != null) continue; // a material group can't move on its own
    const t = saved[p.key]?.tag ?? guessTag(p.name);
    if (t) out[p.key] = { tag: t, mesh: p.mesh };
  }
  return out;
}

export function modelInfo(studio, override = 'auto') {
  const bones = [];
  const parts = [];
  studio.model?.traverse((o) => { if (o.isBone) bones.push(o.name); if (o.isMesh) parts.push(o.name); });
  return detectModelType({ size: studio.carSize, boneNames: bones, partNames: parts }, override);
}

/** motion: { type, stance, tags, pose: { preset, bones }, clip, speed }. t: clip time in seconds or null. */
export function applyMotion(studio, motion = {}, t = null) {
  const m = studio.model;
  if (!m) return;
  const type = modelInfo(studio, motion.type || 'auto').type;
  const tags = tagsFor(m, motion.tags);
  for (const { mesh } of Object.values(tags)) restore(mesh);
  const bones = {};
  m.traverse((o) => { if (o.isBone) { restore(o); bones[o.name] = o; } });

  if (type === 'humanoid') {
    const map = mapBones(Object.keys(bones));
    let euler = {};
    if (motion.pose?.preset) euler = poseBones(motion.pose.preset, motion.pose.bones);
    if (motion.clip && t != null) euler = { ...euler, ...humanoidClipFrame(motion.clip, t, { speed: motion.speed || 1 }) };
    const key = t != null ? keyPose(motion.keys, t) : null; // Pose by hand keyframes: each key is a whole pose
    if (key) euler = key.bones;
    if (bones[map.Hips]) applyHips(studio.pivot, bones[map.Hips], key ? key.hips : motion.pose?.hips);
    for (const [std, deg] of Object.entries(euler)) {
      const b = bones[map[std]];
      if (!b) continue;
      b.quaternion.copy(rest(b).q).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(deg[0] * D2R, deg[1] * D2R, deg[2] * D2R)));
    }
    return;
  }

  const s = { ...STANCE_DEFAULT, ...(motion.stance || {}) };
  const clip = motion.clip && t != null ? carClipFrame(motion.clip, t, { speed: motion.speed ?? 30 }) : { x: 0, roll: 0, wheel: 0, steer: 0, doors: 0 };
  m.position.y += s.rideHeight + (s.frontDrop + s.rearDrop) / 2;
  if (clip.roll) m.rotation.z += clip.roll * D2R;
  if (clip.x) studio.pivot.position.x += clip.x;
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  for (const { tag, mesh } of Object.values(tags)) {
    const box = boxInPivot(studio, mesh);
    const c = box.getCenter(new THREE.Vector3());
    if (tag === 'wheelFront' || tag === 'wheelRear') {
      const steer = tag === 'wheelFront' ? (s.steer + clip.steer) * D2R : 0;
      if (clip.wheel) rotateAbout(studio, mesh, X, c, clip.wheel);
      if (steer) {
        const spun = mesh.quaternion.clone(), pos = mesh.position.clone();
        // steer on top of the spin: rotate the spun pose about Y through the hub
        const r = rest(mesh); const keep = { p: r.p.clone(), q: r.q.clone() };
        r.p.copy(pos); r.q.copy(spun);
        rotateAbout(studio, mesh, Y, c, steer);
        r.p.copy(keep.p); r.q.copy(keep.q);
      }
    } else if (tag === 'door') {
      const open = (s.doors + clip.doors) * D2R;
      const side = c.x >= 0 ? 1 : -1;
      if (open) rotateAbout(studio, mesh, Y, new THREE.Vector3(side > 0 ? box.max.x : box.min.x, c.y, box.max.z), side * open);
    } else if (tag === 'hood' && s.hood) rotateAbout(studio, mesh, X, new THREE.Vector3(c.x, box.max.y, box.min.z), -s.hood * D2R);
    else if (tag === 'trunk' && s.trunk) rotateAbout(studio, mesh, X, new THREE.Vector3(c.x, box.max.y, box.max.z), s.trunk * D2R);
  }
}
