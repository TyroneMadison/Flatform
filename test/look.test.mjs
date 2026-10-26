// Scene look: HDRI import rules, lighting / AO / background presets, reflection toggles, studio presets, Blender JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LOOK, mergeLook, checkHdri, HDRIS, hdriUrl, LIGHT_PRESETS, lightsFromPreset, effectsFor, STUDIO_PRESETS, cleanStudioPresets, blenderLook, TONE_MAPPINGS,
} from '../public/lib/look.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('HDRI import accepts .hdr and .exr, rejects others; built-ins resolve to files that ship', async () => {
  assert.equal(checkHdri('custom-1.hdr').ok, true);
  assert.equal(checkHdri('Studio.EXR').ok, true);
  assert.equal(checkHdri('photo.jpg').ok, false);
  assert.equal(checkHdri('scene.png').ok, false);
  assert.equal(checkHdri('builtin:nope').ok, false);
  assert.equal(checkHdri(null).ok, true);
  assert.equal(Object.keys(HDRIS).length, 4);
  for (const name of Object.keys(HDRIS)) {
    assert.equal(checkHdri(`builtin:${name}`).ok, true);
    assert.equal(hdriUrl(`builtin:${name}`), `/img/hdri/${name}.hdr`);
    assert.ok(existsSync(path.join(ROOT, 'public', 'img', 'hdri', `${name}.hdr`)), name);
  }
  // The packaged build takes public/**/*, so the HDRIs ship; the notices credit them.
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('public/**/*'));
  const notices = await readFile(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /Poly Haven/);
  assert.match(notices, /CC0/);
  for (const name of Object.keys(HDRIS)) assert.ok(notices.includes(name), `${name} credited`);
  assert.equal(hdriUrl('my file.exr'), '/backdrops/my%20file.exr');
});

test('Car Default equals today\'s behaviour; presets round trip through mergeLook', () => {
  assert.deepEqual(STUDIO_PRESETS['Car Default'], DEFAULT_LOOK);
  assert.deepEqual(mergeLook(undefined), DEFAULT_LOOK);
  assert.deepEqual(mergeLook({}), DEFAULT_LOOK);
  const d = DEFAULT_LOOK;
  assert.deepEqual([d.background.kind, d.hdri.file, d.lights.preset, d.ao.on, d.tone, d.exposure, d.bloom.on, d.ssr.on, d.pathTraced, d.aa], ['scene', null, 'match', false, 'neutral', 1, false, false, false, 'msaa']);
  for (const [name, look] of Object.entries(STUDIO_PRESETS)) assert.deepEqual(mergeLook(JSON.parse(JSON.stringify(look))), look, name);
  assert.equal(STUDIO_PRESETS['Warframe Studio'].hdri.file, 'builtin:studio_small_03');
  assert.equal(STUDIO_PRESETS['Showcase Dark'].ssr.on, true);
  // Old or odd values fall back safely.
  const odd = mergeLook({ tone: 'kodak', quality: 'ultra', hdri: { file: 'x.jpg' }, lights: { key: { intensity: 2 } } });
  assert.deepEqual([odd.tone, odd.quality, odd.hdri.file, odd.lights.key.intensity, odd.lights.key.on], ['neutral', 'medium', null, 2, true]);
});

test('lighting presets: key/fill/rim each with on, intensity, colour, azimuth, elevation; Match photo keeps the scene rig', () => {
  assert.deepEqual(Object.values(LIGHT_PRESETS).map((p) => p.label), ['Match photo', 'Studio 3-point', 'Soft box', 'Dramatic rim', 'Outdoor dusk']);
  for (const id of ['studio', 'softbox', 'rim', 'dusk']) {
    const l = lightsFromPreset(id);
    for (const k of ['key', 'fill', 'rim']) assert.deepEqual(Object.keys(l[k]), ['on', 'intensity', 'color', 'azimuth', 'elevation'], `${id}.${k}`);
    assert.equal(typeof l.shadows, 'boolean');
  }
  assert.equal(lightsFromPreset('match').preset, 'match');
  assert.equal(lightsFromPreset('rim').fill.on, false);
  assert.throws(() => lightsFromPreset('disco'), /Unknown lighting preset/);
});

test('reflection settings: SSR and path-traced toggles save in studio presets; Blender uses Cycles for path-traced finals', () => {
  const look = mergeLook({ ssr: { on: true, strength: 0.8 }, pathTraced: true, quality: 'pathTraced' });
  const presets = cleanStudioPresets({ 'My Glossy': look });
  assert.deepEqual([presets['My Glossy'].ssr, presets['My Glossy'].pathTraced], [{ on: true, strength: 0.8 }, true]);
  assert.equal(cleanStudioPresets({ '': look }), null);
  assert.equal(cleanStudioPresets([look]), null);
  assert.equal(cleanStudioPresets({ x: 'not a look' }), null);
  assert.equal(blenderLook(look).engine, 'CYCLES');
  assert.equal(blenderLook(mergeLook({ finalEngine: 'eevee' })).engine, 'BLENDER_EEVEE_NEXT');
  assert.equal(blenderLook(mergeLook({ finalEngine: 'eevee', pathTraced: true })).engine, 'CYCLES'); // a path-traced final is always Cycles
  assert.equal(blenderLook(DEFAULT_LOOK).engine, 'CYCLES');
  assert.equal(blenderLook(DEFAULT_LOOK).lights, null); // Match photo: the script keeps its own rig
  assert.equal(blenderLook(DEFAULT_LOOK).hdri, null);
  const b = blenderLook(STUDIO_PRESETS['Warframe Studio'], { hdriPath: '/x/studio_small_03.hdr' });
  assert.deepEqual([b.tone, b.hdri.path, b.hdri.rotation, b.lights.preset], ['AgX', '/x/studio_small_03.hdr', 30, 'studio']);
  assert.deepEqual(Object.keys(TONE_MAPPINGS), ['neutral', 'aces', 'agx']);
});

test('quality gates the realtime effects: Low turns them off, High allows GTAO and SSR, Path traced needs the toggle', () => {
  const on = { ao: { on: true }, bloom: { on: true }, ssr: { on: true }, aa: 'smaa' };
  const low = effectsFor(mergeLook({ ...on, quality: 'low' }));
  assert.deepEqual([low.composer, low.ao, low.bloom, low.ssr, low.aa], [false, false, false, false, 'msaa']);
  const med = effectsFor(mergeLook({ ...on, quality: 'medium' }));
  assert.deepEqual([med.composer, med.ao, med.aoPass, med.bloom, med.ssr, med.aa], [true, true, 'ssao', true, false, 'smaa']);
  const high = effectsFor(mergeLook({ ...on, quality: 'high' }));
  assert.deepEqual([high.ao, high.aoPass, high.ssr, high.pathTraced], [true, 'gtao', true, false]);
  assert.equal(effectsFor(mergeLook({ quality: 'pathTraced', pathTraced: true })).pathTraced, true);
  assert.equal(effectsFor(mergeLook({ quality: 'high', pathTraced: true })).pathTraced, false);
  assert.equal(effectsFor(DEFAULT_LOOK).composer, false); // today's renderer, no composer
});
