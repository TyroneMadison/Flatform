// Texture library: CC0 sync with a mocked network, offline reuse, licenses per item, per-workspace imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createTextureLibrary, unzip } from '../textures.mjs';
import { LIBRARY, normalizeTextureRef, textureUrl, sourceFiles } from '../public/lib/textures.js';
import { serializeMaterial, deserializeMaterial } from '../public/lib/tenno.js';

const JPG = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag), Buffer.from([0xff, 0xd9])]);
function zip(files, deflate = true) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, raw] of Object.entries(files)) {
    const data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, n, data); centrals.push(c, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const ok = (body) => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), json: async () => JSON.parse(body.toString()) });
function mockNet() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'ambientcg.com') {
      const id = u.searchParams.get('file').replace('_1K-JPG.zip', '');
      return ok(zip({ [`${id}_1K-JPG_Color.jpg`]: JPG('c'), [`${id}_1K-JPG_NormalGL.jpg`]: JPG('n'), [`${id}_1K-JPG_Roughness.jpg`]: JPG('r'), [`${id}.png`]: Buffer.from('x') }));
    }
    if (u.host === 'api.polyhaven.com') {
      const map = (k) => ({ '1k': { jpg: { url: `https://dl.polyhaven.org/${u.pathname}/${k}.jpg` } } });
      return ok(Buffer.from(JSON.stringify({ Diffuse: map('d'), nor_gl: map('n'), Rough: map('r') })));
    }
    if (u.host === 'dl.polyhaven.org') return ok(JPG(u.pathname));
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls };
}

test('library is CC0 only, from ambientCG and Poly Haven, with a license and page per item', () => {
  assert.ok(LIBRARY.length >= 8);
  for (const t of LIBRARY) {
    assert.equal(t.license, 'CC0 1.0');
    assert.match(t.licenseUrl, /creativecommons\.org\/publicdomain\/zero/);
    assert.ok(['ambientCG', 'Poly Haven'].includes(t.source));
    assert.match(t.page, /^https:\/\/(ambientcg\.com|polyhaven\.com)\//);
    assert.doesNotMatch(JSON.stringify(t), /digital ?extremes|warframe\.com/i);
    assert.ok(sourceFiles(t).zip || sourceFiles(t).api);
  }
});

test('unzip reads stored and deflated entries', () => {
  for (const d of [true, false]) assert.equal(unzip(zip({ 'a.txt': Buffer.from('hello') }, d))['a.txt']().toString(), 'hello');
});

test('sync caches every item once, then works offline; licenses list sources', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tex-'));
  try {
    const net = mockNet();
    const lib = createTextureLibrary({ dir, fetch: net.fetch });
    await lib.sync();
    const { items, sync } = await lib.list('car');
    assert.deepEqual(sync.errors, {});
    assert.ok(items.filter((t) => t.kind !== 'custom').every((t) => t.cached));
    const f = await lib.file('acg-Metal009', 'normal', 'car');
    assert.equal((await readFile(f.file)).subarray(4, 5).toString(), 'n');
    const lic = await lib.licenses();
    assert.equal(lic.length, LIBRARY.length);
    assert.ok(lic.every((m) => m.license === 'CC0 1.0' && m.page && m.fetchedAt));
    // Offline: a new library on the same folder never touches the network.
    const offline = createTextureLibrary({ dir, fetch: async () => { throw new Error('offline'); } });
    await offline.sync();
    assert.ok((await offline.list('car')).items.every((t) => t.cached));
    assert.ok(await offline.file('ph-metal_plate', 'color', 'car'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a failed sync reports per item and leaves nothing half-cached', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tex-'));
  try {
    const lib = createTextureLibrary({ dir, fetch: async () => { throw new Error('no network'); } });
    await lib.sync(['acg-Metal009']);
    const { items, sync } = await lib.list('car');
    assert.match(sync.errors['acg-Metal009'], /Could not reach ambientCG/);
    assert.equal(items.find((t) => t.id === 'acg-Metal009').cached, false);
    await assert.rejects(lib.file('acg-Metal009', 'color'), /Not synced/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('imports are per workspace and only images are accepted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tex-'));
  try {
    const lib = createTextureLibrary({ dir, fetch: async () => { throw new Error('no network'); } });
    const t = await lib.importTexture('car', 'My Weave.jpg', JPG('w'));
    assert.equal(t.id, 'my-my-weave');
    assert.equal((await lib.importTexture('car', 'My Weave.jpg', JPG('w'))).id, 'my-my-weave-2');
    assert.ok((await lib.list('car')).items.some((x) => x.id === t.id));
    assert.ok(!(await lib.list('warframe')).items.some((x) => x.id === t.id));
    await assert.rejects(lib.file(t.id, 'color', 'warframe'), /this workspace/);
    await assert.rejects(lib.importTexture('car', 'x.txt', Buffer.from('nope')), /PNG or JPEG/);
    await lib.remove('car', t.id);
    assert.ok(!(await lib.list('car')).items.some((x) => x.id === t.id));
    await assert.rejects(lib.remove('car', 'acg-Metal009'), /Only your own/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('texture refs clamp and round-trip through saved materials', () => {
  assert.deepEqual(normalizeTextureRef({ id: 'acg-Metal009', scale: 999, rotation: -500 }), { id: 'acg-Metal009', scale: 64, rotation: -180 });
  assert.equal(normalizeTextureRef({ id: '../etc' }), null);
  assert.equal(textureUrl('acg-Metal009', 'color', 'car'), '/api/textures/acg-Metal009/color?workspace=car');
  const m = deserializeMaterial(serializeMaterial({ color: '#ffffff', texture: { id: 'ph-metal_plate', scale: 2, rotation: 45 } }));
  assert.deepEqual(m.texture, { id: 'ph-metal_plate', scale: 2, rotation: 45 });
});

test('server routes: sync, serve, import, workspace isolation', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'tex-srv-'));
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const net = mockNet();
  const srv = await startServer({
    dataDir, keyStore: createKeyStore({ env: {} }), textureFetch: net.fetch, cudaCheck: async () => null,
    apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', updateUrl: 'http://127.0.0.1:9/latest', updateDelayMs: 3600000,
  });
  try {
    const base = `http://127.0.0.1:${srv.port}/api/textures`;
    assert.equal((await fetch(`${base}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 202);
    for (let i = 0; i < 200 && (await (await fetch(base)).json()).sync.running; i++) await new Promise((r) => setTimeout(r, 10));
    const img = await fetch(`${base}/acg-Fabric004/color`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    const up = await fetch(`${base}/import?workspace=warframe&name=Void%20cloth.png`, { method: 'POST', body: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]) });
    assert.equal(up.status, 201);
    const { id } = await up.json();
    assert.equal((await fetch(`${base}/${id}/color?workspace=warframe`)).status, 200);
    assert.equal((await fetch(`${base}/${id}/color?workspace=car`)).status, 404);
    assert.equal((await (await fetch(`${base}/licenses`)).json()).length, LIBRARY.length);
  } finally { await srv.close(); await rm(dataDir, { recursive: true, force: true }); }
});
