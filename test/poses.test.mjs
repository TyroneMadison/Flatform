import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePose, loadPoses, posesFor, detectParts, detectBones, shotAngles, mixamoBones, carStance, poseOps } from '../public/lib/poses.js';
import { BONES } from '../public/lib/motion.js';

const DIR = new URL('../public/poses/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, data: JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) }));

test('every bundled pose JSON validates and loads', () => {
  for (const f of files) assert.deepEqual(validatePose(f.data), [], f.file);
  const { poses, bad } = loadPoses(files);
  assert.equal(bad.length, 0);
  assert.equal(poses.length, files.length);
});

test('the full requested list is present', () => {
  const names = new Set(files.map((f) => f.data.id));
  for (const id of ['t-pose', 'a-pose', 'arsenal-idle', 'noble-idle', 'agile-idle', 'combat-rifle', 'combat-melee', 'aiming', 'crouch', 'bullet-jump', 'slide', 'wall-latch', 'hero-landing', 'kneel', 'meditate', 'sit',
    'wave', 'bow', 'salute', 'thumbs-up', 'clap', 'point', 'turnaround',
    'factory', 'lowered', 'lifted', 'wheels-left', 'wheels-right', 'doors-open', 'doors-scissor', 'doors-gullwing', 'hood-up', 'trunk-open', 'drift', 'launch', 'brake-dive', 'three-quarter-hero', 'rolling']) assert.ok(names.has(id), id);
});

test('a new JSON file in the library folder shows up without code changes, and bad ones are reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'poses-'));
  writeFileSync(path.join(dir, 'my-pose.json'), JSON.stringify({ id: 'my-pose', name: 'My pose', kind: 'humanoid', bones: { head: { rotation: [10, 0, 0] } } }));
  writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ id: 'Bad Id', kind: 'boat' }));
  const extra = readdirSync(dir).map((f) => ({ file: f, data: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
  const { poses, bad } = loadPoses([...files, ...extra]);
  assert.ok(poses.some((p) => p.id === 'my-pose'));
  assert.equal(bad.length, 1);
});

test('scissor and gullwing only when the model has those parts', () => {
  const list = loadPoses(files).poses;
  const plain = detectParts([{ name: 'Door_L' }, { name: 'Wheel_FL' }]);
  assert.ok(!posesFor(list, 'car', plain).some((p) => p.id === 'doors-scissor' || p.id === 'doors-gullwing'));
  const lambo = detectParts([{ name: 'ScissorDoor_L' }]);
  const ids = posesFor(list, 'car', lambo).map((p) => p.id);
  assert.ok(ids.includes('doors-scissor'));
  assert.ok(!ids.includes('doors-gullwing'));
});

test('3-view turnaround gives 3 shots: front, side, back', () => {
  const t = files.find((f) => f.data.id === 'turnaround').data;
  const shots = shotAngles(t, 10);
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map((s) => s.angle), [10, 100, 190]);
});

test('adapters: Mixamo bone names and car stance', () => {
  const crouch = files.find((f) => f.data.id === 'crouch').data;
  for (const k of Object.keys(mixamoBones(crouch))) assert.ok(BONES.includes(k), k);
  const lowered = carStance(files.find((f) => f.data.id === 'lowered').data);
  assert.ok(lowered.rideHeight < 0);
  assert.ok(carStance(files.find((f) => f.data.id === 'wheels-left').data).steer > 0);
  assert.equal(detectBones(['mixamorig:LeftArm'])['upperArm.L'], 'mixamorig:LeftArm');
  assert.equal(poseOps(crouch, { bones: {}, parts: {} }).nodes.length, 0);
});
