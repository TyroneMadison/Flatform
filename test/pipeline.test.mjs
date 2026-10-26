// Unit tests for the shared turntable/handoff rules (public/lib/pipeline.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../public/lib/pipeline.js';

test('72 angles at 5° steps, 180 subset is frames 0–36', () => {
  const all = P.angles();
  assert.equal(all.length, 72);
  assert.deepEqual(all.slice(0, 3), [0, 5, 10]);
  assert.equal(all.at(-1), 355);
  const half = P.halfTurn(all);
  assert.equal(half.length, 37);
  assert.deepEqual([half[0], half.at(-1)], [0, 180]);
  assert.equal(P.turnFrames(360), 72);
  assert.equal(P.turnFrames(180), 37);
});

test('frame and file names', () => {
  assert.equal(P.frameName('audi-r8', 0), 'audi-r8_000.png');
  assert.equal(P.frameName('audi-r8', 71), 'audi-r8_071.png');
  assert.equal(P.framePath('audi-r8', 'studio', 6), 'frames/studio/audi-r8_006.png');
  assert.deepEqual(P.angles().map((_, i) => P.frameName('x', i)).slice(-2), ['x_070.png', 'x_071.png']);
  assert.equal(P.stillName('audi-r8', 'studio', 30), 'audi-r8_studio_030.png');
  assert.equal(P.stillName('audi-r8', 'transparent', 365), 'audi-r8_transparent_005.png');
  assert.equal(P.sheetName('transparent', 360, 256), 'transparent-360-256.webp');
  assert.equal(P.spriteJsonName('studio', 180), 'studio-sprite-180.json');
  assert.equal(P.posterName('studio', 'png'), 'studio-poster.png');
  assert.deepEqual(P.sheetFiles('studio', 360).map((s) => s.name), ['studio-360-512.webp', 'studio-360-256.webp', 'studio-360-512.png']);
  assert.deepEqual(P.sheetFiles('studio', 180).map((s) => s.name), ['studio-180-512.webp', 'studio-180-256.webp']);
});

test('sprite grid math: 360 is 12×6, 180 is 12×4 with a partial last row', () => {
  assert.deepEqual(P.spriteGrid(72), { columns: 12, rows: 6, frames: 72, lastRowFrames: 12 });
  assert.deepEqual(P.spriteGrid(37), { columns: 12, rows: 4, frames: 37, lastRowFrames: 1 });
  assert.deepEqual(P.cellOf(0), { col: 0, row: 0 });
  assert.deepEqual(P.cellOf(13), { col: 1, row: 1 });
  assert.deepEqual(P.cellOf(36), { col: 0, row: 3 });
  assert.deepEqual(P.cellOf(71), { col: 11, row: 5 });
  assert.deepEqual(P.frameSize('studio', 512), { width: 512, height: 384 });
  assert.deepEqual(P.frameSize('studio', 256), { width: 256, height: 192 });
  assert.deepEqual(P.frameSize('transparent', 512), { width: 512, height: 512 });
  assert.deepEqual(P.sheetSize('studio', 360, 512), { width: 6144, height: 2304 });
  assert.deepEqual(P.sheetSize('transparent', 180, 256), { width: 3072, height: 1024 });
});

test('manifest fields', () => {
  const m = P.manifest({ slug: 'audi-r8', name: 'Audi R8', look: 'transparent', turn: 360, version: '0.3.0', renderedAt: '2026-10-18T00:00:00.000Z' });
  assert.deepEqual(m, {
    slug: 'audi-r8', name: 'Audi R8', look: 'transparent', frameWidth: 512, frameHeight: 512, columns: 12, rows: 6, frames: 72,
    lastRowFrames: 12, degreesPerFrame: 5, startAngle: 0, loop: true, sheet: 'transparent-360-512.webp',
    sheets: { 512: 'transparent-360-512.webp', 256: 'transparent-360-256.webp' }, sheetPng: 'transparent-360-512.png',
    poster: 'transparent-poster.webp', sourceModel: '../models/audi-r8.glb', renderer: 'three', flatformVersion: '0.3.0',
    renderedAt: '2026-10-18T00:00:00.000Z',
  });
  const half = P.manifest({ slug: 'audi-r8', name: 'Audi R8', look: 'studio', turn: 180, renderer: 'blender', version: '0.3.0' });
  assert.equal(half.loop, false);
  assert.deepEqual([half.frames, half.columns, half.rows, half.lastRowFrames], [37, 12, 4, 1]);
  assert.deepEqual([half.frameWidth, half.frameHeight], [512, 384]);
  assert.equal(half.sheet, 'studio-180-512.webp');
  assert.equal(half.sheetPng, undefined);
  assert.equal(half.renderer, 'blender');
  assert.match(half.renderedAt, /^\d{4}-\d\d-\d\dT/);
});

test('slugify and unique slugs', () => {
  assert.equal(P.slugify('Audi R8'), 'audi-r8');
  assert.equal(P.slugify('  Huracán Tecnica!! '), 'huracan-tecnica');
  assert.equal(P.slugify('GLS Maybach · rear'), 'gls-maybach-rear');
  assert.equal(P.slugify('../../etc/passwd'), 'etc-passwd');
  assert.equal(P.slugify('***'), 'car');
  assert.equal(P.slugify('x'.repeat(100)).length, 60);
  assert.equal(P.uniqueSlug('Audi R8', []), 'audi-r8');
  assert.equal(P.uniqueSlug('Audi R8', ['audi-r8']), 'audi-r8-2');
  assert.equal(P.uniqueSlug('audi r8', ['audi-r8', 'audi-r8-2']), 'audi-r8-3');
});

test('handoff text and viewer page', () => {
  const md = P.handoffText({ slug: 'audi-r8', name: 'Audi R8', looks: ['showroom', 'transparent'], turns: [360, 180], models: ['audi-r8.glb'], version: '0.3.0' });
  assert.match(md, /Showroom 360 · 512\*\* → spinning thumbnails across dudrents\.com: `web\/showroom-360-512\.webp`/);
  assert.match(md, /Transparent 360 · 256\*\* → admin portal lists and the edit page: `web\/transparent-360-256\.webp`/);
  assert.match(md, /Showroom 180\*\* → swipe view on the car's detail page: `web\/showroom-180-512\.webp`/);
  assert.match(md, /`frames\/showroom\/audi-r8_000\.png … audi-r8_071\.png`/);
  assert.match(md, /`models\/audi-r8\.glb`/);
  assert.match(md, /`spin-viewer\.js`/);
  const onlyStudio = P.handoffText({ slug: 'a', name: 'A', looks: ['studio'], turns: [180], version: '0.3.0' });
  assert.match(onlyStudio, /Showroom 360 · 512\*\* → spinning thumbnails across dudrents\.com: _not rendered this time_/);
  assert.match(onlyStudio, /`frames\/studio\/a_000\.png … a_036\.png`/);

  const manifests = { transparent360: P.manifest({ slug: 'a', name: 'A <b>', look: 'transparent', turn: 360, version: '0.3.0' }) };
  const html = P.viewerHtml({ name: 'A <b>', manifests });
  assert.match(html, /<title>A &#60;b&#62; · spin viewer<\/title>/);
  assert.equal((html.match(/data-flatform-spin=/g) || []).length, 1); // the 256 of the transparent 360
  assert.match(html, /<script src="spin-viewer\.js"><\/script>/);
});

test('three looks; the light rig and glass are validated and merged', () => {
  assert.deepEqual(Object.keys(P.LOOKS), ['showroom', 'studio', 'transparent']);
  assert.deepEqual(P.DEFAULT_LOOKS, ['studio', 'transparent']); // v0.6: the Compose scene (White Cyc Studio by default)
  assert.deepEqual(P.frameSize('showroom', 512), { width: 512, height: 384 });
  assert.deepEqual(P.cleanLighting({ key: 1.5, kelvin: 3200 }), { ...P.DEFAULT_LIGHTING, key: 1.5, kelvin: 3200 });
  for (const bad of [{ key: 3 }, { kelvin: 1000 }, { azimuth: '10' }, { color: 1 }, [], null]) assert.equal(P.cleanLighting(bad), null);
  assert.deepEqual(P.cleanGlass({ tint: '#AABBCC', opacity: 0.4 }), { on: true, tint: '#aabbcc', opacity: 0.4 });
  for (const bad of [{ tint: 'red' }, { opacity: 2 }, { on: 'yes' }, { transmission: 1 }]) assert.equal(P.cleanGlass(bad), null);
});

test('plate camera: the car stands where the photo floor is', () => {
  const near = (a, b, d = 1e-6) => assert.ok(Math.abs(a - b) < d, `${a} vs ${b}`);
  // Where a point straight ahead (x = 0) lands in the frame, 0 = top: its angle from the view axis over the half fov.
  const project = (cam, [, y, z]) => {
    const [, cy, cz] = cam.position; const [, ty, tz] = cam.target;
    const off = Math.atan2(cy - y, cz - z) - Math.atan2(cy - ty, cz - tz); // radians below the view axis
    return (1 + Math.tan(off) / Math.tan((cam.vfov * Math.PI) / 360)) / 2;
  };
  for (const [slug, plate] of Object.entries(P.PLATES)) {
    const cam = P.plateCamera(plate.cam);
    near(project(cam, [0, 0, 0]), plate.cam.ground, 1e-9); // the car's ground point lands on the photo's floor
    near(project(cam, [0, cam.position[1], -1e7]), plate.cam.horizon, 1e-3); // eye level lands on the horizon
    assert.ok(cam.position[1] > 0.3 && cam.position[1] < 3, `${slug}: camera height ${cam.position[1]}`);
  }
  assert.equal(P.plateUrl('showroom'), '/img/backplates/showroom.jpg');
});

test('the Drop step tells 3D models from photos', async () => {
  const { isModelFile, extOf, MODEL_EXTS } = await import('../public/lib/importer.js');
  assert.deepEqual(MODEL_EXTS, ['.glb', '.gltf', '.fbx', '.obj', '.usdz']);
  for (const name of ['car.GLB', 'a.b.gltf', 'x.fbx', 'y.obj', 'z.usdz']) assert.ok(isModelFile({ name }), name);
  for (const name of ['car.jpg', 'car.heic', 'glb', 'car.stl', '']) assert.ok(!isModelFile({ name }), name);
  assert.equal(extOf('Some.Car.FBX'), '.fbx');
});
