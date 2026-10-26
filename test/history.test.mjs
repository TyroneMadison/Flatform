// Version history for renders: one version per render run with a copy of its picture and its settings, listed per
// model, and "Use these settings" putting the scene and light rig back.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderHistory } from '../render-history.mjs';
import { changedNames } from '../public/lib/versions.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));
const tmp = async () => { const d = await mkdtemp(path.join(tmpdir(), 'flatform-history-')); temps.push(d); return d; };

test('history: one version per render run, numbered, picture copied, settings kept', async () => {
  const dir = await tmp();
  await mkdir(path.join(dir, 'm1'));
  await writeFile(path.join(dir, 'pic.png'), PNG);
  const h = createRenderHistory({ modelsDir: dir });
  const settings = { scene: { preset: 'showroom' } };
  const [a, same] = await Promise.all([h.add('m1', { picture: path.join(dir, 'pic.png'), pass: 'run1', kind: 'Picture', settings }), h.add('m1', { picture: path.join(dir, 'pic.png'), pass: 'run1', settings })]);
  settings.scene.preset = 'changed later'; // the saved copy is not touched
  const b = await h.add('m1', { picture: path.join(dir, 'pic.png'), pass: 'run2', kind: 'Spin video', settings: {} });
  assert.equal(same, null);
  assert.deepEqual([a.n, b.n, a.picture, b.picture], [1, 2, 'history-v1.png', 'history-v2.png']);
  assert.ok(existsSync(path.join(dir, 'm1', 'history-v2.png')));
  const list = await h.list('m1');
  assert.deepEqual(list.map((v) => [v.n, v.kind, v.settings.scene?.preset]), [[1, 'Picture', 'showroom'], [2, 'Spin video', undefined]]);
  assert.deepEqual(await h.list('nobody'), []);
});

test('history: what changed, in plain words', () => {
  assert.equal(changedNames({ scene: { preset: 'a', lens: 30 } }, { scene: { preset: 'b', lens: 30 } }), 'Place');
  assert.equal(changedNames({ scene: { paint: { a: 1 }, camera: 'x' }, lighting: { k: 1 } }, { scene: { paint: { a: 2 }, camera: 'y' }, lighting: { k: 2 } }), 'Colours, Camera and Light');
  assert.equal(changedNames({ scene: { x: 1 } }, { scene: { x: 1 } }), '');
});

test('history API: renders become versions; restoring puts the scene back', async () => {
  const data = await tmp();
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const put = (id, rel) => fetch(`${base}/api/renders/${id}/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: PNG });
  try {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', 'car.glb'))]), 'model.glb');
    form.append('name', 'Car'); form.append('kind', 'car');
    const car = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    assert.deepEqual((await json(`/api/models/${car.id}/history`)).body, []);

    await json(`/api/models/${car.id}`, 'PATCH', { scene: { preset: 'showroom', lens: 35 } });
    await json(`/api/renders/${car.id}/start`, 'POST', { looks: ['studio'] });
    await put(car.id, 'stills/car_studio_030.png');
    await put(car.id, 'stills/car_studio_090.png'); // same run: still one version
    await json(`/api/models/${car.id}`, 'PATCH', { scene: { preset: 'night-city-rain', lens: 50 } });
    await new Promise((ok) => setTimeout(ok, 5));
    await json(`/api/renders/${car.id}/start`, 'POST', { looks: ['studio'] });
    await put(car.id, 'stills/car_studio_045.png');

    const list = (await json(`/api/models/${car.id}/history`)).body;
    assert.deepEqual(list.map((v) => [v.n, v.kind, v.settings.scene.preset]), [[1, 'Picture', 'showroom'], [2, 'Picture', 'night-city-rain']]);
    assert.ok(list[0].settings.lighting, 'the light rig is kept too');
    assert.equal((await fetch(`${base}/files/${car.id}/${list[0].picture}`)).status, 200);

    const back = await json(`/api/models/${car.id}/history/1`, 'POST', {});
    assert.equal(back.status, 200);
    assert.deepEqual(back.body.model.scene, { preset: 'showroom', lens: 35 });
    assert.deepEqual(JSON.parse(await readFile(path.join(data, 'models', car.id, 'scene.json'), 'utf8')), { preset: 'showroom', lens: 35 });
    assert.equal((await json(`/api/models/${car.id}/history/9`, 'POST', {})).status, 404);
  } finally {
    await app.close();
  }
});
