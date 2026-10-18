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

const temps = [];
const tempDir = async () => { const d = await mkdtemp(path.join(tmpdir(), 'flatform-')); temps.push(d); return d; };
const apps = [];

// Runs `node server.mjs` like `npm run web` does, on a free port, pointed at the fake Tripo.
async function startApp(dataDir, env = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, TRIPO_BASE: `http://127.0.0.1:${fakePort}/v3`, TRIPO_API_KEY: '', DATA_DIR: dataDir, PORT: '0', ...env },
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
  const scene = { preset: 'gold', turn: 30, lens: 50, camera: 'front34' };
  assert.deepEqual((await app.json(`/api/models/${id}`, 'PATCH', { scene })).body.scene, scene);
  assert.deepEqual(JSON.parse(await readFile(path.join(data, 'models', id, 'scene.json'), 'utf8')), scene);
  assert.equal((await app.json(`/api/models/${id}`, 'PATCH', { scene: [1] })).status, 400);
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

test('old v0.2 library migrates and the model still opens', async () => {
  const oldData = await tempDir();
  const old = {
    id: '6f1c3f4e-0000-4000-8000-000000000001', name: 'Audi R8 · front ¾', status: 'ready', progress: 100, task_id: 'task_old',
    created_at: '2026-10-01T10:00:00.000Z', source: 'source.jpg', exports: {}, glb: 'model.glb', thumb: 'preview.webp', credits: 30,
  };
  // A second v0.2 entry was still generating, on a task Tripo has since forgotten.
  const stuck = { id: '6f1c3f4e-0000-4000-8000-000000000002', name: 'Audi R8', status: 'generating', progress: 40, task_id: 'task_gone_1',
    created_at: '2026-10-02T10:00:00.000Z', source: 'source.png', exports: {} };
  await mkdir(path.join(oldData, 'models', old.id), { recursive: true });
  await mkdir(path.join(oldData, 'models', stuck.id), { recursive: true });
  await writeFile(path.join(oldData, 'models', stuck.id, 'source.png'), 'png');
  await writeFile(path.join(oldData, 'library.json'), JSON.stringify([stuck, old], null, 2));
  for (const f of ['model.glb', 'preview.webp', 'source.jpg']) await writeFile(path.join(oldData, 'models', old.id, f), `old-${f}`);
  const before = seen.length;
  const oldApp = await startApp(oldData, { TRIPO_API_KEY: KEY });

  const [s, m] = (await oldApp.j('/api/models')).body;
  assert.deepEqual([s.slug, s.status, s.activeVersion, s.versions.length], ['audi-r8', 'generating', 1, 1]);
  assert.equal(m.slug, 'audi-r8-front-3-4');
  assert.equal(m.activeVersion, 1);
  assert.deepEqual(m.versions, [{
    n: 1, created_at: old.created_at, exports: {}, task_id: 'task_old', status: 'ready', progress: 100,
    glb: 'model.glb', thumb: 'preview.webp', credits: 30, source: 'source.jpg',
  }]);
  for (const k of ['status', 'progress', 'task_id', 'glb', 'thumb', 'source', 'credits', 'name', 'created_at']) assert.deepEqual(m[k], old[k], k);
  assert.equal((await oldApp.j(`/api/models/${old.id}`)).body.status, 'ready');
  assert.equal(await (await fetch(`${oldApp.base}/files/${old.id}/model.glb`)).text(), 'old-model.glb');
  assert.equal(seen.length, before); // opening it never called Tripo
  const saved = JSON.parse(await readFile(path.join(oldData, 'library.json'), 'utf8'));
  assert.equal(saved[1].versions.length, 1);
  assert.equal(saved[1].glb, 'model.glb'); // v0.2 can still read it

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

  assert.equal((await app.json('/api/settings', 'POST', { blenderPath: '' })).status, 200);
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

test('delete removes the model and its files', async () => {
  assert.equal((await app.j(`/api/models/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.j('/api/models')).body.some((m) => m.id === id), false);
  assert.equal((await fetch(`${app.base}/files/${id}/model.glb`)).status, 404);
  assert.equal((await app.j(`/api/models/${id}`)).status, 404);
});
