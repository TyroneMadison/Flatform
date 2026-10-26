// Share links once sharing is set up: Flatform uploads to the share Worker (share-worker/worker.js, run here in
// memory with a fake R2 bucket, so nothing is deployed), the page shows the picture, expiry and turning off reach it,
// a wrong password fails cleanly, and the setup API keeps the address and password out of settings.json.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import worker from '../share-worker/worker.js';
import { createShares, cleanShareUrl } from '../share.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));
const tmp = async () => { const d = await mkdtemp(path.join(tmpdir(), 'flatform-sharetest-')); temps.push(d); return d; };

function fakeWorker(token = 'a-long-share-token-123') {
  const store = new Map();
  const BUCKET = {
    async put(k, body) { store.set(k, Buffer.from(await new Response(body).arrayBuffer())); },
    async get(k) { const b = store.get(k); return b ? { body: b, json: async () => JSON.parse(b) } : null; },
    async delete(k) { store.delete(k); },
  };
  const fetch = (url, init) => worker.fetch(new Request(url, { ...init, duplex: 'half' }), { BUCKET, SHARE_TOKEN: token });
  return { store, fetch };
}

test('share page address: https only (http for this computer), no trailing slash', () => {
  assert.equal(cleanShareUrl(' https://s.example.workers.dev/ '), 'https://s.example.workers.dev');
  assert.equal(cleanShareUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.throws(() => cleanShareUrl('http://evil.example'), /https/);
  assert.throws(() => cleanShareUrl('not a url'), /not a web address/);
});

test('set up: a link uploads its picture, the page shows it, expiry and turning off reach the Worker', async () => {
  const w = fakeWorker();
  let t = Date.parse('2026-10-26T00:00:00Z');
  const sh = createShares({ file: path.join(await tmp(), 'shares.json'), remote: () => ({ url: 'https://share.test', token: 'a-long-share-token-123' }),
    files: async () => ({ poster: Buffer.from('PICTURE') }), fetch: w.fetch, now: () => t });
  assert.equal(sh.ready(), true);
  const s = await sh.create({ modelId: 'm', title: 'Red <Audi>', poster: 'poster-studio.webp', expiresInDays: 7 });
  assert.equal(s.mock, false);
  assert.equal(s.url, `https://share.test/${s.id}`);
  assert.equal(String(w.store.get(`${s.id}/poster.jpg`)), 'PICTURE');
  const page = await w.fetch(`https://share.test/${s.id}`);
  const html = await page.text();
  assert.match(html, /<img src="\/[0-9A-Za-z]+\/poster\.jpg" alt="Red &lt;Audi&gt;">/);
  assert.doesNotMatch(html, /<video/);
  assert.equal((await w.fetch(`https://share.test/${s.id}/poster.jpg`)).headers.get('content-type'), 'image/webp');

  await sh.setExpiry(s.id, 1);
  t += 2 * 864e5;
  assert.equal(JSON.parse(w.store.get(`${s.id}/meta.json`)).expiresAt, new Date(Date.parse('2026-10-26T00:00:00Z') + 864e5).toISOString());
  assert.equal((await sh.list())[0].expired, true);
  assert.equal(await sh.remove(s.id), true);
  assert.equal(w.store.size, 0, 'everything is gone from the bucket');
});

test('a wrong password or no share page: no link, a plain message, nothing left behind', async () => {
  const w = fakeWorker('the-real-token-0000000');
  const file = path.join(await tmp(), 'shares.json');
  const wrong = createShares({ file, remote: () => ({ url: 'https://share.test', token: 'not-the-token-000000' }), files: async () => ({ poster: Buffer.from('x') }), fetch: w.fetch });
  await assert.rejects(wrong.create({ modelId: 'm', poster: 'p.webp' }), /did not accept the share password/);
  assert.deepEqual(await wrong.list(), []);
  const gone = createShares({ file, remote: () => ({ url: 'https://share.test', token: 'x'.repeat(20) }), fetch: async () => { throw new Error('fetch failed'); } });
  await assert.rejects(gone.create({ modelId: 'm', poster: 'p.webp' }), /the share page could not be reached/);
  assert.deepEqual(await gone.list(), []);
});

test('setup API: not set up until saved, checked, kept in the key store, and turned off again', async () => {
  const data = await tmp();
  const keyStore = createKeyStore({ env: {} });
  const app = await startServer({ dataDir: data, keyStore, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const j = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${app.port}/api/${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.deepEqual((await j('shares/setup')).body, { ready: false, url: null });
    assert.equal((await j('shares/setup', 'POST', { url: 'http://evil.example', token: 'x'.repeat(20) })).status, 400);
    assert.equal((await j('shares/setup', 'POST', { url: 'https://s.example.dev', token: 'short' })).status, 400);
    assert.deepEqual((await j('shares/setup', 'POST', { url: 'https://s.example.dev/', token: 'x'.repeat(20) })).body, { ready: true, url: 'https://s.example.dev' });
    assert.deepEqual(JSON.parse(keyStore.get('cloudflare')), { workerUrl: 'https://s.example.dev', adminToken: 'x'.repeat(20) });
    assert.doesNotMatch(await readFile(path.join(data, 'settings.json'), 'utf8').catch(() => ''), /x{20}/);
    assert.doesNotMatch(JSON.stringify((await j('settings')).body), /x{20}/);
    assert.deepEqual((await j('shares/setup', 'DELETE')).body, { ready: false, url: null });
  } finally { await app.close(); }
});
