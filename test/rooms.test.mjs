// v3 rooms: every scene is a 3D room with bundled, licensed assets; the room scales to the model, the HDRI turns
// so its sun is the key light, and Blender gets the same room through --room.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOMS, roomFiles, roomScale, roomRotation, roomThumb, blenderRoom } from '../public/lib/rooms.js';
import { PLATES, DEFAULT_LIGHTING } from '../public/lib/pipeline.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

test('every scene is a room; every room file and thumbnail is bundled and its license noted', () => {
  const notices = readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const slug of Object.keys(PLATES)) assert.ok(ROOMS[slug], `${slug} has no room`);
  assert.equal(Object.keys(PLATES)[0], 'white-cyc-studio'); // the default comes first
  for (const slug of Object.keys(ROOMS)) {
    assert.ok(existsSync(path.join(PUBLIC, roomThumb(slug))), `${slug} thumbnail`);
    const files = roomFiles(slug);
    if (!files) continue;
    for (const f of Object.values(files)) {
      assert.ok(existsSync(path.join(PUBLIC, 'img', 'rooms', f)), f);
      assert.ok(notices.includes(f.replace(/_(2k\.hdr|(diff|rough|nor)_1k\.jpg)$/, '')), `${f} not in THIRD_PARTY_NOTICES.md`);
    }
  }
  // No flat backplates left except the showroom photo the Dud Rents spin sets still use.
  assert.deepEqual(readdirSync(path.join(PUBLIC, 'img', 'backplates')), ['showroom.jpg']);
});
test('the room scales to the model: a car by its length, a person by their height', () => {
  assert.equal(roomScale({ x: 1.9, y: 1.3, z: 4.6 }, 'car'), 1);
  assert.equal(roomScale({ x: 0.6, y: 1.8, z: 0.3 }, 'humanoid'), 1);
  assert.ok(Math.abs(roomScale({ x: 1.5, y: 4.6, z: 0.8 }, 'humanoid') - 4.6 / 1.8) < 1e-9); // Fit made it 4.6 m tall
  assert.equal(roomScale({ x: 0.1, y: 0.1, z: 0.1 }, 'car'), 0.25);
  assert.equal(roomScale(null), 1);
});

test('an HDRI room turns so its sun comes from the key light', () => {
  const norm = (a) => ((a % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  for (const [slug, r] of Object.entries(ROOMS).filter(([, x]) => x.type === 'hdri')) {
    for (const az of [-40, 0, 75, 170]) {
      const turned = 2 * Math.PI * (r.sun - 0.5) - roomRotation(slug, az); // the sun's angle atan2(z, x) after turning
      const key = Math.atan2(Math.cos((az * Math.PI) / 180), Math.sin((az * Math.PI) / 180)); // studio.js key position
      assert.ok(Math.abs(norm(turned - key)) < 1e-9, `${slug} at ${az}`);
    }
  }
  assert.equal(roomRotation('white-cyc-studio', 10), 0);
});

test('blenderRoom: the same room, camera, light and files for Blender', () => {
  const r = blenderRoom('night-city-rain', { kind: 'humanoid', dir: 'C:\\rooms\\' });
  assert.deepEqual([r.type, r.kind, r.files.hdri, r.light, r.camera.vfov > 0], ['hdri', 'humanoid', 'C:\\rooms/shanghai_bund_2k.hdr', PLATES['night-city-rain'].light, true]);
  assert.equal(r.turn, roomRotation('night-city-rain', PLATES['night-city-rain'].light.sun.azimuth));
  assert.equal(blenderRoom('night-city-rain', { keyAzimuth: DEFAULT_LIGHTING.azimuth + 30 }).turn, roomRotation('night-city-rain', PLATES['night-city-rain'].light.sun.azimuth + 30));
  assert.deepEqual([blenderRoom('showroom').light, blenderRoom('cyclorama').camera, blenderRoom('ring'), blenderRoom('transparent')], [null, null, null, null]);
});

test('a Blender render gets --room with files on disk; transparent gets none', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-rooms-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => (await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })).json();
  try {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', 'car.glb'))]), 'car.glb');
    form.append('name', 'Room car');
    const car = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    assert.equal((await json('/api/settings')).defaultScene, 'white-cyc-studio');
    await json('/api/settings', 'POST', { blenderPath: path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs') });
    await json(`/api/models/${car.id}`, 'PATCH', { scene: { preset: 'golden-hour-coast' } });
    await json(`/api/renders/${car.id}/start`, 'POST', { looks: [] });
    await json(`/api/renders/${car.id}/blender`, 'POST', { looks: ['studio', 'transparent'], frames: 0 });
    let job;
    for (let i = 0; i < 100 && (job = await json(`/api/renders/${car.id}/blender`)).status === 'running'; i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(job.status, 'done', job.error);
    const out = (await json(`/api/models/${car.id}`)).renders.outDir;
    const args = (look) => JSON.parse(readFileSync(path.join(out, 'frames', look, 'fake-blender-args.json'), 'utf8'));
    const studio = args('studio');
    assert.ok(!studio.includes('--plate'));
    const room = JSON.parse(studio[studio.indexOf('--room') + 1]);
    assert.deepEqual([room.slug, room.type, room.kind], ['golden-hour-coast', 'hdri', 'car']);
    for (const f of Object.values(room.files)) assert.ok(existsSync(f), f);
    assert.ok(!args('transparent').includes('--room'));
  } finally {
    await app.close();
  }
});
