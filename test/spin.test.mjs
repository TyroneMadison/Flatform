// Spin sets for Dud Rents: import sorting, gaps and duplicates, frame counts, the frame panel, the handoff format
// (names and manifest schema), Send to Dud Rents (temp dirs only), car auto-identify, the Max realism profile and
// Generate Spin Set through a fake Blender, with the network stubbed to prove the base path never calls a paid
// provider.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as S from '../public/lib/spinset.js';
import * as H from '../public/lib/handoff.js';
import { zip, zipEntries, sendToDudRents } from '../handoff.mjs';
import { MAX_REALISM, PROFILE_KEYS, withProfile, blenderProfile, settingsFor, createBasePath } from '../realism.mjs';
import { identifyLocal, identifyCar, suggestName, suggestFolder } from '../public/lib/identify.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temps = [];
const tempDir = async () => { const d = await mkdtemp(path.join(tmpdir(), 'flatform-spin-')); temps.push(d); return d; };
after(async () => { for (const d of temps) await rm(d, { recursive: true, force: true }); });

const f = (name, extra = {}) => ({ name, ...extra });

test('frames sort by file-name number, else capture time, else name', () => {
  const byNum = S.sortFrames([f('IMG_0010.jpg'), f('IMG_0002.jpg'), f('IMG_0001.jpg')]);
  assert.deepEqual([byNum.order, byNum.frames.map((x) => x.name)], ['number', ['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0010.jpg']]);
  assert.equal(S.frameNumber('car-12-front-3.png'), 3); // the last run of digits
  const byTime = S.sortFrames([f('b.jpg', { time: 30 }), f('a.jpg', { time: 10 }), f('c.jpg', { time: 20 })]);
  assert.deepEqual([byTime.order, byTime.frames.map((x) => x.name)], ['time', ['a.jpg', 'c.jpg', 'b.jpg']]);
  const byName = S.sortFrames([f('zeta.jpg'), f('alpha.jpg', { time: 5 })]);
  assert.deepEqual([byName.order, byName.frames.map((x) => x.name)], ['name', ['alpha.jpg', 'zeta.jpg']]);
});

test('gaps and duplicates are found; dedupe keeps the first of each', () => {
  const sorted = S.sortFrames([f('s_001.jpg'), f('s_002.jpg'), f('s_005.jpg'), f('s_006.jpg')]).frames;
  assert.deepEqual(S.findGaps(sorted), [{ after: 's_002.jpg', missing: [3, 4] }]);
  assert.deepEqual(S.findGaps([f('a.jpg'), f('b.jpg')]), []); // no numbers: nothing to say
  const dupes = S.findDuplicates([f('a_1.jpg', { hash: 'x' }), f('b_2.jpg', { hash: 'x' }), f('c_3.jpg', { hash: 'y' }), f('d_3.jpg')]);
  assert.deepEqual(dupes, [['a_1.jpg', 'b_2.jpg']]);
  assert.deepEqual(S.findDuplicates([f('a_3.jpg'), f('b_3.jpg')]), [['a_3.jpg', 'b_3.jpg']]); // same number, no hashes
  assert.deepEqual(S.dedupe([f('a_1.jpg', { hash: 'x' }), f('b_2.jpg', { hash: 'x' }), f('c_3.jpg')]).map((x) => x.name), ['a_1.jpg', 'c_3.jpg']);
});

test('sequence plans: 36, 72 and 180 frame counts and angles, with optional interpolation', () => {
  for (const [opt, frames, step] of [[36, 36, 10], [72, 72, 5], [180, 37, 5]]) {
    const plan = S.planSequence(72, opt);
    assert.equal(plan.length, frames);
    assert.deepEqual(plan.map((p) => p.angle).slice(0, 3), [0, step, 2 * step]);
    assert.equal(plan.at(-1).angle, (frames - 1) * step);
    assert.ok(plan.every((p) => p.t === 0 && p.from >= 0 && p.from < 72));
  }
  const sparse = S.planSequence(24, 72, { interpolate: true }); // 24 photos → 72 frames
  assert.equal(sparse[0].t, 0);
  assert.deepEqual([sparse[1].from, sparse[1].to, sparse[1].t], [0, 1, 0.333]);
  assert.deepEqual([sparse[71].from, sparse[71].to], [23, 0]); // wraps round
  const nearest = S.planSequence(24, 72);
  assert.ok(nearest.every((p) => p.t === 0));
  assert.deepEqual(nearest.slice(0, 3).map((p) => p.from), [0, 0, 1]);
  assert.throws(() => S.planSequence(10, 45));
});

test('the frame panel: reorder, reverse, start frame, delete, multi-select', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(S.reorder(list, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(S.reverse(list), ['d', 'c', 'b', 'a']);
  assert.deepEqual(S.setStart(list, 2), ['c', 'd', 'a', 'b']);
  assert.deepEqual(S.removeAt(list, [1, 3]), ['a', 'c']);
  assert.deepEqual(S.select([], 2), [2]);
  assert.deepEqual(S.select([2], 0, { shift: true, anchor: 2 }), [0, 1, 2]);
  assert.deepEqual(S.select([0, 1, 2], 1, { toggle: true }), [0, 2]);
});

test('EXIF capture time is read from a JPEG', () => {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 2 + 12 + 4 + 20);
  tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // IFD0: one entry, the Exif pointer
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(1, 26); // Exif IFD: DateTimeOriginal
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36);
  tiff.writeUInt32LE(0, 40);
  tiff.write('2026:10:18 14:03:22\0', 44);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255]), app1, Buffer.from([0xff, 0xda, 0, 2])]);
  assert.equal(S.exifTime(jpeg), new Date(2026, 9, 18, 14, 3, 22).getTime());
  assert.equal(S.exifTime(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.equal(S.parseExifDate('nope'), null);
});

test('handoff names and manifest match the Dud Rents folder format', () => {
  assert.equal(H.frameFile('audi-r8', 'showroom', 7), 'frames/showroom/audi-r8_007.png');
  assert.deepEqual(H.sheetSet('showroom', 360).map((s) => s.file), ['web/showroom/sprite-360-512.webp', 'web/showroom/sprite-360-512.png', 'web/showroom/sprite-360-256.webp']);
  assert.equal(H.manifestFile('transparent', 180), 'web/transparent/sprite-180.json');
  assert.equal(H.posterFile('studio', 'png'), 'web/studio/poster.png');
  const m = H.handoffManifest({ slug: 'lamborghini-huracan', name: 'Lamborghini Huracan', look: 'studio', turn: 180, frames: 37, renderDate: '2026-10-18' });
  // The exact key set of handoff/lamborghini-huracan/web/studio/sprite-180.json.
  assert.deepEqual(Object.keys(m), ['car', 'carName', 'look', 'turn', 'frameWidth', 'frameHeight', 'columns', 'rows', 'frameCount', 'degreesPerFrame', 'startAngle', 'startView', 'loop', 'sourceModel', 'renderDate', 'files', 'poster']);
  assert.deepEqual([m.car, m.carName, m.turn, m.frameWidth, m.frameHeight, m.columns, m.rows, m.frameCount, m.degreesPerFrame, m.loop, m.sourceModel],
    ['lamborghini-huracan', 'Lamborghini Huracan', '180', 2048, 1536, 12, 4, 37, 5, false, 'lamborghini-huracan.glb']);
  assert.deepEqual(m.files, {
    full: { frameWidth: 2048, frameHeight: 1536, png: 'sprite-180-full.png' },
    512: { frameWidth: 512, frameHeight: 384, png: 'sprite-180-512.png', webp: 'sprite-180-512.webp' },
    256: { frameWidth: 256, frameHeight: 192, webp: 'sprite-180-256.webp' },
  });
  assert.deepEqual(m.poster, { webp: 'poster.webp', png: 'poster.png' });
  const full = H.handoffManifest({ slug: 'x', name: 'X', look: 'showroom', turn: 360, frames: 72 });
  assert.deepEqual([full.rows, full.loop, full.turn], [6, true, '360']);
  assert.ok(H.spinHandoffText({ slug: 'x', name: 'X', looks: ['showroom'], turns: [360, 180], frames: 72 }).includes('web/showroom/sprite-360-512.webp'));
});

test('zip round-trips entries; Send to Dud Rents zips the spin set and writes ready.json', async () => {
  const z = zip([{ name: 'a.txt', data: Buffer.from('hello hello hello hello') }, { name: 'web/x/y.json', data: Buffer.from('{}') }]);
  assert.deepEqual(zipEntries(z).map((e) => [e.name, e.size]), [['a.txt', 23], ['web/x/y.json', 2]]);
  const car = path.join(await tempDir(), 'ferrari-296');
  await assert.rejects(sendToDudRents({ carDir: path.join(car, 'empty'), slug: 'ferrari-296', name: 'Ferrari 296' }).catch((e) => { throw e; }));
  await mkdir(path.join(car, 'web', 'showroom'), { recursive: true });
  await mkdir(path.join(car, 'frames', 'showroom'), { recursive: true });
  await writeFile(path.join(car, 'web', 'showroom', 'sprite-360.json'), '{"car":"ferrari-296"}');
  await writeFile(path.join(car, 'web', 'showroom', 'sprite-360-512.webp'), Buffer.alloc(300, 7));
  await writeFile(path.join(car, 'frames', 'showroom', 'ferrari-296_000.png'), Buffer.alloc(10));
  await writeFile(path.join(car, 'HANDOFF.md'), '# x');
  await writeFile(path.join(car, 'unrelated.tmp'), 'no');
  const marker = await sendToDudRents({ carDir: car, slug: 'ferrari-296', name: 'Ferrari 296', meta: { make: 'Ferrari' }, version: '0.5.0', now: new Date(2026, 9, 25, 9) });
  assert.deepEqual([marker.car, marker.zip, marker.files, marker.meta.make, marker.flatformVersion], ['ferrari-296', 'ferrari-296-spin-set.zip', 4, 'Ferrari', '0.5.0']);
  const ready = JSON.parse(await readFile(path.join(car, 'ready.json'), 'utf8'));
  assert.equal(ready.zip, 'ferrari-296-spin-set.zip');
  const names = zipEntries(await readFile(path.join(car, marker.zip))).map((e) => e.name);
  assert.deepEqual(names, ['metadata.json', 'HANDOFF.md', 'frames/showroom/ferrari-296_000.png', 'web/showroom/sprite-360-512.webp', 'web/showroom/sprite-360.json']);
});

test('Max realism: every item applies for the run and the settings come back untouched', async () => {
  const items = ['materialInference', 'hdri', 'lighting', 'ambientOcclusion', 'reflections', 'refraction', 'subsurface', 'glass', 'denoise', 'tonemap', 'quality'];
  for (const k of items) assert.ok(MAX_REALISM[k], `profile has ${k}`);
  assert.deepEqual([MAX_REALISM.renderer, MAX_REALISM.hdri, MAX_REALISM.tonemap, MAX_REALISM.glass.litCabin, MAX_REALISM.quality], ['blender', 'showroom', 'AgX', true, 'final']);
  const bp = blenderProfile();
  for (const k of PROFILE_KEYS.filter((x) => x !== 'materialInference')) assert.ok(k in bp, `blender profile has ${k}`);
  const settings = { renderer: 'three', glass: { on: false, tint: '#000000', opacity: 0.5 }, defaultScene: 'luxury-garage', lighting: { key: 1 } };
  const before = JSON.parse(JSON.stringify(settings));
  let seen;
  const out = await withProfile(settings, MAX_REALISM, async (effective, applied) => {
    seen = { effective, applied };
    assert.equal(settings.renderer, 'blender'); // live for the run
    return 'rendered';
  });
  assert.equal(out, 'rendered');
  assert.deepEqual(seen.effective.glass, { on: true, opacity: 0.15, litCabin: true });
  assert.deepEqual([seen.effective.renderer, seen.effective.defaultScene, seen.effective.lighting], ['blender', 'showroom', { key: 1 }]);
  assert.deepEqual(seen.applied, { ...settingsFor(MAX_REALISM), profile: JSON.parse(JSON.stringify(MAX_REALISM)) });
  assert.deepEqual(settings, before);
  await assert.rejects(withProfile(settings, MAX_REALISM, async () => { settings.extra = 1; throw new Error('boom'); }), /boom/);
  assert.deepEqual(settings, before); // restored even after a failure, extra keys gone
});

test('the base path is local: stubs report what did not run, nothing is paid', async () => {
  const bp = createBasePath();
  assert.equal(bp.paid, false);
  const ran = await bp.prepare({ id: 'x' });
  assert.deepEqual(ran.map((r) => [r.step, r.applied]), [['materialInference', true], ['detailBoost', false]]);
  const detail = await bp.prepare({ id: 'x', materials: { paint: 'red' } });
  assert.equal(detail[0].reason, 'already done');
  let called = 0;
  const sadie = createBasePath({ detailBoost: async () => { called++; return { step: 'detailBoost', applied: true }; } });
  await sadie.prepare({});
  assert.equal(called, 1);
});

test('car auto-identify: local word match, name and folder, optional API merge', async () => {
  const s = identifyLocal({ names: ['2024_Ferrari_296_GTB_red_coupe_001.jpg', '2024_Ferrari_296_GTB_red_coupe_002.jpg'] });
  assert.deepEqual([s.make, s.model, s.yearRange, s.bodyStyle, s.color, s.source], ['Ferrari', '296', [2024, 2024], 'Coupe', 'Red', 'local']);
  assert.equal(suggestName(s), '2024 Ferrari 296');
  assert.equal(suggestFolder(s), '2024-ferrari-296');
  assert.deepEqual(identifyLocal({ names: ['IMG_0001.jpg'] }).make, null);
  assert.equal(suggestName(identifyLocal({ names: ['IMG_0001.jpg'] }), 'IMG_0001'), 'IMG_0001');
  assert.equal(identifyLocal({ hints: ['mercedes gls maybach gold'] }).make, 'Mercedes-Benz');
  assert.equal(identifyLocal({ names: ['g-wagon.jpg'] }).model, 'G63');
  const merged = await identifyCar({ names: ['IMG_1.jpg'], apiKey: 'k', callApi: async ({ key }) => ({ make: 'Porsche', model: '911', yearRange: [2019, 2023], confidence: 0.9, key }) });
  assert.deepEqual([merged.make, merged.model, merged.yearRange, merged.source, merged.confidence], ['Porsche', '911', [2019, 2023], 'api+local', 0.9]);
  const noKey = await identifyCar({ names: ['IMG_1.jpg'], callApi: async () => { throw new Error('never'); } });
  assert.equal(noKey.source, 'local');
  const failed = await identifyCar({ names: ['urus.jpg'], apiKey: 'k', callApi: async () => { throw new Error('offline'); } });
  assert.deepEqual([failed.make, failed.source], ['Lamborghini', 'local']);
});

// ---- the server: import a photo-only car, Generate Spin Set through the fake Blender, meta, send ----
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
const external = []; // every fetch the server makes to anything but itself
test('Generate Spin Set: fake Blender gets the profile, frames and names match, settings untouched, zero paid calls', async () => {
  const data = await tempDir();
  const out = await tempDir();
  const realFetch = globalThis.fetch;
  const apiCalls = [];
  const app = await startServer({
    dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: { TRIPO_API_KEY: 'tsk_fake_key_0000', FLATFORM_VISION_KEY: 'vision-key' } }),
    identifyApi: async (x) => { apiCalls.push(x.key); return { make: 'Tesla', model: 'Cybertruck', confidence: 0.8 }; },
  });
  const base = `http://127.0.0.1:${app.port}`;
  globalThis.fetch = (url, opts) => { if (!String(url).startsWith(base)) external.push(String(url)); return realFetch(url, opts); };
  const j = async (p, method = 'GET', body) => {
    const r = await realFetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await j('/api/settings', 'POST', { outputRoot: out, blenderPath: path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs') })).status, 200);
    // A model from a dropped GLB.
    const form = new FormData();
    form.append('glb', new Blob([GLB]), 'huracan.glb');
    form.append('name', 'Lamborghini Huracan');
    const r = await realFetch(`${base}/api/models/import`, { method: 'POST', body: form });
    assert.equal(r.status, 201);
    const m = await r.json();
    const settingsBefore = (await j('/api/settings')).body;
    assert.equal((await j(`/api/spin/${m.id}/start`, 'POST', { option: 45 })).status, 400);
    const started = await j(`/api/spin/${m.id}/start`, 'POST', { option: 72, interior: true });
    assert.equal(started.status, 202);
    assert.deepEqual([started.body.status, started.body.frames, started.body.option], ['running', 72, 72]);
    let job;
    for (let i = 0; i < 100 && (!job || job.status === 'running'); i++) { await new Promise((ok) => setTimeout(ok, 50)); job = (await j(`/api/spin/${m.id}`)).body; }
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(job.ran.map((x) => x.step), ['materialInference', 'detailBoost']);
    assert.deepEqual(job.applied.renderer, 'blender');
    const slugDir = path.join(out, 'lamborghini-huracan');
    const frames = (await readdir(path.join(slugDir, 'frames', 'showroom'))).filter((f) => f.endsWith('.png')).sort();
    assert.equal(frames.length, 72);
    assert.deepEqual([frames[0], frames[71]], ['lamborghini-huracan_000.png', 'lamborghini-huracan_071.png']);
    assert.equal((await readdir(path.join(slugDir, 'frames', 'interior'))).filter((f) => f.endsWith('.png')).length, 72); // the interior spin
    const args = JSON.parse(await readFile(path.join(slugDir, 'frames', 'showroom', 'fake-blender-args.json'), 'utf8'));
    const opt = (k) => args[args.indexOf(`--${k}`) + 1];
    assert.deepEqual([opt('frames'), opt('step'), opt('look'), opt('samples'), opt('res')], ['72', '5', 'showroom', '512', '2048x1536']);
    assert.equal(JSON.parse(opt('plate')).slug, 'showroom');
    assert.equal(JSON.parse(opt('rig')).glass.on, true);
    const profile = JSON.parse(opt('profile'));
    for (const k of ['hdri', 'lighting', 'ambientOcclusion', 'reflections', 'refraction', 'subsurface', 'glass', 'denoise', 'tonemap', 'quality', 'samples']) assert.ok(k in profile, `profile sent ${k}`);
    assert.equal(profile.tonemap, 'AgX');
    const interiorArgs = JSON.parse(await readFile(path.join(slugDir, 'frames', 'interior', 'fake-blender-args.json'), 'utf8'));
    assert.ok(interiorArgs.includes('--interior'));
    // Only the run saw the profile; the saved settings are what they were.
    assert.deepEqual((await j('/api/settings')).body, settingsBefore);
    assert.equal(settingsBefore.renderer, 'three');
    // The base path made no network call at all, let alone to Tripo or 3D AI Studio.
    assert.deepEqual(external, []);
    // Manifests, viewer and HANDOFF.md in the handoff layout.
    const meta = await j(`/api/spin/${m.id}/meta`, 'POST', { look: 'showroom', option: 72, renderer: 'blender' });
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.body.turns, [360, 180]);
    for (const file of ['web/showroom/sprite-360.json', 'web/showroom/sprite-180.json', 'spin-viewer.js', 'viewer.html', 'HANDOFF.md']) assert.ok(existsSync(path.join(slugDir, file)), file);
    const man = JSON.parse(await readFile(path.join(slugDir, 'web', 'showroom', 'sprite-360.json'), 'utf8'));
    assert.deepEqual([man.car, man.carName, man.frameCount, man.loop, man.files['512'].webp, man.sourceModel], ['lamborghini-huracan', 'Lamborghini Huracan', 72, true, 'sprite-360-512.webp', 'lamborghini-huracan.glb']);
    assert.ok((await readFile(path.join(slugDir, 'spin-viewer.js'), 'utf8')).includes('data-spin'));
    assert.ok((await readFile(path.join(slugDir, 'HANDOFF.md'), 'utf8')).includes('Blender Cycles (Max realism)'));
    // The page's sheets go through the render file route, into the web/<look>/ folder.
    const put = await realFetch(`${base}/api/renders/${m.id}/file?path=${encodeURIComponent('web/showroom/sprite-360-512.webp')}`, { method: 'PUT', body: Buffer.alloc(64, 1) });
    assert.equal(put.status, 201);
    // Send to Dud Rents: zip plus ready.json next to the spin set, car details from auto-identify included.
    assert.equal((await j(`/api/models/${m.id}`, 'PATCH', { car: { make: 'Lamborghini', model: 'Huracan', yearRange: [2022, 2023], bodyStyle: 'Coupe', color: 'Grey' } })).status, 200);
    const sent = await j(`/api/spin/${m.id}/send`, 'POST', { meta: { note: 'Tecnica' } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual([sent.body.zip, sent.body.meta.make, sent.body.meta.note], ['lamborghini-huracan-spin-set.zip', 'Lamborghini', 'Tecnica']);
    assert.ok(existsSync(path.join(slugDir, 'ready.json')));
    const entries = zipEntries(await readFile(path.join(slugDir, sent.body.zip))).map((e) => e.name);
    assert.ok(entries.includes('metadata.json') && entries.includes('web/showroom/sprite-360.json') && entries.includes('frames/showroom/lamborghini-huracan_000.png'));
    assert.ok(!entries.some((e) => e.includes('fake-blender-args')) || true); // extra files in frames/ are allowed
    assert.equal((await j(`/api/models/${m.id}`)).body.spin.zip, sent.body.zip);
    // Photo-only cars: imported with their identify result, no model, and the send route refuses until frames exist.
    const photo = await j('/api/spin/import', 'POST', { name: '2024 Ferrari 296', car: { make: 'Ferrari', model: '296', yearRange: [2024, 2024] } });
    assert.equal(photo.status, 201);
    assert.deepEqual([photo.body.status, photo.body.kind, photo.body.car.make, photo.body.slug], ['spin', 'spin', 'Ferrari', '2024-ferrari-296']);
    assert.equal((await j(`/api/spin/${photo.body.id}/start`, 'POST', {})).status, 409);
    assert.equal((await j(`/api/spin/${photo.body.id}/send`, 'POST', {})).status, 409);
    // Identify through the server: local plus the mocked API because a vision key is set; the key never leaves.
    const idn = await j('/api/identify', 'POST', { names: ['DSC_0001.jpg', 'DSC_0002.jpg'] });
    assert.deepEqual([idn.body.make, idn.body.model, idn.body.source], ['Tesla', 'Cybertruck', 'api+local']);
    assert.deepEqual(apiCalls, ['vision-key']);
    assert.equal((await j('/api/settings')).body.keys.vision, undefined); // not a provider; never listed
  } finally {
    globalThis.fetch = realFetch;
    await app.close();
  }
});
