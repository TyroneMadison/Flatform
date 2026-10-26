// TennoGen rules: tint mask packing, texture set names and sizes, colour inheritance, material presets with SSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  SLOTS, TINT_SLOTS, PARTS, MAPS, textureName, textureSize, textureSet, checkTextureName, resolveColors, colorSources, setColor, defaultPaint,
  upsertPiece, MATERIAL_PRESETS, SSS_PRESETS, materialFromPreset, serializeMaterial, deserializeMaterial, blenderMaterial, DEFAULT_MATERIAL,
  packTintMask, packEmissiveMask, grow, exportWarnings, meanLuminance, paletteGrid, recentColor, luminance,
} from '../public/lib/tenno.js';

test('TennoGen slot names and tint channels', () => {
  assert.deepEqual(SLOTS.map((s) => s.label), ['Primary', 'Secondary', 'Tertiary', 'Accents', 'Glow', 'Energy']);
  assert.deepEqual(SLOTS.slice(0, 4).map((s) => s.tint), ['Tint0', 'Tint1', 'Tint2', 'Tint3']);
  assert.deepEqual(TINT_SLOTS, ['primary', 'secondary', 'tertiary', 'accents']);
});

test('texture set: <Part>_<d|e|n|r|s|t>.png, 2048 for d/n/r/s, 1024 for t/e, no custom names', () => {
  assert.deepEqual(PARTS, ['Body', 'Helmet', 'Weapon', 'Syandana', 'Liset']);
  assert.deepEqual(textureSet('Body').map((t) => [t.name, t.width, t.height]), [
    ['Body_d.png', 2048, 2048], ['Body_e.png', 1024, 1024], ['Body_n.png', 2048, 2048], ['Body_r.png', 2048, 2048], ['Body_s.png', 2048, 2048], ['Body_t.png', 1024, 1024],
  ]);
  assert.deepEqual(textureSize('Helmet', 'd', { altHelmet: true }), { width: 2048, height: 1024 });
  assert.deepEqual(textureSize('Helmet', 't', { altHelmet: true }), { width: 2048, height: 1024 });
  assert.throws(() => textureName('Chest', 'd'), /Unknown part/);
  assert.throws(() => textureName('Body', 'x'), /Unknown map/);
  assert.equal(checkTextureName('Syandana_t.png').ok, true);
  assert.equal(checkTextureName('body_d.png').ok, false);
  assert.equal(checkTextureName('Body_d.jpg').ok, false);
  assert.equal(checkTextureName('Body_diffuse.png').ok, false);
  assert.equal(checkTextureName('MyCoolSkin_d.png').ok, false);
  assert.equal(Object.keys(MAPS).join(''), 'denrst');
});

test('colour inheritance Global > Section > Piece and reset to inherited', () => {
  let paint = upsertPiece(defaultPaint(), 'Chest#0', { name: 'Chest', section: 'chest', slot: 'primary' });
  paint = setColor(paint, 'global', 'primary', '#ff0000');
  assert.equal(resolveColors(paint, paint.pieces['Chest#0']).primary, '#ff0000');
  assert.equal(colorSources(paint, paint.pieces['Chest#0']).primary, 'global');
  paint = setColor(paint, 'chest', 'primary', '#00ff00'); // the section overrides the global
  assert.equal(resolveColors(paint, paint.pieces['Chest#0']).primary, '#00ff00');
  assert.equal(colorSources(paint, paint.pieces['Chest#0']).primary, 'section');
  paint = setColor(paint, 'Chest#0', 'primary', '#0000ff'); // the piece overrides the section
  assert.equal(resolveColors(paint, paint.pieces['Chest#0']).primary, '#0000ff');
  assert.equal(colorSources(paint, paint.pieces['Chest#0']).primary, 'piece');
  paint = setColor(paint, 'Chest#0', 'primary', null); // reset to inherited
  assert.equal(resolveColors(paint, paint.pieces['Chest#0']).primary, '#00ff00');
  paint = setColor(paint, 'chest', 'primary', null);
  assert.equal(resolveColors(paint, paint.pieces['Chest#0']).primary, '#ff0000');
  // Other keys inherit untouched; unknown keys are refused.
  assert.equal(resolveColors(paint, paint.pieces['Chest#0']).energy, '#59c3ff');
  assert.throws(() => setColor(paint, 'global', 'glitter', '#fff'), /Unknown colour/);
  // A piece in no section only sees the global level.
  const loose = upsertPiece(paint, 'Loose#1', { section: null });
  assert.equal(colorSources(loose, loose.pieces['Loose#1']).primary, 'global');
});

test('material presets serialise and deserialise; Skin, Cloth and Infested Flesh carry SSS into the Blender JSON', () => {
  assert.deepEqual(Object.values(MATERIAL_PRESETS).map((p) => p.label), ['Metal', 'Brushed Metal', 'Painted Metal', 'Cloth', 'Leather', 'Rubber', 'Glass', 'Skin', 'Infested Flesh', 'Plastic', 'Glow']);
  assert.deepEqual(SSS_PRESETS, ['cloth', 'skin', 'infested']);
  for (const id of Object.keys(MATERIAL_PRESETS)) {
    const m = materialFromPreset(id);
    const back = deserializeMaterial(JSON.parse(JSON.stringify(serializeMaterial(m))));
    assert.deepEqual(back, m, id);
  }
  const skin = materialFromPreset('skin');
  assert.ok(skin.sss > 0 && skin.sssRadius > 0 && /^#/.test(skin.sssColor));
  const b = blenderMaterial(skin, { primary: '#aabbcc' });
  assert.equal(b.subsurface_weight, skin.sss);
  assert.equal(b.subsurface_color, skin.sssColor);
  assert.equal(b.subsurface_radius.length, 3);
  assert.equal(b.base_color, '#aabbcc'); // no own colour: the resolved Primary
  assert.equal(blenderMaterial(materialFromPreset('metal'), {}).subsurface_weight, 0);
  assert.equal(serializeMaterial(DEFAULT_MATERIAL).preset, undefined);
  assert.deepEqual(serializeMaterial({ ...DEFAULT_MATERIAL }), {});
  assert.equal(deserializeMaterial(null).roughness, 0.6);
  assert.equal(deserializeMaterial({ preset: 'nonsense', roughness: 0.1 }).preset, undefined);
  assert.throws(() => materialFromPreset('velvet'), /Unknown material preset/);
});

test('tint mask packing: R/G/B/A per slot, lower layers expanded under higher ones, untinted stays black', () => {
  const w = 8, h = 1;
  const mask = (from, to) => { const m = new Uint8Array(w * h); for (let i = from; i < to; i++) m[i] = 1; return m; };
  // Primary on pixels 0-3, Secondary on 4-5, pixels 6-7 untinted.
  const { data, used } = packTintMask(w, h, [{ slot: 'primary', mask: mask(0, 4) }, { slot: 'secondary', mask: mask(4, 6) }], { expand: 1 });
  const px = (i) => [...data.slice(i * 4, i * 4 + 4)];
  assert.deepEqual(px(0), [255, 0, 0, 0]);
  assert.deepEqual(px(3), [255, 0, 0, 0]);
  assert.deepEqual(px(4), [255, 255, 0, 0]); // the primary layer is expanded one pixel under the secondary's edge
  assert.deepEqual(px(5), [0, 255, 0, 0]);
  assert.deepEqual(px(6), [0, 0, 0, 0]); // untinted base diffuse: black in every channel, never grown into
  assert.deepEqual(px(7), [0, 0, 0, 0]);
  assert.deepEqual(used, { primary: true, secondary: true, tertiary: false, accents: false });
  // Accents go in the alpha channel and sit on top of everything.
  const top = packTintMask(w, h, [{ slot: 'accents', mask: mask(0, 8) }, { slot: 'tertiary', mask: mask(2, 4) }]);
  assert.deepEqual([...top.data.slice(28, 32)], [0, 0, 0, 255]); // accents only
  assert.deepEqual([...top.data.slice(8, 12)], [0, 0, 255, 255]); // tertiary under accents
  assert.deepEqual([...top.data.slice(0, 4)], [0, 0, 255, 255]); // tertiary grown 2 px under the accents layer
  assert.equal(grow(mask(3, 4), w, h, 2).join(''), '01111100');
  assert.equal(grow(mask(3, 4), w, h, 2, mask(4, 8)).join(''), '00011100'); // only into the layer above
  // The emissive mask is a grayscale with opaque alpha.
  const e = packEmissiveMask(w, h, [{ slot: 'emissive', mask: mask(0, 2) }]);
  assert.deepEqual([...e.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...e.slice(8, 12)], [0, 0, 0, 255]);
});

test('export warnings: unused channels and albedo luminance out of range', () => {
  const w = exportWarnings({ used: { primary: true, secondary: false, tertiary: true, accents: false }, albedo: { luminance: 40, metal: false } });
  assert.equal(w.length, 3);
  assert.match(w[0], /Tint1 \(secondary\) is unused/);
  assert.match(w[2], /40\/255 is outside the non-metal/);
  assert.deepEqual(exportWarnings({ used: { primary: true, secondary: true, tertiary: true, accents: true }, albedo: { luminance: 130, metal: false } }), []);
  assert.deepEqual(exportWarnings({ albedo: { luminance: 186, metal: true } }), []);
  assert.equal(exportWarnings({ albedo: { luminance: 128, metal: true } }).length, 1);
  const rgba = new Uint8ClampedArray([128, 128, 128, 255, 0, 0, 0, 0]); // the transparent pixel is ignored
  assert.equal(Math.round(meanLuminance(rgba)), 128);
  assert.equal(Math.round(luminance(255, 255, 255)), 255);
});

test('palette grid and recent swatches', () => {
  const grid = paletteGrid();
  assert.equal(grid.length, 5);
  assert.ok(grid.every((row) => row.length === 8 && row.every((c) => /^#[0-9a-f]{6}$/.test(c))));
  let p = recentColor(defaultPaint(), '#FF0000');
  p = recentColor(p, '#00ff00');
  p = recentColor(p, '#ff0000');
  assert.deepEqual(p.recent, ['#ff0000', '#00ff00']);
});

test('the Blender script reads materials with subsurface, HDRI, lights and tone mapping from the scene JSON', async () => {
  const py = await readFile(new URL('../render/blender_turntable.py', import.meta.url), 'utf8');
  for (const s of ['Subsurface Weight', 'Subsurface Radius', 'subsurface_color', 'def apply_materials', 'def apply_look', 'hdri', 'BLENDER_EEVEE_NEXT']) assert.ok(py.includes(s), s);
});
