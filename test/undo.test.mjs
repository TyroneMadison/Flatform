// Global undo/redo on Compose: the history store (one step per drag, bursts merge), the shortcuts, where the buttons
// live, and the Color/Material panel layout that used to overlap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHistory, historyKey, isTyping } from '../public/lib/history.js';

const clockAt = () => { const c = { t: 10_000, now: () => c.t }; return c; };

test('history: separate edits are separate steps; undo and redo walk them', () => {
  const c = clockAt();
  const h = createHistory({ now: c.now });
  let s = { x: 0 };
  h.record(s); s = { x: 1 }; c.t += 1000;
  h.record(s); s = { x: 2 };
  assert.ok(h.canUndo); assert.ok(!h.canRedo);
  s = h.undo(s); assert.deepEqual(s, { x: 1 });
  s = h.undo(s); assert.deepEqual(s, { x: 0 });
  assert.equal(h.undo(s), null);
  s = h.redo(s); assert.deepEqual(s, { x: 1 });
  s = h.redo(s); assert.deepEqual(s, { x: 2 });
  assert.equal(h.redo(s), null);
});

test('history: a new edit after undo clears redo', () => {
  const c = clockAt();
  const h = createHistory({ now: c.now });
  let s = { x: 0 };
  h.record(s); s = { x: 1 };
  s = h.undo(s);
  assert.ok(h.canRedo);
  h.record(s); s = { x: 5 };
  assert.ok(!h.canRedo);
  assert.deepEqual(h.undo(s), { x: 0 });
});

test('history: a drag is one step however long it runs, back to where it started', () => {
  const c = clockAt();
  const h = createHistory({ now: c.now });
  let s = { orbit: [0, 0, 5] };
  h.begin(s);
  for (let i = 1; i <= 50; i++) { h.record(s); s = { orbit: [i, 0, 5] }; c.t += 900; } // slower than a burst
  h.end();
  assert.deepEqual(h.undo(s), { orbit: [0, 0, 5] });
  assert.ok(!h.canUndo);
});

test('history: a click that changes nothing (begin/end with no edit) adds no step', () => {
  const h = createHistory({ now: clockAt().now });
  h.begin({ x: 0 }); h.end();
  assert.ok(!h.canUndo);
});

test('history: quick repeated edits (keys on a slider, wheel zoom) merge; the next edit after a drag does not', () => {
  const c = clockAt();
  const h = createHistory({ now: c.now });
  let s = { lens: 50 };
  for (let i = 1; i <= 5; i++) { h.record(s); s = { lens: 50 + i }; c.t += 100; }
  assert.deepEqual(h.undo(s), { lens: 50 });
  assert.ok(!h.canUndo);
  // a drag then an immediate click: two steps
  s = { lens: 55 };
  h.begin(s); h.record(s); s = { lens: 70 }; h.end();
  c.t += 50;
  h.record(s); s = { lens: 70, view: 'free' };
  s = h.undo(s); assert.deepEqual(s, { lens: 70 });
  assert.deepEqual(h.undo(s), { lens: 55 });
});

test('history: stores copies, keeps a limit, clear empties both ways', () => {
  const c = clockAt();
  const h = createHistory({ limit: 3, now: c.now });
  const s = { paint: { pieces: { a: 1 } } };
  h.record(s); s.paint.pieces.a = 2;
  assert.equal(h.undo(s).paint.pieces.a, 1, 'mutating the live scene does not change the stored step');
  for (let i = 0; i < 10; i++) { c.t += 1000; h.record({ i }); }
  let n = 0; while (h.undo({})) n++;
  assert.equal(n, 3);
  h.redo({}); h.clear();
  assert.ok(!h.canUndo && !h.canRedo);
});

const key = (k, mods = {}, target = { tagName: 'CANVAS' }) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods, target });

test('shortcuts: Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo, Cmd works on macOS', () => {
  assert.equal(historyKey(key('z', { ctrlKey: true })), 'undo');
  assert.equal(historyKey(key('Z', { ctrlKey: true, shiftKey: true })), 'redo');
  assert.equal(historyKey(key('y', { ctrlKey: true })), 'redo');
  assert.equal(historyKey(key('z', { metaKey: true })), 'undo');
  assert.equal(historyKey(key('z')), null);
  assert.equal(historyKey(key('z', { ctrlKey: true, altKey: true })), null);
  assert.equal(historyKey(key('x', { ctrlKey: true })), null);
});

test('shortcuts: ignored while typing in a field, active on sliders, switches and the canvas', () => {
  for (const t of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'INPUT', type: 'number' }, { tagName: 'INPUT', type: 'search' }, { tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.ok(isTyping(t), JSON.stringify(t));
    assert.equal(historyKey(key('z', { ctrlKey: true }, t)), null);
  }
  for (const t of [{ tagName: 'INPUT', type: 'range' }, { tagName: 'INPUT', type: 'checkbox' }, { tagName: 'INPUT', type: 'color' }, { tagName: 'BUTTON' }, { tagName: 'CANVAS' }, { tagName: 'BODY' }]) {
    assert.ok(!isTyping(t), JSON.stringify(t));
    assert.equal(historyKey(key('z', { ctrlKey: true }, t)), 'undo');
  }
});

const compose = readFileSync(new URL('../public/views/compose.js', import.meta.url), 'utf8');
const paint = readFileSync(new URL('../public/views/compose-paint.js', import.meta.url), 'utf8');
const base = readFileSync(new URL('../public/styles/base.css', import.meta.url), 'utf8');
const screens = readFileSync(new URL('../public/styles/screens.css', import.meta.url), 'utf8');

test('compose: Undo and Redo sit in the top bar (v3), start disabled, and the raw history list is gone', () => {
  const header = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').match(/<header class="topbar"[\s\S]*?<\/header>/)[0];
  assert.match(header, /id="undoBtn"[^>]*disabled/);
  assert.match(header, /id="redoBtn"[^>]*disabled/);
  assert.match(compose, /\$\('#undoBtn'\)\.addEventListener\('click', \(\) => stepHistory\(false\), \{ signal \}\)/, 'wired with the screen signal, so it stops on unmount');
  assert.doesNotMatch(compose, /histlist|hist\.list\(/);
  const keys = readFileSync(new URL('../public/lib/shortcuts.js', import.meta.url), 'utf8');
  assert.match(keys, /id: 'undo'.*click: '#undoBtn'/, 'Ctrl+Z (one global key handler) presses the top bar Undo');
  assert.match(keys, /id: 'redo'.*click: '#redoBtn'/);
  assert.doesNotMatch(compose, /document\.addEventListener\('keydown'/, 'no second Ctrl+Z handler, or one press would undo twice');
  assert.match(compose, /signal/, 'listeners are removed on unmount');
});

test('compose: every scene edit goes through change(), including frame all and export settings', () => {
  assert.doesNotMatch(compose, /Object\.assign\(scene, changed\)/);
  assert.doesNotMatch(compose, /scene\.orbit = orbit;/, 'the orbit only lands in the scene when the drag ends');
  assert.doesNotMatch(paint, /let exportPart|let altHelmet/);
  assert.match(paint, /exportSet/);
});

test('color panel: no global .swatch rule leaks into the colour slots; 44 px targets; two per row', () => {
  assert.doesNotMatch(base, /^\.swatch\b/m, 'the theme dot has its own class (.tswatch)');
  const rule = screens.match(/^\.swatch \{[^}]*\}/m)?.[0] || '';
  assert.match(rule, /min-height: 44px/);
  assert.match(screens, /\.swatches \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(rule, /text-overflow|white-space: nowrap/, 'sublabels wrap instead of truncating');
  assert.match(screens, /\.levels \.chip \{[^}]*min-height: 44px/);
});

test('color panel: Section and Piece explain why they are unavailable instead of going silently disabled', () => {
  const lv = paint.slice(paint.indexOf('const levels = ['), paint.indexOf('const levelValue'));
  assert.match(lv, /Pick a piece first/);
  assert.match(lv, /no section/);
  assert.match(paint, /aria-disabled="true" aria-describedby="levelHint"/);
  assert.match(paint, /id="levelHint"/);
  assert.match(paint, /getAttribute\('aria-disabled'\) === 'true'\) return true/);
});

test('material and inference rows: long controls get their own line and wrap', () => {
  assert.match(paint, /<div class="mg-row stack">\s*<button class="btn sm sec" type="button" data-act="infer"/);
  assert.match(paint, /<div class="mg-row mat-acts">\$\{sel\('mat-preset'/);
  assert.match(screens, /\.mg-row\.stack \.btn \{[^}]*white-space: normal/);
});

test('record() says when an edit starts a new undo step (auto-save saves sooner after one)', () => {
  let t = 1000;
  const h = createHistory({ now: () => t });
  assert.equal(h.record({ a: 1 }), true);
  t += 100; assert.equal(h.record({ a: 2 }), false, 'same burst');
  t += 1000; assert.equal(h.record({ a: 3 }), true);
  h.begin({ a: 4 }); assert.equal(h.record({ a: 4 }), true); assert.equal(h.record({ a: 5 }), false, 'same drag'); h.end();
});
