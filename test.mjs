// End-to-end checks of server.mjs against a fake Tripo API and a fake Blender. No network, no credits.
// Run: npm test
import test, { after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEIC_FIXTURE } from './test/fixtures/heic.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'tsk_test_key_0001';
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const polls = {};
const seen = [];
const uploads = [];
const generationBodies = [];
const failing = new Set();
let generations = 0;
let failNext = false;

// Fake Tripo: each task reports "running" once, then "success" (or "failed") with expiring-style CDN URLs.
const fake = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const body = raw.toString('latin1');
  seen.push(`${req.method} ${req.url}`);
  const ok = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); };
  if (req.url.startsWith('/cdn/')) { res.writeHead(200); return res.end(`bytes:${req.url}`); }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 2, message: 'Invalid API key' }));
  }
  if (req.url === '/v3/account/balance') return ok({ balance: 1500, frozen: 0 });
  if (req.url === '/v3/files') {
    assert.match(body, /name="file"/);
    uploads.push(raw);
    return ok({ file_token: `file_${uploads.length}` });
  }
  if (req.url === '/v3/generation/image-to-model') {
    const n = ++generations;
    const task = n === 1 ? 'task_gen' : `task_gen${n}`;
    generationBodies.push(JSON.parse(body));
    assert.equal(JSON.parse(body).input, `file_${uploads.length}`);
    if (failNext) { failing.add(task); failNext = false; }
    return ok({ task_id: task });
  }
  if (req.url === '/v3/models/convert') {
    const { input, format } = JSON.parse(body);
    seen.push(`convert ${input} ${format}`);
    return ok({ task_id: `task_conv_${input}_${format}` });
  }
  const id = req.url.match(/^\/v3\/tasks\/(.+)$/)?.[1];
  if (id?.startsWith('task_gone')) { // a task Tripo no longer has
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 2001, message: 'Task not found' }));
  }
  if (id) {
    polls[id] = (polls[id] || 0) + 1;
    if (polls[id] === 1) return ok({ task_id: id, status: 'running', progress: 40 });
    if (failing.has(id)) return ok({ task_id: id, status: 'failed', progress: 40 });
    const base = `http://127.0.0.1:${fakePort}/cdn/${id}`;
    const fmt = id.match(/^task_conv_.+_(\w+)$/)?.[1];
    return ok({ task_id: id, status: 'success', progress: 100, credits_consumed: 30,
      output: fmt ? { model_url: `${base}/out.${fmt.toLowerCase()}` } : { model_url: `${base}/model_pbr.glb?sig=x`, rendered_image_url: `${base}/preview.webp` } });
  }
  res.writeHead(404);
  res.end();
});
const fakePort = await listen(fake);

// Fake GitHub releases API: every app here asks it for updates (FLATFORM_UPDATE_URL) instead of api.github.com.
const github = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tag_name: 'v99.0.0', draft: false, prerelease: false, html_url: 'https://github.com/TyroneMadison/Flatform/releases/tag/v99.0.0', body: 'Faster renders.', assets: [] }));
});
const githubPort = await listen(github);

const temps = [];
const tempDir = async () => { const d = await mkdtemp(path.join(tmpdir(), 'flatform-')); temps.push(d); return d; };
const apps = [];

// Runs `node server.mjs` like `npm run web` does, on a free port, pointed at the fake Tripo. Keys from the real
// environment are blanked and 3D AI Studio and GitHub point at fakes too, so nothing can reach a real service.
async function startApp(dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: {
      ...process.env, TRIPO_BASE: `http://127.0.0.1:${fakePort}/v3`, TRIPO_API_KEY: '', TRIPO_MODEL: '',
      THREE_D_AI_STUDIO_BASE: `http://127.0.0.1:${fakePort}/3das`, THREE_D_AI_STUDIO_KEY: '', DATA_DIR: dataDir, PORT: '0',
      FLATFORM_UPDATE_URL: `http://127.0.0.1:${githubPort}/repos/TyroneMadison/Flatform/releases/latest`, FLATFORM_UPDATE_DELAY_MS: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((ok, fail) => {
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; const m = out.match(/localhost:(\d+)/); if (m) ok(Number(m[1])); });
    child.once('exit', (code) => fail(new Error(`server exited with ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const app = {
    base, port, origin: base,
    async j(p, opts = {}) {
      const r = await fetch(base + p, opts);
      const text = await r.text();
      let body = text;
      try { body = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body };
    },
    json: (p, method, data, headers = {}) => app.j(p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }),
    stop: () => new Promise((ok) => {
      if (child.exitCode !== null || child.signalCode !== null) return ok(); // already stopped
      child.once('exit', ok);
      child.kill();
    }),
  };
  apps.push(app);
  return app;
}

// Polls a model until its active version settles.
async function settle(app, id) {
  for (let i = 0; i < 10; i++) {
    const m = (await app.j(`/api/models/${id}`)).body;
    if (m.status !== 'generating') return m;
  }
  throw new Error('model never settled');
}

after(async () => {
  for (const app of apps) await app.stop();
  fake.close();
  github.close();
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

const data = await tempDir();
let app = await startApp(data);
let id; // the first model

test('refuses other host names (DNS rebinding guard)', async () => {
  const status = await new Promise((ok) => http.get({ host: '127.0.0.1', port: app.port, path: '/api/models', headers: { Host: 'evil.example:80' } }, (r) => { r.resume(); ok(r.statusCode); }));
  assert.equal(status, 403);
});

test('API key: refused without one, wrong keys rejected, a valid key saved', async () => {
  assert.deepEqual((await app.j('/api/account')).body, { hasKey: false });
  assert.equal((await app.j('/api/models', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'x' })).status, 401);
  const setKey = (apiKey) => app.json('/api/settings', 'POST', { apiKey });
  assert.equal((await setKey('tsk_wrong_key_123')).status, 401);
  assert.equal((await setKey('x')).status, 400);
  assert.deepEqual((await setKey(` ${KEY} `)).body, { hasKey: true, balance: 1500, frozen: 0 });
  assert.equal((await app.j('/api/account')).body.balance, 1500);
});

test('upload → generate → library → export (existing flow)', async () => {
  // Rejects other image types before calling Tripo (including names that only exist on Object.prototype).
  assert.equal((await app.j('/api/models', { method: 'POST', headers: { 'Content-Type': 'image/gif' }, body: 'x' })).status, 415);
  assert.equal((await app.j('/api/models', { method: 'POST', headers: { 'Content-Type': 'constructor' }, body: 'x' })).status, 415);

  const created = await app.j('/api/models?name=Red%20Chair', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'png-bytes' });
  assert.equal(created.status, 201);
  id = created.body.id;
  assert.equal(created.body.status, 'generating');
  assert.equal(created.body.slug, 'red-chair');
  assert.deepEqual(created.body.versions.map((v) => [v.n, v.status]), [[1, 'generating']]);

  // Two simultaneous polls on a finished task must download once.
  const first = (await app.j(`/api/models/${id}`)).body;
  assert.equal(first.progress, 40);
  assert.equal(first.tripo_status, 'running');
  const [a, b] = await Promise.all([app.j(`/api/models/${id}`), app.j(`/api/models/${id}`)]);
  assert.equal(a.body.status, 'ready');
  assert.equal(b.body.status, 'ready');
  assert.equal(seen.filter((s) => s.includes('/cdn/task_gen/model_pbr.glb')).length, 1);
  assert.equal(a.body.glb, 'model.glb');
  assert.equal(a.body.thumb, 'preview.webp');
  assert.equal(a.body.credits, 30);
  assert.equal(await (await fetch(`${app.base}/files/${id}/model.glb`)).text(), 'bytes:/cdn/task_gen/model_pbr.glb?sig=x');
  assert.equal(await (await fetch(`${app.base}/files/${id}/source.png`)).text(), 'png-bytes');

  // Path traversal is refused.
  assert.equal((await fetch(`${app.base}/files/${id}/..%2F..%2Flibrary.json`)).status, 404);
  assert.equal((await fetch(`${app.base}/..%2Fpackage.json`)).status, 404);

  // Export to FBX.
  assert.equal((await app.j(`/api/models/${id}/exports/FBX`, { method: 'POST' })).body.status, 'converting');
  assert.ok(seen.includes('convert task_gen FBX'));
  assert.equal((await app.j(`/api/models/${id}/exports/FBX`)).body.status, 'converting');
  const fbx = (await app.j(`/api/models/${id}/exports/FBX`)).body;
  assert.deepEqual([fbx.status, fbx.file], ['ready', 'model-fbx.fbx']);
  assert.equal((await app.j(`/api/models/${id}/exports/PDF`, { method: 'POST' })).status, 404);

  const lib = (await app.j('/api/models')).body;
  assert.equal(lib.length, 1);
  assert.equal(lib[0].exports.FBX.status, 'ready');
  assert.equal(lib[0].versions[0].exports.FBX.status, 'ready');
});

test('spend ledger: one line per paid call with balance snapshots; thresholds validated', async () => {
  const file = path.join(data, 'spend.jsonl');
  for (let i = 0; i < 50 && (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length < 2; i++) await new Promise((ok) => setTimeout(ok, 20));
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.service, l.task, l.taskId, l.modelId, l.balanceBefore, l.balanceAfter, l.delta]),
    [['tripo', 'image_to_model', 'task_gen', id, 1500, 1500, 0], ['tripo', 'convert', 'task_conv_task_gen_FBX', id, 1500, 1500, 0]]);
  const spend = (await app.j('/api/spend')).body;
  assert.equal(spend.services.tripo.all.calls, 2);
  assert.equal(spend.services.tripo.balance, 1500);
  assert.equal(spend.daily.length, 30);
  assert.equal((await app.json('/api/settings', 'POST', { spend: { thresholds: { tripo: -1 } } })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { spend: { thresholds: { other: 5 } } })).status, 400);
  const saved = await app.json('/api/settings', 'POST', { spend: { thresholds: { tripo: 2000 } } });
  assert.equal(saved.body.spend.thresholds.tripo, 2000);
  assert.equal((await app.j('/api/spend')).body.services.tripo.low, true);
});

test('serves the app, fonts and three.js from local files', async () => {
  for (const p of ['/', '/app.js', '/lib/pipeline.js', '/fonts/Sora-VariableFont_wght.ttf', '/img/icon.svg', '/vendor/three/build/three.module.js', '/vendor/three/examples/jsm/loaders/GLTFLoader.js']) {
    assert.equal((await fetch(app.base + p)).status, 200, p);
  }
  const page = await fetch(`${app.base}/`);
  assert.match(page.headers.get('content-type'), /text\/html/);
  // The page may only load its own scripts (plus its inline import map) and only talk to this server.
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' 'sha256-[\w+/=]+'/);
  assert.match(csp, /connect-src 'self' blob: data:(;|$)/); // GLB textures load from blob: URLs; nothing remote
  assert.match(csp, /img-src 'self' data: blob:(;|$)/);
  assert.match(csp, /worker-src 'self' blob:(;|$)/); // the Draco decoder runs in a blob: worker
  assert.match(csp, /object-src 'none'/);
});

test('Origin check: foreign origins cannot POST, PATCH, PUT or DELETE', async () => {
  const evil = { Origin: 'http://evil.example' };
  assert.equal((await app.j(`/api/models/${id}/versions`, { method: 'POST', headers: evil })).status, 403);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { name: 'Hacked' }, evil)).status, 403);
  assert.equal((await app.j(`/api/models/${id}`, { method: 'DELETE', headers: evil })).status, 403);
  assert.equal((await app.json('/api/settings', 'POST', { region: 'china' }, evil)).status, 403);
  assert.equal((await app.j('/api/renders/x/file?path=a.png', { method: 'PUT', headers: evil, body: 'x' })).status, 403);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { name: 'Red Chair' }, { Origin: 'null' })).status, 403);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { name: 'Red Chair' }, { Origin: app.origin })).status, 200);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { name: 'Red Chair' }, { Origin: `http://localhost:${app.port}` })).status, 200);
  assert.equal(generations, 1); // nothing was started by the refused requests
});

test('retry a failed task, regenerate into version 2, keep version 1, switch versions', async () => {
  failNext = true;
  const created = (await app.j('/api/models?name=Audi%20R8', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'jpeg-bytes' })).body;
  const failed = await settle(app, created.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Tripo task failed');
  assert.equal((await app.j(`/api/models/${id}/retry`, { method: 'POST' })).status, 409); // only failed models

  const retried = (await app.j(`/api/models/${created.id}/retry`, { method: 'POST' })).body;
  assert.equal(retried.status, 'generating');
  assert.equal(retried.versions.length, 1);
  assert.equal(retried.error, undefined);
  assert.equal(uploads.at(-1).includes(Buffer.from('jpeg-bytes')), true); // the saved photo was sent again
  const ready = await settle(app, created.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.glb, 'model.glb');

  // Regenerate from the same photo: version 2, version 1 kept.
  const v2 = await app.j(`/api/models/${created.id}/versions`, { method: 'POST' });
  assert.equal(v2.status, 201);
  assert.equal(v2.body.activeVersion, 2);
  assert.equal(v2.body.status, 'generating');
  assert.equal(v2.body.source, 'source.jpg');
  const done = await settle(app, created.id);
  assert.deepEqual(done.versions.map((v) => [v.n, v.status, v.glb]), [[1, 'ready', 'model.glb'], [2, 'ready', 'model-v2.glb']]);
  assert.equal(done.glb, 'model-v2.glb');
  assert.equal(done.thumb, 'preview-v2.webp');
  assert.equal((await fetch(`${app.base}/files/${created.id}/model.glb`)).status, 200);

  // Regenerate with a better photo: version 3 keeps its own source.
  const v3 = (await app.j(`/api/models/${created.id}/versions`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'better-photo' })).body;
  assert.equal(v3.activeVersion, 3);
  assert.equal(v3.source, 'source-v3.png');
  assert.equal(await (await fetch(`${app.base}/files/${created.id}/source-v3.png`)).text(), 'better-photo');
  await settle(app, created.id);

  // Switch back to version 1.
  const switched = (await app.json(`/api/models/${created.id}`, 'PATCH', { activeVersion: 1 })).body;
  assert.deepEqual([switched.activeVersion, switched.glb, switched.source, switched.versions.length], [1, 'model.glb', 'source.jpg', 3]);
  assert.equal((await app.json(`/api/models/${created.id}`, 'PATCH', { activeVersion: 9 })).status, 400);
  assert.equal((await app.json(`/api/models/${created.id}`, 'PATCH', { status: 'ready' })).status, 400);
});

test('rename keeps slugs unique', async () => {
  const lib = (await app.j('/api/models')).body;
  const audi = lib.find((m) => m.name === 'Audi R8');
  assert.equal(audi.slug, 'audi-r8');
  const twin = (await app.j('/api/models?name=Audi%20R8', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'png' })).body;
  assert.equal(twin.slug, 'audi-r8-2');
  await settle(app, twin.id);
  const renamed = (await app.json(`/api/models/${twin.id}`, 'PATCH', { name: '  Huracán Tecnica ' })).body;
  assert.deepEqual([renamed.name, renamed.slug], ['Huracán Tecnica', 'huracan-tecnica']);
  assert.equal((await app.json(`/api/models/${twin.id}`, 'PATCH', { name: 'Audi R8' })).body.slug, 'audi-r8-2');
  assert.equal((await app.json(`/api/models/${audi.id}`, 'PATCH', { name: 'Audi R8' })).body.slug, 'audi-r8'); // its own slug is not a clash
  assert.equal((await app.json(`/api/models/${twin.id}`, 'PATCH', { name: '   ' })).status, 400);
});

test('scene state is saved per model', async () => {
  const scene = { preset: 'ring', turn: 30, lens: 50, camera: 'front34' };
  assert.deepEqual((await app.json(`/api/models/${id}`, 'PATCH', { scene })).body.scene, scene);
  assert.deepEqual(JSON.parse(await readFile(path.join(data, 'models', id, 'scene.json'), 'utf8')), scene);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { scene: [1] })).status, 400);
});

// A minimal valid GLB 2.0: header, then one JSON chunk.
function tinyGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' } }).padEnd(28, ' '));
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + json.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, json]);
}

test('a dropped 3D model is imported as GLB, skips Generate and keeps its original file', async () => {
  const form = new FormData();
  form.append('name', 'Garage Find');
  form.append('glb', new Blob([tinyGlb()], { type: 'model/gltf-binary' }), 'model.glb');
  form.append('original', new Blob(['fbx bytes']), 'garage find.fbx');
  form.append('preview', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], { type: 'image/png' }), 'preview.png');
  const r = await app.j('/api/models/import', { method: 'POST', body: form });
  assert.equal(r.status, 201);
  const m = r.body;
  assert.deepEqual([m.status, m.provider, m.glb, m.file, m.fileName, m.thumb, m.credits, m.generation], ['ready', 'upload', 'model.glb', 'original.fbx', 'garage find.fbx', 'preview.png', 0, null]);
  assert.deepEqual(await readFile(path.join(data, 'models', m.id, 'model.glb')), tinyGlb());
  assert.equal(await readFile(path.join(data, 'models', m.id, 'original.fbx'), 'utf8'), 'fbx bytes');
  assert.equal((await app.j('/api/models')).body[0].id, m.id);

  const bad = (parts) => { const f = new FormData(); for (const [k, v, n] of parts) (n ? f.append(k, v, n) : f.append(k, v)); return app.j('/api/models/import', { method: 'POST', body: f }); };
  assert.equal((await bad([['glb', new Blob(['not a glb at all, really']), 'model.glb']])).status, 415);
  assert.equal((await bad([['glb', new Blob([tinyGlb()]), 'model.glb'], ['original', new Blob(['x']), 'car.exe']])).status, 415);
  assert.equal((await bad([['name', 'x']])).status, 400);
  assert.equal((await app.j('/api/models/import', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  // A GLB dropped as is: no separate original file.
  const plain = (await bad([['glb', new Blob([tinyGlb()]), 'model.glb'], ['fileName', 'plain.glb']])).body;
  assert.deepEqual([plain.fileName, plain.file, plain.name], ['plain.glb', undefined, 'plain']);
  await app.j(`/api/models/${plain.id}`, { method: 'DELETE' });
  await app.j(`/api/models/${m.id}`, { method: 'DELETE' });
});

test('each new version keeps the prompt and settings it was generated with; approve is a flag', async () => {
  const m = (await app.j(`/api/models/${id}`)).body;
  const v = m.versions.at(-1);
  assert.equal(v.generation.provider, v.provider);
  assert.equal(v.generation.engine, v.engine);
  assert.deepEqual(v.generation.options, v.options);
  assert.equal(v.generation.prompt, null);
  assert.equal(typeof v.generation.credits, 'number');
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { approved: 'yes' })).status, 400);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { approved: true })).body.approved, true);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { approved: false })).body.approved, false);
});

let outRoot;
test('settings persist and the region is validated', async () => {
  const s = (await app.j('/api/settings')).body;
  assert.equal(s.region, 'global');
  assert.equal(s.model, 'v3.1-20260211');
  assert.deepEqual(s.regions, { global: 'https://openapi.tripo3d.ai/v3', china: 'https://openapi.tripo3d.com/v3' });
  assert.equal(s.apiKey, undefined);
  assert.equal((await app.json('/api/settings', 'POST', { region: 'mars' })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { region: 'https://evil.example/v3' })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { apiBase: 'https://evil.example/v3' })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { texture: 'yes' })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { outputRoot: 'relative/folder' })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { outputRoot: path.join(data, 'missing') })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { blenderPath: path.join(data, 'blender.exe') })).status, 400);

  outRoot = await tempDir();
  const saved = await app.json('/api/settings', 'POST', { region: 'china', pbr: false, defaultScene: 'cyclorama', outputRoot: outRoot });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.region, saved.body.pbr, saved.body.defaultScene, saved.body.outputRoot], ['china', false, 'cyclorama', path.resolve(outRoot)]);
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).region, 'china');
  assert.equal(JSON.stringify(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8'))).includes(KEY), false);

  // Restart: settings and library survive.
  await app.stop();
  app = await startApp(data, { TRIPO_API_KEY: KEY });
  const after = (await app.j('/api/settings')).body;
  assert.deepEqual([after.region, after.pbr, after.defaultScene, after.outputRoot], ['china', false, 'cyclorama', path.resolve(outRoot)]);
  assert.equal((await app.j('/api/models')).body.length, 3);
  assert.equal((await app.json('/api/settings', 'POST', { region: 'global', pbr: true })).body.region, 'global');
});

test('the Render step light rig and glass are saved in settings and validated', async () => {
  const s = (await app.j('/api/settings')).body;
  assert.equal(s.lighting.kelvin, 5600);
  assert.equal(s.glass.on, true);
  assert.equal((await app.json('/api/settings', 'POST', { lighting: { key: 9 } })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { glass: { tint: 'javascript:1' } })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { defaultScene: 'showroom' })).status, 200);
  const saved = (await app.json('/api/settings', 'POST', { lighting: { azimuth: 60 }, glass: { opacity: 0.5 } })).body;
  assert.deepEqual([saved.lighting.azimuth, saved.lighting.key, saved.glass.opacity, saved.glass.on], [60, 1, 0.5, true]);
  assert.equal(JSON.parse(await readFile(path.join(data, 'settings.json'), 'utf8')).lighting.azimuth, 60);
  await app.json('/api/settings', 'POST', { defaultScene: 'ring' });
});

test('Blender is found on PATH, in a portable folder in the home folder, and in Program Files', async () => {
  const { blenderCandidates } = await import('./server.mjs');
  const home = await tempDir();
  const env = { PATH: path.join(home, 'bin'), USERPROFILE: home, ProgramFiles: path.join(home, 'PF') };
  await mkdir(path.join(home, 'Blender', 'blender-4.2.1-windows-x64'), { recursive: true });
  await mkdir(path.join(home, 'Blender', 'blender-5.2.2-windows-x64'), { recursive: true });
  await mkdir(path.join(home, 'PF', 'Blender Foundation', 'Blender 4.5'), { recursive: true });
  const list = blenderCandidates('win32', env);
  assert.ok(list.includes(path.join(home, 'bin', 'blender.exe')));
  assert.ok(list.includes(path.join(home, 'PF', 'Blender Foundation', 'Blender 4.5', 'blender.exe')));
  const portable = list.filter((p) => p.startsWith(path.join(home, 'Blender', 'blender-')));
  assert.deepEqual(portable.map((p) => path.basename(path.dirname(p))), ['blender-5.2.2-windows-x64', 'blender-4.2.1-windows-x64']); // newest first
  assert.ok(blenderCandidates('linux', { PATH: '/opt/b' }).includes('/opt/b/blender'));
});

test('keys: saved, replaced and removed per provider, never sent back to the page', async () => {
  // This app was restarted with TRIPO_API_KEY in its environment.
  const leaks = (res) => JSON.stringify(res.body).includes(KEY) || JSON.stringify(res.body).includes('tsk_');
  const settings = await app.j('/api/settings');
  assert.deepEqual(settings.body.keys, { tripo: 'env', '3daistudio': 'none' });
  assert.equal(leaks(settings), false);
  const account = await app.j('/api/account?provider=tripo');
  assert.deepEqual(account.body, { hasKey: true, balance: 1500, frozen: 0 });
  assert.deepEqual((await app.j('/api/account?provider=3daistudio')).body, { hasKey: false });
  assert.equal((await app.j('/api/account?provider=constructor')).status, 404);

  const saved = await app.json('/api/keys/tripo', 'PUT', { key: KEY });
  assert.equal(saved.status, 200);
  assert.equal(leaks(saved), false);
  assert.deepEqual(saved.body.keys, { tripo: 'saved', '3daistudio': 'none' });
  assert.equal((await app.json('/api/keys/tripo', 'PUT', { key: 'tsk_wrong_key_123' })).status, 401); // checked with Tripo first
  const short = await app.json('/api/keys/3daistudio', 'PUT', { key: 'abc' });
  assert.deepEqual([short.status, short.body.error.includes('abc')], [400, false]);
  assert.equal((await app.json('/api/keys/3daistudio', 'PUT', { key: 'not-a-3das-key-0001' })).status, 401); // the fake refuses it
  assert.equal((await app.json('/api/keys/meshy', 'PUT', { key: KEY })).status, 404);
  assert.equal((await app.json('/api/keys/tripo', 'PUT', { key: KEY }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await app.j('/api/keys/tripo', { method: 'DELETE', headers: { Origin: 'http://evil.example' } })).status, 403);

  const removed = await app.j('/api/keys/tripo', { method: 'DELETE' });
  assert.deepEqual(removed.body.keys, { tripo: 'env', '3daistudio': 'none' }); // back to the environment's key
  assert.equal((await app.j('/api/keys/tripo')).status, 404); // there is no way to read a key
  for (const file of ['settings.json', 'library.json']) assert.equal((await readFile(path.join(data, file), 'utf8')).includes(KEY), false, file);
});

test('settings remember the provider and its last setup', async () => {
  assert.equal((await app.json('/api/settings', 'POST', { provider: 'meshy' })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { setups: { tripo: { engine: 'hitem3d' } } })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { setups: { constructor: {} } })).status, 400);
  const saved = (await app.json('/api/settings', 'POST', { provider: '3daistudio', setups: { '3daistudio': { engine: 'hitem3d', mode: 'views', options: { shading: 0.37, nonsense: 1 } } } })).body;
  assert.equal(saved.provider, '3daistudio');
  assert.deepEqual(saved.setups['3daistudio'], { provider: '3daistudio', engine: 'hitem3d', mode: 'views', options: { resolution: '2048quality', texture: 'pbr', shading: 0.4, face_limit: 2000000 } });
  assert.equal((await app.json('/api/settings', 'POST', { provider: 'tripo' })).body.setups['3daistudio'].engine, 'hitem3d');
});

test('old v0.2 library migrates and the model still opens', async () => {
  const oldData = await tempDir();
  const old = {
    id: '6f1c3f4e-0000-4000-8000-000000000001', name: 'Audi R8 · front ¾', status: 'ready', progress: 100, task_id: 'task_old',
    created_at: '2026-10-01T10:00:00.000Z', source: 'source.jpg', exports: {}, glb: 'model.glb', thumb: 'preview.webp', credits: 30,
  };
  // A second v0.2 entry was still generating, on a task Tripo has since forgotten.
  const stuck = { id: '6f1c3f4e-0000-4000-8000-000000000002', name: 'Audi R8', status: 'generating', progress: 40, task_id: 'task_gone_1',
    created_at: '2026-10-02T10:00:00.000Z', source: 'source.png', exports: {} };
  // v0.3 called the studio preset 'gold'.
  old.scene = { preset: 'gold', turn: 30 };
  await mkdir(path.join(oldData, 'models', old.id), { recursive: true });
  await mkdir(path.join(oldData, 'models', stuck.id), { recursive: true });
  await writeFile(path.join(oldData, 'models', stuck.id, 'source.png'), 'png');
  await writeFile(path.join(oldData, 'models', old.id, 'scene.json'), JSON.stringify(old.scene));
  await writeFile(path.join(oldData, 'library.json'), JSON.stringify([stuck, old], null, 2));
  await writeFile(path.join(oldData, 'settings.json'), JSON.stringify({ defaultScene: 'gold', region: 'global' }));
  for (const f of ['model.glb', 'preview.webp', 'source.jpg']) await writeFile(path.join(oldData, 'models', old.id, f), `old-${f}`);
  const before = seen.length;
  const oldApp = await startApp(oldData, { TRIPO_API_KEY: KEY });

  const [s, m] = (await oldApp.j('/api/models')).body;
  assert.deepEqual([s.slug, s.status, s.activeVersion, s.versions.length], ['audi-r8', 'generating', 1, 1]);
  assert.equal(m.slug, 'audi-r8-front-3-4');
  assert.equal(m.activeVersion, 1);
  assert.deepEqual(m.versions, [{
    n: 1, created_at: old.created_at, exports: {}, task_id: 'task_old', status: 'ready', progress: 100,
    glb: 'model.glb', thumb: 'preview.webp', credits: 30, source: 'source.jpg', provider: 'tripo',
  }]);
  for (const k of ['status', 'progress', 'task_id', 'glb', 'thumb', 'source', 'credits', 'name', 'created_at']) assert.deepEqual(m[k], old[k], k);
  assert.equal((await oldApp.j(`/api/models/${old.id}`)).body.status, 'ready');
  assert.equal(await (await fetch(`${oldApp.base}/files/${old.id}/model.glb`)).text(), 'old-model.glb');
  assert.equal(seen.length, before); // opening it never called Tripo
  const saved = JSON.parse(await readFile(path.join(oldData, 'library.json'), 'utf8'));
  assert.equal(saved[1].versions.length, 1);
  assert.equal(saved[1].glb, 'model.glb'); // v0.2 can still read it
  assert.deepEqual(m.scene, { preset: 'ring', turn: 30 });
  assert.deepEqual(JSON.parse(await readFile(path.join(oldData, 'models', old.id, 'scene.json'), 'utf8')), { preset: 'ring', turn: 30 });
  assert.equal((await oldApp.j('/api/settings')).body.defaultScene, 'cyclorama'); // gold -> ring -> showroom (v0.5) -> White Cyc Studio (v0.6 default)

  // The in-flight one is polled; Tripo no longer has its task, so it fails (and can be retried) instead of spinning forever.
  const gone = (await oldApp.j(`/api/models/${stuck.id}`)).body;
  assert.deepEqual([gone.status, gone.error], ['failed', 'Tripo has no record of this task']);
  assert.equal((await oldApp.j(`/api/models/${stuck.id}/retry`, { method: 'POST' })).body.status, 'generating');
  await oldApp.stop();
});

let slugDir;
test('render file endpoint writes inside <root>/<slug>/ only', async () => {
  const lib = (await app.j('/api/models')).body;
  const audi = lib.find((m) => m.slug === 'audi-r8');
  assert.equal((await app.j(`/api/renders/${audi.id}/file?path=frames/studio/x_000.png`, { method: 'PUT', body: 'x' })).status, 409); // not started
  assert.equal((await app.json(`/api/renders/${audi.id}/start`, 'POST', { looks: ['constructor'] })).status, 400);
  assert.equal((await app.json(`/api/renders/${audi.id}/start`, 'POST', { looks: ['studio'], formats: ['PDF'] })).status, 400);

  const started = await app.json(`/api/renders/${audi.id}/start`, 'POST', { looks: ['studio', 'transparent'], formats: ['FBX'] });
  assert.equal(started.status, 200);
  slugDir = path.join(path.resolve(outRoot), 'audi-r8');
  assert.equal(started.body.outDir, slugDir);
  for (const sub of ['frames/studio', 'frames/transparent', 'web', 'stills', 'models']) assert.ok(existsSync(path.join(slugDir, sub)), sub);
  // The active version is 1, which the retry generated as task_gen3.
  assert.equal(await readFile(path.join(slugDir, 'models', 'audi-r8.glb'), 'utf8'), 'bytes:/cdn/task_gen3/model_pbr.glb?sig=x');
  // FBX wasn't converted yet: converting starts now and the file lands in models/ when Tripo is done.
  assert.equal((await app.j(`/api/models/${audi.id}/exports/FBX`)).body.status, 'converting');
  assert.equal((await app.j(`/api/models/${audi.id}/exports/FBX`)).body.status, 'ready');
  assert.match(await readFile(path.join(slugDir, 'models', 'audi-r8.fbx'), 'utf8'), /^bytes:\/cdn\/task_conv_task_gen3_FBX\/out\.fbx/);

  const put = (p, body = 'data', headers = {}) => app.j(`/api/renders/${audi.id}/file?path=${encodeURIComponent(p)}`, { method: 'PUT', body, headers });
  assert.equal((await put('frames/studio/audi-r8_000.png', 'frame-0')).status, 201);
  assert.equal(await readFile(path.join(slugDir, 'frames', 'studio', 'audi-r8_000.png'), 'utf8'), 'frame-0');
  assert.equal((await put('frames/studio/audi-r8_000.png', 'frame-0b')).status, 201); // render again overwrites
  assert.equal(await readFile(path.join(slugDir, 'frames', 'studio', 'audi-r8_000.png'), 'utf8'), 'frame-0b');
  assert.equal((await app.j(`/api/renders/${audi.id}/file?path=frames/studio/audi-r8_000.png`)).body, 'frame-0b');

  // Traversal, absolute paths and other file types are refused.
  for (const bad of ['../evil.png', 'frames/../../evil.png', '..\\evil.png', path.join(outRoot, 'evil.png'), '/tmp/evil.png', 'C:/evil.png', '']) {
    assert.equal((await put(bad)).status, 400, bad);
  }
  for (const bad of ['web/x.exe', 'web/x.png.bat', 'web/x', 'HANDOFF.txt']) assert.equal((await put(bad)).status, 415, bad);
  assert.equal(existsSync(path.join(outRoot, 'evil.png')), false);
  assert.equal(existsSync(path.join(path.dirname(outRoot), 'evil.png')), false);
  assert.equal((await put('web/x.png', 'x', { Origin: 'http://evil.example' })).status, 403);

  // Finished sheets mark the library entry, and the poster becomes its thumbnail.
  assert.equal((await put('web/studio-poster.webp', 'poster')).status, 201);
  assert.equal((await put('web/studio-sprite-360.json', '{}')).status, 201);
  assert.equal((await put('web/transparent-sprite-180.json', '{}')).status, 201);
  assert.equal((await put('stills/audi-r8_studio_030.png', 'still')).status, 201);
  for (const f of ['spin-viewer.js', 'viewer.html', 'HANDOFF.md', 'web/studio-360-512.webp']) assert.equal((await put(f)).status, 201, f);
  const renders = (await app.j('/api/models')).body.find((m) => m.id === audi.id).renders;
  assert.equal(renders.studio360, true);
  assert.equal(renders.transparent180, true);
  assert.equal(renders.studio180, undefined);
  assert.equal(renders.poster, 'poster-studio.webp');
  assert.deepEqual(renders.stills, ['audi-r8_studio_030.png']);
  assert.equal(await (await fetch(`${app.base}/files/${audi.id}/poster-studio.webp`)).text(), 'poster');
});

test('Blender: detection and a fake blender run through spawn', async () => {
  const fakeBlender = path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs');
  assert.equal((await app.json('/api/settings', 'POST', { blenderPath: fakeBlender })).status, 200);
  const info = (await app.j('/api/blender')).body;
  assert.deepEqual([info.found, info.path], [true, fakeBlender]);

  const audi = (await app.j('/api/models')).body.find((m) => m.slug === 'audi-r8');
  assert.equal((await app.json(`/api/renders/${audi.id}/blender`, 'POST', { looks: ['chrome'], frames: 72 })).status, 400);
  assert.equal((await app.json(`/api/renders/${audi.id}/blender`, 'POST', { looks: ['studio'], frames: 10 })).status, 400);
  const started = await app.json(`/api/renders/${audi.id}/blender`, 'POST', { looks: ['studio'], frames: 37, still: 30 });
  assert.equal(started.status, 202);
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await app.j(`/api/renders/${audi.id}/blender`)).body;
    if (job.status !== 'running') break;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.frame, 37);
  const frames = (await readdir(path.join(slugDir, 'frames', 'studio'))).filter((f) => /^audi-r8_\d{3}\.png$/.test(f));
  assert.equal(frames.length, 37);
  assert.ok(existsSync(path.join(slugDir, 'stills', 'audi-r8_studio_030.png')));
  const args = JSON.parse(await readFile(path.join(slugDir, 'frames', 'studio', 'fake-blender-args.json'), 'utf8'));
  assert.deepEqual(args.slice(0, 2), ['-b', '-P']);
  assert.match(args[2], /render[\\/]blender_turntable\.py$/);
  const after = args.slice(args.indexOf('--') + 1);
  const opt = (k) => after[after.indexOf(`--${k}`) + 1];
  assert.deepEqual([opt('look'), opt('frames'), opt('step'), opt('res'), opt('slug')], ['studio', '37', '5', '2048x1536', 'audi-r8']);
  assert.match(opt('glb'), /model\.glb$/);
  assert.equal(opt('out'), path.join(slugDir, 'frames', 'studio'));
  const look = JSON.parse(opt('scenelook'));
  assert.deepEqual([look.engine, look.tone, look.hdri, look.lights], ['CYCLES', 'Khronos PBR Neutral', null, null]); // the default look: Cycles, neutral, the script's own rig
  assert.match(opt('materials'), /blender-materials\.json$/);
  assert.deepEqual(JSON.parse(await readFile(opt('materials'), 'utf8')), { materials: {}, groups: {} });

  assert.equal((await app.json('/api/settings', 'POST', { blenderPath: '' })).status, 200);
});

test('studio presets save in settings; inference falls back without a key; path tracer modules are served', async () => {
  const look = { background: { kind: 'solid', color: '#101010' }, ssr: { on: true, strength: 0.7 }, pathTraced: true, quality: 'pathTraced' };
  const saved = await app.json('/api/settings', 'POST', { studioPresets: { 'My Dark': look } });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.studioPresets['My Dark'].ssr, saved.body.studioPresets['My Dark'].pathTraced, saved.body.studioPresets['My Dark'].tone], [{ on: true, strength: 0.7 }, true, 'neutral']);
  assert.equal((await app.json('/api/settings', 'POST', { studioPresets: { '': look } })).status, 400);
  assert.equal((await app.json('/api/settings', 'POST', { studioPresets: [look] })).status, 400);
  assert.equal((await app.j('/api/settings')).body.visionKey, 'none');
  // No Anthropic key: the built-in rules label the clusters and nothing leaves the machine.
  const before = seen.length;
  const inferred = await app.json('/api/infer', 'POST', { stats: [{ r: 180, g: 30, b: 30, x: 0.5, y: 0.5, share: 0.8, n: 80 }, { r: 10, g: 10, b: 10, x: 0.4, y: 0.9, share: 0.2, n: 20 }], image: 'data:image/png;base64,AA==' });
  assert.equal(inferred.status, 200);
  assert.deepEqual([inferred.body.source, inferred.body.labels.map((l) => l.label)], ['heuristic', ['paint', 'rubber']]);
  assert.equal(seen.length, before);
  assert.equal((await app.json('/api/infer', 'POST', { stats: 'x' })).status, 400);
  assert.equal((await app.json('/api/keys/anthropic', 'PUT', { key: 'abc' })).status, 400);
  for (const p of ['/vendor/three-gpu-pathtracer/src/index.js', '/vendor/three-mesh-bvh/src/index.js', '/vendor/three/examples/jsm/postprocessing/GTAOPass.js', '/img/hdri/studio_small_03.hdr']) {
    assert.equal((await fetch(app.base + p)).status, 200, p);
  }
  assert.equal((await fetch(`${app.base}/vendor/three-mesh-bvh/src/..%2Fpackage.json`)).status, 404);
});

test('HEIC photos are converted to JPEG before upload', async () => {
  const before = uploads.length;
  const created = await app.j('/api/models?name=Phone%20Photo', { method: 'POST', headers: { 'Content-Type': 'image/heic' }, body: HEIC_FIXTURE });
  assert.equal(created.status, 201, created.body.error);
  assert.equal(created.body.source, 'source.jpg');
  assert.equal(uploads.length, before + 1);
  const sent = uploads.at(-1).toString('latin1');
  assert.match(sent, /Content-Type: image\/jpeg/);
  assert.ok(sent.includes('\xff\xd8\xff')); // a JPEG went to Tripo, not the HEIC
  const source = Buffer.from(await (await fetch(`${app.base}/files/${created.body.id}/source.jpg`)).arrayBuffer());
  assert.deepEqual([...source.subarray(0, 2)], [0xff, 0xd8]);
  const broken = await app.j('/api/models?name=Bad', { method: 'POST', headers: { 'Content-Type': 'image/heic' }, body: 'not a heic file' });
  assert.equal(broken.status, 415);
  assert.match(broken.body.error, /HEIC/);
});

test('setup screen: a Tripo preset goes out as multipart with its options', async () => {
  const setup = (s) => JSON.stringify(s);
  const post = (fields) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return app.j('/api/models', { method: 'POST', body: form });
  };
  const png = (text) => new Blob([text], { type: 'image/png' });
  const created = await post({ name: 'Setup Car', setup: setup({ provider: 'tripo', engine: 'tripo-direct', options: { texture: 'pbr', texture_quality: 'detailed' } }), front: png('front-bytes') });
  assert.equal(created.status, 201, created.body.error);
  assert.deepEqual(generationBodies.at(-1), { input: `file_${uploads.length}`, model: 'v3.1-20260211', texture: true, pbr: true, texture_quality: 'detailed' });
  const v = created.body.versions[0];
  assert.deepEqual([created.body.name, v.provider, v.engine, v.mode, v.estimate, v.source], ['Setup Car', 'tripo', 'tripo-direct', 'single', 40, 'source.png']);
  // Tripo direct takes one photo, so extra views are not kept.
  const four = await post({ setup: setup({ provider: 'tripo', engine: 'tripo-direct', mode: 'views' }), front: png('f'), left: png('l') });
  assert.deepEqual([four.status, four.body.versions[0].mode, four.body.versions[0].views], [201, 'single', undefined]);

  // Refused before anything is sent: a 3D AI Studio setup without its key, unknown engines, other image types.
  const before = generationBodies.length;
  assert.equal((await post({ setup: setup({ provider: '3daistudio', engine: 'trellis2' }), front: png('x') })).status, 401);
  assert.equal((await post({ setup: setup({ provider: 'tripo', engine: 'hitem3d' }), front: png('x') })).status, 400);
  assert.equal((await post({ setup: 'nonsense', front: png('x') })).status, 400);
  assert.equal((await post({ setup: setup({ provider: 'tripo', engine: 'tripo-direct' }), front: new Blob(['x'], { type: 'image/gif' }) })).status, 415);
  assert.equal((await post({ setup: setup({ provider: 'tripo', engine: 'tripo-direct' }) })).status, 400);
  assert.equal(generationBodies.length, before);

  // Regenerate with a new setup and the same photo.
  const v2 = await app.j(`/api/models/${created.body.id}/versions`, { method: 'POST', body: (() => { const f = new FormData(); f.append('setup', setup({ provider: 'tripo', engine: 'tripo-direct', options: { texture: 'none' } })); return f; })() });
  assert.equal(v2.status, 201, v2.body.error);
  assert.deepEqual([v2.body.activeVersion, v2.body.source, v2.body.versions[1].estimate], [2, 'source.png', 20]);
  assert.deepEqual(generationBodies.at(-1), { input: `file_${uploads.length}`, model: 'v3.1-20260211', texture: false, pbr: false });
  for (const m of [created.body, four.body]) await settle(app, m.id);
});

test('updates: npm run web asks FLATFORM_UPDATE_URL (here the fake GitHub) a moment after it starts', async () => {
  const web = await startApp(await tempDir(), { FLATFORM_UPDATE_DELAY_MS: '0' });
  let u;
  for (let i = 0; i < 100 && !(u = (await web.j('/api/update')).body).checkedAt; i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual([u.latest, u.newer, u.notes, u.downloadUrl], ['99.0.0', true, 'Faster renders.', 'https://github.com/TyroneMadison/Flatform/releases/tag/v99.0.0']);
  await web.stop();
});

test('delete removes the model and its files', async () => {
  assert.equal((await app.j(`/api/models/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.j('/api/models')).body.some((m) => m.id === id), false);
  assert.equal((await fetch(`${app.base}/files/${id}/model.glb`)).status, 404);
  assert.equal((await app.j(`/api/models/${id}`)).status, 404);
});
