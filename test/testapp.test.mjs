// Flatform Test: the mocks answer like Tripo and Blender at no cost, the seed fills a library with the samples and
// every room, the checklist keeps pass/fail, and none of it exists outside test mode.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { startMocks, MOCK_KEYS } from '../test-app/mocks.mjs';
import { seedTestApp } from '../test-app/seed.mjs';
import { PLATES } from '../public/lib/pipeline.js';
import { CHECK_IDS } from '../public/lib/checklist.js';

const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));
const until = async (fn) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((ok) => setTimeout(ok, 50)); } throw new Error('timed out'); };

test('test app: seeded library, mock Tripo and Blender, checklist', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-testapp-'));
  temps.push(data);
  const mocks = await startMocks();
  const app = await startServer({ dataDir: data, apiBase: mocks.tripoBase, threeDAIBase: mocks.threeDAIBase, keyStore: createKeyStore({ env: MOCK_KEYS }), defaultOutputRoot: path.join(data, 'out'), testMode: true });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const seed = await seedTestApp({ base, dataDir: data, photosDir: path.join(data, 'photos') });
    assert.deepEqual(await seedTestApp({ base, dataDir: data, photosDir: path.join(data, 'photos') }), seed); // once only
    const lib = (await json('/api/models')).body;
    assert.equal(lib.length, Object.keys(PLATES).length + 4);
    const byId = Object.fromEntries(lib.map((m) => [m.id, m]));
    assert.deepEqual([byId[seed.models.car].kind, byId[seed.models.humanoid].kind, byId[seed.models['humanoid-rigged']].kind], ['car', 'humanoid', 'humanoid']);
    for (const slug of Object.keys(PLATES)) assert.equal(byId[seed.models[`room-${slug}`]].scene.preset, slug);
    assert.deepEqual((await readdir(seed.photosDir)).sort(), ['car.png', 'person.png']);
    const settings = (await json('/api/settings')).body;
    assert.deepEqual([settings.testMode, settings.updates.autoCheck, /mock-blender\.mjs$/.test(settings.blenderPath)], [true, false, true]);

    // Mock Tripo: a photo becomes a model, nothing is charged.
    const form = new FormData();
    form.append('setup', JSON.stringify({ provider: 'tripo', engine: 'tripo-direct' }));
    form.append('front', new Blob([await readFile(path.join(seed.photosDir, 'person.png'))], { type: 'image/png' }), 'person.png');
    const made = await (await fetch(`${base}/api/models`, { method: 'POST', body: form })).json();
    const ready = await until(async () => { const m = (await json(`/api/models/${made.id}`)).body; return m.status === 'ready' && m; });
    assert.equal(ready.credits, 0);

    // Mock Blender: the sample humanoid gets the real rig (a GLB with a skin); any other model a clear error.
    assert.equal((await json(`/api/models/${seed.models.humanoid}/rig`, 'POST')).status, 202);
    const done = await until(async () => { const j = (await json(`/api/models/${seed.models.humanoid}/rig`)).body; return j.status !== 'running' && j; });
    assert.equal(done.status, 'done', done.error);
    const glb = await readFile(path.join(data, 'models', seed.models.humanoid, 'rigged-v2.glb'));
    assert.ok(JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12))).skins?.length, 'the rigged sample has a skin');
    await json(`/api/models/${made.id}`, 'PATCH', { kind: 'humanoid' });
    await json(`/api/models/${made.id}/rig`, 'POST');
    const refused = await until(async () => { const j = (await json(`/api/models/${made.id}/rig`)).body; return j.status !== 'running' && j; });
    assert.deepEqual([refused.status, /only rigs the sample humanoid/.test(refused.error)], ['failed', true]);

    // Checklist: pass, fail, clear; unknown items refused.
    assert.equal((await json('/api/test-checklist', 'POST', { item: CHECK_IDS[0], result: 'pass' })).body.results[CHECK_IDS[0]].result, 'pass');
    assert.equal((await json('/api/test-checklist', 'POST', { item: CHECK_IDS[1], result: 'fail' })).body.results[CHECK_IDS[1]].result, 'fail');
    assert.equal((await json('/api/test-checklist', 'POST', { item: CHECK_IDS[0], result: null })).body.results[CHECK_IDS[0]], undefined);
    assert.equal((await json('/api/test-checklist', 'POST', { item: 'nope', result: 'pass' })).status, 400);
    assert.deepEqual((await json('/api/test-checklist')).body.seed.models, seed.models);
  } finally {
    await app.close();
    mocks.close();
  }
});

test('outside test mode there is no checklist', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-notest-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/test-checklist`)).status, 404);
    assert.equal((await (await fetch(`http://127.0.0.1:${app.port}/api/settings`)).json()).testMode, false);
  } finally {
    await app.close();
  }
});
