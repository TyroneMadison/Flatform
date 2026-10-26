// Health check, shortcut keys, client preview PIN (all local, nothing paid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkScene, applyFix, openEdges, triCount, TENNO_BUDGET } from '../public/lib/health.js';
import { loadKeys, saveKeys, validCombo, comboOf, conflicts, bindingsFor, ACTIONS } from '../public/lib/hotkeys.js';
import { hashPin, pinMatches, createPreviewLock } from '../preview.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'flatform-d-'));
const geo = (tris, extra = {}) => ({ attributes: { position: { count: tris * 3 }, normal: {}, uv: {}, ...extra.attrs }, index: extra.index ?? null, computeVertexNormals() { this.attributes.normal = {}; } });
const quad = () => ({ index: { count: 6, array: [0, 1, 2, 0, 2, 3] }, attributes: { position: { count: 4 }, normal: {}, uv: {} } });
const tree = (meshes) => ({ traverse(fn) { meshes.forEach(fn); } });
const mesh = (name, g, material = { name: 'paint' }) => ({ isMesh: true, name, geometry: g, material });

test('health: clean model passes; missing material, normals, textures and budget are caught', () => {
  assert.equal(triCount(quad()), 2);
  assert.equal(openEdges(quad()), 4, 'a lone quad has 4 open edges');
  const closed = { index: { count: 12, array: [0, 1, 2, 0, 2, 1, 0, 1, 3, 0, 3, 1] }, attributes: { position: { count: 4 } } };
  assert.equal(openEdges(closed) >= 0, true);
  const ok = checkScene(tree([mesh('body', geo(10, { index: { count: 30, array: Array.from({ length: 30 }, (_, i) => [0, 1, 2, 0, 2, 1][i % 6]) } }))]));
  assert.equal(ok.pass, true);
  const bad = checkScene(tree([
    mesh('door', { attributes: { position: { count: 3 } }, computeVertexNormals() { this.attributes.normal = {}; } }, null),
    mesh('decal_logo', geo(1), { map: { name: 'x', image: null } }),
    mesh('wheel', geo(1), { map: { name: 'rim', image: { width: 300, height: 300 } } }),
  ]));
  const ids = bad.checks.map((c) => c.id);
  for (const id of ['material', 'normals', 'uvs', 'texture-missing', 'texture-size']) assert.ok(ids.includes(id), id);
  assert.equal(bad.pass, false);
  const t = checkScene(tree([mesh('frame', geo(TENNO_BUDGET.tris + 1))]), { tennogen: true });
  assert.ok(t.checks.some((c) => c.id === 'tris') && t.checks.some((c) => c.id === 'tint'));
  assert.equal(checkScene(tree([])).checks[0].id, 'empty');
});

test('health fixes: normals rebuilt, plain material added, nothing else touched', () => {
  const door = mesh('door', { attributes: { position: { count: 3 }, uv: {} }, computeVertexNormals() { this.attributes.normal = {}; } }, null);
  const t = tree([door, mesh('body', geo(1))]);
  assert.equal(applyFix(t, 'normals'), 1);
  assert.equal(applyFix(t, 'material', { makeMaterial: () => ({ name: 'plain' }) }), 1);
  assert.equal(door.material.name, 'plain');
  assert.equal(checkScene(t).pass, true);
  assert.equal(applyFix(t, 'uvs'), 0);
});

test('hotkeys: defaults, saved combos, bad combos rejected, conflicts found, per-screen list', () => {
  const mem = new Map(); const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadKeys(store).keys.preview, ACTIONS.preview.key);
  assert.equal(loadKeys(store).show, true);
  saveKeys({ show: false, keys: { preview: 'Alt+P', finish: 'Shift+X' } }, store);
  const k = loadKeys(store);
  assert.equal(k.show, false); assert.equal(k.keys.preview, 'Alt+P'); assert.equal(k.keys.finish, ACTIONS.finish.key, 'Shift alone is not allowed');
  assert.equal(validCombo('Ctrl+Shift+F5'), true); assert.equal(validCombo('P'), false); assert.equal(validCombo('Ctrl+Ctrl+P'), false);
  assert.equal(comboOf({ key: 'p', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+P');
  assert.equal(comboOf({ key: 'Control', ctrlKey: true }), '');
  assert.deepEqual(conflicts({ a: 'Ctrl+P', b: 'Ctrl+P', c: 'Alt+P' }), [['a', 'b']]);
  const rows = bindingsFor('compose', k.keys);
  assert.ok(rows.some(([key]) => key === 'Alt+P'));
  mem.set('flatform.hotkeys', '{not json'); assert.equal(loadKeys(store).keys.preview, ACTIONS.preview.key);
});

test('preview PIN: hashed, change needs the old PIN, pauses after 5 wrong tries', async () => {
  const rec = hashPin('2468');
  assert.ok(!JSON.stringify(rec).includes('2468'));
  assert.equal(pinMatches(rec, '2468'), true); assert.equal(pinMatches(rec, '1111'), false);
  assert.throws(() => hashPin('12'));
  let t = 0; const file = path.join(await tmp(), 'preview.json');
  const lock = createPreviewLock({ file, now: () => t });
  assert.deepEqual(await lock.view(), { hasPin: false });
  assert.equal((await lock.unlock('')).ok, true, 'no PIN, no lock');
  await lock.setPin('2468');
  await assert.rejects(lock.setPin('1357', '0000'));
  for (let i = 0; i < 5; i++) assert.equal((await lock.unlock('0000')).ok, false);
  assert.match((await lock.unlock('2468')).error, /Wait/);
  t += 31000;
  assert.equal((await lock.unlock('2468')).ok, true);
  const again = createPreviewLock({ file }); assert.deepEqual(await again.view(), { hasPin: true });
  await lock.setPin(null, '2468'); assert.deepEqual(await lock.view(), { hasPin: false });
});

test('preview API: set PIN, wrong PIN 403, right PIN ok, PIN never returned', async () => {
  const app = await startServer({ dataDir: await tmp(), keyStore: createKeyStore({ env: {} }) });
  const j = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${app.port}/api/${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.deepEqual((await j('preview')).body, { hasPin: false });
    assert.equal((await j('preview', 'PUT', { pin: 'abc' })).status, 400);
    assert.equal((await j('preview', 'PUT', { pin: '4321' })).status, 200);
    const v = await j('preview'); assert.deepEqual(v.body, { hasPin: true });
    assert.equal((await j('preview/unlock', 'POST', { pin: '0000' })).status, 403);
    assert.equal((await j('preview/unlock', 'POST', { pin: '4321' })).status, 200);
  } finally { await app.close(); }
});
