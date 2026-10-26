import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, samplePath, pathFromBookmarks, spreadStops, normalizeSky, skyAt } from '../public/lib/camera-path.js';

const A = { position: [0, 1, 5], target: [0, 1, 0], lens: 35, at: 0 };
const B = { position: [5, 1, 0], target: [0, 1, 0], lens: 50, at: 1 };
const C = { position: [0, 3, -5], target: [0, 0, 0], lens: 85, at: 0.5 };

test('path: cleans, sorts and needs two stops to be on', () => {
  const p = normalizePath({ on: true, stops: [B, { position: [1] }, A] });
  assert.equal(p.stops.length, 2);
  assert.equal(p.stops[0].at, 0);
  assert.equal(p.on, true);
  assert.equal(normalizePath({ on: true, stops: [A] }).on, false);
  assert.equal(normalizePath({ easing: 'nope' }).easing, 'smooth');
});
test('path: hits every stop exactly and holds at the ends', () => {
  for (const easing of ['linear', 'smooth', 'curve']) {
    const p = { easing, stops: [A, C, B] };
    assert.deepEqual(samplePath(p, 0).position, A.position);
    assert.deepEqual(samplePath(p, 0.5).position.map((v) => Math.round(v * 1e6) / 1e6), C.position);
    assert.deepEqual(samplePath(p, 1).position, B.position);
  }
});
test('path: linear is halfway at the middle, smooth eases in', () => {
  const lin = samplePath({ easing: 'linear', stops: [A, B] }, 0.25);
  const sm = samplePath({ easing: 'smooth', stops: [A, B] }, 0.25);
  assert.equal(lin.position[0], 1.25);
  assert.ok(sm.position[0] < lin.position[0]);
  assert.equal(samplePath({ easing: 'linear', stops: [A, B] }, 0.5).lens, 42.5);
});
test('path: built from camera spots, spread evenly', () => {
  const p = pathFromBookmarks([A, C, B].map((x) => ({ ...x, at: undefined })));
  assert.deepEqual(p.stops.map((s) => s.at), [0, 0.5, 1]);
  assert.deepEqual(spreadStops([A]).map((s) => s.at), [0]);
});
test('sky: spins over the clip and switches HDRIs with a fade', () => {
  const sky = { on: true, spin: 90, fade: 0.1, playlist: [{ file: 'builtin:studio_small_03', at: 0 }, { file: 'builtin:studio_small_08', at: 0.5 }] };
  assert.equal(skyAt(sky, 0).file, 'builtin:studio_small_03');
  assert.equal(skyAt(sky, 0.6).file, 'builtin:studio_small_08');
  assert.equal(skyAt(sky, 1).rotation, 90);
  assert.equal(skyAt(sky, 0.5).dim, 0);
  assert.equal(skyAt(sky, 0.2).dim, 1);
  assert.equal(skyAt({ ...sky, on: false }, 0.6).file, null);
  assert.equal(normalizeSky({ spin: 9999 }).spin, 720);
});

test('server: presets save, list and delete per kind', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { startServer } = await import('../server.mjs');
  const { createKeyStore } = await import('../keys.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-presets-'));
  const app = await startServer({ dataDir: path.join(dir, 'data'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const h = { 'Content-Type': 'application/json', Origin: base };
  try {
    let r = await fetch(`${base}/api/presets/camera-paths`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Sweep', data: { stops: [A, B] } }) });
    assert.equal(r.status, 200);
    r = await (await fetch(`${base}/api/presets/camera-paths`)).json();
    assert.equal(r[0].name, 'Sweep');
    r = await (await fetch(`${base}/api/presets/camera-paths`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'Sweep', remove: true }) })).json();
    assert.equal(r.length, 0);
    r = await fetch(`${base}/api/presets/nope`);
    assert.notEqual(r.status, 200);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
