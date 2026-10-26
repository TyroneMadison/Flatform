// Test Rig picture quality (public/lib/rig-quality.js): Fast / High, the post.js effects, subsurface on skin and
// cloth, the sky picture that lights a place, the frame-rate rule that keeps High smooth, and the photo banner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUALITY, DEFAULT_QUALITY, qualityOf, saveQuality, rigEffects, materialKind, SSS, lightingHdri, FALLBACK_HDRI, adaptScale, fpsOf, photoLabel, SLOW, MIN_SCALE, RETRY } from '../public/lib/rig-quality.js';
import { mergeLook, HDRIS } from '../public/lib/look.js';
import { ENVIRONMENTS } from '../public/lib/environments.js';
import { lookChange, GLOW } from '../public/lib/rig-look.js';
import { readFileSync } from 'node:fs';

test('two qualities, plain words and a tip each; High is the default and is remembered on this computer', () => {
  assert.deepEqual(Object.keys(QUALITY), ['fast', 'high']);
  for (const q of Object.values(QUALITY)) assert.ok(q.label && q.tip.length > 20);
  assert.equal(DEFAULT_QUALITY, 'high');
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(qualityOf(storage), 'high');
  saveQuality(storage, 'fast');
  assert.equal(qualityOf(storage), 'fast');
  saveQuality(storage, 'ultra'); // not a quality: ignored
  assert.equal(qualityOf(storage), 'fast');
  assert.equal(qualityOf({ getItem: () => { throw new Error('blocked'); } }), 'high');
  assert.equal(qualityOf(undefined), 'high');
});

test('High: corner shading (GTAO) and smooth edges; Fast: the plain renderer unless the look glows', () => {
  const plain = mergeLook({});
  assert.deepEqual(rigEffects(plain, 'high'), { composer: true, ao: true, aoPass: 'gtao', bloom: false, ssr: false, aa: 'smaa' });
  assert.deepEqual(rigEffects(plain, 'fast'), { composer: false, ao: false, aoPass: 'gtao', bloom: false, ssr: false, aa: 'msaa' });
  const glow = mergeLook(lookChange({}, 'glow', true).look);
  assert.deepEqual(rigEffects(glow, 'fast'), { composer: true, ao: false, aoPass: 'gtao', bloom: true, ssr: false, aa: 'fxaa' });
  assert.equal(rigEffects(glow, 'high').bloom, true);
  // the glow is the toned-down one (bloom only past white), not look.js's stronger default
  assert.equal(glow.bloom.strength, GLOW.strength);
  assert.equal(glow.bloom.threshold, GLOW.threshold);
  assert.equal(rigEffects(plain, 'nonsense').ao, true); // unknown: High
  assert.ok(QUALITY.high.shadowMap > QUALITY.fast.shadowMap && QUALITY.high.shadowRadius > QUALITY.fast.shadowRadius);
});

test('subsurface goes on skin and cloth, never on metal, glass or hard parts', () => {
  assert.equal(materialKind({ name: 'Skin' }), 'skin');
  assert.equal(materialKind({ name: 'Body_mat' }), 'skin');
  assert.equal(materialKind({ name: '' }, 'Face'), 'skin'); // the mesh name counts too
  assert.equal(materialKind({ name: 'Jacket' }), 'fabric');
  assert.equal(materialKind({ name: 'denim_jeans' }), 'fabric');
  assert.equal(materialKind({ name: 'Material_0' }), 'fabric'); // a plain material on a character: gentle
  assert.equal(materialKind({ name: '' }), 'fabric');
  assert.equal(materialKind({ name: 'Armor' }), null);
  assert.equal(materialKind({ name: 'Eyes' }), null);
  assert.equal(materialKind({ name: 'Visor_glass' }), null);
  assert.equal(materialKind({ name: 'Skin', metalness: 0.9 }), null);
  assert.equal(materialKind({ name: 'Shirt', transmission: 0.5 }), null);
  assert.equal(materialKind({ name: 'Backpack' }), null); // named, not skin or cloth: left alone
  assert.ok(SSS.skin.amount > SSS.fabric.amount);
});

test('the sky picture that lights a place: the scene\'s own, then the place\'s sky or reflection, then a studio', () => {
  const look = mergeLook({ hdri: { file: 'builtin:garage', rotation: 90, intensity: 1.3 } });
  assert.deepEqual(lightingHdri(look, ENVIRONMENTS['white-cyc-studio']), { name: 'garage', rotation: 90, intensity: 1.3 });
  assert.equal(lightingHdri(mergeLook({}), ENVIRONMENTS['night-city-rain']).name, 'shanghai_bund');
  assert.equal(lightingHdri(mergeLook({}), ENVIRONMENTS['white-cyc-studio']).name, 'white_studio_02');
  assert.equal(lightingHdri(mergeLook({}), ENVIRONMENTS.showroom).name, FALLBACK_HDRI);
  assert.equal(lightingHdri(mergeLook({}), undefined).name, FALLBACK_HDRI);
  for (const e of [...Object.values(ENVIRONMENTS), undefined]) {
    const { name } = lightingHdri(mergeLook({}), e);
    assert.ok(HDRIS[name], `${name} is a bundled sky picture`);
    readFileSync(new URL(`../public/img/hdri/${name}.hdr`, import.meta.url)); // and the file is there
  }
});

test('High stays smooth: shrinks after two slow seconds, grows back, and does not see-saw', () => {
  const run = (s, fpss, max = 2) => fpss.reduce((st, f) => adaptScale(st, f, max), s);
  assert.equal(adaptScale({ scale: 2 }, 60, 2).scale, 2); // smooth: as it is
  assert.equal(adaptScale({ scale: 2 }, 20, 2).scale, 2); // one hitch (a place loading): nothing
  assert.equal(run({ scale: 2 }, [20, 60, 20]).scale, 2); // hitches apart: nothing
  let s = run({ scale: 2 }, [35, 35]);
  assert.equal(s.scale, 1.75);
  assert.equal(s.ceiling, 2);
  s = run(s, [45, 45]); assert.equal(s.scale, 1.5);
  s = run(s, [60, 60, 60]); assert.equal(s.scale, 1.5); // 1.75 was too slow: stays
  s = run(s, Array(RETRY).fill(60)); assert.equal(s.scale, 2); // smooth for a long while: tries the full size again
  assert.equal(run({ scale: 1, ceiling: 2 }, [60]).scale, 1.25); // room to grow
  assert.equal(run({ scale: 1 }, Array(20).fill(10)).scale, MIN_SCALE); // never blurrier than this
  assert.equal(adaptScale({ scale: 2 }, 60, 1).scale, 1); // a screen change caps it
  assert.equal(run({ scale: 1 }, [SLOW, SLOW], 1).scale, 1); // right on the line: fine
});

test('frames per second from frame times', () => {
  assert.equal(fpsOf([]), 0);
  assert.equal(fpsOf([5]), 0);
  assert.equal(Math.round(fpsOf(Array.from({ length: 61 }, (_, i) => i * (1000 / 60)))), 60);
  assert.equal(fpsOf([0, 100, 200]), 10);
});

test('the photo banner says what is happening and how to play on', () => {
  assert.equal(photoLabel(0, 512, false), 'Getting the photo ready… The first one takes a few seconds.');
  assert.equal(photoLabel(0, 512, true), 'Getting the photo ready… The first one takes a few seconds.'); // set up, first sample not in
  assert.equal(photoLabel(128, 512), 'Making a photo… 25%. Press any key to play on.');
  assert.equal(photoLabel(512, 512), 'Photo finished. Press any key to play on.');
  assert.equal(photoLabel(900, 512), 'Photo finished. Press any key to play on.');
});

test('the Test Rig uses the main scene pipeline and has Fast/High, Photo and P', () => {
  const src = readFileSync(new URL('../public/views/compose-testrig.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\.\/lib\/post\.js'/);
  assert.match(src, /new Post\(/);
  assert.match(src, /new PathTraced\(/);
  assert.match(src, /withSSS\(/);
  assert.match(src, /data-quality=/);
  assert.match(src, /tr-photobtn[^>]*title="[^"]+"/);
  assert.doesNotMatch(src, /RoomEnvironment|UnrealBloomPass/); // no second, home-made pipeline
});
