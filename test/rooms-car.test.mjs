// One shared room list for every workspace (Car and Warframe alike), and every room built for a real car in metres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ENVIRONMENTS, ROOMS, CAR, envThumb, roomFor, envParts, partBounds, envScale } from '../public/lib/environments.js';
import { CAR_LENGTH, modelScale } from '../public/lib/pipeline.js';
import { RIG_ENVS } from '../public/lib/rig-look.js';

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('one room list: every room in environments.js, in order, each with its own picture', () => {
  assert.deepEqual(ROOMS.map((r) => r.slug), Object.keys(ENVIRONMENTS));
  for (const r of ROOMS) {
    assert.equal(r.label, ENVIRONMENTS[r.slug].label);
    assert.equal(r.thumb, envThumb(r.slug));
    assert.ok(existsSync(new URL(`../public${r.thumb}`, import.meta.url)), `${r.slug}: thumbnail on disk`);
    assert.ok(r.note, `${r.slug}: a tooltip`);
  }
});

test('Car and Warframe offer exactly the same rooms, from the one list; the old flat scenes are gone', () => {
  const compose = src('public/views/compose.js');
  const picker = compose.slice(compose.indexOf('function renderScenes()'), compose.indexOf('function renderAside('));
  assert.match(picker, /ROOMS\.map\(/);
  assert.doesNotMatch(picker, /workspace|miami|cyclorama|'ring'|custom/i, 'the picker never changes with the workspace');
  assert.deepEqual(Object.keys(RIG_ENVS), ROOMS.map((r) => r.slug)); // the Test Rig's Place list
  assert.match(src('public/views/settings.js'), /const SCENES = ROOMS\.map\(/);
  assert.match(src('server.mjs'), /const SCENES = Object\.keys\(ENVIRONMENTS\);/);
  const presets = src('public/lib/studio.js').match(/export const PRESETS = \{[\s\S]*?\n\};/)[0];
  assert.match(presets, /ROOMS\.map/);
  for (const old of ['cyclorama', 'miami', 'ring:', 'custom:']) assert.ok(!presets.includes(old), `studio PRESETS still has ${old}`);
  for (const f of ['public/lib/templates.js', 'public/lib/render-ideas.js']) {
    for (const [, p] of src(f).matchAll(/preset: '([\w-]+)'/g)) assert.ok(ENVIRONMENTS[p], `${f}: ${p} is a room`);
  }
});

test('old flat scenes open in their closest room', () => {
  assert.equal(roomFor('ring'), 'showroom');
  assert.equal(roomFor('gold'), 'showroom');
  assert.equal(roomFor('cyclorama'), 'white-cyc-studio');
  assert.equal(roomFor('miami'), 'night-city-rain');
  assert.equal(roomFor('custom'), 'white-cyc-studio');
  assert.equal(roomFor(undefined), 'white-cyc-studio');
  assert.equal(roomFor('constructor'), 'white-cyc-studio'); // not fooled by Object.prototype
  for (const slug of Object.keys(ENVIRONMENTS)) assert.equal(roomFor(slug), slug);
});

test('car scale: a fitted car is 4.6 m long and every room stays at real size round it, in the app and in Blender', () => {
  assert.equal(CAR.length, CAR_LENGTH);
  // A raw scan of any size is fitted to 4.6 m; the room then needs no scaling.
  for (const raw of [{ x: 0.9, y: 0.3, z: 0.4 }, { x: 46, y: 14, z: 19 }]) {
    const k = modelScale(raw);
    const fitted = { x: raw.x * k, y: raw.y * k, z: raw.z * k };
    assert.ok(Math.abs(envScale(fitted, 'car') - 1) < 1e-9);
  }
  // Scaled up by hand (Same size off): the room grows with it, so the car still fits through the same door.
  assert.ok(Math.abs(envScale({ x: 1.9 * 1.5, y: 1.5 * 1.5, z: 4.6 * 1.5 }, 'car') - 1.5) < 1e-9);
  // Blender scales its rooms the same way (render/blender_turntable.py env_scale).
  assert.match(src('render/blender_turntable.py'), new RegExp(`REAL_SIZE = \\{"car": ${CAR.length}, "humanoid": 1\\.8\\}`));
});

test('every room fits a real car: on the floor, turns without touching anything, room for its roof, through the door', () => {
  const turn = Math.hypot(CAR.length, CAR.width) / 2 + 0.1; // the circle its corners sweep, plus 10 cm
  let doors = 0;
  for (const [slug, e] of Object.entries(ENVIRONMENTS)) {
    const parts = envParts(e);
    const floorTop = parts.some((p) => (p.room || p.cyc ? partBounds(p).min[1] : partBounds(p).max[1]) === 0 || Math.abs(partBounds(p).max[1]) < 1e-9);
    assert.ok(floorTop, `${slug}: a floor at y = 0 for the tyres`);
    for (const p of parts) {
      if (p.room) assert.ok(p.room[1] >= CAR.height + 1, `${slug}: ceiling ${p.room[1]} m clears the roof`);
      if (p.room || p.cyc) continue;
      const b = partBounds(p);
      if (b.max[1] <= 0.05 || b.min[1] >= CAR.height) continue; // road paint, floors, things overhead
      const dx = Math.max(b.min[0], Math.min(0, b.max[0]));
      const dz = Math.max(b.min[2], Math.min(0, b.max[2]));
      assert.ok(Math.hypot(dx, dz) > turn, `${slug}: ${JSON.stringify(p.glb || p.mat)} is in the car's way as it turns`);
    }
    for (const p of parts.filter((x) => x.mat === 'door')) {
      doors++;
      const b = partBounds(p);
      const [w, h] = [Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]), b.max[1] - b.min[1]];
      assert.ok(Math.abs(b.min[1]) < 1e-9, `${slug}: the door starts at the floor`);
      assert.ok(h >= CAR.height + 0.5 && w >= CAR.width + 1, `${slug}: a ${w} x ${h} m door fits the car`);
    }
  }
  assert.ok(doors >= 1, 'the garage has a door to drive through');
});
