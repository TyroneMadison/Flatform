// Share links (mock, no deploy), auto-crop with union crop, LOD, style transfer, render version compare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import { shareId, createShares, MOCK_BASE } from '../share.mjs';
import { bounds, union, fit, sequenceCrop } from '../public/lib/autocrop.js';
import { buildLods, plan, triangles, table } from '../public/lib/lod.js';
import { applyStyle, kuwahara, cel } from '../public/lib/style.js';
import { addVersion, diffSettings, wipeClip, sliderKey, pairFrame } from '../public/lib/versions.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const img = (w, h, box) => { const data = new Uint8ClampedArray(w * h * 4); if (box) for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) data[(y * w + x) * 4 + 3] = 255; return { data, width: w, height: h }; };

test('share ids are 12 base62 chars and unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => shareId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[0-9A-Za-z]{12}$/);
});

test('shares: mock links until a base URL is set, expiry, delete, through the API', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-share-'));
  const app = await startServer({ dataDir: data, keyStore: createKeyStore({ env: {} }) });
  const u = `http://127.0.0.1:${app.port}/api/shares`;
  const j = async (url, method = 'GET', body) => { const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await j(u, 'POST', { modelId: 'm1' })).status, 400, 'no video, no link');
    const s = (await j(u, 'POST', { modelId: 'm1', title: 'Cybertruck', video: 'a.mp4', expiresInDays: 7 })).body;
    assert.equal(s.mock, true);
    assert.ok(s.url.startsWith(MOCK_BASE + '/'));
    assert.ok(s.expiresAt);
    assert.equal((await j(`${u}/${s.id}`, 'PATCH', { expiresInDays: null })).body.expiresAt, null);
    assert.equal((await j(u)).body.length, 1);
    assert.equal((await j(`${u}/${s.id}`, 'DELETE')).body.ok, true);
    assert.equal((await j(u)).body.length, 0);
  } finally { await app.close(); }
  let now = Date.parse('2026-01-01');
  const sh = createShares({ file: path.join(data, 'x.json'), baseUrl: () => 'https://s.example.dev/', now: () => now });
  const a = await sh.create({ modelId: 'm', video: 'v.mp4', expiresInDays: 1 });
  assert.equal(a.url, `https://s.example.dev/${a.id}`);
  now += 2 * 864e5;
  assert.equal((await sh.list())[0].expired, true);
});

test('auto-crop: bounds, padding, aspect, and one stable union crop for a spin', () => {
  assert.deepEqual(bounds(img(20, 10, { x: 5, y: 2, w: 4, h: 3 })), { x: 5, y: 2, w: 4, h: 3 });
  assert.equal(bounds(img(4, 4)), null);
  const r = fit({ x: 40, y: 40, w: 20, h: 20 }, { width: 100, height: 100 }, { padding: 0.1, aspect: 2 });
  assert.equal(r.w / r.h, 2);
  // a car drifting left to right across frames: every frame gets the same rectangle
  const frames = [0, 10, 20, 30].map((dx) => img(100, 50, { x: 10 + dx, y: 10, w: 30, h: 20 }));
  const crop = sequenceCrop(frames, { padding: 0 });
  assert.deepEqual(crop, { x: 10, y: 10, w: 60, h: 20 });
  assert.deepEqual(union([{ x: 0, y: 0, w: 1, h: 1 }, null]), { x: 0, y: 0, w: 1, h: 1 });
  // shadows (semi-transparent) are optional
  const sh = img(10, 10, { x: 2, y: 2, w: 2, h: 2 }); sh.data[(8 * 10 + 8) * 4 + 3] = 40;
  assert.equal(bounds(sh, { includeShadow: true }).w, 7);
  assert.equal(bounds(sh, { includeShadow: false }).w, 2);
});

test('LOD: three levels with fewer triangles, full model untouched', async () => {
  const g = new THREE.SphereGeometry(1, 48, 32);
  const full = triangles(g);
  const before = g.attributes.position.count;
  const lods = await buildLods(g, (geo, n) => new SimplifyModifier().modify(geo, n));
  assert.equal(g.attributes.position.count, before);
  assert.deepEqual(lods.map((l) => l.name), ['LOD1', 'LOD2', 'LOD3']);
  assert.ok(lods[0].tris < full && lods[2].tris < lods[0].tris, JSON.stringify(table(full, lods)));
  assert.equal(plan(100)[2].target, 64);
});

test('style: painterly and cel change pixels, none returns the frame, input never mutated', () => {
  const f = img(8, 8, { x: 0, y: 0, w: 8, h: 8 });
  for (let i = 0; i < f.data.length; i += 4) f.data[i] = (i * 7) % 255;
  const copy = new Uint8ClampedArray(f.data);
  assert.equal(applyStyle(f, 'none'), f);
  assert.notDeepEqual(kuwahara(f).data, f.data);
  assert.notDeepEqual(cel(f).data, f.data);
  assert.deepEqual(f.data, copy);
});

test('render versions: saved with settings, diff, wipe and paired frames', () => {
  let v = addVersion([], { files: ['a0.png', 'a1.png'], settings: { scene: 'showroom', light: { k: 1 } } });
  v = addVersion(v, { files: ['b0.png', 'b1.png', 'b2.png', 'b3.png'], settings: { scene: 'night', light: { k: 1 } } });
  assert.deepEqual(v.map((x) => x.n), [1, 2]);
  assert.deepEqual(diffSettings(v[0].settings, v[1].settings), [{ key: 'scene', a: 'showroom', b: 'night' }]);
  assert.deepEqual(wipeClip(0.25, 400, 200), { x: 100, y: 0, w: 300, h: 200 });
  assert.equal(sliderKey(0.5, 'ArrowRight'), 0.55);
  assert.equal(sliderKey(0.9, 'ArrowRight', true), 1);
  assert.deepEqual(pairFrame(1, v[0], v[1]), ['a1.png', 'b2.png']);
});
