// Pose by hand: IK solver, mirror mapping, keyframes, and saving a pose so it lists and applies like a preset.
// The skeleton is built at runtime with Mixamo names (no asset needed).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { solveTwoBone, CHAINS, canPoseByHand, mirrorName, mirrorEuler, mirrorBones, mirrorPose, readPose, writeBone, applyHips, toSpace, addKey, keyPose, toPreset, fromPreset, poseId } from '../public/lib/handpose.js';
import { mapBones, BONES } from '../public/lib/motion.js';
import { validatePose, loadPoses } from '../public/lib/poses.js';

// A small humanoid: hips 1 m up, arms out (T-pose), legs straight down. Mixamo's 0.01 armature scale included.
function rig() {
  const root = new THREE.Group();
  const arm = new THREE.Group(); arm.scale.setScalar(0.01); root.add(arm);
  const bones = {};
  const add = (name, parent, [x, y, z]) => { const b = new THREE.Bone(); b.name = `mixamorig:${name}`; b.position.set(x, y, z); (parent ? bones[parent] : arm).add(b); bones[name] = b; };
  add('Hips', null, [0, 100, 0]);
  add('Spine', 'Hips', [0, 10, 0]); add('Spine1', 'Spine', [0, 10, 0]); add('Spine2', 'Spine1', [0, 10, 0]); add('Neck', 'Spine2', [0, 15, 0]); add('Head', 'Neck', [0, 10, 0]);
  for (const [S, s] of [['Left', 1], ['Right', -1]]) {
    add(`${S}Shoulder`, 'Spine2', [s * 5, 12, 0]); add(`${S}Arm`, `${S}Shoulder`, [s * 10, 0, 0]); add(`${S}ForeArm`, `${S}Arm`, [s * 28, 0, 0]); add(`${S}Hand`, `${S}ForeArm`, [s * 25, 0, 0]);
    add(`${S}UpLeg`, 'Hips', [s * 10, -5, 0]); add(`${S}Leg`, `${S}UpLeg`, [0, -45, 0]); add(`${S}Foot`, `${S}Leg`, [0, -45, 0]); add(`${S}ToeBase`, `${S}Foot`, [0, -5, 10]);
  }
  root.updateMatrixWorld(true);
  for (const b of Object.values(bones)) b.userData.rest = { p: b.position.clone(), q: b.quaternion.clone() }; // as rig.js does on load
  return { root, bones };
}
const wp = (b) => b.getWorldPosition(new THREE.Vector3());
const near = (a, b, eps = 1e-4) => assert.ok(a.distanceTo(b) < eps, `${a.toArray()} vs ${b.toArray()}`);

test('the runtime skeleton maps with the existing mapBones, and qualifies for pose by hand', () => {
  const { bones } = rig();
  const map = mapBones(Object.values(bones).map((b) => b.name));
  for (const b of BONES) assert.ok(map[b], b);
  assert.ok(canPoseByHand(map));
  assert.ok(!canPoseByHand(mapBones(['Wheel_FL', 'Door_L'])));
});

test('IK: a reachable target is reached exactly, bone lengths stay the same', () => {
  const { bones } = rig();
  const chain = CHAINS.LeftHand.map((n) => bones[n]);
  const len = () => [wp(chain[0]).distanceTo(wp(chain[1])), wp(chain[1]).distanceTo(wp(chain[2]))];
  const before = len();
  const shoulder = wp(chain[0]);
  for (const target of [shoulder.clone().add(new THREE.Vector3(0.3, -0.2, 0.2)), shoulder.clone().add(new THREE.Vector3(0.1, 0.3, -0.1)), shoulder.clone().add(new THREE.Vector3(0.05, -0.05, 0.3))]) {
    const got = solveTwoBone(chain, target, { pole: new THREE.Vector3(0, 0, -1) });
    near(got, target);
    near(wp(chain[2]), target);
    len().forEach((l, i) => assert.ok(Math.abs(l - before[i]) < 1e-6));
  }
});

test('IK: out of reach straightens the limb toward the target', () => {
  const { bones } = rig();
  const chain = CHAINS.RightFoot.map((n) => bones[n]);
  const hip = wp(chain[0]);
  const target = hip.clone().add(new THREE.Vector3(0, -5, 3));
  const got = solveTwoBone(chain, target);
  assert.ok(Math.abs(got.distanceTo(hip) - 0.9) < 1e-4); // fully stretched: thigh + shin
  const dir = target.clone().sub(hip).normalize();
  near(got.clone().sub(hip).normalize(), dir);
});

test('IK: a straight leg bends its knee toward the pole, and the foot keeps its world rotation', () => {
  const { bones } = rig();
  const chain = CHAINS.LeftFoot.map((n) => bones[n]);
  const footQ = chain[2].getWorldQuaternion(new THREE.Quaternion());
  const target = wp(chain[2]).add(new THREE.Vector3(0, 0.3, 0)); // crouch
  solveTwoBone(chain, target, { pole: new THREE.Vector3(0, 0, 1) });
  assert.ok(wp(chain[1]).z > 0.1, 'knee forward');
  assert.ok(chain[2].getWorldQuaternion(new THREE.Quaternion()).angleTo(footQ) < 1e-5);
});

test('mirror mapping: names swap, rotations mirror, centre bones stay', () => {
  assert.equal(mirrorName('LeftForeArm'), 'RightForeArm');
  assert.equal(mirrorName('RightUpLeg'), 'LeftUpLeg');
  assert.equal(mirrorName('Head'), 'Head');
  assert.deepEqual(mirrorEuler([10, 20, -30]), [10, -20, 30]);
  assert.deepEqual(mirrorEuler([5, 0, 0]), [5, 0, 0]); // no -0
  assert.deepEqual(mirrorBones({ LeftArm: [0, 0, -45], Head: [5, 0, 0] }, ['LeftArm', 'Head']), { LeftArm: [0, 0, -45], RightArm: [0, 0, 45], Head: [5, 0, 0] });
  assert.deepEqual(mirrorBones({ LeftArm: [1, 2, 3], RightArm: [9, 9, 9] }, ['LeftHand']), { LeftArm: [1, 2, 3], RightArm: [9, 9, 9] });
  assert.deepEqual(mirrorPose(mirrorPose({ LeftArm: [1, 2, 3], Spine: [4, 5, 6] })), { LeftArm: [1, 2, 3], Spine: [4, 5, 6] });
});

test('mirror is geometric: the mirrored arm puts the other hand at the reflected spot', () => {
  const { bones } = rig();
  solveTwoBone(CHAINS.LeftHand.map((n) => bones[n]), wp(bones.LeftArm).add(new THREE.Vector3(0.2, -0.3, 0.25)));
  const left = readPose({ LeftArm: bones.LeftArm, LeftForeArm: bones.LeftForeArm, LeftHand: bones.LeftHand });
  const right = mirrorBones(left, Object.keys(left));
  for (const n of ['RightArm', 'RightForeArm', 'RightHand']) if (right[n]) writeBone(bones[n], right[n]);
  bones.Hips.updateMatrixWorld(true);
  const l = wp(bones.LeftHand), r = wp(bones.RightHand);
  near(r, new THREE.Vector3(-l.x, l.y, l.z), 2e-3); // stored to 0.1°
});

test('read and write a pose round-trip through Euler degrees on top of rest', () => {
  const { bones } = rig();
  writeBone(bones.LeftForeArm, [10, -35, 20]);
  writeBone(bones.Head, [0, 15, 0]);
  const pose = readPose({ LeftForeArm: bones.LeftForeArm, Head: bones.Head, Spine: bones.Spine });
  assert.deepEqual(pose, { LeftForeArm: [10, -35, 20], Head: [0, 15, 0] });
});

test('hips offset is in metres in the stage space, whatever the armature scale', () => {
  const { root, bones } = rig();
  const before = wp(bones.Hips);
  applyHips(root, bones.Hips, [0, -0.2, 0.1]);
  bones.Hips.updateMatrixWorld(true);
  near(wp(bones.Hips), before.clone().add(new THREE.Vector3(0, -0.2, 0.1)));
  root.rotation.y = Math.PI / 2; root.updateMatrixWorld(true);
  near(toSpace(root, new THREE.Vector3(1, 0, 0)), new THREE.Vector3(0, 0, 1));
  applyHips(root, bones.Hips, null);
  assert.deepEqual(bones.Hips.position.toArray(), [0, 100, 0]);
});

test('keyframes: add, replace, ease between keys and loop back to the first', () => {
  let keys = addKey([], 0, { bones: { Head: [0, 0, 0] } });
  keys = addKey(keys, 2, { bones: { Head: [0, 40, 0] }, hips: [0, -0.1, 0] });
  keys = addKey(keys, 2.02, { bones: { Head: [0, 30, 0] } }); // same moment: replaced
  assert.equal(keys.length, 2);
  assert.deepEqual(keyPose(keys, 0).bones.Head, [0, 0, 0]);
  assert.deepEqual(keyPose(keys, 2.02).bones.Head, [0, 30, 0]);
  assert.deepEqual(keyPose(keys, 1.01).bones.Head, [0, 15, 0]); // halfway, eased
  assert.deepEqual(keyPose(keys, 3.01).bones.Head, [0, 15, 0]); // easing back to key 0 over the loop
  assert.deepEqual(keyPose(keys, 4).bones.Head, [0, 0, 0]);
  assert.equal(keyPose([], 1), null);
  assert.deepEqual(keyPose([{ t: 1, bones: { Neck: [1, 2, 3] } }], 3).bones, { Neck: [1, 2, 3] });
  // angles take the short way round
  assert.deepEqual(keyPose([{ t: 0, bones: { Head: [0, 170, 0] } }, { t: 2, bones: { Head: [0, -170, 0] } }], 1).bones.Head, [0, 180, 0]);
});

test('save and load: a hand pose becomes a valid preset that lists and applies back', () => {
  const pose = { bones: { LeftArm: [0, 0, -60], RightForeArm: [0, 80, 0], Spine2: [10, 0, 0], Spine1: [3, 0, 0], Head: [0, 20, 0] }, hips: [0, -0.15, 0.05] };
  const preset = toPreset('My Hero Pose!', pose);
  assert.equal(preset.id, 'my-hero-pose');
  assert.deepEqual(validatePose(preset), []);
  const { poses } = loadPoses([{ file: 'x.json', data: JSON.parse(JSON.stringify(preset)) }]);
  const back = fromPreset(poses[0]);
  const { Spine1, ...kept } = pose.bones; // presets have no Spine1
  assert.deepEqual(back.bones, kept);
  assert.deepEqual(back.hips, pose.hips);
  assert.equal(poseId('   '), 'my-pose');
});

test('server: POST /api/poses saves to the library and it lists with the bundled presets', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-handpose-'));
  const app = await startServer({ dataDir: path.join(dir, 'data'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const h = { 'Content-Type': 'application/json', Origin: base };
  try {
    let r = await fetch(`${base}/api/poses`, { method: 'POST', headers: h, body: JSON.stringify({ pose: toPreset('Crouch', { bones: { Head: [0, 10, 0] } }) }) });
    assert.equal(r.status, 200);
    const saved = (await r.json()).pose;
    assert.equal(saved.id, 'my-crouch'); // never replaces a bundled preset
    const list = (await (await fetch(`${base}/api/poses`)).json()).poses;
    assert.ok(list.some((p) => p.id === 'my-crouch'));
    assert.ok(list.some((p) => p.id === 'crouch'));
    r = await fetch(`${base}/api/poses`, { method: 'POST', headers: h, body: JSON.stringify({ pose: { id: 'x', kind: 'boat' } }) });
    assert.equal(r.status, 400);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('rig.js applies the saved hips offset, and plays keys when a time is set', async () => {
  const { applyMotion } = await import('../public/lib/rig.js');
  const { root, bones } = rig();
  const pivot = new THREE.Group(); pivot.add(root);
  const studio = { model: root, pivot, carSize: new THREE.Vector3(0.5, 1.8, 0.3) };
  const hips0 = wp(bones.Hips);
  applyMotion(studio, { type: 'humanoid', pose: { preset: 'tpose', bones: { Head: [0, 30, 0] }, hips: [0, -0.25, 0] } });
  near(wp(bones.Hips), hips0.clone().add(new THREE.Vector3(0, -0.25, 0)));
  assert.deepEqual(readPose({ Head: bones.Head }), { Head: [0, 30, 0] });
  const keys = [{ t: 0, bones: { Head: [0, 0, 0] } }, { t: 2, bones: { Head: [0, 40, 0] }, hips: [0, -0.1, 0] }];
  applyMotion(studio, { type: 'humanoid', pose: { preset: 'tpose', bones: { Head: [0, 30, 0] } }, keys }, 2);
  assert.deepEqual(readPose({ Head: bones.Head }), { Head: [0, 40, 0] });
  near(wp(bones.Hips), hips0.clone().add(new THREE.Vector3(0, -0.1, 0)));
  applyMotion(studio, { type: 'humanoid', pose: { preset: 'tpose', bones: {} }, keys }); // no time: the still pose
  assert.deepEqual(readPose({ Head: bones.Head }), {});
  near(wp(bones.Hips), hips0);
});
