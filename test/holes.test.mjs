// Fill small holes: small rings of open edges are closed with triangles that face the same way as the part, tiny
// cracks are pulled shut, big openings and flat sheets are left alone, a GLB keeps every other attribute, and a new
// model is cleaned (or not, when the Setup switch is off) with one plain line about it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillHoles, fillNote, HOLE_EDGES } from '../public/lib/holes.js';
import { fillGlb } from '../glb-fill.mjs';
import { readGlb, accessor } from '../glb-trim.mjs';
import { presetConfig } from '../public/lib/engines.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { holeyMesh, holeyGlb, HOLEY } from './fixtures/holey-mesh.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

// A box of six faces, each with its own four corners (every edge a seam of copies). skip: face numbers left out.
function box({ skip = [], size = 1, at = [0, 0, 0], lift = 0 } = {}) {
  const pos = [], idx = [];
  const P = (x, y, z) => [at[0] + x * size, at[1] + y * size, at[2] + z * size];
  const faces = [
    [P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0)], [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)],
    [P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0)], [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)],
    [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)], [P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)],
  ];
  faces.forEach((q, f) => {
    if (skip.includes(f)) return;
    const o = pos.length / 3;
    q.forEach((p) => pos.push(p[0], p[1] + (f === 5 ? lift : 0), p[2])); // lift: the top face a hair off its walls
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { pos, idx };
}
const merge = (...parts) => {
  const pos = [], idx = [];
  for (const p of parts) { const o = pos.length / 3; pos.push(...p.pos); idx.push(...p.idx.map((i) => i + o)); }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
};
const normal = (p, a, b, c) => {
  const u = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]), v = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};
// A tube (no ends) of n sides, radius r, height h: its two rims are openings.
function tube(n, r = 1, h = 1) {
  const pos = [], idx = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pos.push(Math.cos(a) * r, 0, Math.sin(a) * r, Math.cos(a) * r, h, Math.sin(a) * r); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(i * 2, j * 2, j * 2 + 1, i * 2, j * 2 + 1, i * 2 + 1); }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}

test('fillHoles: a box with its top missing gets the top back, facing the same way as the rest', () => {
  const s = merge(box({ skip: [5], size: 0.2 }), box({ at: [5, 0, 0], size: 5 })); // small open box beside a big closed one
  const r = fillHoles(s.pos, s.idx);
  assert.deepEqual([r.holes, r.cracks, r.pos], [1, 0, null]);
  assert.equal(r.index.length, s.idx.length + 6, 'two new triangles');
  assert.deepEqual([...r.index.slice(0, s.idx.length)], [...s.idx], 'every old triangle stays, in order');
  const top = merge(box({ size: 0.2 }));
  const want = normal(top.pos, top.idx[30], top.idx[31], top.idx[32]);
  for (let i = s.idx.length; i < r.index.length; i += 3) {
    const n = normal(s.pos, r.index[i], r.index[i + 1], r.index[i + 2]);
    assert.ok(n[0] * want[0] + n[1] * want[1] + n[2] * want[2] > 0, 'the new top faces the way the old one did');
  }
  const again = fillHoles(s.pos, r.index);
  assert.deepEqual([again.holes, again.cracks], [0, 0], 'a filled box has nothing left to fill');
  const closed = merge(box());
  assert.deepEqual([...fillHoles(closed.pos, closed.idx).index], [...closed.idx]);
  const flat = Float32Array.from([...s.idx].flatMap((v) => [s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2]]));
  assert.equal(fillHoles(flat, null).holes, 1, 'triangles with no index work too');
});

test('fillHoles: big openings stay open (too many edges, or too wide), and so does the edge of a flat sheet', () => {
  const many = tube(HOLE_EDGES + 8, 0.05, 2); // thin: narrow enough, but too many edges
  assert.equal(fillHoles(many.pos, many.idx).holes, 0);
  const wide = tube(8); // few edges, but the rim is most of the part
  assert.equal(fillHoles(wide.pos, wide.idx).holes, 0);
  assert.equal(fillHoles(wide.pos, wide.idx, { maxSize: 2 }).holes, 2, 'with no width limit both rims are filled');
  // A small loose card beside a big box: its edge is a short ring, but filling it would only double the card.
  const card = { pos: [10, 0, 0, 10.1, 0, 0, 10.1, 0.1, 0, 10, 0.1, 0], idx: [0, 1, 2, 0, 2, 3] };
  const s = merge(box({ size: 5 }), card);
  assert.equal(fillHoles(s.pos, s.idx).holes, 0);
});

test('fillHoles: a top face a hair off its walls is a crack, pulled shut, not a hole', () => {
  const s = merge(box({ lift: 1e-4 }));
  const r = fillHoles(s.pos, s.idx);
  assert.deepEqual([r.holes, r.cracks], [0, 4], 'four corners meet again');
  assert.ok(r.pos, 'corners moved');
  for (let v = 20; v < 24; v++) assert.ok([0, 1].includes(r.pos[v * 3 + 1]), 'the top corners sit on the walls');
  assert.deepEqual(fillHoles(r.pos, r.index).cracks, 0);
  const far = merge(box({ lift: 0.05 }));
  assert.equal(fillHoles(far.pos, far.idx).cracks, 0, 'a real gap is not a crack');
});

test('fillHoles: the test ball has its three small holes and the seam crack closed, the cut-off bottom stays open', () => {
  const m = holeyMesh();
  const r = fillHoles(m.pos, m.idx);
  assert.deepEqual({ holes: r.holes, cracks: r.cracks }, HOLEY);
  assert.equal((r.index.length - m.idx.length) / 3, 2 + 2 + 6);
  for (let i = m.idx.length; i < r.index.length; i += 3) {
    const [a] = r.index.slice(i, i + 1), n = normal(r.pos, r.index[i], r.index[i + 1], r.index[i + 2]);
    assert.ok(n[0] * r.pos[a * 3] + n[1] * r.pos[a * 3 + 1] + n[2] * r.pos[a * 3 + 2] > 0, 'new triangles face out');
  }
});

test('fillGlb: new triangles and corners go in the file, normals, UVs and material stay; nothing to fill leaves the file as it was', () => {
  const glb = holeyGlb();
  const r = fillGlb(glb);
  assert.deepEqual({ holes: r.holes, cracks: r.cracks }, HOLEY);
  const { json, bin } = readGlb(r.glb);
  const prim = json.meshes[0].primitives[0];
  assert.deepEqual([prim.attributes.NORMAL, prim.attributes.TEXCOORD_0, prim.material], [2, 3, 0], 'same normals, UVs and material');
  assert.equal(json.accessors[prim.indices].count, holeyMesh().idx.length + 30);
  assert.equal(json.accessors[prim.attributes.POSITION].count, json.accessors[2].count);
  assert.ok(json.accessors[prim.attributes.POSITION].min.every(Number.isFinite));
  assert.equal(json.buffers[0].byteLength, bin.length);
  assert.equal(r.glb.readUInt32LE(8), r.glb.length, 'the GLB header length is right');
  const pos = accessor(json, bin, prim.attributes.POSITION, Float32Array, 3);
  assert.deepEqual(fillHoles(pos, accessor(json, bin, prim.indices, Uint16Array, 1)).holes, 0, 'read back: nothing left to fill');
  const again = fillGlb(r.glb);
  assert.deepEqual([again.holes, again.cracks], [0, 0]);
  assert.ok(again.glb.equals(r.glb), 'a clean file comes back byte for byte');
});

test('fillNote: one plain line', () => {
  assert.equal(fillNote({ holes: 12, cracks: 0 }), 'Filled 12 small holes');
  assert.equal(fillNote({ holes: 1, cracks: 1 }), 'Filled 1 small hole and closed 1 tiny crack');
  assert.equal(fillNote({ holes: 0, cracks: 3 }), 'Closed 3 tiny cracks');
  assert.equal(fillNote({ holes: 0, cracks: 0 }), 'No small holes to fill');
});

test('server: a new model is filled and says so; with the Setup switch off it is left as it came', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'flatform-holes-'));
  const weights = path.join(dataDir, 'local-engine', 'weights');
  await mkdir(weights, { recursive: true });
  await writeFile(path.join(weights, 'complete.json'), '{}');
  const glb = holeyGlb();
  let n = 0;
  const eng = { submit: async () => ({ task_id: `t${++n}` }), status: async () => ({ status: 'success', progress: 100 }), result: async () => glb, stop() {} };
  const srv = await startServer({
    dataDir, keyStore: createKeyStore({ env: {} }), localEngine: eng, cudaCheck: async () => ({ name: 'RTX 3090', memoryGB: 24 }),
    apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', updateUrl: 'http://127.0.0.1:9/latest', updateDelayMs: 3600000,
    weightsFetch: async () => { throw new Error('no downloads in tests'); },
  });
  const base = `http://127.0.0.1:${srv.port}`;
  const make = async () => {
    const form = new FormData();
    form.append('name', 'Ball');
    form.append('setup', JSON.stringify(presetConfig('local', 'balanced')));
    form.append('front', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'front.png');
    const m = await (await fetch(`${base}/api/models`, { method: 'POST', body: form })).json();
    let got;
    for (let i = 0; i < 5; i++) { got = await (await fetch(`${base}/api/models/${m.id}`)).json(); if (got.status === 'ready') break; }
    assert.equal(got.status, 'ready', JSON.stringify(got));
    return { got, file: await readFile(path.join(dataDir, 'models', m.id, got.glb)) };
  };
  const set = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).fillHoles, true, 'on by default');
    const on = await make();
    assert.equal(on.got.fillNote, 'Filled 3 small holes and closed 28 tiny cracks');
    assert.ok(!on.file.equals(glb), 'the saved model is the filled one');
    assert.equal(fillGlb(on.file).holes, 0);
    assert.equal((await set({ fillHoles: 'yes' })).status, 400);
    assert.equal((await (await set({ fillHoles: false })).json()).fillHoles, false);
    const off = await make();
    assert.equal(off.got.fillNote, undefined);
    assert.ok(off.file.equals(glb), 'switched off: the model is saved as it came');
  } finally {
    await srv.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Fill small holes UI: a Clean up switch in Setup with a tip, the note on the Generate screen, plain words', () => {
  const setup = read('public/views/setup.js');
  assert.match(setup, /<h2 class="k">Clean up<\/h2>/);
  assert.match(setup, /role="switch"[^`]*title="\$\{FILL_TIP\}"[^`]*data-setting="fillHoles"/);
  assert.match(setup, /const FILL_TIP = '[^']+'/);
  assert.match(setup, /send\('\/api\/settings', 'POST', \{ fillHoles: t\.checked \}\)/);
  assert.match(read('public/views/generate.js'), /m\.fillNote/);
  assert.match(read('server.mjs'), /fillHoles: true/);
  for (const f of ['public/lib/holes.js', 'glb-fill.mjs', 'render/blender_fillholes.py', 'test/fixtures/holey-mesh.mjs']) {
    assert.doesNotMatch(read(f), new RegExp(String.fromCharCode(0x2014)), `${f}: no em dashes`);
  }
});
