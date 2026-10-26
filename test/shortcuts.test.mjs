// Keyboard shortcuts: one registry with no clashes, keys matched per screen, paused while typing, in a dialog or in
// the Test rig, and the cheat sheet lists every one. The key handler runs against a tiny fake document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, TAKEN, clashes, shortcutFor, comboOf, isTyping, cycle, keyOf, worksOn } from '../public/lib/shortcuts.js';
import { bindingsFor, installHotkeys, pausedBy, ACTIONS } from '../public/lib/hotkeys.js';

const key = (k, mods = {}, target = { tagName: 'BODY' }) => ({ key: k, target, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('registry: no two shortcuts share a key on one screen, none uses a key the window or a screen owns', () => {
  assert.deepEqual(clashes(), []);
  assert.equal(new Set(SHORTCUTS.map((s) => s.id)).size, SHORTCUTS.length, 'ids are unique');
  for (const s of SHORTCUTS) {
    assert.ok(s.label && s.keys && (s.where === '*' || s.where.length), s.id);
    if (s.click) assert.ok(s.none, `${s.id} says something when its button is missing`);
  }
  for (const id of ['shelf', 'share', 'history', 'still', 'turntable', 'undo', 'redo', 'reset', 'frame', 'envNext', 'envPrev', 'pose', 'testrig', 'export', 'palette', 'help'])
    assert.ok(keyOf(id), `${id} has a key`);
  // the checker itself catches a clash and a taken key
  const extra = [...SHORTCUTS, { id: 'x', keys: 'F', label: 'x', where: ['compose'] }, { id: 'y', keys: 'Ctrl+R', label: 'y', where: ['library'] }];
  assert.deepEqual(clashes(extra), [['frame', 'x'], ['y', 'Ctrl+R']]);
  assert.deepEqual(clashes(SHORTCUTS, { preview: 'Ctrl+E' }), [['preview', 'export']], 'a custom key can clash too');
  assert.ok(TAKEN.includes('Ctrl+1') && TAKEN.includes('5'));
  assert.deepEqual(Object.keys(ACTIONS), ['preview', 'finish'], 'Settings still edits the same two');
});

test('keys: matched on the right screen, with ? and [ ] working whatever Shift does', () => {
  assert.equal(shortcutFor(key('z', { ctrlKey: true }), 'compose').id, 'undo');
  assert.equal(shortcutFor(key('Z', { ctrlKey: true, shiftKey: true }), 'compose').id, 'redo');
  assert.equal(shortcutFor(key('y', { ctrlKey: true }), 'compose').id, 'redo');
  assert.equal(shortcutFor(key('?', { shiftKey: true }), 'library').id, 'help');
  assert.equal(shortcutFor(key(']'), 'compose').id, 'envNext');
  assert.equal(shortcutFor(key('['), 'compose').id, 'envPrev');
  assert.equal(shortcutFor(key('f'), 'compose').id, 'frame');
  assert.equal(shortcutFor(key('f'), 'library'), null, 'Compose keys stay in Compose');
  assert.equal(shortcutFor(key('S', { shiftKey: true }), 'compose'), null, 'Shift+S is not S');
  assert.equal(shortcutFor(key('k', { metaKey: true }), 'drop').id, 'palette');
  assert.equal(shortcutFor(key('p', { altKey: true }), 'compose', { preview: 'Alt+P' }).id, 'preview', 'custom keys count');
  assert.equal(shortcutFor(key('p', { ctrlKey: true, shiftKey: true }), 'compose', { preview: 'Alt+P' }), null, 'the old key is free again');
  assert.equal(comboOf(key('Shift', { shiftKey: true })), '');
  assert.equal(comboOf(key('Backspace', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Backspace');
});

test('typing: text boxes keep their keys, sliders and buttons do not', () => {
  assert.equal(isTyping({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTyping({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isTyping({ tagName: 'INPUT' }), true);
  assert.equal(isTyping({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTyping({ tagName: 'SELECT' }), true);
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: 'INPUT', type: 'range' }), false, 'Ctrl+Z still undoes after moving a slider');
  assert.equal(isTyping({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTyping({ tagName: 'BUTTON' }), false);
  assert.equal(isTyping(null), false);
});

test('cycle: steps through lighting places and wraps at both ends', () => {
  assert.equal(cycle(7, 6, 1), 0);
  assert.equal(cycle(7, 0, -1), 6);
  assert.equal(cycle(7, 2, 1), 3);
  assert.equal(cycle(7, -1, 1), 0, 'none picked: next is the first');
  assert.equal(cycle(7, -1, -1), 6, 'none picked: previous is the last');
  assert.equal(cycle(0, -1, 1), -1);
});

test('cheat sheet: lists every shortcut for the screen plus the global ones', () => {
  const rows = bindingsFor('compose', { preview: 'Alt+P', finish: 'Ctrl+Shift+H' });
  for (const s of SHORTCUTS) assert.ok(rows.some(([, label]) => label === s.label), s.id);
  assert.ok(rows.some(([k]) => k === 'Ctrl+Shift+Z or Ctrl+Y'));
  assert.ok(rows.some(([k]) => k === 'Alt+P'));
  const lib = bindingsFor('library', {});
  assert.ok(lib.some(([k]) => k === 'Ctrl+K') && !lib.some(([k]) => k === 'F'));
  assert.equal(SHORTCUTS.filter((s) => worksOn(s, 'library')).length, 6); // help, palette, preview, finish, share, history
});

// A small stand-in for document: listeners, a body, querySelector by a few known selectors.
function fakeDoc() {
  const on = {};
  const found = {};
  const el = () => ({ hidden: false, classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } }, setAttribute() {}, querySelector: () => ({}), remove() {} });
  return {
    found, on,
    createElement: el,
    body: { append(x) { found.sheet = x; } },
    addEventListener: (t, f) => { on[t] = f; },
    removeEventListener: (t) => { delete on[t]; },
    querySelector: (sel) => found[sel] || null,
    querySelectorAll: (sel) => found[sel] || [],
    press(k, mods, target) { const e = { ...key(k, mods, target), prevented: false, preventDefault() { this.prevented = true; } }; on.keydown(e); return e; },
  };
}

test('key handler: presses the button, says why when it cannot, and rests while typing, in a dialog or the Test rig', () => {
  globalThis.requestAnimationFrame = (f) => f();
  const doc = fakeDoc();
  const said = [], ran = [];
  let frames = 0;
  doc.found['#view [data-act="frame"]'] = { click: () => frames++ };
  const hk = installHotkeys({ screen: () => 'compose', run: (id) => ran.push(id), say: (t) => said.push(t) }, doc);

  assert.ok(doc.press('f').prevented); assert.equal(frames, 1);
  doc.press('f', {}, { tagName: 'INPUT', type: 'range' }); assert.equal(frames, 2, 'a focused slider does not block F');
  doc.press('f', {}, { tagName: 'INPUT', type: 'text' }); assert.equal(frames, 2, 'typing an f in a name box');
  doc.press('f', { repeat: true }); assert.equal(frames, 2, 'holding F does it once');

  doc.found['.tr-wrap'] = {};
  assert.equal(pausedBy(key('w'), doc), 'test rig');
  doc.press('f'); doc.press('s'); doc.press('k', { ctrlKey: true });
  for (const k of ['a', 's', 'v', 'A', 'S', 'V']) doc.press(k); // WASD-style keys belong to the character
  assert.equal(frames, 2); assert.deepEqual(ran, [], 'nothing runs while the Test rig plays, not even A, S or V');
  delete doc.found['.tr-wrap'];

  doc.found['dialog[open]'] = {};
  doc.press('f'); assert.equal(frames, 2, 'a dialog on top keeps the keys');
  delete doc.found['dialog[open]'];

  doc.press('p'); assert.deepEqual(said, ['Pose by hand works on characters with a skeleton']);
  doc.found['#view #undoBtn'] = { disabled: true, click: () => assert.fail('disabled') };
  doc.press('z', { ctrlKey: true }); assert.equal(said.at(-1), 'Nothing to undo');

  doc.press('r'); doc.press('k', { ctrlKey: true }); doc.press('P', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(ran, ['still', 'palette', 'preview']);
  ran.length = 0;
  doc.press('a'); doc.press('s'); doc.press('v');
  assert.deepEqual(ran, ['shelf', 'share', 'history'], 'A, S and V in Compose');

  const picked = [];
  const card = (k, on) => ({ textContent: ` ${k} `, getAttribute: () => String(on), click: () => picked.push(k) });
  doc.found['#view [data-light]'] = [card('Garage', false), card('Desert dusk', true), card('Open sky', false)];
  doc.press(']'); doc.press('[');
  assert.deepEqual(picked, ['Open sky', 'Garage']); assert.equal(said.at(-1), 'Lighting: Garage');

  doc.press('?', { shiftKey: true }); assert.ok(doc.found.sheet.classList.contains('on'), '? opens the sheet');
  doc.press('Escape'); assert.ok(!doc.found.sheet.classList.contains('on'), 'Esc closes it');
  hk.act('frame'); assert.equal(frames, 3, 'the Ctrl+K palette runs shortcuts the same way');
  hk.off(); assert.equal(doc.on.keydown, undefined);
});
