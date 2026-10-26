// Finding Blender (blender.mjs) with a pretend file system, the Settings status line, and the pose handed to Blender.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { blenderCandidates, findBlender, parseVersion, blenderVersion, blenderPose } from '../blender.mjs';
import { blenderStatus, blenderLight } from '../public/lib/render-status.js';

const W = path.win32;
// A pretend Windows disk: folders and what is in them.
const DISK = {
  'C:\\Users\\tyron\\Blender': ['blender-4.2.1-windows-x64', 'blender-5.2.2-windows-x64', 'notes.txt'],
  'C:\\Program Files\\Blender Foundation': ['Blender 4.5', 'Blender 4.10'],
  'D:\\Program Files\\Blender Foundation': ['Blender 3.6'],
};
const readdir = (dir) => { if (!DISK[dir]) throw new Error('ENOENT'); return DISK[dir]; };
const env = { USERPROFILE: 'C:\\Users\\tyron', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: 'C:\\Windows;C:\\Tools\\blender' };
const list = blenderCandidates('win32', env, { readdir, drives: () => ['C:\\', 'D:\\'] });

test('Blender: the portable folder in the home folder comes first, newest version first', () => {
  assert.equal(list[0], 'C:\\Users\\tyron\\Blender\\blender-5.2.2-windows-x64\\blender.exe');
  assert.equal(list[1], 'C:\\Users\\tyron\\Blender\\blender-4.2.1-windows-x64\\blender.exe');
  assert.ok(!list.some((p) => p.includes('notes.txt')));
});

test('Blender: Program Files on every drive, Steam and PATH are all looked at', () => {
  const pf = list.filter((p) => p.includes('Blender Foundation'));
  assert.deepEqual(pf, ['C:\\Program Files\\Blender Foundation\\Blender 4.10\\blender.exe', 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe', 'D:\\Program Files\\Blender Foundation\\Blender 3.6\\blender.exe']);
  assert.ok(list.includes('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe'));
  assert.ok(list.includes('D:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe'));
  assert.ok(list.includes(W.join('C:\\Tools\\blender', 'blender.exe')));
  assert.equal(new Set(list).size, list.length, 'no place twice');
  assert.ok(blenderCandidates('linux', { PATH: '/opt/b:/usr/local/bin' }).includes('/opt/b/blender'));
  assert.equal(blenderCandidates('darwin', { HOME: '/Users/t' })[0], '/Applications/Blender.app/Contents/MacOS/Blender');
});

test('Blender: the one picked in Settings wins while it exists, then the first one found', () => {
  const there = new Set(['C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe', 'E:\\Apps\\blender.exe']);
  const exists = (f) => there.has(f);
  assert.equal(findBlender('E:\\Apps\\blender.exe', { candidates: list, exists }), 'E:\\Apps\\blender.exe');
  assert.equal(findBlender('E:\\Gone\\blender.exe', { candidates: list, exists }), 'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe');
  assert.equal(findBlender('', { candidates: list, exists: () => false }), null);
});

test('Blender: the version comes from the program, else from its folder name', async () => {
  assert.equal(parseVersion('Blender 5.2.2 LTS\n\tbuild date: 2026-09-15'), '5.2.2');
  assert.equal(parseVersion('blender-4.2.1-windows-x64'), '4.2.1');
  assert.equal(parseVersion('Blender 4.5'), '4.5');
  assert.equal(parseVersion('steamapps'), null);
  const run = (bin, args, opts, done) => done(null, 'Blender 5.2.2 LTS\n');
  assert.equal(await blenderVersion('X:\\nowhere\\a\\blender.exe', { run }), '5.2.2');
  const broken = (bin, args, opts, done) => done(new Error('ENOENT'));
  assert.equal(await blenderVersion('X:\\nowhere\\blender-4.2.1-windows-x64\\blender.exe', { run: broken }), '4.2.1');
  assert.equal(await blenderVersion(null), null);
});

test('Blender: Settings says plainly whether it was found', () => {
  assert.equal(blenderStatus({ found: true, path: 'C:\\b\\blender.exe', version: '5.2.2' }), 'Blender found: 5.2.2');
  assert.equal(blenderStatus({ found: false }), 'Blender not found - click Browse');
  assert.equal(blenderStatus(null), 'Looking for Blender...');
  assert.match(blenderLight({ found: true, path: 'C:\\b.exe', version: '5.2.2' }).tip, /Blender found: 5\.2\.2/);
});

// A GLB with only a JSON chunk: enough for the bone names.
function glb(json) {
  const body = Buffer.from(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + body.length, 8); head.writeUInt32LE(body.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, body]);
}

test('Blender pose: Compose pose with the model bone names; nothing for cars or no pose', () => {
  const names = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine2', 'mixamorig:Head', 'mixamorig:LeftArm', 'mixamorig:RightArm', 'mixamorig:LeftUpLeg'];
  const rig = glb({ nodes: [...names.map((name) => ({ name })), { name: 'Body', mesh: 0 }], skins: [{ joints: names.map((_, i) => i) }] });
  const pose = blenderPose(rig, { pose: { preset: 'tpose', bones: { LeftArm: [0, 0, -70], Nope: [1, 2, 3] }, hips: [0, -0.1, 0] } });
  assert.deepEqual(pose, { bones: { 'mixamorig:LeftArm': [0, 0, -70] }, hips: { bone: 'mixamorig:Hips', offset: [0, -0.1, 0] } });
  assert.deepEqual(blenderPose(rig, { pose: { preset: 'apose' } }).bones, { 'mixamorig:LeftArm': [0, 0, -45], 'mixamorig:RightArm': [0, 0, 45] });
  assert.equal(blenderPose(rig, { pose: { preset: 'tpose', bones: {}, hips: null } }), null);
  assert.equal(blenderPose(rig, { type: 'car', pose: { preset: 'apose' } }), null);
  assert.equal(blenderPose(rig, null), null);
  assert.equal(blenderPose(glb({ nodes: [{ name: 'Wheel_FL', mesh: 0 }] }), { pose: { preset: 'apose' } }), null);
});
