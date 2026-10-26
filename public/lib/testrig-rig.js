// Test Rig: turns a testrig.js pose (angles per limb in the character's frame) into bone rotations on any
// Mixamo-named skeleton. Limbs are aimed at directions rather than rotated about their own axes, so it works the
// same whatever way each bone's local axes point and whether the model was made in a T-pose or an A-pose.
import * as THREE from 'three';
import { mapBones } from './motion.js';
import { aim, setWorldQuat } from './handpose.js';

const D2R = Math.PI / 180;
const V = () => new THREE.Vector3();
const wp = (o) => o.getWorldPosition(V());
const LIMBS = { lArm: ['LeftArm', 'LeftForeArm', 'LeftHand'], rArm: ['RightArm', 'RightForeArm', 'RightHand'], lLeg: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'], rLeg: ['RightUpLeg', 'RightLeg', 'RightFoot'] };

/**
 * model: the skinned model (posed as it was made). body: the group above it that spin, tilt and plant move; its
 * local +z must be the way the character faces, +y up. Rest rotations are taken as they are now.
 */
export function makeRig(model, body) {
  const byName = {};
  model.traverse((o) => { if (o.isBone) byName[o.name] = o; });
  const map = mapBones(Object.keys(byName));
  const b = Object.fromEntries(Object.entries(map).map(([std, n]) => [std, byName[n]]));
  const rest = [...Object.values(byName)].map((o) => [o, o.quaternion.clone(), o.position.clone()]);
  body.updateMatrixWorld(true);
  const inBody = (o) => body.worldToLocal(wp(o));
  const ankle = Math.min(inBody(b.LeftFoot).y, inBody(b.RightFoot).y);
  const mid = inBody(b.Hips).y || 0.9; // spin and tilt turn about the hips
  return { model, body, b, rest, ankle, mid };
}

function limbDirs(angles, side, leg) {
  // Hanging straight down, raised out to the side, swung forward; the lower bone bends forward (elbow) or back (knee).
  const [raise, swing, bend] = leg ? [angles[2], angles[0], angles[1]] : angles; // legs are [swing, knee, splay]
  const r = raise * D2R, s1 = swing * D2R, s2 = (leg ? swing - bend : swing + bend) * D2R;
  const d = (s) => new THREE.Vector3(side * Math.sin(r), -Math.cos(r) * Math.cos(s), Math.cos(r) * Math.sin(s)).normalize();
  return [d(s1), d(s2)];
}

/** Pose the rig. Bones go back to rest first, so a pose never builds on the last one. */
export function applyPose(rig, pose) {
  const { body, b } = rig;
  for (const [o, q, p] of rig.rest) { o.quaternion.copy(q); o.position.copy(p); }
  // Whole body: spin (forward roll) and tilt (sideways) about the middle of the body.
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pose.spin * D2R, 0, -pose.tilt * D2R, 'ZXY'));
  const pivot = new THREE.Vector3(0, rig.mid, 0);
  body.quaternion.copy(q);
  body.position.copy(pivot).sub(pivot.clone().applyQuaternion(q));
  body.updateMatrixWorld(true);
  const bq = body.getWorldQuaternion(new THREE.Quaternion());
  const axis = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(bq);
  const turn = (bone, ax, deg) => { if (bone && deg) setWorldQuat(bone, new THREE.Quaternion().setFromAxisAngle(ax, deg * D2R).multiply(bone.getWorldQuaternion(new THREE.Quaternion()))); };
  const X = axis(1, 0, 0);
  turn(b.Spine, X, pose.lean / 2);
  turn(b.Spine2 || b.Spine1, X, pose.lean / 2);
  turn(b.Head || b.Neck, X, pose.head - pose.lean / 2); // eyes stay on the road
  for (const [k, names] of Object.entries(LIMBS)) {
    const [upper, lower, end] = names.map((n) => b[n]);
    if (!upper || !lower || !end) continue;
    const [d1, d2] = limbDirs(pose[k], k[0] === 'l' ? 1 : -1, k.endsWith('Leg'));
    aim(upper, wp(lower).sub(wp(upper)), d1.applyQuaternion(bq));
    aim(lower, wp(end).sub(wp(lower)), d2.applyQuaternion(bq));
  }
  if (pose.plant > 0) { // drop the body so the lower foot is where it stood
    const low = Math.min(body.parent.worldToLocal(wp(b.LeftFoot)).y, body.parent.worldToLocal(wp(b.RightFoot)).y);
    body.position.y += (rig.ankle - low) * Math.min(1, pose.plant);
    body.updateMatrixWorld(true);
  }
}
