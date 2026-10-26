import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { LIGHTING_PRESETS, applyLightingPreset, lightingPresetOf, lookNeedsRebuild, HDRIS, checkHdri, mergeLook, STUDIO_PRESETS } from '../public/lib/look.js';

test('lighting presets: garage, desert dusk and white cyclorama ship, every file is bundled and noted', () => {
  for (const id of ['garage', 'desertDusk', 'whiteCyc']) assert.ok(LIGHTING_PRESETS[id]);
  const notices = readFileSync(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  for (const p of Object.values(LIGHTING_PRESETS)) {
    assert.ok(checkHdri(p.hdri.file).ok, p.hdri.file);
    const name = p.hdri.file.slice(8);
    const f = new URL(`../public/img/hdri/${name}.hdr`, import.meta.url);
    assert.ok(existsSync(f) && statSync(f).size < 3e6, name);
    assert.match(notices, new RegExp(`polyhaven.com/a/${name}`));
    assert.ok(HDRIS[name]);
  }
});
test('lighting presets: applying one changes only the HDRI and tone, and is recognised', () => {
  const look = STUDIO_PRESETS['Warframe Studio'];
  const out = applyLightingPreset(look, 'desertDusk');
  assert.equal(out.hdri.file, 'builtin:goegap_road');
  assert.equal(out.tone, 'aces');
  assert.deepEqual(out.lights, mergeLook(look).lights);
  assert.deepEqual(out.background, mergeLook(look).background);
  assert.equal(lightingPresetOf(out), 'desertDusk');
  assert.equal(lightingPresetOf(look), 'studioSoft'); // Warframe Studio uses the same environment
  assert.equal(lightingPresetOf({ hdri: { file: 'builtin:studio_small_03', rotation: 45 } }), null);
  assert.deepEqual(applyLightingPreset(look, 'nope'), mergeLook(look));
});
test('lighting presets: swapping between environments does not rebuild the scene', () => {
  const g = applyLightingPreset({}, 'garage'), d = applyLightingPreset({}, 'desertDusk'), s = applyLightingPreset({}, 'studioSoft');
  assert.equal(lookNeedsRebuild(g, d), false);
  assert.equal(lookNeedsRebuild(g, s), true); // background on to off
  assert.equal(lookNeedsRebuild({}, g), true); // none to an HDRI
  assert.equal(lookNeedsRebuild(g, { ...g, hdri: { ...g.hdri, rotation: 10 } }), false);
});
