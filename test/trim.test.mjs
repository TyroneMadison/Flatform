// Remove part: loose pieces found by welded vertices, one piece taken out of a GLB as a new version, Ctrl+Z going
// back to the version before, and the one-sentence warning for a big piece.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPieces, removePiece, pieceIndex, pieceCard, isBig, weldTol } from '../public/lib/pieces.js';
import { trimGlb, readGlb, writeGlb } from '../glb-trim.mjs';
import { createHistory } from '../public/lib/history.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

// A unit box (12 triangles) made of two halves whose seam vertices are copies (as a UV seam leaves them), plus a
// small loose tetrahedron (4 triangles) floating beside it.
function shape() {
  const pos = [], idx = [];
  const quad = (a, b, c, d) => { const o = pos.length / 3; pos.push(...a, ...b, ...c, ...d); idx.push(o, o + 1, o + 2, o, o + 2, o + 3); };
  const P = (x, y, z) => [x, y, z];
  // six faces, every face its own four vertices (so every edge is a seam of copies)
  quad(P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0)); quad(P(0, 0, 1), P(0, 1, 1), P(1, 1, 1), P(1, 0, 1));
  quad(P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1)); quad(P(1, 0, 0), P(1, 0, 1), P(1, 1, 1), P(1, 1, 0));
  quad(P(0, 0, 0), P(0, 0, 1), P(1, 0, 1), P(1, 0, 0)); quad(P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1));
  const o = pos.length / 3;
  pos.push(3, 0, 0, 3.2, 0, 0, 3, 0.2, 0, 3, 0, 0.2);
  idx.push(o, o + 2, o + 1, o, o + 1, o + 3, o, o + 3, o + 2, o + 1, o + 2, o + 3);
  return { pos: Float32Array.from(pos), idx: Uint16Array.from(idx) };
}
function glbOf({ pos, idx }) {
  const normal = new Float32Array(pos.length).fill(0.5); // a second attribute that must come through untouched
  const bin = Buffer.concat([Buffer.from(idx.buffer), Buffer.alloc((4 - (idx.byteLength % 4)) % 4), Buffer.from(pos.buffer), Buffer.from(normal.buffer)]);
  const io = 0, po = idx.byteLength + ((4 - (idx.byteLength % 4)) % 4), no = po + pos.byteLength;
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Body', mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: io, byteLength: idx.byteLength }, { buffer: 0, byteOffset: po, byteLength: pos.byteLength }, { buffer: 0, byteOffset: no, byteLength: normal.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5123, count: idx.length, type: 'SCALAR' }, { bufferView: 1, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [0, 0, 0], max: [3.2, 1, 1] }, { bufferView: 2, componentType: 5126, count: pos.length / 3, type: 'VEC3' }],
  };
  return writeGlb(json, bin);
}

test('pieces: copies of a vertex weld into one piece; a loose bit is its own piece', () => {
  const { pos, idx } = shape();
  const r = findPieces(pos, idx);
  assert.equal(r.triangles, 16);
  assert.deepEqual([...r.sizes], [12, 4], 'the box (six faces of copied vertices) is one piece, the tetrahedron another');
  assert.equal(r.vertexPiece[0], r.vertexPiece[23], 'first and last box vertex: same piece');
  assert.notEqual(r.vertexPiece[0], r.vertexPiece[24]);
  assert.ok(weldTol(pos) > 0 && weldTol(pos) < 1e-3);
  // Triangles with no index (every 3 vertices) work too.
  const flat = Float32Array.from([...idx].flatMap((v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]));
  assert.deepEqual([...findPieces(flat, null).sizes], [12, 4]);
});

test('pieces: removing one keeps every other triangle in order; the highlight is just that piece', () => {
  const { pos, idx } = shape();
  const r = findPieces(pos, idx);
  const loose = r.vertexPiece[24];
  const kept = removePiece(idx, pos.length / 3, r.vertexPiece, loose);
  assert.deepEqual([...kept], [...idx.slice(0, 36)]);
  assert.deepEqual([...pieceIndex(idx, pos.length / 3, r.vertexPiece, loose)], [...idx.slice(36)]);
  const flat = removePiece(null, 12, Int32Array.from([0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1]), 1);
  assert.deepEqual([...flat], [0, 1, 2, 6, 7, 8]);
});

test('pieces: a big piece (over a fifth of the model) gets one warning sentence', () => {
  assert.equal(isBig(20, 100), false);
  assert.equal(isBig(21, 100), true);
  const small = pieceCard(1234, 100000);
  assert.equal(small.title, 'Remove this piece? (1,234 triangles)');
  assert.equal(small.warn, '');
  const big = pieceCard(400000, 1800000);
  assert.match(big.warn, /^This piece is big, 22% of your model, so make sure it is not a part you want\.$/);
  assert.equal(big.warn.split(/[.!?](\s|$)/).filter((s) => s.trim()).length, 1, 'one sentence');
});

test('trimGlb: only the piece goes; vertices, the other attribute and the rest of the file stay', () => {
  const s = shape(), glb = glbOf(s);
  const r = trimGlb(glb, { piece: 0, vertex: 25, expect: 4 });
  assert.deepEqual([r.removed, r.left], [4, 12]);
  const { json, bin } = readGlb(r.glb);
  const prim = json.meshes[0].primitives[0], a = json.accessors[prim.indices], bv = json.bufferViews[a.bufferView];
  assert.equal(a.count, 36);
  assert.equal(a.componentType, 5123);
  const out = new Uint16Array(bin.buffer.slice(bin.byteOffset + bv.byteOffset, bin.byteOffset + bv.byteOffset + bv.byteLength));
  assert.deepEqual([...out], [...s.idx.slice(0, 36)]);
  assert.deepEqual(prim.attributes, { POSITION: 1, NORMAL: 2 }, 'same vertex data');
  assert.equal(bv.byteOffset % 4, 0);
  assert.equal(json.buffers[0].byteLength, bin.length);
  assert.equal(r.glb.readUInt32LE(8), r.glb.length, 'the GLB header length is right');
  assert.deepEqual([...findPieces(s.pos, out).sizes].filter(Boolean), [12], 'what is left is one piece');
  assert.throws(() => trimGlb(glb, { piece: 0, vertex: 25, expect: 5 }), /changed since the piece was picked/);
  assert.throws(() => trimGlb(trimGlb(glb, { piece: 0, vertex: 25 }).glb, { piece: 0, vertex: 0 }), /whole part/);
  assert.throws(() => trimGlb(glb, { piece: 3, vertex: 0 }), /not in the model file/);
  assert.throws(() => trimGlb(glb, { piece: 0, vertex: 999 }), /not on the model/);
});

test('remove-piece API: a new version from the active one, not switched to; switching back is the undo', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-trim-')); temps.push(data);
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => { const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    const glb = glbOf(shape());
    const form = new FormData();
    form.append('glb', new Blob([glb]), 'model.glb');
    form.append('name', 'Stray'); form.append('kind', 'humanoid');
    const m = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    const r = await json(`/api/models/${m.id}/remove-piece`, 'POST', { piece: 0, vertex: 26, expect: 4 });
    assert.equal(r.status, 201);
    assert.deepEqual([r.body.version, r.body.removed, r.body.model.activeVersion], [2, 4, 1], 'the page switches, as one undo step');
    const v2 = r.body.model.versions.find((v) => v.n === 2);
    assert.deepEqual([v2.provider, v2.from, v2.glb, v2.note], ['trim', 1, 'trimmed-v2.glb', 'Removed a piece (4 triangles) from version 1']);
    assert.deepEqual(await readFile(path.join(data, 'models', m.id, 'model.glb')), glb, 'the version before is never touched');
    const on = await json(`/api/models/${m.id}`, 'PATCH', { activeVersion: 2 });
    assert.equal(on.body.glb, 'trimmed-v2.glb');
    assert.equal(readGlb(await readFile(path.join(data, 'models', m.id, 'trimmed-v2.glb'))).json.accessors.at(-1).count, 36);
    // Ctrl+Z: the scene history holds { scene, version } before the swap, and undo hands back version 1.
    const hist = createHistory();
    hist.push({ scene: {}, version: 1 }, 'Remove piece');
    assert.equal(hist.undoLabel, 'Remove piece');
    const back = hist.undo({ scene: {}, version: 2 });
    assert.equal(back.version, 1);
    assert.equal((await json(`/api/models/${m.id}`, 'PATCH', { activeVersion: back.version })).body.glb, 'model.glb');
    assert.equal(hist.redo({ scene: {}, version: 1 }).version, 2, 'and Ctrl+Y brings the removal back');
    // A second removal on the trimmed version leaves nothing loose: the box is the whole part.
    await json(`/api/models/${m.id}`, 'PATCH', { activeVersion: 2 });
    const again = await json(`/api/models/${m.id}/remove-piece`, 'POST', { piece: 0, vertex: 0, expect: 12 });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /whole part/);
    assert.equal((await json(`/api/models/${m.id}/remove-piece`, 'POST', { piece: 0 })).status, 400);
  } finally { await app.close(); }
});

test('Remove part UI: Tools and Pose (before joints), a worker, a card with Remove and Keep, Esc, one undo step', () => {
  const ui = read('public/views/compose-trim.js');
  assert.match(read('public/views/compose-tools.js'), /\$\{trimButton\(\)\}/);
  assert.match(read('public/views/compose-motion.js'), /function rigPanel\(\)[\s\S]*\$\{trimButton\(\)\}/, 'in the Pose card while there are no joints');
  assert.match(ui, /new Worker\(new URL\('\.\.\/lib\/pieces-worker\.js', import\.meta\.url\), \{ type: 'module' \}\)/);
  assert.match(ui, /const cache = new WeakMap\(\)/, 'pieces are found once per mesh');
  assert.match(ui, /data-trim="remove"[^>]*title="[^"]+"/);
  assert.match(ui, /data-trim="keep"[^>]*title="[^"]+"/);
  assert.match(ui, /e\.key === 'Escape'/);
  assert.match(ui, /ctx\.swapVersion\(r\.version, 'Remove piece', \{ from \}\)/);
  const compose = read('public/views/compose.js');
  assert.match(compose, /if \(onTrimCanvasClick\(/);
  assert.match(compose, /stopTrim\(\);/);
  assert.match(read('public/views/history.js'), /Model versions/);
  assert.match(read('public/styles/stage.css'), /\.trimcard \.btn \{ min-height: 44px; \}/);
  for (const f of ['public/views/compose-trim.js', 'public/lib/pieces.js', 'glb-trim.mjs']) assert.doesNotMatch(read(f), new RegExp(String.fromCharCode(0x2014)),`${f}: no em dashes`);
});
