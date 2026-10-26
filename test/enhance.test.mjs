// Enhance and real-cost tracking. Tripo is a fake local server: no paid call ever leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { ENHANCE, enhanceBlock } from '../enhance.mjs';
import { entry, totals, actualOf } from '../ledger.mjs';

test('enhanceBlock: only ready Tripo versions with a task', () => {
  assert.equal(enhanceBlock({ status: 'ready', provider: 'tripo', task_id: 't' }), null);
  assert.match(enhanceBlock({ status: 'running', provider: 'tripo', task_id: 't' }), /not ready/);
  assert.match(enhanceBlock({ status: 'ready', provider: '3daistudio', task_id: 't' }), /Tripo/);
  assert.match(enhanceBlock({ status: 'ready', provider: 'tripo', task_id: 't', enhance: { status: 'running' } }), /Already/);
  assert.equal(ENHANCE.texture.body('abc').original_model_task_id, 'abc');
});

test('ledger: actual cost is the balance drop, the estimate when the drop is unknown', () => {
  const a = entry({ service: 'tripo', task: 'enhance', credits: 20, balanceBefore: 100, balanceAfter: 75 });
  const b = entry({ service: 'tripo', task: 'convert', credits: 5 });
  assert.equal(actualOf(a), 25);
  assert.equal(actualOf(b), 5);
  const t = totals([a, b]).tripo.all;
  assert.equal(t.credits, 25);
  assert.equal(t.actualCredits, 30);
  assert.equal(t.actualUsd, 0.3);
});

test('POST /enhance sends a texture_model task to (fake) Tripo, logs the spend, and GET finishes it', async () => {
  let balance = 500; const posted = [];
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const reply = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 0, data })); };
    if (req.url.endsWith('/account/balance')) return reply({ balance, frozen: 0 });
    if (req.url.endsWith('/task') && req.method === 'POST') { posted.push(JSON.parse(body)); balance -= 20; return reply({ task_id: 'enh-1' }); }
    if (req.url.endsWith('/tasks/enh-1')) return reply({ status: 'success', output: { model_url: `http://127.0.0.1:${fake.address().port}/m.glb` } });
    if (req.url.endsWith('/m.glb')) { res.setHeader('Content-Type', 'model/gltf-binary'); return res.end('glTF'); }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((ok) => fake.listen(0, '127.0.0.1', ok));
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-enh-'));
  await mkdir(path.join(data, 'models', 'car1'), { recursive: true });
  const lib = [{ id: 'car1', name: 'Car', slug: 'car', status: 'ready', activeVersion: 1, versions: [{ n: 1, status: 'ready', provider: 'tripo', task_id: 'orig-1', exports: {} }] }];
  await writeFile(path.join(data, 'library.json'), JSON.stringify(lib));
  const app = await startServer({ dataDir: data, apiBase: `http://127.0.0.1:${fake.address().port}/v2/openapi`, keyStore: createKeyStore({ env: { TRIPO_API_KEY: 'tsk_fake_key_0000' } }) });
  const base = `http://127.0.0.1:${app.port}/api/models/car1/enhance`;
  try {
    const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'texture' }) });
    assert.equal(r.status, 202, await r.clone().text());
    assert.equal(posted[0].type, 'texture_model');
    assert.equal(posted[0].original_model_task_id, 'orig-1');
    assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'texture' }) })).status, 409, 'no double charge');
    const done = await (await fetch(base)).json();
    assert.equal(done.status, 'ready');
    await new Promise((ok) => setTimeout(ok, 300));
    const spend = (await readFile(path.join(data, 'spend.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(spend.at(-1).task, 'enhance');
    assert.equal(spend.at(-1).delta, 20);
  } finally { await app.close(); fake.close(); }
});
