// Car material inference: region → preset table, highlight stripping, projection voting, low-confidence flags,
// user overrides across re-runs, provider fallback, inferred materials reflect the scene environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REGIONS, REGION_IDS, presetFor, stripHighlights, voteRegions, groupFaces, labelClusters, labelClusterHeuristic, kmeans, clusterStats, mergeInference, overrideRegion, LOW_CONFIDENCE } from '../public/lib/infer.js';
import { inferRegions } from '../inference.mjs';

test('region to preset mapping table', () => {
  assert.deepEqual(REGION_IDS, ['paint', 'chrome', 'glass', 'rubber', 'carbon', 'caliper', 'lights', 'grille']);
  const paint = presetFor('paint', '#a01020');
  assert.deepEqual([paint.color, paint.clearcoat, paint.flake.size > 0, paint.region], ['#a01020', 1, true, 'paint']);
  assert.deepEqual([presetFor('chrome').metalness, presetFor('chrome').roughness], [1, 0.05]);
  const glass = presetFor('glass');
  assert.deepEqual([glass.transmission, glass.ior, glass.thickness > 0, typeof glass.color], [1, 1.5, true, 'string']);
  assert.deepEqual([presetFor('rubber').roughness, presetFor('rubber').metalness], [0.9, 0]);
  assert.deepEqual([presetFor('carbon').weave, presetFor('carbon').clearcoat], [true, 1]);
  assert.equal(presetFor('caliper', '#ff2200').color, '#ff2200'); // painted metal with the sampled colour
  assert.ok(presetFor('lights').emissiveIntensity > 0 && presetFor('lights').transmission > 0); // glass over emissive
  assert.ok(presetFor('grille').roughness > 0.4 && presetFor('grille').metalness === 0);
  assert.equal(presetFor('chrome', '#ff0000').color, '#f2f2f2'); // chrome never takes a sampled colour
  assert.throws(() => presetFor('fur'), /Unknown region/);
  for (const r of Object.values(REGIONS)) assert.ok(r.label);
});

test('highlight stripping: a stable base colour from a fixture with specular hotspots and shadows', () => {
  // A red car panel: 70 % mid-tone red, 15 % white hotspots, 15 % near-black shadow.
  const px = [];
  const seed = (n, rgb, jitter) => { for (let i = 0; i < n; i++) px.push(...rgb.map((v) => Math.min(255, Math.max(0, v + ((i * 37) % 11 - 5) * jitter))), 255); };
  seed(70, [170, 30, 40], 2);
  seed(15, [250, 248, 246], 1);
  seed(15, [6, 4, 5], 1);
  const { color, samples } = stripHighlights(new Uint8ClampedArray(px));
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  assert.ok(Math.abs(r - 170) <= 6 && Math.abs(g - 30) <= 6 && Math.abs(b - 40) <= 6, color);
  assert.ok(samples > 20);
  // Twice the hotspots: the same answer (robust), and a mask limits the sample to the panel.
  seed(30, [255, 255, 255], 0);
  const again = stripHighlights(new Uint8ClampedArray(px));
  assert.equal(again.color, color);
  const mask = new Uint8Array(px.length / 4).fill(0);
  for (let i = 70; i < 85; i++) mask[i] = 1; // only the hotspots → nothing usable → neutral grey
  assert.deepEqual(stripHighlights(new Uint8ClampedArray(px), mask), { color: '#808080', samples: 0 });
  assert.equal(stripHighlights(new Uint8ClampedArray([200, 100, 50]), null, 3).color, '#c86432');
});

test('projection voting assigns fixture pieces and flags low confidence', () => {
  const samples = [
    ...Array.from({ length: 20 }, () => ({ piece: 'body', label: 'paint' })), { piece: 'body', label: 'glass' },
    ...Array.from({ length: 6 }, () => ({ piece: 'wheelFL', label: 'rubber' })), { piece: 'wheelFL', label: 'chrome' }, { piece: 'wheelFL', label: 'chrome' },
    { piece: 'mirror', label: 'paint' }, { piece: 'mirror', label: 'chrome' }, // 50/50 and only 2 votes
    { piece: 'sky', label: null }, // off the car: ignored
  ];
  const v = voteRegions(samples);
  assert.deepEqual([v.body.region, v.body.flagged, Math.round(v.body.confidence * 100)], ['paint', false, 95]);
  assert.deepEqual([v.wheelFL.region, v.wheelFL.flagged], ['rubber', false]);
  assert.deepEqual([v.mirror.region, v.mirror.flagged, v.mirror.confidence], ['paint', true, 0.5]);
  assert.equal(v.sky, undefined);
  assert.ok(0.5 <= LOW_CONFIDENCE && LOW_CONFIDENCE < 0.75);
  const weighted = voteRegions([{ piece: 'p', label: 'glass', weight: 5 }, { piece: 'p', label: 'paint' }, { piece: 'p', label: 'paint' }, { piece: 'p', label: 'paint' }]);
  assert.equal(weighted.p.region, 'glass');
});

test('faces grouped by label become material groups, biggest first, unlabelled kept apart', () => {
  const index = [0, 1, 2, 2, 3, 0, 4, 5, 6, 6, 7, 4, 8, 9, 10];
  const { index: out, groups } = groupFaces(index, ['glass', 'paint', 'paint', null, 'paint']);
  assert.deepEqual(groups, [{ start: 0, count: 9, label: 'paint' }, { start: 9, count: 3, label: 'glass' }, { start: 12, count: 3, label: null }]);
  assert.deepEqual([...out], [2, 3, 0, 4, 5, 6, 8, 9, 10, 0, 1, 2, 6, 7, 4]);
  assert.equal(out.constructor, Uint16Array);
  assert.equal(groupFaces(new Uint32Array(65538 * 3), new Array(65538).fill('paint')).index.constructor, Uint32Array);
});

test('cluster labelling: the heuristic fallback, and vision labels when a model answered', () => {
  assert.equal(labelClusterHeuristic({ r: 20, g: 20, b: 22, y: 0.85, x: 0.3, share: 0.1 }).label, 'rubber');
  assert.equal(labelClusterHeuristic({ r: 230, g: 230, b: 232, y: 0.5, x: 0.5, share: 0.03 }).label, 'chrome');
  assert.equal(labelClusterHeuristic({ r: 40, g: 45, b: 55, y: 0.3, x: 0.5, share: 0.1 }).label, 'glass');
  assert.equal(labelClusterHeuristic({ r: 200, g: 40, b: 40, y: 0.5, x: 0.5, share: 0.5 }, { largest: true }).label, 'paint');
  // Pixels: a big red cluster and a small dark cluster at the bottom.
  const w = 10, h = 10;
  const px = new Uint8ClampedArray(w * h * 4);
  const mask = new Uint8Array(w * h).fill(1);
  for (let i = 0; i < w * h; i++) { const dark = Math.floor(i / w) >= 8; px.set(dark ? [20, 20, 20, 255] : [180, 30, 30, 255], i * 4); }
  const { labels, centres } = kmeans(px, mask, 2, 4);
  const stats = clusterStats(labels, centres, w, h);
  const named = labelClusters(stats);
  assert.deepEqual(named.map((n) => n.label).sort(), ['paint', 'rubber']);
  assert.ok(named.every((n) => n.source === 'heuristic'));
  const vision = labelClusters(stats, [{ label: 'carbon', confidence: 0.9 }, { label: 'nonsense' }]);
  assert.deepEqual([vision[0].label, vision[0].source, vision[1].source], ['carbon', 'vision', 'heuristic']);
});

test('user overrides persist and survive a re-run of the inference', () => {
  let pieces = { body: { name: 'Body' }, trim: { name: 'Trim' } };
  pieces = mergeInference(pieces, { body: { region: 'paint', confidence: 0.9, flagged: false }, trim: { region: 'chrome', confidence: 0.4, flagged: true } });
  assert.deepEqual(pieces.trim.region, { label: 'chrome', confidence: 0.4, flagged: true, user: false });
  pieces = overrideRegion(pieces, 'trim', 'carbon');
  assert.deepEqual(pieces.trim.region, { label: 'carbon', confidence: 1, flagged: false, user: true });
  pieces = mergeInference(pieces, { body: { region: 'glass', confidence: 0.6, flagged: false }, trim: { region: 'chrome', confidence: 0.9, flagged: false } });
  assert.equal(pieces.trim.region.label, 'carbon'); // the override survived the re-run
  assert.equal(pieces.body.region.label, 'glass'); // an untouched piece follows the new result
  assert.equal(pieces.body.name, 'Body');
});

test('provider fallback: no model and no key → the heuristic labels, never a network call', async () => {
  const stats = [{ r: 180, g: 30, b: 30, y: 0.5, x: 0.5, share: 0.7, n: 70 }, { r: 15, g: 15, b: 15, y: 0.9, x: 0.3, share: 0.3, n: 30 }];
  let fetched = 0;
  const r = await inferRegions({ stats, image: null, key: undefined, fetch: async () => { fetched++; throw new Error('must not be called'); } });
  assert.equal(fetched, 0);
  assert.deepEqual([r.source, r.labels.map((l) => l.label)], ['heuristic', ['paint', 'rubber']]);
  // A key but an unreachable model: still the heuristic, with the reason.
  const bad = await inferRegions({ stats, image: 'data:image/png;base64,AA==', key: 'sk-test', fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual([bad.source, bad.labels[0].label, /offline/.test(bad.note)], ['heuristic', 'paint', true]);
  // A model that answers: its labels win, with the confidence it gave.
  const ok = await inferRegions({ stats, image: 'data:image/png;base64,AA==', key: 'sk-test', fetch: async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '[{"index":0,"label":"carbon","confidence":0.85},{"index":1,"label":"rubber","confidence":0.95}]' }] }), { status: 200 }) });
  assert.deepEqual([ok.source, ok.labels.map((l) => [l.label, l.confidence])], ['vision', [['carbon', 0.85], ['rubber', 0.95]]]);
});

test('inferred materials reflect the scene environment: studio.js never turns envMap off for inferred pieces', async () => {
  const js = await readFile(new URL('../public/lib/paint.js', import.meta.url), 'utf8');
  assert.match(js, /envMapIntensity/); // the paint, chrome and glass read scene.environment through envMapIntensity 1
  assert.ok(!/envMap\s*[:=]\s*null/.test(js), 'no piece material detaches from the scene environment');
});
