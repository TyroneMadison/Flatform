// Prices, presets, option rules and request bodies for both providers. Pure functions, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, THREE_D_AI } from '../public/lib/pricing.js';
import { normalize, presetConfig, matchPreset, PRESETS, threeDAIRequest, tripoDirectBody, summary, engineList } from '../public/lib/engines.js';

const cost = (provider, engine, options = {}, mode = 'single') => estimate(normalize({ provider, engine, mode, options })).credits;
const ai = (engine, options, mode) => cost('3daistudio', engine, options, mode);
const tripo = (options) => cost('tripo', 'tripo-direct', options);

test('Tripo via 3D AI Studio: base 40 + documented surcharges', () => {
  assert.equal(ai('tripo-3.2'), 60); // docs: image with default settings = 60
  assert.equal(ai('tripo-3.2', { texture_quality: 'detailed', geometry_quality: 'detailed' }), 120); // docs worked example
  assert.equal(ai('tripo-3.1', { texture: 'none' }), 40);
  assert.equal(ai('tripo-3.0', { texture_quality: 'extreme' }), 100);
  assert.equal(ai('tripo-3.2', { texture_quality: 'fast' }), 60);
  assert.equal(ai('tripo-3.2', {}, 'views'), 60); // multiview base is also 40
  assert.equal(ai('tripo-3.2', { texture: 'none', smart_low_poly: true, generate_parts: true }), 40 + 20 + 40);
  assert.equal(ai('tripo-3.2', { quad: true }), 70);
});

test('Hunyuan 3D Pro: 60, +20 PBR, +20 multi-view', () => {
  assert.equal(ai('hunyuan-pro'), 60);
  assert.equal(ai('hunyuan-pro', { enable_pbr: true }), 80);
  assert.equal(ai('hunyuan-pro', { enable_pbr: true }, 'views'), 100);
  assert.equal(ai('hunyuan-pro', { enable_pbr: true, generate_type: 'Geometry' }), 60); // PBR isn't sent for geometry only
});

test('TRELLIS.2: the whole table, +2 thumbnail', () => {
  const table = { 512: [15, 25, 25, 30], 1024: [20, 30, 30, 40], 1536: [25, 40, 40, 55] };
  for (const [resolution, [geometry, t1, t2, t4]] of Object.entries(table)) {
    assert.equal(ai('trellis2', { resolution }), geometry, resolution);
    for (const [texture_size, price] of [[1024, t1], [2048, t2], [4096, t4]]) assert.equal(ai('trellis2', { resolution, textures: true, texture_size }), price);
  }
  assert.equal(ai('trellis2', { resolution: '1024', textures: true, texture_size: 2048, generate_thumbnail: true }), 32); // docs example
  assert.deepEqual(THREE_D_AI.trellis2.textured[1536], { 1024: 40, 2048: 40, 4096: 55 });
});

test('Hitem3D: 125 / 150 quality, 625 / 650 master; views and PBR are free', () => {
  assert.equal(ai('hitem3d', { texture: 'none' }), 125);
  assert.equal(ai('hitem3d', { texture: 'pbr' }), 150);
  assert.equal(ai('hitem3d', { texture: 'color' }, 'views'), 150);
  assert.equal(ai('hitem3d', { resolution: '2048master', texture: 'none' }), 625);
  assert.equal(ai('hitem3d', { resolution: '2048master' }), 650);
});

test('Tripo direct estimate', () => {
  assert.equal(tripo({ texture: 'none' }), 20);
  assert.equal(tripo({ texture: 'color' }), 30);
  assert.equal(tripo({ texture_quality: 'detailed' }), 40); // HD +10
  assert.equal(tripo({ texture_quality: 'extreme' }), 50); // 8K +20
  assert.equal(tripo({ geometry_quality: 'detailed', texture_quality: 'extreme' }), 70); // Ultra +20
  assert.equal(tripo({ quad: true }), 35);
  assert.equal(tripo({ smart_low_poly: true }), 40);
  assert.equal(tripo({ texture: 'none', generate_parts: true }), 40);
});

test('presets cost what the mockups say', () => {
  const credits = (provider) => PRESETS[provider].map((p) => estimate(presetConfig(provider, p.id)).credits);
  assert.deepEqual(credits('3daistudio'), [30, 60, 150]); // Draft, Balanced, Max quality
  assert.deepEqual(credits('tripo'), [30, 40, 70]); // Fast draft, Balanced, Max quality
  for (const provider of ['tripo', '3daistudio']) {
    for (const p of PRESETS[provider]) assert.equal(matchPreset(presetConfig(provider, p.id)), p.id);
  }
  const custom = normalize({ ...presetConfig('3daistudio', 'balanced'), options: { ...presetConfig('3daistudio', 'balanced').options, quad: true } });
  assert.equal(matchPreset(custom), 'custom');
});

test('options that do not apply are dropped, bad values repaired', () => {
  const t = normalize({ provider: '3daistudio', engine: 'trellis2', mode: 'views', options: { textures: false, texture_size: 4096, steps: 99 } });
  assert.equal(t.mode, 'single'); // TRELLIS.2 takes one photo
  assert.equal('texture_size' in t.options, false);
  assert.equal(t.options.steps, 50);
  const h = normalize({ provider: '3daistudio', engine: 'hitem3d', options: { shading: 0.34, face_limit: 9e9 } });
  assert.deepEqual([h.options.shading, h.options.face_limit], [0.3, 5000000]);
  const q = normalize({ provider: '3daistudio', engine: 'tripo-3.2', options: { quad: true, face_limit: 900000 } });
  assert.equal(q.options.face_limit, 150000); // quad caps faces
  const parts = normalize({ provider: '3daistudio', engine: 'tripo-3.2', options: { texture: 'pbr', generate_parts: true } });
  assert.equal(parts.options.generate_parts, false); // parts needs texture off
  assert.equal(normalize({ provider: '3daistudio', engine: 'tripo-3.1', options: { texture_quality: 'fast' } }).options.texture_quality, 'standard'); // 3.2 only
  assert.equal('lighting_removal' in normalize({ provider: '3daistudio', engine: 'tripo-3.1' }).options, false);
  assert.equal(normalize({ provider: 'tripo', engine: 'tripo-direct', options: { texture_model: '3.5', texture_quality: 'fast' } }).options.texture_quality, 'fast');
  assert.equal(normalize({ provider: '3daistudio', engine: 'hunyuan-pro', options: { model: '3.1', generate_type: 'LowPoly' } }).options.generate_type, 'Normal');
  assert.equal(normalize({ provider: 'tripo', engine: 'tripo-direct', options: { model: 'v9.9-20990101' } }).options.model, 'v9.9-20990101');
  assert.equal(normalize({ provider: 'tripo', engine: 'tripo-direct', options: { model: 'evil"<x>' } }).options.model, 'v3.1-20260211');
  assert.throws(() => normalize({ provider: 'tripo', engine: 'hitem3d' }));
  assert.throws(() => normalize({ provider: '3daistudio', engine: 'constructor' }));
  assert.equal(engineList('3daistudio').length, 6);
  assert.equal(summary(presetConfig('3daistudio', 'max'), 'quality'), 'Hitem3D 3.0 · 2048 quality · real materials');
  assert.equal(summary(presetConfig('tripo', 'balanced'), 'quality'), 'v3.1 · standard shape · real materials · HD');
});

test('3D AI Studio request bodies for every engine', () => {
  const img = { front: 'data:image/jpeg;base64,RlJPTlQ=', left: 'data:image/jpeg;base64,TEVGVA==', right: 'data:image/png;base64,UklHSFQ=' };
  const req = (engine, options, mode = 'single') => threeDAIRequest(normalize({ provider: '3daistudio', engine, mode, options }), mode === 'views' ? img : { front: img.front });

  const t = req('tripo-3.2', {});
  assert.equal(t.path, '/v1/3d-models/tripo/image-to-3d/3.2/');
  assert.deepEqual(t.body, { image: img.front, texture: true, pbr: true, texture_quality: 'standard', lighting_removal: true, texture_alignment: 'original_image', geometry_quality: 'standard', enable_image_autofix: false, export_uv: true, auto_size: false });
  const tv = req('tripo-3.1', { texture: 'none', generate_parts: true, compress: true }, 'views');
  assert.equal(tv.path, '/v1/3d-models/tripo/multiview-to-3d/3.1/');
  assert.deepEqual(tv.body.images, [{ image: img.front }, { image: img.left }, { image: img.right }]); // front, left, (back), right
  assert.deepEqual([tv.body.texture, tv.body.pbr, tv.body.generate_parts, tv.body.compress, 'enable_image_autofix' in tv.body], [false, false, true, 'geometry', false]);

  const h = req('hunyuan-pro', { enable_pbr: true }, 'views');
  assert.equal(h.path, '/v1/3d-models/tencent/generate/pro/');
  assert.deepEqual(h.body, {
    multi_view_images: [{ view_type: 'front', view_image: img.front }, { view_type: 'left', view_image: img.left }, { view_type: 'right', view_image: img.right }],
    model: '3.1', generate_type: 'Normal', enable_pbr: true, face_count: 500000,
  });
  assert.deepEqual(req('hunyuan-pro', { model: '3.0', generate_type: 'LowPoly', polygon_type: 'quadrilateral' }).body,
    { image: img.front, model: '3.0', generate_type: 'LowPoly', enable_pbr: false, polygon_type: 'quadrilateral', face_count: 500000 });

  const tr = req('trellis2', { textures: true, generate_thumbnail: true, seed: 7 });
  assert.equal(tr.path, '/v1/3d-models/trellis2/generate/');
  assert.deepEqual(tr.body, { image: img.front, resolution: '1024', steps: 12, textures: true, texture_size: 2048, decimation_target: 1000000, seed: 7, generate_thumbnail: true });

  const hi = req('hitem3d', { shading: 0.8 }, 'views');
  assert.equal(hi.path, '/v1/3d-models/hitem3d/multiview-to-3d/');
  assert.deepEqual(hi.body, { views: { front: { image: img.front }, left: { image: img.left }, right: { image: img.right } }, resolution: '2048quality', texture: true, pbr: true, shading: 0.8, face_limit: 2000000 });
  assert.equal(req('hitem3d', { texture: 'none' }).body.shading, undefined);
});

test('Tripo direct body sends only what differs from Tripo defaults', () => {
  assert.deepEqual(tripoDirectBody(presetConfig('tripo', 'balanced').options, 'file_1'), { input: 'file_1', model: 'v3.1-20260211', texture: true, pbr: true, texture_quality: 'detailed' });
  assert.deepEqual(tripoDirectBody(presetConfig('tripo', 'fast').options, 'file_2'),
    { input: 'file_2', model: 'v3.1-20260211', texture: true, pbr: false, texture_quality: 'fast', texture_version: 'v3.5-20260815', delight: true });
  assert.deepEqual(tripoDirectBody(normalize({ provider: 'tripo', engine: 'tripo-direct', options: { texture: 'none', generate_parts: true, face_limit: 10000, model_seed: 3 } }).options, 'f'),
    { input: 'f', model: 'v3.1-20260211', texture: false, pbr: false, face_limit: 10000, generate_parts: true, model_seed: 3 });
});
