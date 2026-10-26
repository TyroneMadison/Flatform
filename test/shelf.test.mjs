// The asset shelf (Compose, Add things): items, search and filter, placing, the single-key shortcuts, and shelf items
// reaching the Blender render as files on this computer only. Runs the fake Blender, never the real one.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPS, FILTERS, MAX_EXTRAS, shelfItems, filterItems, placeExtra, besideSpot, propLabel } from '../public/lib/shelf.js';
import { SHORTCUTS, TAKEN, clashes, byId } from '../public/lib/shortcuts.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

test('shelf: library people and cars plus the bundled props, searched and filtered', () => {
  assert.equal(PROPS.length, 13);
  assert.equal(propLabel('namaqualand_boulder_04.glb'), 'Namaqualand boulder');
  const models = [
    { id: 'a', name: 'Red Audi', status: 'ready', glb: 'model.glb', kind: 'car' },
    { id: 'b', name: 'Hero', status: 'ready', glb: 'rigged.glb', kind: 'humanoid' },
    { id: 'c', name: 'Busy', status: 'generating', glb: null },
    { id: 'me', name: 'This one', status: 'ready', glb: 'model.glb' },
  ];
  const items = shelfItems(models, { exclude: 'me', fileUrl: (m, f) => `/files/${m.id}/${f}` });
  assert.deepEqual(items.slice(0, 2).map((i) => [i.group, i.src]), [['cars', '/files/a/model.glb'], ['characters', '/files/b/rigged.glb']]);
  assert.equal(items.length, 2 + PROPS.length);
  assert.deepEqual(filterItems(items, { group: 'characters' }).map((i) => i.label), ['Hero']);
  assert.deepEqual(filterItems(items, { q: 'street LAMP' }).map((i) => i.src), ['/env/street_lamp_01.glb']);
  assert.equal(filterItems(items, { q: 'zzz' }).length, 0);
  assert.deepEqual(Object.keys(FILTERS), ['all', 'characters', 'cars', 'props']);
});

test('shelf: placing keeps spots on the floor and stops at the limit', () => {
  const lamp = PROPS.find((p) => p.label === 'Street lamp');
  const one = placeExtra([], lamp, [2.345, -99], 'x1');
  assert.deepEqual(one, [{ id: 'x1', src: lamp.src, label: 'Street lamp', group: 'props', at: [2.35, -30], turn: 0 }]);
  assert.notDeepEqual(besideSpot(0), besideSpot(1));
  const full = Array.from({ length: MAX_EXTRAS }, (_, i) => ({ id: `x${i}` }));
  assert.throws(() => placeExtra(full, lamp, [0, 0]), /most for one scene/);
});

test('single-key shortcuts: A, V and S live in the one registry, never on a key already taken', () => {
  assert.deepEqual(['shelf', 'history', 'share'].map((id) => byId(id).keys), ['A', 'V', 'S']);
  assert.deepEqual(byId('shelf').where, ['compose']);
  for (const k of ['A', 'V', 'S']) assert.ok(!TAKEN.includes(k), `${k} is already used`);
  assert.equal(SHORTCUTS.filter((s) => ['A', 'V', 'S'].includes(s.keys)).length, 3, 'nothing else uses them');
  assert.deepEqual(clashes(), []);
});

test('shelf items reach Blender as bundled or library files; anything else is dropped', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-shelf-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => (await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) })).json();
  const upload = async (name, kind) => {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', `${kind === 'car' ? 'car' : 'humanoid'}.glb`))]), 'model.glb');
    form.append('name', name); form.append('kind', kind);
    return (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
  };
  try {
    const car = await upload('Car', 'car');
    const hero = await upload('Hero', 'humanoid');
    await json('/api/settings', 'POST', { blenderPath: path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs') });
    await json(`/api/models/${car.id}`, 'PATCH', { scene: { extras: [
      { id: 'a', src: '/env/street_lamp_01.glb', group: 'props', at: [2, 1] },
      { id: 'b', src: `/files/${hero.id}/model.glb`, group: 'characters', at: [-3, 0.5], turn: 90 },
      { id: 'c', src: '/env/../../secret.glb', group: 'props', at: [0, 0] },
      { id: 'd', src: 'C:/Windows/evil.glb', group: 'props', at: [0, 0] },
      { id: 'e', src: '/env/lifebuoy.glb', group: 'props', at: ['x', 0] },
    ] } });
    await json(`/api/renders/${car.id}/start`, 'POST', { looks: [] });
    await json(`/api/renders/${car.id}/blender`, 'POST', { looks: ['studio'], frames: 0 });
    let job;
    for (let i = 0; i < 100 && (job = await json(`/api/renders/${car.id}/blender`)).status === 'running'; i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(job.status, 'done', job.error);
    const out = (await json(`/api/models/${car.id}`)).renders.outDir;
    const args = JSON.parse(await readFile(path.join(out, 'frames', 'studio', 'fake-blender-args.json'), 'utf8'));
    const extras = JSON.parse(args[args.indexOf('--extras') + 1]);
    assert.deepEqual(extras.map((x) => [path.basename(x.path), x.group, x.at, x.turn]), [['street_lamp_01.glb', 'props', [2, 1], 0], ['model.glb', 'characters', [-3, 0.5], 90]]);
    assert.ok(extras[1].path.startsWith(path.join(data, 'models', hero.id)));
  } finally {
    await app.close();
  }
});
