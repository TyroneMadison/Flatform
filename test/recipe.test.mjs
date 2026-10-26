// Recipe fixes: Tripo face limit ranges per combo (smart low poly caps at 10,000), clamping of old saved values, the
// low-detail warning, Custom and Max quality never getting smart low poly by surprise, plain error sentences, the
// failed queue card, and where the quick hover tips go.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, presetConfig, matchPreset, tripoFaceRange, SMART_LOW_POLY, detailWarning, customFrom, tripoDirectBody, threeDAIRequest, optionSpecs } from '../public/lib/engines.js';
import { plainError } from '../public/lib/plain-errors.js';
import { placeTip, TIP_TARGETS } from '../public/lib/tips.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const direct = (options) => normalize({ provider: 'tripo', engine: 'tripo-direct', options });
const studio = (options, engine = 'tripo-3.2') => normalize({ provider: '3daistudio', engine, options });
const rangeOf = (cfg) => optionSpecs(cfg.engine).find((s) => s.key === 'face_limit').range(cfg.options);

test('Tripo face limit: the right range for every combo', () => {
  assert.deepEqual(tripoFaceRange({ smart_low_poly: true, quad: true }), [500, 10000], 'the live API refused 20,000 here');
  assert.deepEqual(tripoFaceRange({ smart_low_poly: true, quad: false }), [500, 10000], 'capped at 10,000 either way');
  assert.deepEqual(tripoFaceRange({ smart_low_poly: true, geometry_quality: 'detailed' }), [500, 10000]);
  assert.deepEqual(tripoFaceRange({ quad: true }), [500, 150000]);
  assert.deepEqual(tripoFaceRange({ quad: true, geometry_quality: 'detailed' }), [500, 150000]);
  assert.deepEqual(tripoFaceRange({ geometry_quality: 'detailed' }), [500, 2000000]);
  assert.deepEqual(tripoFaceRange({}), [500, 1500000]);
  assert.deepEqual(tripoFaceRange({}, 1000000), [500, 1000000], 'Tripo 3.0');
  for (const engine of ['tripo-direct']) assert.deepEqual(rangeOf(direct({ smart_low_poly: true, quad: true })), [500, 10000], engine);
  for (const engine of ['tripo-3.2', 'tripo-3.1', 'tripo-3.0']) assert.deepEqual(rangeOf(studio({ smart_low_poly: true }, engine)), [500, 10000], engine);
  assert.doesNotMatch(read('public/lib/engines.js'), /smart_low_poly \? 20000/, '20,000 is gone for smart low poly');
});

test('smart low poly: 5,000 by default, no Auto end, old saved values clamped before sending', () => {
  assert.equal(direct({ smart_low_poly: true }).options.face_limit, SMART_LOW_POLY.default);
  assert.equal(direct({ smart_low_poly: true, face_limit: null }).options.face_limit, 5000);
  assert.equal(direct({ smart_low_poly: true, quad: true, face_limit: 20000 }).options.face_limit, 10000, 'the saved 20,000 that failed');
  assert.equal(direct({ smart_low_poly: true, face_limit: 200 }).options.face_limit, 500);
  assert.equal(direct({ smart_low_poly: true, face_limit: 7000 }).options.face_limit, 7000);
  assert.equal(direct({ quad: true, face_limit: 900000 }).options.face_limit, 150000);
  assert.equal(direct({}).options.face_limit, null, 'plain: still Auto');
  assert.equal(tripoDirectBody(direct({ smart_low_poly: true, quad: true, face_limit: 20000 }).options, 'f').face_limit, 10000);
  assert.equal(threeDAIRequest(studio({ smart_low_poly: true, face_limit: 20000 }), { front: 'x' }).body.face_limit, 10000);
  const spec = optionSpecs('tripo-direct').find((s) => s.key === 'face_limit');
  assert.equal(spec.noAuto({ smart_low_poly: true }), true);
  const setup = read('public/views/setup.js');
  assert.match(setup, /k === 'smart_low_poly' && v \? \{ face_limit: SMART_LOW_POLY\.default \}/, 'turning it on picks 5,000');
  assert.match(setup, /class="sl-ends"/, 'the slider shows its true low and high ends');
});

test('low-detail warning: shows when smart low poly or square pieces cap the recipe', () => {
  assert.equal(detailWarning(presetConfig('tripo', 'max')), '');
  assert.match(detailWarning(direct({ geometry_quality: 'detailed', smart_low_poly: true })), /^Game-ready low detail stops the model at 10,000 pieces, so Ultra shape will not show\.$/);
  assert.match(detailWarning(direct({ smart_low_poly: true })), /10,000 pieces\.$/);
  assert.match(detailWarning(direct({ quad: true })), /^Square pieces stops the model at 150,000 pieces\.$/);
  assert.equal(detailWarning(presetConfig('local', 'max')), '', 'other engines: nothing');
  assert.equal(detailWarning(presetConfig('3daistudio', 'max')), '');
  assert.match(read('public/views/setup.js'), /put\('#suWarn', detailWarning\(setup\) \? `<p class="su-warn" role="status">/, 'in the Ready to build card');
});

test('Max quality and Custom never carry smart low poly by default', () => {
  for (const provider of ['tripo', '3daistudio', 'local']) for (const id of ['fast', 'balanced', 'max', 'draft']) {
    const cfg = presetConfig(provider, id);
    assert.ok(!cfg.options.smart_low_poly, `${provider} ${id}`);
  }
  const low = direct({ ...presetConfig('tripo', 'max').options, smart_low_poly: true });
  assert.equal(matchPreset(low), 'custom');
  const custom = customFrom(low);
  assert.equal(custom.options.smart_low_poly, false);
  assert.equal(custom.options.geometry_quality, 'detailed', 'the rest stays');
  const max = presetConfig('tripo', 'max');
  assert.equal(customFrom(max), max, 'nothing to take off');
  assert.match(read('public/views/setup.js'), /if \(matchPreset\(setup\) !== 'custom'\) setup = customFrom\(setup\)/);
});

test('errors become one plain sentence', () => {
  assert.equal(plainError('when smart_low_poly is enabled, face_limit must be between 500 and 10000 (quad mesh), got 20000'),
    'The detail level was too high for game-ready low detail. Pick 10,000 pieces or less and try again.');
  assert.equal(plainError('face_limit must be <= 150000'), 'The detail level was outside what this engine allows. Pick a lower one and try again.');
  assert.equal(plainError('Tripo: HTTP 402 insufficient balance'), 'Not enough credits. Top up, then try again.');
  assert.equal(plainError('401 Unauthorized'), 'The key was not accepted. Check it in Settings.');
  assert.equal(plainError('429 Too Many Requests'), 'Too many requests at once. Wait a minute and try again.');
  assert.equal(plainError('fetch failed'), 'Could not reach the service. Check your internet and try again.');
  assert.equal(plainError(''), 'Something went wrong. Try again.');
  assert.equal(plainError(undefined), 'Something went wrong. Try again.');
  assert.equal(plainError('Tripo returned no model URL'), 'Tripo returned no model URL');
  assert.ok(plainError('x'.repeat(300)).length <= 100, 'long text is cut to one line');
  assert.equal(plainError('First thing broke. Then more words here.'), 'First thing broke.');
});

test('failed queue card: one short line, Details for the full message, buttons on their own row', () => {
  const gen = read('public/views/generate.js');
  assert.match(gen, /esc\(plainError\(q\.error\)\)/);
  assert.match(gen, /<details><summary title="Show the full message">Details<\/summary><code>\$\{esc\(raw\)\}<\/code><\/details>/);
  const css = read('public/styles/stage.css');
  assert.match(css, /\.qi\.qfail \{ flex-wrap: wrap; \}/);
  assert.match(css, /\.qi\.qfail \.qt \{ flex: 1 1 100%; \}/, 'the text takes the full width, not a narrow column');
  assert.match(css, /\.qi\.qfail \.qt > span \{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/, 'one line');
});

test('quick hover tips: placed above, below when there is no room, kept on screen', () => {
  assert.deepEqual(placeTip({ top: 100, bottom: 130, left: 200, width: 80 }, 120, 30, 1366), { top: 62, left: 180, above: true });
  assert.deepEqual(placeTip({ top: 10, bottom: 40, left: 200, width: 80 }, 120, 30, 1366), { top: 48, left: 180, above: false });
  assert.equal(placeTip({ top: 100, bottom: 130, left: 1350, width: 16 }, 200, 30, 1366).left, 1162, 'not past the right edge');
  assert.equal(placeTip({ top: 100, bottom: 130, left: 0, width: 16 }, 200, 30, 1366).left, 4, 'not past the left edge');
  assert.match(TIP_TARGETS, /\[title\]/);
  assert.match(read('public/app.js'), /installTips\(\)/);
  assert.match(read('public/styles/stage.css'), /\.tip \{ position: fixed;/);
});
