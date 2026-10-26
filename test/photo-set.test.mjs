// Several photos = ONE model (public/lib/photo-set.js): angle guess and edit, front fallback, per-engine photo limits,
// one job and one price by default, one job per photo with Separate models, and the setup screen's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as S from '../public/lib/photo-set.js';
import { presetConfig, normalize, tripoDirectBody, threeDAIRequest, ENGINES } from '../public/lib/engines.js';
import { estimate } from '../public/lib/pricing.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// Tiny car-like pictures on a white background, as RGBA.
function picture(w, h, shapes) {
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const [x0, y0, x1, y1, [r, g, b]] of shapes) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d.set([r, g, b, 255], (y * w + x) * 4);
  }
  return S.photoFeatures(d, w, h);
}
const BODY = [40, 60, 140], GLASS = [30, 30, 40], TYRE = [10, 10, 10], LAMP = [250, 240, 200], RED = [220, 20, 20];
const mirror = (w, shapes) => shapes.map(([x0, y0, x1, y1, c]) => [w - x1, y0, w - x0, y1, c]);
// Side view, nose at the left of the picture: low hood on the left, cabin toward the back.
const SIDE = [[6, 24, 90, 36, BODY], [40, 12, 82, 24, GLASS], [14, 34, 26, 42, TYRE], [66, 34, 78, 42, TYRE]];
const FRONT = [[10, 22, 54, 40, BODY], [18, 10, 46, 22, GLASS], [12, 26, 20, 30, LAMP], [44, 26, 52, 30, LAMP], [12, 40, 20, 46, TYRE], [44, 40, 52, 46, TYRE]];
const BACK = [[10, 22, 54, 40, BODY], [18, 10, 46, 22, GLASS], [12, 26, 22, 32, RED], [42, 26, 52, 32, RED], [12, 40, 20, 46, TYRE], [44, 40, 52, 46, TYRE]];
const CORNER = [[6, 20, 58, 40, BODY], [8, 8, 30, 20, GLASS], [8, 38, 18, 46, TYRE], [44, 38, 52, 46, TYRE]];

test('angle guess: side views by the low hood end, front and back by mirror shape and tail lights, a corner is Other', () => {
  assert.equal(S.guessAngle(picture(96, 48, SIDE)).angle, 'left');
  assert.equal(S.guessAngle(picture(96, 48, mirror(96, SIDE))).angle, 'right');
  assert.equal(S.guessAngle(picture(64, 50, FRONT)).angle, 'front');
  assert.equal(S.guessAngle(picture(64, 50, BACK)).angle, 'back');
  assert.equal(S.guessAngle(picture(64, 50, CORNER)).angle, 'other');
  assert.deepEqual(S.guessAngle(picture(32, 32, [])), { angle: 'other', sure: 0 }); // nothing in it
  assert.deepEqual(S.guessAngle(null), { angle: 'other', sure: 0 });
  const f = picture(64, 50, FRONT);
  assert.ok(f.symmetry > 0.9 && f.size > 0.1 && f.sharp > 0, JSON.stringify(f));
});

const car = (id, angle, size = 0.3, sharp = 0.05) => ({ id, angle, features: { size, sharp } });
const FIVE = [car('a', 'front'), car('b', 'left'), car('c', 'back'), car('d', 'right'), car('e', 'other')];

test('5 photos of one car: ONE job with front, left, back and right, one model price; the 5th is kept', () => {
  for (const setup of [presetConfig('tripo', 'balanced'), presetConfig('3daistudio', 'balanced')]) {
    const { jobs } = S.planJobs(FIVE, setup);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].files, { front: 'a', left: 'b', back: 'c', right: 'd' });
    assert.deepEqual(jobs[0].refs, ['e']);
    assert.equal(jobs[0].setup.mode, 'views');
    assert.equal(estimate(jobs[0].setup).credits * jobs.length, estimate(jobs[0].setup).credits); // 1x, not 5x
  }
  assert.equal(S.planLine(FIVE, presetConfig('tripo', 'balanced')), '4 of 5 photos go to Tripo. 1 is kept for checking detail.');
  assert.equal(S.planLine(FIVE, presetConfig('3daistudio', 'balanced')), '4 of 5 photos go to Tripo 3.2. 1 is kept for checking detail.');
  // Tripo direct: one model price, the same as a single photo.
  const one = presetConfig('tripo', 'balanced');
  assert.equal(estimate(S.planJobs(FIVE, one).jobs[0].setup).credits, estimate(one).credits);
});

test('Separate models on: one job per photo, each with one photo, N x price', () => {
  const setup = presetConfig('tripo', 'balanced');
  const { jobs } = S.planJobs(FIVE, setup, { separate: true });
  assert.equal(jobs.length, 5);
  assert.deepEqual(jobs.map((j) => j.files), FIVE.map((p) => ({ front: p.id })));
  assert.ok(jobs.every((j) => j.setup.mode === 'single' && !j.refs.length));
  assert.equal(jobs.reduce((t, j) => t + estimate(j.setup).credits, 0), 5 * estimate(setup).credits);
  assert.equal(S.planLine(FIVE, setup, { separate: true }), 'Each of the 5 photos makes its own model.');
});

test('per-engine photo limits: 4 sides for Tripo, Tripo 3.x, Hunyuan and Hitem3D; TRELLIS.2 takes one and says so', () => {
  const limits = Object.fromEntries(Object.keys(ENGINES).map((e) => [e, S.photoLimit(e)]));
  assert.deepEqual(limits, { 'local-trellis': 4, 'tripo-direct': 4, 'tripo-3.2': 4, 'tripo-3.1': 4, 'tripo-3.0': 4, 'hunyuan-pro': 4, trellis2: 1, hitem3d: 4 });
  const trellis = presetConfig('3daistudio', 'draft');
  const { jobs } = S.planJobs(FIVE, trellis);
  assert.deepEqual([jobs.length, jobs[0].files, jobs[0].refs, jobs[0].setup.mode], [1, { front: 'a' }, ['b', 'c', 'd', 'e'], 'single']);
  assert.equal(S.planLine(FIVE, trellis), 'TRELLIS.2 takes one photo, so the best one is sent. 4 are kept for checking detail.');
  // What each engine receives for the 4 sides.
  const uris = { front: 'F', left: 'L', back: 'B', right: 'R' };
  const views = (engine) => threeDAIRequest(normalize({ provider: '3daistudio', engine, mode: 'views' }), uris);
  assert.deepEqual(views('tripo-3.2').body.images, [{ image: 'F' }, { image: 'L' }, { image: 'B' }, { image: 'R' }]);
  assert.deepEqual(views('hunyuan-pro').body.multi_view_images.map((x) => x.view_type), ['front', 'left', 'back', 'right']);
  assert.deepEqual(Object.keys(views('hitem3d').body.views), ['front', 'left', 'back', 'right']);
  assert.deepEqual(views('trellis2').body.image, 'F');
  // Tripo direct: one multiview job with inputs, front first; one photo stays image to model.
  const o = presetConfig('tripo', 'balanced').options;
  assert.deepEqual(tripoDirectBody(o, { back: 't3', front: 't1', left: 't2' }).inputs, [{ front: 't1' }, { left: 't2' }, { back: 't3' }]);
  assert.equal(tripoDirectBody(o, 't1').input, 't1');
});

test('angle edit wins, the sharpest of two of a side is sent, and kept photos are capped', () => {
  const photos = [car('a', 'front', 0.2), car('b', 'front', 0.4), car('c', 'left')];
  assert.deepEqual(S.pickViews(photos), { views: { front: 'b', left: 'c' }, kept: ['a'], frontWasGuessed: false });
  photos[2].angle = 'right'; // clicked the chip
  assert.deepEqual(S.pickViews(photos).views, { front: 'b', right: 'c' });
  const many = Array.from({ length: 12 }, (_, i) => car(`p${i}`, 'other', 0.1 + i / 100));
  assert.equal(S.planJobs(many, presetConfig('tripo', 'balanced')).jobs[0].refs.length, S.MAX_REFS);
});

test('no clear front: the best photo (biggest, sharpest subject) becomes the front, and the line says so', () => {
  const photos = [car('a', 'other', 0.1, 0.01), car('b', 'other', 0.5, 0.08), car('c', 'left')];
  const plan = S.pickViews(photos);
  assert.deepEqual(plan, { views: { front: 'b', left: 'c' }, kept: ['a'], frontWasGuessed: true });
  assert.match(S.planLine(photos, presetConfig('tripo', 'balanced')), /No photo is marked Front, so the clearest one is used\.$/);
  // Only sides: one of them moves to the front rather than nothing being sent.
  assert.deepEqual(S.pickViews([car('l', 'left')]).views, { front: 'l' });
  // One photo: a plain image to model job, and no line.
  const solo = S.planJobs([car('x', 'other')], presetConfig('tripo', 'balanced'));
  assert.deepEqual([solo.jobs.length, solo.jobs[0].setup.mode, S.planLine([car('x', 'other')], presetConfig('tripo', 'balanced'))], [1, 'single', '']);
  assert.deepEqual(S.planJobs([], presetConfig('tripo', 'balanced')), { jobs: [], plan: null });
});

test('setup screen wiring: no 4 sides control, Separate models off by default with a tip, angle chips, 44px, no em dashes', () => {
  const js = read('public/views/setup.js');
  assert.doesNotMatch(js, /Use 4 sides|'4 sides'|data-pickslot|data-mode=/);
  assert.match(js, /class="sep-tg" title="\$\{SEP_TIP\}"><input type="checkbox" role="switch"[^>]*data-sep/);
  assert.match(js, /const separate = \(\) => Boolean\(pending\(\)\.separate && !model\)/); // off unless turned on
  assert.match(js, /<select class="angle" data-angle="[^"]*" data-fk="[^"]*" title="\$\{ANGLE_TIP\}"/);
  assert.match(js, />Used for checking detail</);
  assert.match(js, /n > 1 && `\$\{n\} models × \$\{each\}`/); // N x price only with more than one job
  const css = read('public/styles/stage.css');
  for (const sel of ['.su-strip .angle', '.sep-tg']) assert.match(css, new RegExp(`${sel.replace(/\./g, '\\.')} \\{[^}]*min-height: 44px`), sel);
  for (const f of ['public/views/setup.js', 'public/lib/photo-set.js']) assert.doesNotMatch(read(f), /—/, f);
  const app = read('public/app.js');
  assert.match(app, /form\.append\(`ref\$\{i\}`/); // kept photos travel with the job
  assert.match(app, /planJobs\(photos, normalize/); // quick drops make one model too
});
