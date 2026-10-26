import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { ENVIRONMENTS, envParts, partBounds, blenderEnvironment, skyRotation, rainDrops, envScale } from '../public/lib/environments.js';
import { buildEnvironment } from '../public/lib/env3d.js';
import { envCamera, letterbox, CAR_LENGTH } from '../public/lib/pipeline.js';
import { HDRIS, LIGHTING_PRESETS, hdriGround, blenderLook, applyLightingPreset } from '../public/lib/look.js';

const PLACES = ['showroom', 'white-cyc-studio', 'soft-studio', 'luxury-garage', 'golden-hour-coast', 'night-city-rain', 'desert-highway-dusk', 'modern-villa-driveway'];
const inside = (p, b) => p.every((v, i) => v > b.min[i] && v < b.max[i]);

test('every scene is a real 3D place around the car, not a picture: it moves on screen when the camera orbits', async () => {
  assert.deepEqual(Object.keys(ENVIRONMENTS).sort(), [...PLACES].sort());
  for (const [slug, e] of Object.entries(ENVIRONMENTS)) {
    assert.ok(e.sky.color || e.sky.hdri || e.sky.sun, `${slug}: sky is a colour, an HDRI at infinity or a procedural sky`);
    const group = await buildEnvironment(e);
    const meshes = [];
    group.traverse((o) => { if (o.isMesh) meshes.push(o); });
    assert.ok(meshes.length >= 3, `${slug}: has floor, walls or props`);
    for (const m of meshes) for (const mat of [].concat(m.material)) assert.equal(mat.map ?? null, null, `${slug}: no photo textures`);
    // Orbit the car-view camera 40° round the car: a world-space place shifts across the frame; a backplate would not.
    group.updateMatrixWorld(true);
    const cam = envCamera(e.cam);
    const camera = new THREE.PerspectiveCamera(cam.vfov, 4 / 3, 0.1, 2000);
    const shot = (yaw) => {
      camera.position.set(...cam.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yaw));
      camera.lookAt(new THREE.Vector3(...cam.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(yaw)));
      camera.updateMatrixWorld();
      return meshes.map((m) => new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).project(camera));
    };
    const [a, b] = [shot(0), shot(40)];
    const moved = a.filter((p, i) => Math.abs(p.z) < 1 && Math.hypot(p.x - b[i].x, p.y - b[i].y) > 0.1).length;
    assert.ok(moved >= Math.min(3, meshes.length), `${slug}: only ${moved} parts moved on screen`);
  }
});

test('environments are at real-world scale: the car stands on the floor, fits inside, camera at eye level', () => {
  const car = { min: [-CAR_LENGTH / 2 - 0.3, 0.05, -CAR_LENGTH / 2 - 0.3], max: [CAR_LENGTH / 2 + 0.3, 1.6, CAR_LENGTH / 2 + 0.3] };
  for (const [slug, e] of Object.entries(ENVIRONMENTS)) {
    const parts = envParts(e);
    for (const p of parts) for (const k of ['mat', 'floor', 'walls', 'ceiling']) if (p[k]) assert.ok(e.mats[p[k]], `${slug}: material ${p[k]}`);
    const boxes = parts.map(partBounds);
    // A floor whose top is exactly y = 0 under the whole turning car.
    const floor = boxes.find((b, i) => (parts[i].room || parts[i].cyc ? b.min[1] : b.max[1]) === 0 || Math.abs(b.max[1]) < 1e-9);
    assert.ok(floor && floor.min[0] <= car.min[0] && floor.max[0] >= car.max[0] && floor.min[2] <= car.min[2] && floor.max[2] >= car.max[2], `${slug}: floor under the car`);
    // Nothing solid where the car turns (rooms and coves are hollow; road paint and floors sit below 5 cm).
    parts.forEach((p, i) => {
      if (p.room || p.cyc) return;
      const b = boxes[i];
      const hit = b.min.every((v, k) => v < car.max[k]) && b.max.every((v, k) => v > car.min[k]);
      assert.ok(!hit, `${slug}: part ${JSON.stringify(p)} cuts into the car`);
    });
    // Car-view camera: eye level, standing in the place (inside the room), not inside a prop.
    const cam = envCamera(e.cam);
    assert.ok(cam.position[1] > 0.5 && cam.position[1] < 2, `${slug}: camera ${cam.position[1].toFixed(2)} m up`);
    const room = parts.find((p) => p.room);
    if (room) {
      const b = partBounds(room);
      assert.ok(room.room[1] >= 2.4 && room.room[1] <= 8, `${slug}: ceiling ${room.room[1]} m`);
      assert.ok(inside(cam.position, b), `${slug}: camera inside the room`);
    }
    parts.forEach((p, i) => { if (!p.room && !p.cyc) assert.ok(!inside(cam.position, boxes[i]), `${slug}: camera inside ${JSON.stringify(p)}`); });
    for (const b of boxes) for (const v of [...b.min, ...b.max]) assert.ok(Math.abs(v) <= 1500, `${slug}: part ${v} m away`);
    for (const name of [e.sky.hdri, e.reflect].filter(Boolean)) {
      assert.ok(HDRIS[name] && existsSync(new URL(`../public/img/hdri/${name}.hdr`, import.meta.url)), `${slug}: ${name}.hdr is bundled`);
    }
  }
});

test('the scene shows at the same size at any window shape (the 4:3 frame is letterboxed, never stretched)', () => {
  const tanV = Math.tan(THREE.MathUtils.degToRad(envCamera(ENVIRONMENTS['luxury-garage'].cam).vfov) / 2);
  for (const view of [0.5, 1, 4 / 3, 16 / 9, 21 / 9, 3]) {
    const fov = letterbox(tanV, 4 / 3, view);
    const frameShare = view >= 4 / 3 ? 1 : view / (4 / 3); // the frame's height as a share of the canvas height
    assert.ok(Math.abs(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * frameShare - tanV) < 1e-12, `view ${view}`);
  }
});

test('Blender builds the same places at the same scale, and place HDRIs sit on a real floor', () => {
  for (const slug of PLACES) {
    const cam = envCamera(ENVIRONMENTS[slug].cam);
    const b = blenderEnvironment(slug, cam, { hdri: (n) => `/hdri/${n}.hdr`, glb: (f) => `/env/${f}` });
    assert.deepEqual(b.parts.map(({ path, ...p }) => p), envParts(ENVIRONMENTS[slug]));
    for (const p of b.parts) if (p.glb) assert.equal(p.path, `/env/${p.glb}`);
    assert.deepEqual(b.rain, ENVIRONMENTS[slug].rain || null);
    assert.deepEqual(b.camera, cam);
    if (b.sky.hdri) assert.equal(b.sky.path, `/hdri/${b.sky.hdri}.hdr`);
    assert.deepEqual(JSON.parse(JSON.stringify(b)), b, 'survives the command line');
  }
  // Lighting studio places shown around the car are ground-projected: lens height and a radius in metres.
  for (const [id, p] of Object.entries(LIGHTING_PRESETS)) {
    const [height, radius] = hdriGround(p.hdri.file);
    assert.ok(height >= 1.4 && height <= 2 && radius >= 6 && radius <= 200, id);
    if (p.preset) assert.ok(ENVIRONMENTS[p.preset], `${id}: its 3D set ${p.preset} exists`);
    if (p.hdri.background) assert.deepEqual(blenderLook(applyLightingPreset({}, id)).hdri.ground, [height, radius]);
  }
  assert.deepEqual(hdriGround('my-upload.hdr'), [1.7, 40]);
});

test('the places use real CC0 models, each bundled and credited; Coast, Night City, Villa and Desert have some', () => {
  const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const slug of ['golden-hour-coast', 'night-city-rain', 'modern-villa-driveway', 'desert-highway-dusk']) {
    assert.ok(envParts(ENVIRONMENTS[slug]).some((p) => p.glb), `${slug} has models`);
  }
  for (const e of Object.values(ENVIRONMENTS)) {
    for (const p of envParts(e).filter((x) => x.glb)) {
      assert.ok(existsSync(new URL(`../public/env/${p.glb}`, import.meta.url)), `${p.glb} is bundled`);
      assert.ok(notices.includes(`\`${p.glb}\``), `${p.glb} is in THIRD_PARTY_NOTICES.md`);
    }
  }
  for (const name of ['umhlanga_sunrise', 'shanghai_bund']) assert.ok(notices.includes(`\`${name}.hdr\``), `${name}.hdr credited`);
  assert.equal(ENVIRONMENTS['golden-hour-coast'].sky.hdri, 'umhlanga_sunrise');
  assert.equal(ENVIRONMENTS['night-city-rain'].sky.hdri, 'shanghai_bund');
});

test('an HDRI sky turns so its sun comes from the key light', () => {
  for (const [slug, e] of Object.entries(ENVIRONMENTS).filter(([, x]) => x.sky.hdri)) {
    // three.js turns the sky like an object about Y: a direction at angle atan2(z, x) moves to angle - rotation.
    const sun = 2 * Math.PI * (e.sky.sunU - 0.5) - THREE.MathUtils.degToRad(skyRotation(e));
    const az = THREE.MathUtils.degToRad(e.light.sun.azimuth);
    const key = Math.atan2(Math.cos(az), Math.sin(az)); // studio.js key light position
    assert.ok(Math.abs(Math.atan2(Math.sin(sun - key), Math.cos(sun - key))) < 1e-9, slug);
  }
});

test('Night City rain: the same streaks in the app and in Blender', () => {
  const { rain } = ENVIRONMENTS['night-city-rain'];
  const drops = rainDrops(rain);
  assert.equal(drops.length, rain.drops);
  assert.deepEqual(rainDrops(rain), drops, 'fixed seed');
  for (const [x, y, z] of drops) assert.ok(Math.abs(x) <= rain.box[0] / 2 && y >= 0 && y <= rain.box[1] && Math.abs(z) <= rain.box[2] / 2);
  // render/blender_turntable.py rain_drops, run on its own (no Blender here): identical numbers.
  const py = readFileSync(new URL('../render/blender_turntable.py', import.meta.url), 'utf8').match(/^def rain_drops[\s\S]*?\n(?=\S)/m)[0];
  let out;
  try { out = execFileSync('python', ['-c', `import json\n${py}\nprint(json.dumps(rain_drops(json.loads('${JSON.stringify(rain)}'))[:50]))`], { encoding: 'utf8' }); } catch { return; } // no Python: skip the cross-check
  JSON.parse(out).forEach((d, i) => d.forEach((v, k) => assert.ok(Math.abs(v - drops[i][k]) < 1e-12, `drop ${i}`)));
});

test('a place scales to the model: a car by its length, a person by their height', () => {
  assert.equal(envScale({ x: 1.9, y: 1.3, z: 4.6 }, 'car'), 1);
  assert.equal(envScale({ x: 0.6, y: 1.8, z: 0.3 }, 'humanoid'), 1);
  assert.ok(Math.abs(envScale({ x: 1.5, y: 4.6, z: 0.8 }, 'humanoid') - 4.6 / 1.8) < 1e-9);
  assert.equal(envScale({ x: 0.1, y: 0.1, z: 0.1 }, 'car'), 0.25);
  assert.equal(envScale(null), 1);
});
