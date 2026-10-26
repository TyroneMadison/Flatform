// Local TRELLIS engine (local.mjs) and the server's "Local (free)" path. Everything is mocked: no Python, no GPU,
// no weight download, and a fetch spy proves nothing reaches Tripo or 3D AI Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { checkCuda, downloadWeights, localEngine, weightsReady, TRELLIS_FILES } from '../local.mjs';
import { PROVIDERS, PRESETS, DEFAULT_PROVIDER, normalize, presetConfig } from '../public/lib/engines.js';
import { estimate } from '../public/lib/pricing.js';
import * as L from '../ledger.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'ff-local-'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('Local (free) is the default provider, listed first, and every preset costs 0 credits', () => {
  assert.equal(DEFAULT_PROVIDER, 'local');
  assert.equal(Object.keys(PROVIDERS)[0], 'local');
  assert.equal(PROVIDERS.local.name, 'Local (free)');
  for (const p of PRESETS.local) assert.equal(estimate(presetConfig('local', p.id)).credits, 0);
  assert.ok(PROVIDERS.tripo && PROVIDERS['3daistudio'], 'paid engines stay as options');
  const max = presetConfig('local', 'max');
  assert.equal(max.options.texture_size, 4096);
  assert.equal(normalize({ provider: 'local', engine: 'local-trellis', options: { steps: 999 } }).options.steps, 50);
});

test('the GPU check names the card, or says clearly that there is none', async () => {
  assert.deepEqual(await checkCuda(async () => 'NVIDIA GeForce RTX 3090, 24576\n'), { name: 'NVIDIA GeForce RTX 3090', memoryGB: 24 });
  await assert.rejects(checkCuda(async () => { throw new Error('ENOENT'); }), /No NVIDIA graphics card/);
  await assert.rejects(checkCuda(async () => 'GT 710, 2048'), /needs 8 GB/);
});

test('weight download resumes a stopped file with a Range request, then skips when complete', async () => {
  const dir = await tmp();
  const data = { 'a.json': Buffer.from('{"a":1}'), 'ckpts/b.bin': Buffer.alloc(5000, 7) };
  const files = Object.keys(data).map((p) => ({ path: p, url: `https://weights.test/${p}` }));
  const calls = [];
  let breakB = true;
  const fetch = async (url, { headers }) => {
    const p = new URL(url).pathname.slice(1);
    calls.push({ p, range: headers.Range || null });
    const from = headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)[1]) : 0;
    const body = data[p].subarray(from);
    if (p === 'ckpts/b.bin' && breakB) { // first try: half arrives, then the connection drops
      breakB = false;
      const stream = new ReadableStream({ n: 0, pull(c) { if (this.n++) c.error(new Error('connection reset')); else c.enqueue(body.subarray(0, 2000)); } });
      return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    return new Response(body, { status: from ? 206 : 200, headers: { 'content-length': String(body.length) } });
  };
  const seen = [];
  await assert.rejects(downloadWeights({ dir, files, fetch, onProgress: (p) => seen.push(p) }), /connection reset/);
  assert.ok(existsSync(path.join(dir, 'ckpts', 'b.bin.part')));
  assert.equal(weightsReady(dir), false);
  await downloadWeights({ dir, files, fetch, onProgress: (p) => seen.push(p) });
  assert.deepEqual((await readFile(path.join(dir, 'ckpts', 'b.bin'))), data['ckpts/b.bin']);
  assert.equal(calls.at(-1).range, 'bytes=2000-');
  assert.equal(calls.filter((c) => c.p === 'a.json').length, 1, 'a finished file is not fetched again');
  assert.ok(weightsReady(dir));
  assert.ok(seen.some((p) => p.done > 0));
  const n = calls.length;
  assert.equal((await downloadWeights({ dir, files, fetch })).skipped, true);
  assert.equal(calls.length, n);
  assert.ok(TRELLIS_FILES.every((f) => f.url.startsWith('https://huggingface.co/microsoft/TRELLIS-image-large/')));
  await rm(dir, { recursive: true });
});

// A fake TRELLIS service behind a fake spawn: healthy once spawned, jobs finish on the second status check.
function fakeService() {
  const state = { spawned: 0, up: false, killed: false, jobs: {}, bodies: [] };
  const spawn = (cmd, args) => {
    state.spawned++; state.args = [cmd, ...args]; state.up = true;
    const child = new EventEmitter();
    child.kill = () => { state.killed = true; state.up = false; };
    return child;
  };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.hostname, '127.0.0.1');
    if (!state.up) throw new Error('ECONNREFUSED');
    if (u.pathname === '/health') return json({ ok: true });
    if (u.pathname === '/generate') { state.bodies.push(JSON.parse(init.body)); state.jobs.j1 = 0; return json({ task_id: 'j1' }); }
    if (u.pathname === '/status/j1') { state.jobs.j1++; return json(state.jobs.j1 > 1 ? { status: 'success', progress: 100 } : { status: 'running', progress: 40 }); }
    if (u.pathname === '/result/j1') return new Response(Buffer.from('glTF\x02\x00\x00\x00fake'), { headers: { 'content-type': 'model/gltf-binary' } });
    if (u.pathname === '/shutdown') { state.up = false; return json({ ok: true }); }
    return json({ error: 'no' }, 404);
  };
  return { state, spawn, fetch };
}

test('the engine refuses before the download, starts the service once, and stops it on close', async () => {
  const dir = await tmp();
  const f = fakeService();
  const eng = localEngine({ weightsDir: dir, spawn: f.spawn, fetch: f.fetch, cuda: async () => ({ name: 'RTX 3090' }), pollMs: 1 });
  await assert.rejects(eng.submit({ front: 'data:image/png;base64,AA==' }), (e) => e.status === 409 && /one-time download/.test(e.message));
  await writeFile(path.join(dir, 'complete.json'), '{}');
  const noGpu = localEngine({ weightsDir: dir, spawn: f.spawn, fetch: f.fetch, cuda: async () => { throw Object.assign(new Error('No NVIDIA graphics card found.'), { status: 503 }); } });
  await assert.rejects(noGpu.submit({ front: 'x' }), /No NVIDIA/);
  assert.equal(f.state.spawned, 0);
  assert.deepEqual(await eng.submit({ front: 'x' }, { steps: 12 }), { task_id: 'j1' });
  await eng.submit({ front: 'x' });
  assert.equal(f.state.spawned, 1, 'a healthy service is reused');
  assert.ok(f.state.args.includes('--weights') && f.state.args.includes(dir));
  assert.equal((await eng.status('j1')).status, 'running');
  await eng.stop();
  assert.equal(f.state.up, false);
  await rm(dir, { recursive: true });
});

test('server: a Local (free) generation never calls a paid provider and logs $0 in the ledger', async () => {
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const dataDir = await tmp();
  const weights = path.join(dataDir, 'local-engine', 'weights');
  await mkdir(weights, { recursive: true });
  await writeFile(path.join(weights, 'complete.json'), '{}');
  const f = fakeService();
  const eng = localEngine({ weightsDir: weights, spawn: f.spawn, fetch: f.fetch, cuda: async () => ({ name: 'RTX 3090', memoryGB: 24 }), pollMs: 1 });
  const realFetch = globalThis.fetch;
  const outside = [];
  globalThis.fetch = (url, init) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (u.hostname !== '127.0.0.1') outside.push(u.href);
    return realFetch(url, init);
  };
  const srv = await startServer({
    dataDir, keyStore: createKeyStore({ env: {} }), localEngine: eng, cudaCheck: async () => ({ name: 'RTX 3090', memoryGB: 24 }),
    apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', updateUrl: 'http://127.0.0.1:9/latest', updateDelayMs: 3600000,
    weightsFetch: async () => { throw new Error('no downloads in tests'); },
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const settings = await (await realFetch(`${base}/api/settings`)).json();
    assert.equal(settings.provider, 'local');
    assert.equal(settings.keys.local, undefined, 'the local engine has no key');
    const acct = await (await realFetch(`${base}/api/account?provider=local`)).json();
    assert.deepEqual([acct.hasKey, acct.free, acct.ready], [true, true, true]);
    const form = new FormData();
    form.append('name', 'Test car');
    form.append('setup', JSON.stringify(presetConfig('local', 'max')));
    form.append('front', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'front.png');
    const res = await realFetch(`${base}/api/models`, { method: 'POST', body: form });
    const m = await res.json();
    assert.equal(res.status, 201, JSON.stringify(m));
    assert.equal(m.provider, 'local');
    assert.equal(f.state.bodies[0].options.texture_size, 4096);
    let got;
    for (let i = 0; i < 5; i++) { got = await (await realFetch(`${base}/api/models/${m.id}`)).json(); if (got.status === 'ready') break; }
    assert.equal(got.status, 'ready');
    assert.equal(got.credits, 0);
    assert.ok(existsSync(path.join(dataDir, 'models', m.id, got.glb)));
    await new Promise((ok) => setTimeout(ok, 50));
    const ledger = L.parse(await readFile(path.join(dataDir, 'spend.jsonl'), 'utf8'));
    assert.equal(ledger.length, 1);
    assert.deepEqual([ledger[0].service, ledger[0].credits, ledger[0].usd], ['local', 0, 0]);
    const spend = await (await realFetch(`${base}/api/spend`)).json();
    assert.deepEqual(spend.free, { calls: 1, usd: 0 });
    assert.equal(spend.services.tripo.all.credits, 0);
    const local = await (await realFetch(`${base}/api/local`)).json();
    assert.equal(local.ready, true);
    assert.equal(local.gpu.name, 'RTX 3090');
    assert.deepEqual(outside, [], 'no request left this computer');
  } finally {
    globalThis.fetch = realFetch;
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  assert.equal(f.state.up, false, 'closing the app stops the local service');
});

test('Detail Boost: max preset and the base path turn it on; the upscaler file is optional and resumable', async () => {
  const { BASE_PATH_SETUP, baseSetup } = await import('../public/lib/engines.js');
  const { UPSCALER_FILES, upscalerPath } = await import('../local.mjs');
  assert.equal(presetConfig('local', 'max').options.detail_boost, true);
  assert.equal(presetConfig('local', 'balanced').options.detail_boost, false);
  assert.deepEqual(baseSetup().options, { ...normalize(BASE_PATH_SETUP).options });
  assert.equal(baseSetup().provider, 'local');
  assert.match(UPSCALER_FILES[0].url, /^https:\/\/github\.com\/xinntao\/Real-ESRGAN\//);
  const dir = await tmp();
  assert.equal(upscalerPath(dir), null);
  await writeFile(path.join(dir, 'complete.json'), '{}');
  assert.equal(upscalerPath(dir), path.join(dir, 'RealESRGAN_x4plus.pth'));
  await rm(dir, { recursive: true });
});

test('base path (Generate Spin Set uses it): zero network calls to Tripo or 3D AI Studio, even when a paid setup is sent', async () => {
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const dataDir = await tmp();
  const weights = path.join(dataDir, 'local-engine', 'weights');
  const upscaler = path.join(dataDir, 'local-engine', 'upscaler');
  await mkdir(weights, { recursive: true });
  await mkdir(upscaler, { recursive: true });
  // Weights folders are empty; the download is mocked and counted. Nothing real is fetched.
  const downloads = [];
  const weightsFetch = async (url) => { downloads.push(url); return new Response(Buffer.from('w'), { headers: { 'content-length': '1' } }); };
  const f = fakeService();
  const eng = localEngine({ weightsDir: weights, spawn: f.spawn, fetch: f.fetch, cuda: async () => ({ name: 'RTX 4090' }), pollMs: 1 });
  // The network layer: every outgoing call is recorded. Paid hosts get a hard failure so a slip can't pass quietly.
  const realFetch = globalThis.fetch;
  const paid = [];
  globalThis.fetch = (url, init) => {
    const u = new URL(typeof url === 'string' ? url : url.url);
    if (/tripo|3daistudio|:9\b|127\.0\.0\.1:9\//.test(u.href) || u.port === '9') { paid.push(u.href); return Promise.reject(new Error('paid call')); }
    return realFetch(url, init);
  };
  const keyStore = createKeyStore({ env: { TRIPO_API_KEY: 'tsk_should_not_be_used', THREE_D_AI_STUDIO_KEY: 'should-not-be-used' } });
  const srv = await startServer({
    dataDir, keyStore, localEngine: eng, cudaCheck: async () => ({ name: 'RTX 4090', memoryGB: 24 }), weightsFetch,
    apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', updateUrl: 'http://127.0.0.1:9/latest', updateDelayMs: 3600000,
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const dl = await realFetch(`${base}/api/local/download`, { method: 'POST' });
    assert.equal(dl.status, 202);
    for (let i = 0; i < 50 && !(await (await realFetch(`${base}/api/local`)).json()).upscaler; i++) await new Promise((ok) => setTimeout(ok, 10));
    const view = await (await realFetch(`${base}/api/local`)).json();
    assert.deepEqual([view.ready, view.upscaler], [true, true]);
    assert.ok(downloads.some((u) => /Real-ESRGAN/.test(u)) && downloads.some((u) => /TRELLIS-image-large/.test(u)));
    assert.deepEqual(await (await realFetch(`${base}/api/local/base`)).json(), JSON.parse(JSON.stringify(presetConfig('local', 'max'))));
    // A Tripo setup sent on the base path still runs locally.
    const form = new FormData();
    form.append('name', 'Spin car');
    form.append('path', 'base');
    form.append('setup', JSON.stringify(presetConfig('tripo', 'balanced')));
    form.append('front', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'front.png');
    const res = await realFetch(`${base}/api/models`, { method: 'POST', body: form });
    const m = await res.json();
    assert.equal(res.status, 201, JSON.stringify(m));
    assert.equal(m.provider, 'local');
    assert.equal(f.state.bodies[0].options.detail_boost, true);
    assert.equal(f.state.bodies[0].options.texture_size, 4096);
    assert.equal(f.state.bodies[0].upscaler, path.join(upscaler, 'RealESRGAN_x4plus.pth'));
    let got;
    for (let i = 0; i < 5; i++) { got = await (await realFetch(`${base}/api/models/${m.id}`)).json(); if (got.status === 'ready') break; }
    assert.equal(got.status, 'ready');
    await new Promise((ok) => setTimeout(ok, 50));
    const ledger = L.parse(await readFile(path.join(dataDir, 'spend.jsonl'), 'utf8'));
    assert.ok(ledger.every((e) => e.service === 'local' && e.credits === 0 && e.usd === 0));
    assert.deepEqual(paid, [], 'no request to Tripo or 3D AI Studio');
  } finally {
    globalThis.fetch = realFetch;
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('detail_boost.py: height, normal and displacement math (skipped without Python + numpy + Pillow)', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import numpy, PIL'], { stdio: 'ignore' }).status === 0);
  if (!py) return t.skip('no python with numpy and Pillow');
  const code = `
import sys, json; sys.path.insert(0, ${JSON.stringify(path.resolve('local'))})
import numpy as np; from PIL import Image
from detail_boost import upscale, height_map, normal_map, displace
img = Image.fromarray((np.indices((16, 16)).sum(0) % 2 * 255).astype('uint8')).convert('RGB')
big, how = upscale(img, None, 32)
h = height_map(big)
flat = normal_map(np.zeros((4, 4)))
ramp = normal_map(np.tile(np.linspace(0, 1, 8), (8, 1)))
moved = displace(np.zeros((2, 3)), np.array([[0, 0, 1.], [0, 1, 0.]]), np.array([[0, 0], [0.99, 0.99]]), np.array([[1., 0.], [0., 0.5]]), 2)
print(json.dumps({'size': big.size, 'how': how, 'h': [float(h.min()), float(h.max())], 'flat': flat[0, 0].tolist(), 'rampx': int(ramp[4, 4, 0]), 'moved': moved.tolist()}))
`;
  const r = spawnSync(py, ['-c', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.size, [32, 32]);
  assert.equal(o.how, 'lanczos');
  assert.ok(o.h[0] >= 0 && o.h[1] <= 1);
  assert.deepEqual(o.flat, [128, 128, 255]);
  assert.ok(o.rampx < 128, 'a slope to the right tilts the normal left');
  assert.deepEqual(o.moved, [[0, 0, 1], [0, 0, 0]]);
});
