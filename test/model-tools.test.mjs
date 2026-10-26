import test from 'node:test';
import assert from 'node:assert/strict';
import { alignPatch, distance, proportionsCheck, mirrorAttributes, seamCount, depthRange, addBookmark, setHero, removeBookmark, lerpCamera, bookmarkKey, heat, boneWeights, weightFlags } from '../public/lib/model-tools.js';

test('alignment: floor and centre patches', () => {
  assert.deepEqual(alignPatch({ ground: true, center: false }), { snap: true, y: 0 });
  assert.deepEqual(alignPatch({ ground: false, center: true }), { center: true, x: 0 });
});

test('measure: point to point distance', () => {
  assert.equal(distance([0, 0, 0], [3, 4, 0]), 5);
});

test('proportions check per workspace', () => {
  assert.ok(proportionsCheck({ x: 1.9, y: 1.4, z: 4.6 }, 'car').ok);
  assert.ok(!proportionsCheck({ x: 0.2, y: 0.1, z: 0.4 }, 'car').ok);
  assert.ok(proportionsCheck({ x: 1, y: 2.2, z: 0.6 }, 'warframe').ok);
  const w = proportionsCheck({ x: 1, y: 12, z: 0.6 }, 'warframe');
  assert.ok(!w.ok && /Height/.test(w.warnings[0]));
  assert.ok(!w.warnings.join('').includes('\u2014'));
});

test('mirror: keeps one half, mirrors it, welds the seam, flips winding', () => {
  // one triangle on +x touching the seam (x within tol), one on -x
  const pos = new Float32Array([0.0004, 0, 0, 1, 0, 0, 1, 1, 0, -1, 0, 0, -1, 1, 0, -0.5, 0, 1]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const out = mirrorAttributes({ position: { array: pos, itemSize: 3 }, normal: { array: nrm, itemSize: 3 } }, 'x', { tol: 1e-3 });
  const p = out.position.array;
  assert.equal(p.length, 18); // 1 kept + 1 mirrored
  assert.equal(p[0], 0); // welded onto the seam
  assert.equal(Math.abs(p[9]), 0);
  assert.deepEqual([...p.slice(12, 15)], [-1, 1, 0]); // v2 first (winding flipped)
  assert.equal(seamCount(out, 'x'), 2);
  const other = mirrorAttributes({ position: { array: pos, itemSize: 3 } }, 'x', { keep: -1 });
  assert.ok(other.position.array[0] < 0);
});

test('depth range keeps near plane close to the model, not at the camera', () => {
  const r = depthRange(10, 2.5);
  assert.ok(r.near > 0.1 && r.near <= 0.5);
  assert.ok(r.far > 10 + 2.5);
  assert.equal(depthRange(0.3, 1).near, 0.01);
});

test('camera bookmarks: add, replace, max 9, hero, remove, smooth jump, path key', () => {
  let l = [];
  for (let i = 0; i < 11; i++) l = addBookmark(l, { name: `S${i}`, position: [0, 1, 5], target: [0, 1, 0], lens: 50 });
  assert.equal(l.length, 9);
  l = addBookmark(l, { name: 'S5', position: [1, 1, 1], target: [0, 0, 0], lens: 35 });
  assert.equal(l.filter((b) => b.name === 'S5').length, 1);
  l = setHero(l, 'S5');
  assert.equal(l.filter((b) => b.hero).length, 1);
  assert.equal(removeBookmark(l, 'S5').length, 8);
  const a = { position: [0, 0, 0], target: [0, 0, 0], lens: 20 }, b = { position: [10, 0, 0], target: [0, 0, 0], lens: 60 };
  assert.deepEqual(lerpCamera(a, b, 0).position, [0, 0, 0]);
  assert.deepEqual(lerpCamera(a, b, 1).position, [10, 0, 0]);
  assert.equal(lerpCamera(a, b, 0.5).lens, 40);
  const k = bookmarkKey({ position: [0, 2, 5], target: [0, 2, 0], lens: 50 }, 1.5);
  assert.equal(k.orbit, 0);
  assert.equal(k.distance, 5);
});

test('rigging preview: heat colours, bone weights, flags', () => {
  assert.deepEqual(heat(0), [0, 0, 1]);
  assert.deepEqual(heat(1), [1, 0, 0]);
  const idx = [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  const wt = [0.5, 0.5, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  assert.deepEqual([...boneWeights(idx, wt, 1)], [0.5, 1, 0]);
  const f = weightFlags([0.5, 0.5, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.25, 0.25, 0.25], { extraInfluences: [0, 0, 0, 2] });
  assert.deepEqual(f.none, [2]);
  assert.deepEqual(f.unnormalized, [1]);
  assert.deepEqual(f.over4, [3]);
});
