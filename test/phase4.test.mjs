import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHistory, rollbackCommand, isSafe, isUndo, isRedo } from '../public/lib/history.js';
import { toUnit, fromUnit, formatLength, dimensions, gridSpec } from '../public/lib/grid.js';
import { compareSet, lumaStats } from '../public/lib/compare.js';
import { textureSet } from '../public/lib/tenno.js';
import { PRESETS, normalizeTheme, resolveTheme, themeVars, contrast, AAA } from '../public/lib/theme.js';
import { createWorkspaces } from '../workspaces.mjs';
import { startApp } from '../server.mjs';

test('undo/redo stack: push, undo, redo, new edit clears redo, limit', () => {
  const h = createHistory({ limit: 3 });
  let s = { x: 0 };
  for (let i = 1; i <= 4; i++) { h.push(s); s = { x: i }; }
  assert.deepEqual(h.undo(s), { x: 3 });
  assert.deepEqual(h.undo({ x: 3 }), { x: 2 });
  assert.deepEqual(h.undo({ x: 2 }), { x: 1 });
  assert.equal(h.undo({ x: 1 }), null); // limit 3
  assert.deepEqual(h.redo({ x: 1 }), { x: 2 });
  h.push({ x: 2 }, 'turn');
  assert.equal(h.canRedo, false);
  assert.equal(h.list()[0].label, 'turn');
  assert.ok(isUndo({ ctrlKey: true, key: 'z' }) && isRedo({ ctrlKey: true, shiftKey: true, key: 'Z' }) && isRedo({ ctrlKey: true, key: 'y' }));
});

test('rollback builds a safe git command: revert or new branch, never reset or force', () => {
  const sha = 'a1b2c3d4e5f6';
  assert.deepEqual(rollbackCommand({ sha, mode: 'revert' }), [['revert', '--no-edit', `${sha}..HEAD`]]);
  assert.deepEqual(rollbackCommand({ sha }), [['switch', '-c', 'rollback-a1b2c3d', sha]]);
  for (const mode of ['reset', 'hard', 'force']) assert.throws(() => rollbackCommand({ sha, mode }));
  assert.throws(() => rollbackCommand({ sha: 'HEAD~1; rm -rf /' }));
  assert.throws(() => rollbackCommand({ sha, branch: 'main' }));
  assert.throws(() => rollbackCommand({ sha, branch: '--force' }));
  assert.ok(isSafe(rollbackCommand({ sha, mode: 'revert' })) && isSafe(rollbackCommand({ sha })));
  assert.equal(isSafe([['reset', '--hard', sha]]), false);
  assert.equal(isSafe([['push', '--force']]), false);
});

test('grid unit conversion and dimension readout', () => {
  assert.ok(Math.abs(toUnit(1.8, 'ft') - 5.905) < 0.001);
  assert.ok(Math.abs(fromUnit(10, 'ft') - 3.048) < 1e-9);
  assert.equal(formatLength(1.8, 'ft'), '5 ft 11 in');
  assert.equal(formatLength(0.42), '42 cm');
  assert.equal(dimensions({ x: 1.85, y: 1.45, z: 4.5 }).text, 'W 1.85 m x H 1.45 m x L 4.50 m');
  assert.equal(dimensions({ x: 1.85, y: 1.45, z: 4.5 }, 'ft').l, '14 ft 9 in');
  const g = gridSpec({ x: 1.85, y: 1.45, z: 4.5 }, 'ft');
  assert.equal(g.cell, 0.3048); assert.ok(g.size >= 4.5 * 2.5);
});

test('TennoGen compare checklist: pass on the template set, fail on wrong size, name, channels, albedo', () => {
  const good = textureSet('Body').map((t) => ({ name: t.name, width: t.width, height: t.height, channels: t.map === 't' ? 4 : 3, luma: t.map === 'd' ? { min: 40, max: 210, mean: 130 } : null }));
  const ok = compareSet(good);
  assert.equal(ok.pass, true, JSON.stringify(ok.checks.filter((c) => !c.pass)));
  const bad = good.map((f) => (f.name === 'Body_n.png' ? { ...f, width: 1024, height: 1024 } : f.name === 'Body_t.png' ? { ...f, channels: 3 } : f.name === 'Body_d.png' ? { ...f, luma: { min: 0, max: 255, mean: 250 } } : f)).filter((f) => f.name !== 'Body_e.png');
  bad.push({ name: 'body-diffuse.png', width: 2048, height: 2048 });
  const r = compareSet(bad);
  assert.equal(r.pass, false);
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
  for (const id of ['e-present', 'n-size', 't-channels', 'd-luma', 'name-body-diffuse.png']) assert.ok(failed.includes(id), id);
  const l = lumaStats(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 9, 9, 9, 0]));
  assert.equal(l.min, 0); assert.equal(l.max, 255); assert.ok(Math.abs(l.mean - 127.5) < 1e-9);
});

test('themes: presets apply, reset restores Flatform Dark, High Contrast meets AAA, no 3D values', () => {
  assert.deepEqual(normalizeTheme(undefined), { preset: 'dark', custom: {} });
  assert.deepEqual(normalizeTheme({ preset: 'nope', custom: { primary: 'red', accent: '#ABCDEF' } }), { preset: 'dark', custom: { accent: '#abcdef' } });
  assert.equal(resolveTheme({ preset: 'warm' }).primary, '#FA614B');
  assert.equal(themeVars({ preset: 'cool', custom: { primary: '#123456' } })['--accent'], '#123456');
  assert.ok(Object.keys(PRESETS).length === 6);
  const hc = PRESETS.contrast;
  for (const fg of [hc.text, hc.muted, hc.primary, hc.accent]) assert.ok(contrast(fg, hc.bg) >= AAA, fg);
  assert.ok(contrast(hc.onAccent, hc.primary) >= AAA);
  for (const k of Object.keys(themeVars({ preset: 'orokin' }))) assert.ok(k.startsWith('--'), 'CSS variables only');
});

test('workspaces: migration keeps the old library as Car with a backup, folders are isolated', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'ff-ws-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, 'models', 'abc'), { recursive: true });
  await writeFile(path.join(base, 'library.json'), '[{"id":"abc"}]');
  const ws = createWorkspaces({ baseDir: base });
  const v = await ws.load();
  assert.equal(v.active, 'car');
  assert.deepEqual(v.list.map((w) => w.id), ['car', 'warframe']);
  assert.equal(ws.activeDir(), path.resolve(base));
  assert.ok(existsSync(path.join(base, 'models', 'abc')), 'nothing moved');
  assert.equal(await readFile(path.join(base, 'backup-before-workspaces', 'library.json'), 'utf8'), '[{"id":"abc"}]');
  assert.equal(await readFile(path.join(base, 'backup-before-workspaces', 'models.txt'), 'utf8'), 'abc');
  await ws.setActive('warframe');
  assert.equal(ws.activeDir(), path.join(base, 'workspaces', 'warframe'));
  assert.ok(!existsSync(path.join(ws.activeDir(), 'library.json')));
  const added = await ws.add({ name: 'Ships', kind: 'warframe' });
  assert.ok(added.list.some((w) => w.id === 'ships'));
  await assert.rejects(ws.setActive('nope'));
  await assert.rejects(ws.add({ name: 'x', kind: 'boat' }));
  const again = createWorkspaces({ baseDir: base });
  assert.equal((await again.load()).active, 'warframe');
});

test('server: switching workspace restarts on the same port with an isolated library', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'ff-wss-'));
  const app = await startApp({ dataDir: base, keyStore: { get: () => null, source: () => 'none', set() {}, remove() {} } });
  t.after(async () => { await app.close(); await rm(base, { recursive: true, force: true }); });
  const url = (p) => `http://127.0.0.1:${app.port}${p}`;
  const port = app.port;
  assert.equal((await (await fetch(url('/api/workspaces'))).json()).active, 'car');
  await fetch(url('/api/settings'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: { preset: 'orokin' } }) });
  const r = await (await fetch(url('/api/workspaces/active'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'warframe' }) })).json();
  assert.equal(r.active, 'warframe'); assert.equal(r.restarting, true);
  let s;
  for (let i = 0; i < 50; i++) { await new Promise((ok) => setTimeout(ok, 50)); try { s = await (await fetch(url('/api/settings'))).json(); if (s.libraryDir?.includes('warframe')) break; } catch { /* restarting */ } }
  assert.equal(app.port, port);
  assert.ok(s.libraryDir.endsWith(path.join('workspaces', 'warframe')));
  assert.notEqual(s.theme?.preset, 'orokin', 'settings do not leak between workspaces');
  const h = await fetch(url('/api/history/git'));
  assert.equal(h.status, 409);
});
