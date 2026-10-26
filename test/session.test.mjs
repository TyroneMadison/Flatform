// Auto-save, Reset scene and Recents: snapshot rotation, crash detection, reset to defaults (library untouched),
// recents order, the Ctrl+K filter, and the /api/session endpoints. Temp files live in .scratch/ inside the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createSession, cleanSnapshot } from '../session.mjs';
import { prunable, snapName, snapshotDue, bumpRecent, resetScene, sameSnapshot, timeAgo, AUTOSAVE_MS, MIN_GAP_MS, MODEL_FIXES } from '../public/lib/session.js';
import { filterCommands, isPaletteKey } from '../public/lib/palette.js';
import { bindingsFor } from '../public/lib/hotkeys.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temps = [];
const tempDir = async () => { const d = path.join(ROOT, '.scratch', `session-${randomUUID()}`); await mkdir(d, { recursive: true }); temps.push(d); return d; };
test.after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

const scene = (turn) => ({ preset: 'cyclorama', turn, look: null });

test('snapshot rotation: only the newest 5 stay, oldest go first, an unchanged scene is not written twice', async () => {
  const dir = await tempDir();
  let t = 1_700_000_000_000;
  const s = createSession({ dir, now: () => t });
  s.start();
  for (let i = 0; i < 8; i++) { t += 1000; await s.snapshot({ modelId: 'audi', scene: scene(i), frame: i }); }
  const files = (await readdir(dir)).filter((n) => n.startsWith('snap-')).sort();
  assert.equal(files.length, 5);
  assert.deepEqual(files, [4, 5, 6, 7, 8].map((k) => snapName(1_700_000_000_000 + k * 1000)));
  assert.equal((await s.latest()).scene.turn, 7);
  t += 1000;
  await s.snapshot({ modelId: 'audi', scene: scene(7), frame: 7 }); // same as the last one
  assert.equal((await readdir(dir)).filter((n) => n.startsWith('snap-')).length, 5);
  assert.equal((await s.latest()).at, 1_700_000_008_000, 'the duplicate did not push out a real snapshot');
  assert.deepEqual(prunable(['snap-000000000000003.json', 'recents.json', 'snap-000000000000001.json', 'snap-000000000000002.json'], 2), ['snap-000000000000001.json']);
  assert.deepEqual(prunable(['snap-000000000000001.json'], 5), []);
  assert.ok(sameSnapshot({ a: 1, at: 1 }, { a: 1, at: 2 }) && !sameSnapshot({ a: 1 }, { a: 2 }) && !sameSnapshot(null, { a: 1 }));
});

test('snapshots from the page are checked', () => {
  assert.throws(() => cleanSnapshot({ modelId: '../x', scene: {} }), /Bad snapshot/);
  assert.throws(() => cleanSnapshot({ modelId: 'a', scene: [] }), /Bad snapshot/);
  assert.throws(() => cleanSnapshot(null), /Bad snapshot/);
  assert.deepEqual(cleanSnapshot({ modelId: 'a-1', scene: { x: 1 }, frame: -3, extra: 'dropped' }), { modelId: 'a-1', scene: { x: 1 }, frame: 0 });
});

test('crash detection: a run that never quit cleanly is noticed once, a clean quit is not', async () => {
  const dir = await tempDir();
  const first = createSession({ dir });
  assert.equal(first.start(), false, 'first ever launch');
  // ...the app dies here without markClean()
  const second = createSession({ dir });
  assert.equal(second.start(), true, 'unclean exit noticed');
  assert.equal(second.crashed, true);
  second.dismiss();
  assert.equal(second.crashed, false, '"No thanks" hides the offer for this run');
  second.markClean();
  assert.equal(createSession({ dir }).start(), false, 'clean quit');
});

test('auto-save timing: every 2.5 min while dirty, sooner for a big edit, never when nothing changed', () => {
  const now = 1_000_000;
  assert.equal(snapshotDue({ now, lastAt: now - AUTOSAVE_MS, dirty: false }), false);
  assert.equal(snapshotDue({ now, lastAt: now - AUTOSAVE_MS, dirty: true }), true);
  assert.equal(snapshotDue({ now, lastAt: now - 60_000, dirty: true }), false);
  assert.equal(snapshotDue({ now, lastAt: now - MIN_GAP_MS, dirty: true, significant: true }), true);
  assert.equal(snapshotDue({ now, lastAt: now - 5000, dirty: true, significant: true }), false);
});

test('reset to defaults: the look goes back, model fixes stay, the old scene and the library are untouched', async () => {
  const { defaultScene } = await import('../public/lib/studio.js');
  const defaults = defaultScene({});
  const before = { ...defaults, preset: 'miami', turn: 200, lens: 85, key: 2.5, look: { background: { kind: 'color' } },
    paint: { pieces: { body: { color: '#ff0000' } } }, motion: { clip: 'walk' }, decals: [{ id: 'd1' }], cameraPath: { on: true },
    sky: { on: true }, bookmarks: [{ id: 'b' }], view: 'free', orbit: { position: [1, 2, 3] }, autoOrient: false, center: false, flip: true };
  const frozen = structuredClone(before);
  const out = resetScene(before, defaults);
  assert.deepEqual(before, frozen, 'the scene passed in is not changed (undo keeps it)');
  for (const k of ['preset', 'turn', 'lens', 'key', 'look', 'paint', 'view', 'orbit']) assert.deepEqual(out[k], defaults[k], k);
  for (const k of ['motion', 'decals', 'cameraPath', 'sky', 'bookmarks']) assert.equal(k in out, false, `${k} cleared`);
  for (const k of MODEL_FIXES) assert.equal(out[k], before[k], `${k} kept`);
  out.look = 'changed';
  assert.equal(defaults.look, null, 'the defaults are a copy, not shared');

  // Library: models, renders and library.json are not touched by a reset or by auto-save.
  const lib = await tempDir();
  const entry = { id: 'audi', name: 'Audi R8', glb: 'model.glb', renders: { poster: 'poster.png', showroom360: 'x' }, scene: before };
  await writeFile(path.join(lib, 'library.json'), JSON.stringify([entry]));
  const libBytes = await readFile(path.join(lib, 'library.json'), 'utf8');
  const session = createSession({ dir: path.join(lib, 'session') });
  session.start();
  const reset = { ...entry, scene: resetScene(entry.scene, defaults) };
  await session.snapshot({ modelId: 'audi', scene: reset.scene, frame: 0 });
  assert.equal(await readFile(path.join(lib, 'library.json'), 'utf8'), libBytes);
  assert.deepEqual({ ...reset, scene: undefined }, { ...entry, scene: undefined }, 'only the scene changes');
  assert.deepEqual((await readdir(lib)).sort(), ['library.json', 'session']);
});

test('recents: newest first, one per item, last 3 only, kept across launches', async () => {
  assert.deepEqual(bumpRecent([], { id: 'a', at: 1 }), [{ id: 'a', at: 1 }]);
  assert.deepEqual(bumpRecent([{ id: 'b' }, { id: 'a' }, { id: 'c' }], { id: 'a', at: 9 }).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(bumpRecent([{ id: 'b' }, { id: 'c' }, { id: 'd' }], { id: 'a' }).map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(bumpRecent(null, { id: 'a' }).map((r) => r.id), ['a']);

  const dir = await tempDir();
  let t = 1000;
  const s = createSession({ dir, now: () => t });
  s.start();
  for (const id of ['audi', 'bmw', 'audi', 'civic', 'delorean']) { t += 1000; await s.snapshot({ modelId: id, scene: scene(t), frame: 4 }); }
  const again = createSession({ dir });
  assert.deepEqual((await again.recents()).map((r) => r.id), ['delorean', 'civic', 'audi']);
  assert.deepEqual(await again.recents().then((r) => r[0]), { id: 'delorean', at: 6000, frame: 4 }, 'the frame comes back too');
});

test('Ctrl+K palette: every typed word must match, order kept; listed in the shortcut sheet', () => {
  const cmds = [{ label: 'Audi R8', hint: 'Edited 5 min ago' }, { label: 'Library', hint: 'Everything you have made' }, { label: 'Settings' }];
  assert.deepEqual(filterCommands(cmds, '').map((c) => c.label), ['Audi R8', 'Library', 'Settings']);
  assert.deepEqual(filterCommands(cmds, 'audi  ago').map((c) => c.label), ['Audi R8']);
  assert.deepEqual(filterCommands(cmds, 'LIB').map((c) => c.label), ['Library']);
  assert.deepEqual(filterCommands(cmds, 'zzz'), []);
  assert.ok(isPaletteKey({ ctrlKey: true, key: 'k' }) && isPaletteKey({ metaKey: true, key: 'K' }));
  assert.ok(!isPaletteKey({ ctrlKey: true, shiftKey: true, key: 'k' }) && !isPaletteKey({ key: 'k' }));
  assert.ok(bindingsFor('drop', {}).some(([k]) => k === 'Ctrl+K'));
});

test('time labels are plain English', () => {
  const now = Date.UTC(2026, 9, 26, 12);
  assert.equal(timeAgo(now - 10_000, now), 'just now');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5 min ago');
  assert.equal(timeAgo(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(timeAgo(now - 30 * 3600_000, now), 'yesterday');
  assert.match(timeAgo(now - 10 * 86400_000, now), /16 Oct/);
});

test('server: /api/session offers a restore after a crash, takes snapshots, and a clean close clears the marker', async () => {
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const dataDir = await tempDir();
  const opts = { dataDir, keyStore: createKeyStore({ env: {} }), updateUrl: 'http://127.0.0.1:9/none', updateDelayMs: 3_600_000 };
  const call = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}).then(async (r) => ({ status: r.status, body: await r.json() }));

  let app = await startServer(opts);
  assert.deepEqual((await call(app.port, '/api/session')).body, { crashed: false, last: null, recents: [] });
  const r = await call(app.port, '/api/session/snapshots', { modelId: 'audi', scene: scene(42), frame: 9 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.recents.map((x) => x.id), ['audi']);
  assert.equal((await call(app.port, '/api/session/snapshots', { modelId: '../../etc', scene: {} })).status, 400);
  app.server.closeAllConnections?.();
  app.server.close(); // a crash: the server goes away without close(), so the marker stays

  app = await startServer(opts);
  const s = (await call(app.port, '/api/session')).body;
  assert.equal(s.crashed, true);
  assert.deepEqual([s.last.modelId, s.last.scene.turn, s.last.frame], ['audi', 42, 9]);
  assert.equal((await call(app.port, '/api/session/dismiss', {})).body.crashed, false);
  app.server.closeAllConnections?.();
  await app.close(); // a clean quit

  app = await startServer(opts);
  assert.equal((await call(app.port, '/api/session')).body.crashed, false);
  app.server.closeAllConnections?.();
  await app.close();
});
