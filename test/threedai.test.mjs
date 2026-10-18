// 3D AI Studio end to end: the app server (in this process, with a short rate-limit window) against a fake
// 3D AI Studio that enforces the 3-requests-a-window limit itself. All four engines, polling, FINISHED, FAILED,
// 410 Gone, results older than a day, the wallet and the Tripo-only exports. No network.
import test, { after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const KEY = '3das_test_key_0001';
const WINDOW = 700; // the app's limiter window in this test
const FAKE_WINDOW = 600; // the fake allows 3 requests per this; the difference is network slack
const calls = []; // { at, method, path } for every API call (result downloads excluded)
const submits = []; // { path, body }
const tasks = new Map(); // id → { polls, fail, gone, thumb }
const failOnce = new Set(['image/png:FAIL']); // this photo fails the first time only
let tooMany = 0;
let fakePort;

const decode = (uri) => { const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(uri || ''); return m && `${m[1]}:${Buffer.from(m[2], 'base64')}`; };
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://x');
  // Result files live on another host (localhost, not 127.0.0.1), like storage.3daistudio.com.
  if (url.pathname.startsWith('/assets/')) { res.writeHead(200); return res.end(`asset:${url.pathname}`); }
  const now = Date.now();
  if (calls.filter((c) => c.at > now - FAKE_WINDOW).length >= 3) { tooMany++; return json(res, 429, { error_code: 'rate_limited' }); }
  calls.push({ at: now, method: req.method, path: url.pathname });
  if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { error_code: 'INVALID_API_KEY', message: 'Invalid API key' });
  if (url.pathname === '/account/user/wallet/') return json(res, 200, { balance: '200.00', rate_limit: 3 });
  if (req.method === 'POST' && url.pathname.startsWith('/v1/3d-models/')) {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const first = decode(body.image || body.images?.[0]?.image || body.multi_view_images?.[0]?.view_image || body.views?.front?.image);
    if (!first) return json(res, 400, { error_code: 'VALIDATION_FAILED', errors: { image: ['An image is required.'] } });
    if (first.endsWith('POOR')) return json(res, 402, { error_code: 'INSUFFICIENT_CREDITS' });
    const id = `task-${submits.length + 1}`;
    submits.push({ path: url.pathname, body });
    tasks.set(id, { polls: 0, fail: failOnce.delete(first), gone: first.endsWith('GONE'), thumb: body.generate_thumbnail });
    return json(res, 200, { task_id: id, created_at: new Date().toISOString() });
  }
  const id = url.pathname.match(/^\/v1\/generation-request\/([\w-]+)\/status\/$/)?.[1];
  const t = tasks.get(id);
  if (!t) return json(res, 404, { error_code: 'NOT_FOUND' });
  if (t.gone) return json(res, 410, { error_code: 'GONE' });
  t.polls++;
  if (t.polls === 1) return json(res, 200, { status: 'PENDING', progress: 0, failure_reason: null, results: [] });
  if (t.polls === 2) return json(res, 200, { status: 'IN_PROGRESS', progress: 55, failure_reason: null, results: [] });
  if (t.fail) return json(res, 200, { status: 'FAILED', progress: 55, failure_reason: 'Could not find an object in the image', results: [] });
  const asset = (file, type) => ({ asset: `http://localhost:${fakePort}/assets/${id}/${file}`, asset_type: type, metadata: null });
  return json(res, 200, {
    status: 'FINISHED', progress: 100, failure_reason: null,
    results: [asset('model.glb', '3D_MODEL'), ...(t.thumb ? [asset('thumbnail.png', 'IMAGE')] : [])],
  });
});
fakePort = await new Promise((ok) => fake.listen(0, '127.0.0.1', () => ok(fake.address().port)));
const BASE = `http://127.0.0.1:${fakePort}`;

const temps = [];
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
  fake.close();
  for (const d of temps) await rm(d, { recursive: true, force: true });
});
const tempDir = async () => { const d = await mkdtemp(path.join(tmpdir(), 'flatform-3das-')); temps.push(d); return d; };

async function start(dataDir) {
  // Tripo points at the fake too (it answers 404), so nothing here can reach a real provider.
  const s = await startServer({ dataDir, keyStore: createKeyStore({ env: {} }), apiBase: `${BASE}/tripo`, threeDAIBase: BASE, rateWindowMs: WINDOW });
  servers.push(s);
  const base = `http://127.0.0.1:${s.port}`;
  const j = async (p, opts = {}) => {
    const r = await fetch(base + p, opts);
    const text = await r.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body };
  };
  return {
    base, j, close: s.close,
    send: (p, method, data) => j(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    create(setup, photos, name = 'Car') {
      const form = new FormData();
      form.append('name', name);
      form.append('setup', JSON.stringify(setup));
      for (const [view, text] of Object.entries(photos)) form.append(view, new Blob([text], { type: 'image/png' }), `${view}.png`);
      return j('/api/models', { method: 'POST', body: form });
    },
    async settle(id, wanted = ['ready', 'failed']) {
      for (let i = 0; i < 200; i++) {
        const m = (await j(`/api/models/${id}`)).body;
        if (wanted.includes(m.status)) return m;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      throw new Error(`model ${id} never settled`);
    },
  };
}

const data = await tempDir();
const app = await start(data);
const ai = (engine, options = {}, mode = 'single') => ({ provider: '3daistudio', engine, mode, options });

test('a key is checked on the free wallet call before it is saved', async () => {
  assert.deepEqual((await app.j('/api/account?provider=3daistudio')).body, { hasKey: false });
  assert.equal((await app.create(ai('trellis2'), { front: 'x' })).status, 401); // no key: refused, nothing sent
  assert.equal(submits.length, 0);
  const wrong = await app.send('/api/keys/3daistudio', 'PUT', { key: 'wrong_key_000000' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error, /3D AI Studio/);
  const ok = await app.send('/api/keys/3daistudio', 'PUT', { key: KEY });
  assert.equal(ok.status, 200, ok.body.error);
  assert.deepEqual([ok.body.balance, ok.body.rateLimit, ok.body.keys['3daistudio']], [200, 3, 'saved']);
  assert.equal(JSON.stringify(ok.body).includes(KEY), false);
  // The balance is remembered for a while: it costs one of the 3 requests a minute.
  const before = calls.length;
  assert.equal((await app.j('/api/account?provider=3daistudio')).body.balance, 200);
  assert.equal(calls.length, before);
  assert.equal((await app.j('/api/account?provider=3daistudio&fresh')).body.balance, 200);
  assert.equal(calls.length, before + 1);
});

let models;
test('all four engines: submitted as documented, polled in the background, downloaded at once', { timeout: 60000 }, async () => {
  const created = [
    await app.create(ai('tripo-3.2'), { front: 'tripo-front' }, 'Tripo car'),
    await app.create(ai('hunyuan-pro', {}, 'views'), { front: 'hy-front', left: 'hy-left', back: 'hy-back' }, 'Hunyuan car'),
    await app.create(ai('trellis2', { textures: true, generate_thumbnail: true }), { front: 'trellis-front' }, 'Trellis car'),
    await app.create(ai('hitem3d', {}, 'views'), { front: 'hit-front', right: 'hit-right' }, 'Hitem car'),
  ];
  for (const c of created) assert.equal(c.status, 201, c.body.error);
  models = created.map((c) => c.body);
  assert.deepEqual(submits.map((s) => s.path), [
    '/v1/3d-models/tripo/image-to-3d/3.2/', '/v1/3d-models/tencent/generate/pro/', '/v1/3d-models/trellis2/generate/', '/v1/3d-models/hitem3d/multiview-to-3d/',
  ]);
  const [tripo, hunyuan, trellis, hitem] = submits.map((s) => s.body);
  assert.equal(decode(tripo.image), 'image/png:tripo-front');
  assert.deepEqual([tripo.texture, tripo.pbr, tripo.texture_quality], [true, true, 'standard']);
  assert.deepEqual(hunyuan.multi_view_images.map((v) => [v.view_type, decode(v.view_image)]), [['front', 'image/png:hy-front'], ['left', 'image/png:hy-left'], ['back', 'image/png:hy-back']]);
  assert.deepEqual([hunyuan.model, hunyuan.face_count, 'image' in hunyuan], ['3.1', 500000, false]);
  assert.deepEqual([decode(trellis.image), trellis.textures, trellis.texture_size, trellis.generate_thumbnail], ['image/png:trellis-front', true, 2048, true]);
  assert.deepEqual(Object.keys(hitem.views), ['front', 'right']);
  assert.equal(decode(hitem.views.right.image), 'image/png:hit-right');

  const first = models[0];
  assert.deepEqual([first.status, first.provider, first.engine, first.upstream_status], ['generating', '3daistudio', 'tripo-3.2', 'PENDING']);
  assert.deepEqual(models[1].views, { front: 'source.png', left: 'source-left.png', back: 'source-back.png' });

  // The page polling the model as fast as it likes never reaches 3D AI Studio.
  const statusCalls = () => calls.filter((c) => c.path.includes('/generation-request/')).length;
  const seenBefore = statusCalls();
  await Promise.all(Array.from({ length: 20 }, () => app.j(`/api/models/${first.id}`)));
  assert.ok(statusCalls() - seenBefore <= 1);

  const done = [];
  for (const m of models) done.push(await app.settle(m.id));
  assert.deepEqual(done.map((m) => [m.status, m.glb, m.credits]), [['ready', 'model.glb', 60], ['ready', 'model.glb', 80], ['ready', 'model.glb', 32], ['ready', 'model.glb', 150]]);
  assert.equal(done[2].thumb, 'preview.png');
  assert.equal(await (await fetch(`${app.base}/files/${models[3].id}/model.glb`)).text(), 'asset:/assets/task-4/model.glb');
  assert.equal(await (await fetch(`${app.base}/files/${models[1].id}/source-left.png`)).text(), 'hy-left');
});

test('FAILED jobs say why and can be retried; 402 and 410 are clear', { timeout: 30000 }, async () => {
  const c = await app.create(ai('hitem3d'), { front: 'FAIL' }, 'Bad photo');
  const failed = await app.settle(c.body.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Could not find an object in the image\. The credits are refunded/);
  const retried = (await app.j(`/api/models/${failed.id}/retry`, { method: 'POST' })).body;
  assert.deepEqual([retried.status, retried.engine, retried.versions.length, retried.error], ['generating', 'hitem3d', 1, undefined]);
  assert.equal(decode(submits.at(-1).body.image), 'image/png:FAIL'); // the saved photo, same setup, as a new task
  assert.equal((await app.settle(failed.id)).status, 'ready');

  const poor = await app.create(ai('hitem3d'), { front: 'POOR' });
  assert.deepEqual([poor.status, poor.body.error], [402, '3D AI Studio: not enough credits']);
  const gone = await app.create(ai('trellis2'), { front: 'GONE' });
  const expired = await app.settle(gone.body.id);
  assert.match(expired.error, /keeps results for 24 hours/);
});

test('GLB only: Tripo conversions are refused for 3D AI Studio models', async () => {
  const id = models[0].id;
  const fbx = await app.j(`/api/models/${id}/exports/FBX`, { method: 'POST' });
  assert.equal(fbx.status, 409);
  assert.match(fbx.body.error, /only works on models made with Tripo direct/);
  const out = await tempDir();
  assert.equal((await app.send('/api/settings', 'POST', { outputRoot: out })).status, 200);
  assert.equal((await app.send(`/api/renders/${id}/start`, 'POST', { looks: ['studio'], formats: ['FBX'] })).status, 409);
  assert.equal((await app.send(`/api/renders/${id}/start`, 'POST', { looks: ['studio'], formats: [] })).status, 200);
});

test('on startup, a job older than a day is failed without asking 3D AI Studio', async () => {
  const dir = await tempDir();
  const old = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const recent = new Date().toISOString();
  const entry = (id, task, at) => ({
    id, name: id, slug: id, created_at: at, activeVersion: 1,
    versions: [{ n: 1, created_at: at, submitted_at: at, provider: '3daistudio', engine: 'trellis2', mode: 'single', options: {}, task_id: task, status: 'generating', upstream_status: 'IN_PROGRESS', progress: 40, source: 'source.png', exports: {} }],
  });
  for (const id of ['old-job', 'new-job']) { await mkdir(path.join(dir, 'models', id), { recursive: true }); await writeFile(path.join(dir, 'models', id, 'source.png'), 'x'); }
  tasks.set('task-old', { polls: 5 });
  tasks.set('task-new', { polls: 5 });
  await writeFile(path.join(dir, 'library.json'), JSON.stringify([entry('old-job', 'task-old', old), entry('new-job', 'task-new', recent)]));
  const restarted = await start(dir);
  await restarted.send('/api/keys/3daistudio', 'PUT', { key: KEY });
  const [stale, fresh] = (await restarted.j('/api/models')).body;
  assert.deepEqual([stale.status, stale.error], ['failed', '3D AI Studio keeps results for 24 hours and this job is older, so its model is gone. Retry to generate it again.']);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'library.json'), 'utf8'))[0].status, 'failed');
  assert.equal((await restarted.settle(fresh.id)).status, 'ready'); // a recent one is picked up again
  assert.equal(calls.some((c) => c.path.includes('task-old')), false);
  await restarted.close();
});

test('the limit held all along: never more than 3 calls in any window, no 429s', () => {
  assert.equal(tooMany, 0);
  for (let i = 3; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 3].at >= FAKE_WINDOW, `call ${i}`);
  assert.ok(calls.length > 20);
});
