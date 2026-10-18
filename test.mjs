// End-to-end check against a fake Tripo API: upload → generate → library → export → delete.
// Run: node test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const listen = (server) => new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server.address().port)));
const polls = {};
const seen = [];

// Fake Tripo: each task reports "running" once, then "success" with expiring-style CDN URLs.
const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen.push(`${req.method} ${req.url}`);
  const ok = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); };
  if (req.url.startsWith('/cdn/')) { res.writeHead(200); return res.end(`bytes:${req.url}`); }
  assert.equal(req.headers.authorization, 'Bearer test-key');
  if (req.url === '/v3/files') { assert.match(body, /name="file"/); return ok({ file_token: 'file_1' }); }
  if (req.url === '/v3/generation/image-to-model') {
    assert.equal(JSON.parse(body).input, 'file_1');
    return ok({ task_id: 'task_gen' });
  }
  if (req.url === '/v3/models/convert') {
    const { input, format } = JSON.parse(body);
    assert.equal(input, 'task_gen');
    return ok({ task_id: `task_conv_${format}` });
  }
  const id = req.url.match(/^\/v3\/tasks\/(.+)$/)?.[1];
  if (id) {
    polls[id] = (polls[id] || 0) + 1;
    if (polls[id] === 1) return ok({ task_id: id, status: 'running', progress: 40 });
    const base = `http://127.0.0.1:${fakePort}/cdn/${id}`;
    return ok({ task_id: id, status: 'success', progress: 100, credits_consumed: 30,
      output: id === 'task_gen'
        ? { model_url: `${base}/model_pbr.glb?sig=x`, rendered_image_url: `${base}/preview.webp` }
        : { model_url: `${base}/out.fbx` } });
  }
  res.writeHead(404); res.end();
});
const fakePort = await listen(fake);

const data = await mkdtemp(path.join(tmpdir(), 'tripo-studio-'));
const appPort = 5900 + Math.floor(Math.random() * 90);
const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, TRIPO_BASE: `http://127.0.0.1:${fakePort}/v3`, TRIPO_API_KEY: 'test-key', DATA_DIR: data, PORT: String(appPort) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok) => app.stdout.once('data', ok));
const base = `http://127.0.0.1:${appPort}`;
const j = async (p, opts) => { const r = await fetch(base + p, opts); return { status: r.status, body: await r.json() }; };

try {
  // Rejects non-PNG/JPEG before calling Tripo.
  assert.equal((await j('/api/models', { method: 'POST', headers: { 'Content-Type': 'image/gif' }, body: 'x' })).status, 415);

  const created = await j('/api/models?name=Red%20Chair', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'png-bytes' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.status, 'generating');

  // Two simultaneous polls on a finished task must download once.
  assert.equal((await j(`/api/models/${id}`)).body.progress, 40);
  const [a, b] = await Promise.all([j(`/api/models/${id}`), j(`/api/models/${id}`)]);
  assert.equal(a.body.status, 'ready');
  assert.equal(b.body.status, 'ready');
  assert.equal(seen.filter((s) => s.includes('/cdn/task_gen/model_pbr.glb')).length, 1);
  assert.equal(a.body.glb, 'model.glb');
  assert.equal(a.body.thumb, 'preview.webp');
  assert.equal(await (await fetch(`${base}/files/${id}/model.glb`)).text(), 'bytes:/cdn/task_gen/model_pbr.glb?sig=x');
  assert.equal(await (await fetch(`${base}/files/${id}/source.png`)).text(), 'png-bytes');

  // Path traversal is refused.
  assert.equal((await fetch(`${base}/files/${id}/..%2F..%2Flibrary.json`)).status, 404);

  // Export to FBX.
  assert.equal((await j(`/api/models/${id}/exports/FBX`, { method: 'POST' })).body.status, 'converting');
  assert.equal((await j(`/api/models/${id}/exports/FBX`)).body.status, 'converting');
  const fbx = (await j(`/api/models/${id}/exports/FBX`)).body;
  assert.deepEqual([fbx.status, fbx.file], ['ready', 'model-fbx.fbx']);
  assert.equal((await j(`/api/models/${id}/exports/PDF`, { method: 'POST' })).status, 404);

  // Library persists, then delete clears it.
  const lib = (await j('/api/models')).body;
  assert.equal(lib.length, 1);
  assert.equal(lib[0].exports.FBX.status, 'ready');
  assert.equal((await j(`/api/models/${id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await j('/api/models')).body, []);
  assert.equal((await fetch(`${base}/files/${id}/model.glb`)).status, 404);
  console.log('PASS: upload → generate → library → export → delete');
} finally {
  app.kill();
  fake.close();
  await rm(data, { recursive: true, force: true });
}
