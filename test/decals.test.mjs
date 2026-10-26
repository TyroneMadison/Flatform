// Decals: saved data is clamped and safe, uploads are PNG or script-free SVG, served with a sandbox policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeDecal, normalizeDecals, decalKind, decalMaterialParams, finishOf, FINISH_VALUES, MAX_DECALS } from '../public/lib/decals.js';

const FILE = `${'a'.repeat(40)}.png`;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]);

test('decals clamp, normalise the surface normal and drop bad files', () => {
  const d = normalizeDecal({ id: 'd1', file: FILE, normal: [0, 0, 2], size: 99, rotation: 400, gloss: 2, offsetX: -5 });
  assert.deepEqual([d.normal, d.size, d.rotation, d.gloss, d.offsetX, d.visible], [[0, 0, 1], 5, 180, 1, -1, true]);
  assert.equal(normalizeDecal({ file: '../../etc/passwd' }), null);
  assert.equal(normalizeDecal({ file: 'x.png' }), null);
  assert.equal(normalizeDecals(Array.from({ length: 40 }, () => ({ file: FILE }))).length, MAX_DECALS);
  assert.deepEqual(normalizeDecals('nope'), []);
});

test('finishes map to material settings and back', () => {
  for (const [k, v] of Object.entries(FINISH_VALUES)) assert.equal(finishOf(normalizeDecal({ file: FILE, ...v })), k);
  const p = decalMaterialParams(normalizeDecal({ file: FILE, ...FINISH_VALUES.mirror }));
  assert.deepEqual([p.roughness, p.metalness, p.clearcoat, p.transparent, p.depthWrite], [0, 1, 1, true, false]);
});

test('only PNG or script-free SVG uploads are accepted', () => {
  assert.equal(decalKind(PNG), 'png');
  assert.equal(decalKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')), 'svg');
  assert.equal(decalKind(Buffer.from('<?xml version="1.0"?><svg><rect/></svg>')), 'svg');
  assert.equal(decalKind(Buffer.from('<svg><script>alert(1)</script></svg>')), null);
  assert.equal(decalKind(Buffer.from('<svg><rect onload="x()"/></svg>')), null);
  assert.equal(decalKind(Buffer.from('<svg><a href="javascript:x"/></svg>')), null);
  assert.equal(decalKind(Buffer.from('GIF89a')), null);
});

test('server stores decals once by content and serves them sandboxed', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'decal-'));
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const srv = await startServer({
    dataDir, keyStore: createKeyStore({ env: {} }), cudaCheck: async () => null, textureFetch: async () => { throw new Error('offline'); },
    apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', updateUrl: 'http://127.0.0.1:9/latest', updateDelayMs: 3600000,
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    const a = await fetch(`${base}/api/decals`, { method: 'POST', body: PNG });
    assert.equal(a.status, 201);
    const { file } = await a.json();
    assert.match(file, /^[a-f0-9]{40}\.png$/);
    assert.equal((await (await fetch(`${base}/api/decals`, { method: 'POST', body: PNG })).json()).file, file);
    const got = await fetch(`${base}/decals/${file}`);
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await fetch(`${base}/api/decals`, { method: 'POST', body: '<svg><script>x</script></svg>' })).status, 415);
    assert.equal((await fetch(`${base}/decals/..%2Fsettings.json`)).status, 404);
  } finally { await srv.close(); await rm(dataDir, { recursive: true, force: true }); }
});
