// TennoGen naming and size checker: the rules table, the report, the fix plan, the PNG codec and the server's
// check/fix routes on a temp folder. No network.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check, fixPlan, parseName, mapOf, guessType, properName, CONTENT_TYPES, MAP_KEYS, SET_NAMES } from '../public/lib/tennogen.js';
import { encode, decode, resize, pngSize, resizePng, isPng } from '../png.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const png = (w, h, channels = 4, fill = (x, y, c) => (x * 7 + y * 3 + c * 11) & 255) => {
  const data = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < channels; c++) data[(y * w + x) * channels + c] = fill(x, y, c);
  return encode({ width: w, height: h, channels, data });
};
const set = (name, size = [2048, 2048], tint = [1024, 1024]) => MAP_KEYS.map((k) => ({ name: `${name}_${k}.png`, width: (k === 't' || k === 'e' ? tint : size)[0], height: (k === 't' || k === 'e' ? tint : size)[1] }));
const codes = (r) => r.issues.map((i) => i.code);

test('rules table: the five set names from the texturing guide and the sizes from the content pages', () => {
  assert.deepEqual(SET_NAMES, ['Body', 'Helmet', 'Syandana', 'Weapon', 'Liset']);
  assert.deepEqual([CONTENT_TYPES.warframe.authored, CONTENT_TYPES.warframe.tint, CONTENT_TYPES.warframe.emissive], [[2048, 2048], [1024, 1024], [1024, 1024]]);
  assert.deepEqual([CONTENT_TYPES.helmet.tris, CONTENT_TYPES.helmet.authored, CONTENT_TYPES.helmet.ingame, CONTENT_TYPES.helmet.tint], [8000, [1024, 2048], [512, 1024], [256, 512]]);
  assert.deepEqual([CONTENT_TYPES.syandana.tris, CONTENT_TYPES.syandana.authored, CONTENT_TYPES.syandana.ingame], [7500, [2048, 1024], [1024, 512]]);
  assert.equal(CONTENT_TYPES.operator.tintChannels, 2);
  assert.deepEqual(MAP_KEYS, ['d', 'e', 'n', 'r', 's', 't']);
});

test('names: Texture_x.png, one character after the underscore, same set on every map, no extra underscores', () => {
  assert.deepEqual(parseName('Body_d.png'), { set: 'Body', suffix: 'd', map: 'd', underscores: 1 });
  assert.deepEqual(parseName('Excal_bake_n.png'), { set: 'Excal_bake', suffix: 'n', map: 'n', underscores: 2 });
  assert.equal(parseName('emissives.png'), null);
  assert.deepEqual(['diffuse', 'normal', 'roughness', 'spec', 'emissive', 'tintmask', 'x'].map(mapOf), ['d', 'n', 'r', 's', 'e', 't', null]);
  assert.equal(properName('helmet', 'n'), 'Helmet_n.png');
  const ok = check('warframe', set('Body'));
  assert.deepEqual([ok.pass, ok.errors, ok.warnings, ok.missing], [true, 0, 0, []]);

  const bad = check('warframe', [
    { name: 'Excalibur_diffuse.png', width: 2048, height: 2048 }, { name: 'Excal_s.png', width: 2048, height: 2048 },
    { name: 'Excalibur_bake_n.png', width: 2048, height: 2048 }, { name: 'emissives.png', width: 1024, height: 1024 },
    { name: 'Body r.png', width: 2048, height: 2048 }, { name: 'Body_t.jpg', width: 1024, height: 1024 },
  ]);
  assert.equal(bad.pass, false);
  for (const code of ['long-suffix', 'custom-set', 'extra-underscore', 'no-type', 'illegal-chars', 'not-png', 'mixed-sets', 'missing-maps']) assert.ok(codes(bad).includes(code), code);
  // Every bad name that names its map gets a one-click rename to the proper name.
  const renames = Object.fromEntries(bad.issues.filter((i) => i.fix?.kind === 'rename').map((i) => [i.file, i.fix.to]));
  assert.deepEqual(renames, { 'Excalibur_diffuse.png': 'Body_d.png', 'Excal_s.png': 'Body_s.png', 'Excalibur_bake_n.png': 'Body_n.png' });
});

test('sizes per content type: wrong sizes get a resize fix; tint and emissive have their own sizes', () => {
  const r = check('warframe', set('Body', [1024, 1024], [2048, 2048]));
  assert.equal(r.issues.filter((i) => i.code === 'size').length, 6);
  assert.deepEqual(r.issues.find((i) => i.file === 'Body_d.png').fix, { kind: 'resize', width: 2048, height: 2048 });
  assert.deepEqual(r.issues.find((i) => i.file === 'Body_t.png').fix, { kind: 'resize', width: 1024, height: 1024 });
  const helmet = check('helmet', set('Helmet', [1024, 2048], [256, 512]));
  // The helmet guide gives no emissive size, so the 256 × 512 emissive is left alone.
  assert.deepEqual(codes(helmet), []);
  assert.equal(check('liset', set('Liset', [777, 777], [5, 5])).pass, true, 'no Liset numbers in the guides: naming only');
  // Unknown sizes (no width) are not judged.
  assert.equal(check('warframe', MAP_KEYS.map((k) => ({ name: `Body_${k}.png` }))).pass, true);
});

test('duplicates, meshes and the fix plan', () => {
  const r = check('syandana', [...set('Syandana', [2048, 1024], [2048, 1024]), { name: 'Syandana_diffuse.png', width: 2048, height: 1024 }, { name: 'My Cape.fbx' }, { name: 'Syandana.fbx' }]);
  assert.ok(codes(r).includes('duplicate'));
  assert.ok(r.issues.some((i) => i.file === 'My Cape.fbx' && i.code === 'illegal-chars'));
  assert.ok(r.issues.some((i) => i.file === 'My Cape.fbx' && i.code === 'mesh-name' && i.severity === 'warn'));
  assert.ok(!r.issues.some((i) => i.file === 'Syandana.fbx'));
  const plan = fixPlan(r);
  // Syandana_diffuse.png → Syandana_d.png would clash with the existing map, so the plan drops it: one rename target each.
  assert.deepEqual(plan.map((p) => `${p.kind}:${p.file}`), ['rename:Syandana_diffuse.png', 'rename:My Cape.fbx']);
  const two = fixPlan(check('warframe', [{ name: 'Excal_diffuse.png', width: 2048, height: 2048 }, { name: 'Excalibur_d.png', width: 1024, height: 1024 }]));
  assert.equal(two.filter((p) => p.to === 'Body_d.png').length, 1, 'two files never get renamed to the same name');
  assert.ok(two.some((p) => p.kind === 'resize' && p.file === 'Excalibur_d.png'));
  assert.equal(guessType([{ name: 'helmet_d.png' }]), 'helmet');
  assert.equal(guessType([{ name: 'thing.png' }]), null);
});

test('png.mjs: size from the header, decode, resize and encode round trip', () => {
  const buf = png(8, 4);
  assert.ok(isPng(buf));
  assert.deepEqual(pngSize(buf), { width: 8, height: 4 });
  assert.equal(pngSize(Buffer.from('not a png at all, really not')), null);
  const img = decode(buf);
  assert.deepEqual([img.width, img.height, img.channels, img.data[5]], [8, 4, 4, (1 * 7 + 0 * 3 + 1 * 11) & 255]);
  const half = resize(img, 4, 2);
  assert.deepEqual([half.width, half.height], [4, 2]);
  assert.equal(half.data[0], Math.round(((0) + (7) + (3) + (10)) / 4)); // box average of the 2 × 2 block
  const up = resize(decode(png(2, 2, 1, (x, y) => (x + y) * 100)), 4, 4);
  assert.deepEqual([up.width, up.channels, up.data[0], up.data[15]], [4, 1, 0, 200]);
  assert.ok(up.data[5] > 0 && up.data[5] < 200, 'bilinear in between');
  const grey = decode(png(3, 3, 2));
  assert.equal(grey.channels, 2);
  assert.deepEqual(pngSize(resizePng(png(16, 16, 3), 8, 4)), { width: 8, height: 4 });
  assert.throws(() => decode(Buffer.from('nope')), /Not a PNG/);
});

const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

test('server: check a folder, then fix it (renames in place, resizes with the original kept)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flatform-tennogen-'));
  temps.push(dir);
  const tex = path.join(dir, 'textures');
  await (await import('node:fs/promises')).mkdir(tex);
  await writeFile(path.join(tex, 'Excalibur_diffuse.png'), png(2048, 2048, 3));
  await writeFile(path.join(tex, 'Body_n.png'), png(1024, 1024, 3));
  for (const k of ['r', 's']) await writeFile(path.join(tex, `Body_${k}.png`), png(2048, 2048, 1));
  await writeFile(path.join(tex, 'Body_e.png'), png(1024, 1024, 1));
  await writeFile(path.join(tex, 'Body_t.png'), png(1024, 1024, 3));
  await writeFile(path.join(tex, 'notes.txt'), 'ignored');
  const app = await startServer({ dataDir: path.join(dir, 'data'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  try {
    const j = async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${app.port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${app.port}`, Host: `127.0.0.1:${app.port}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    let r = await j('/api/tennogen/check', { dir: tex, type: 'warframe' });
    assert.equal(r.status, 200);
    assert.equal(r.body.pass, false);
    assert.deepEqual(r.body.files.map((f) => f.name), ['Body_e.png', 'Body_n.png', 'Body_r.png', 'Body_s.png', 'Body_t.png', 'Excalibur_diffuse.png']);
    assert.equal(r.body.files.find((f) => f.name === 'Body_n.png').width, 1024);
    assert.ok(codes(r.body).includes('long-suffix') && codes(r.body).includes('size'));
    assert.equal((await j('/api/tennogen/check', { dir: path.join(dir, 'nope'), type: 'warframe' })).status, 400);
    assert.equal((await j('/api/tennogen/check', { dir: tex, type: 'hat' })).status, 400);

    r = await j('/api/tennogen/fix', { dir: tex, type: 'warframe' });
    assert.equal(r.status, 200);
    assert.ok(r.body.applied.every((a) => a.ok), JSON.stringify(r.body.applied));
    assert.equal(r.body.pass, true, JSON.stringify(r.body.issues));
    const names = (await readdir(tex)).sort();
    assert.deepEqual(names, ['Body_d.png', 'Body_e.png', 'Body_n.png', 'Body_r.png', 'Body_s.png', 'Body_t.png', 'notes.txt', 'tennogen-original']);
    assert.deepEqual(pngSize(await readFile(path.join(tex, 'Body_n.png'))), { width: 2048, height: 2048 });
    assert.deepEqual(pngSize(await readFile(path.join(tex, 'tennogen-original', 'Body_n.png'))), { width: 1024, height: 1024 });

    // The setting and the per-model folder.
    const s = await j('/api/settings', { tennogenCheck: 'block' });
    assert.equal(s.body.tennogenCheck, 'block');
    assert.equal((await j('/api/settings', { tennogenCheck: 'maybe' })).status, 400);
  } finally {
    await app.close();
  }
});
