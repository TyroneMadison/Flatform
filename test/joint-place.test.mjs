// The joints placement screen (lib/joint-place.js), toast dedupe (lib/toasts.js) and the Test Rig gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SPOTS, SPOT_NAMES, newPlacement, placedCount, currentSpot, canRig, rigLabel, mirrorPoint, place, setMirror, pick,
  undoLast, startOver, twinOf, guessSpot, insideDistance, spotHelp, middleOf,
} from '../public/lib/joint-place.js';
import { toastPlan, MAX_TOASTS } from '../public/lib/toasts.js';
import { testRigGate, TEST_RIG_LATER } from '../public/lib/testrig-ui.js';
import { SHORTCUTS } from '../public/lib/shortcuts.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the 10 spots, in order, with plain names', () => {
  assert.deepEqual(SPOTS.map((k) => SPOT_NAMES[k]), ['Chin', 'Groin', 'Left elbow', 'Left wrist', 'Right elbow', 'Right wrist', 'Left knee', 'Left ankle', 'Right knee', 'Right ankle']);
  assert.match(spotHelp('leftElbow'), /The model's own left\. When it faces you, that's on your right\./);
  assert.equal(twinOf('leftKnee'), 'rightKnee');
  assert.equal(twinOf('chin'), null);
});

test('checklist progress: placing moves to the next spot, a picked row is placed next', () => {
  const pl = newPlacement(false);
  assert.equal(currentSpot(pl), 'chin');
  place(pl, [0, 1.6, 0]);
  place(pl, [0, 0.9, 0]);
  assert.equal(placedCount(pl), 2);
  assert.equal(currentSpot(pl), 'leftElbow');
  pick(pl, 'chin');
  assert.equal(currentSpot(pl), 'chin');
  place(pl, [0, 1.62, 0.01]);
  assert.deepEqual(pl.points.chin, [0, 1.62, 0.01]);
  assert.equal(placedCount(pl), 2, 're-placing does not count twice');
  assert.equal(currentSpot(pl), 'leftElbow');
  assert.equal(place(pl, [NaN, 0, 0]), null, 'a bad point is never placed');
});

test('mirror math: a left spot copies across the middle, tagged mirrored, and can be placed again', () => {
  assert.deepEqual(mirrorPoint([0.5, 1, 0.1], 0.1).map((n) => Math.round(n * 1e9) / 1e9), [-0.3, 1, 0.1]);
  const pl = newPlacement(true);
  place(pl, [0.1, 1.6, 0]); place(pl, [0.1, 0.9, 0]);
  const r = place(pl, [0.45, 1.2, 0.05], 0.1);
  assert.deepEqual(r, { key: 'leftElbow', twin: 'rightElbow' });
  assert.deepEqual(pl.points.rightElbow, [-0.25, 1.2, 0.05]);
  assert.equal(pl.mirrored.rightElbow, true);
  assert.equal(placedCount(pl), 4);
  assert.equal(currentSpot(pl), 'leftWrist', 'the mirrored one is skipped');
  pick(pl, 'rightElbow');
  place(pl, [-0.3, 1.21, 0.05], 0.1);
  assert.equal(pl.mirrored.rightElbow, undefined, 'placed by hand now');
  pick(pl, 'leftElbow');
  place(pl, [0.5, 1.2, 0.05], 0.1);
  assert.deepEqual(pl.points.rightElbow, [-0.3, 1.21, 0.05], 'a hand-placed right spot is never overwritten');
  // Mirror off: nothing is copied. Turning it on copies the left spots already in.
  const off = newPlacement(false);
  place(off, [0, 1.6, 0]); place(off, [0, 0.9, 0]); place(off, [0.4, 1.2, 0]);
  assert.equal(off.points.rightElbow, undefined);
  setMirror(off, true);
  assert.deepEqual(off.points.rightElbow, [-0.4, 1.2, 0]);
  assert.equal(placedCount(off), 4);
});

test('Rig it unlocks at 10 of 10, and says how many spots are left until then', () => {
  const pl = newPlacement(true);
  assert.equal(rigLabel(pl), 'Rig it · 10 spots left');
  for (const p of [[0, 1.6, 0], [0, 0.9, 0], [0.4, 1.2, 0], [0.6, 1, 0], [0.1, 0.5, 0], [0.1, 0.05, 0]]) place(pl, p);
  assert.equal(placedCount(pl), 10, 'mirror on: 6 clicks place all 10');
  assert.equal(canRig(pl), true);
  assert.equal(rigLabel(pl), 'Rig it');
  assert.equal(currentSpot(pl), null);
  undoLast(pl);
  assert.equal(canRig(pl), false);
  assert.equal(rigLabel(pl), 'Rig it · 2 spots left');
  const one = newPlacement(false);
  for (let i = 0; i < 9; i++) place(one, [i, i, 0]);
  assert.equal(rigLabel(one), 'Rig it · 1 spot left');
});

test('Undo last takes back one placement with its mirrored twin; Start over clears all', () => {
  const pl = newPlacement(true);
  assert.equal(undoLast(pl), false);
  place(pl, [0, 1.6, 0]); place(pl, [0, 0.9, 0]); place(pl, [0.4, 1.2, 0]);
  assert.equal(placedCount(pl), 4);
  assert.equal(undoLast(pl), true);
  assert.equal(placedCount(pl), 2);
  assert.equal(pl.points.rightElbow, undefined);
  assert.equal(pl.mirrored.rightElbow, undefined);
  assert.equal(currentSpot(pl), 'leftElbow');
  pick(pl, 'chin'); place(pl, [0, 1.7, 0]);
  undoLast(pl);
  assert.deepEqual(pl.points.chin, [0, 1.6, 0], 'undo puts a re-placed spot back where it was');
  startOver(pl);
  assert.equal(placedCount(pl), 0);
  assert.equal(pl.mirror, true, 'Start over keeps the mirror choice');
  assert.equal(pl.history.length, 0);
});

test('guesses: the target ring sits near each spot of a T-pose figure, and a placed twin is mirrored', () => {
  // A rough figure 1.8 tall: a column body, arms straight out to x = ±0.8 at shoulder height.
  const verts = [];
  for (let y = 0; y <= 1.8; y += 0.02) for (const x of [-0.12, -0.05, 0.05, 0.12]) verts.push([x, y, 0]);
  for (let i = -40; i <= 40; i++) verts.push([i / 50, 1.45, 0]);
  const chin = guessSpot('chin', verts);
  assert.ok(Math.abs(chin[1] - 0.86 * 1.8) < 0.03 && Math.abs(chin[0]) < 0.05);
  const wrist = guessSpot('leftWrist', verts), elbow = guessSpot('leftElbow', verts);
  assert.ok(wrist[0] > 0.6 && elbow[0] > 0.25 && elbow[0] < wrist[0], `left arm on +x: ${elbow} ${wrist}`);
  assert.ok(guessSpot('rightWrist', verts)[0] < -0.6);
  assert.ok(guessSpot('leftKnee', verts)[0] > 0);
  const pl = newPlacement(); pl.points.leftKnee = [0.09, 0.5, 0.02];
  assert.deepEqual(guessSpot('rightKnee', verts, pl).map((n) => Math.round(n * 100) / 100), [-0.09, 0.5, 0.02]);
  assert.equal(guessSpot('chin', []), null);
});

test('mirror follows the body, not the file: a figure turned to face +X mirrors front to back in the file', () => {
  // The T-pose figure turned a quarter: its arms run along z, so its left-right is z.
  const verts = [];
  for (let y = 0; y <= 90; y++) for (const z of [-0.12, -0.05, 0.05, 0.12]) verts.push([0.3, y / 50, z + 0.2]);
  for (let i = -40; i <= 40; i++) verts.push([0.3, 1.45, i / 50 + 0.2]);
  const mid = middleOf(verts);
  assert.ok(Math.abs(Math.abs(mid.n[2]) - 1) < 1e-6, `left-right is z: ${mid.n}`);
  const m = mirrorPoint([0.3, 1.2, 0.6], mid);
  assert.ok(Math.abs(m[0] - 0.3) < 1e-6 && Math.abs(m[2] + 0.2) < 0.03, `mirrored across z = 0.2: ${m}`);
  const lw = guessSpot('leftWrist', verts, newPlacement(), mid), rw = guessSpot('rightWrist', verts, newPlacement(), mid);
  assert.ok(Math.abs(lw[2] - rw[2]) > 1, 'the two wrists are on opposite ends of the arms');
});

test('clicks go to the inside middle of the limb under them', () => {
  assert.equal(insideDistance([{ distance: 2, entering: true }, { distance: 2.2, entering: false }, { distance: 3, entering: true }]), 2.1);
  assert.equal(insideDistance([{ distance: 1, entering: false }, { distance: 2, entering: true }, { distance: 2.4, entering: false }]), 2.2);
  assert.equal(insideDistance([{ distance: 5, entering: true }]), 5);
  assert.equal(insideDistance([]), null, 'empty space: nothing');
});

test('toast dedupe: the same words refresh the toast on screen, at most 3 show', () => {
  assert.equal(MAX_TOASTS, 3);
  assert.deepEqual(toastPlan([], 'Hi'), { drop: 0 });
  assert.deepEqual(toastPlan(['A', 'Hi'], 'Hi'), { same: 1 });
  assert.deepEqual(toastPlan(['A', 'B'], 'C'), { drop: 0 });
  assert.deepEqual(toastPlan(['A', 'B', 'C'], 'D'), { drop: 1 });
  const app = read('public/app.js');
  assert.match(app, /toastPlan\(live\.map\(\(c\) => c\.dataset\.msg\), msg\)/, 'app.js toast() asks toastPlan');
  assert.match(app, /live\[plan\.same\]\.refresh\(\); return;/);
});

test('Test Rig gate: always there for a person, greyed with the hint until rigged; G says the same', () => {
  assert.deepEqual(testRigGate({ humanoid: true, rigged: false }), { show: true, enabled: false, hint: 'Opens after your model is rigged' });
  assert.deepEqual(testRigGate({ humanoid: true, rigged: true }), { show: true, enabled: true, hint: '' });
  assert.equal(testRigGate({ humanoid: false, rigged: false }).show, false);
  const tr = read('public/views/compose-testrig.js');
  assert.match(tr, /data-tr="start" data-none="\$\{esc\(gate\.hint\)\}" disabled/, 'the greyed button carries the hint');
  assert.match(read('public/lib/hotkeys.js'), /ctx\.say\(b\?\.dataset\?\.none \|\| s\.none\)/, 'G on a greyed button says its hint');
  assert.equal(SHORTCUTS.find((s) => s.id === 'testrig').click, '[data-tr="start"]');
  assert.equal(TEST_RIG_LATER.includes('—'), false);
});

test('one path: Add joints only, its failure goes straight to the placement screen', () => {
  const mo = read('public/views/compose-motion.js');
  assert.doesNotMatch(mo, /Show me where the joints are/);
  assert.doesNotMatch(mo, /data-mo-act="marks"/);
  assert.match(mo, /job\?\.fallback === 'markers' && ctx\.model\(\)\?\.id === m\.id\) startPlacement\(error\)/);
  for (const w of ['Pose · Add joints', 'Mirror left to right', 'Place the left side, we copy it.', 'Next spot', 'Undo last', 'Start over', 'Click here: ', 'You placed', 'Mirrored', 'Nice! ']) assert.ok(mo.includes(w), w);
  assert.equal(/—/.test(mo + read('public/lib/joint-place.js')), false, 'no em dashes');
  const css = read('public/styles/stage.css');
  assert.match(css, /\.jp-row \{[^}]*min-height: 44px/, '44 px rows');
  assert.match(css, /\.jp-card \{[^}]*min-height: 44px/);
});
