// Hotkey overlay and key handler. Press ? (or hold Ctrl on its own for a peek) for a cheat sheet of the keys on the
// current screen. The keys themselves live in shortcuts.js; the editable ones (preview, finish) can be changed in
// Settings > Shortcuts and are kept on this computer (localStorage), so nothing here touches the shared settings file.
// No key does anything while typing in a text box, while a dialog is open or while the Test rig is playing.
import { SHORTCUTS, comboOf, shortcutFor, worksOn, keyOf, isTyping, cycle, byId } from './shortcuts.js';
export { comboOf };
export const ACTIONS = Object.fromEntries(SHORTCUTS.filter((s) => s.editable).map((s) => [s.id, { label: s.label, key: s.keys }]));
// Mouse moves and keys a screen handles on its own, shown next to the shortcuts.
const FIXED = {
  all: [['Ctrl+1 to Ctrl+9', 'Switch workspace']],
  drop: [['Ctrl+V', 'Paste a photo'], ['Enter', 'Choose photos']],
  setup: [['Ctrl+V', 'Paste a photo']],
  generate: [['Ctrl+V', 'Add a photo to the queue']],
  compose: [['Drag', 'Spin the model'], ['Scroll', 'Zoom'], ['Right drag', 'Move the view'], ['1 to 9', 'Jump to a saved camera spot']],
  render: [['Arrow keys', 'Move the before and after line']],
  finish: [['Arrow keys', 'Move the before and after line'], ['Shift+Arrow', 'Move it further']],
  spin: [['Drag a frame', 'Reorder'], ['Shift+click', 'Pick many frames'], ['Delete', 'Remove picked frames']],
  preview: [['Drag', 'Look around'], ['T', 'Turntable on or off'], ['Esc', 'Leave preview']],
};
const STORE = 'flatform.hotkeys';
export function loadKeys(storage = globalThis.localStorage) {
  let saved = {}; try { saved = JSON.parse(storage?.getItem(STORE) || '{}'); } catch { /* reset */ }
  return { show: saved.show !== false, keys: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, validCombo(saved.keys?.[k]) ? saved.keys[k] : a.key])) };
}
export const saveKeys = (v, storage = globalThis.localStorage) => storage?.setItem(STORE, JSON.stringify(v));

/** 'Ctrl+Shift+P' style: at least one of Ctrl/Alt plus one letter, digit or F-key. */
export function validCombo(c) {
  if (typeof c !== 'string') return false;
  const parts = c.split('+'); const key = parts.pop();
  return parts.length > 0 && parts.every((p) => ['Ctrl', 'Shift', 'Alt'].includes(p)) && parts.some((p) => p !== 'Shift') && /^([A-Z0-9]|F\d{1,2})$/.test(key) && new Set(parts).size === parts.length;
}
export const matches = (e, combo) => comboOf(e) === combo;
export function conflicts(keys) { const seen = {}; const out = []; for (const [a, c] of Object.entries(keys)) { if (seen[c]) out.push([seen[c], a]); seen[c] = a; } return out; }

/** Rows for the overlay on one screen: [keys, what they do]. */
export function bindingsFor(screen, keys = loadKeys().keys) {
  return [...SHORTCUTS.filter((s) => worksOn(s, screen)).map((s) => [[keyOf(s.id, keys), ...(s.also || [])].join(' or '), s.label]), ...(FIXED[screen] || []), ...FIXED.all];
}
/** Why keys are paused right now ('' when they work): typing, a dialog on top, or the Test rig playing. */
export function pausedBy(e, doc = document) {
  if (isTyping(e.target)) return 'typing';
  if (doc.querySelector('.tr-wrap')) return 'test rig';
  if (doc.querySelector('dialog[open]')) return 'dialog';
  return '';
}

/** Wires the overlay and every shortcut. ctx: { screen(), run(id), say(text) }; run handles the ones that are not a
 * button press (palette, preview, finish, still, turntable). Returns { act(id), off() }. */
export function installHotkeys(ctx, doc = document) {
  const el = doc.createElement('div');
  el.className = 'hk'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Keyboard shortcuts'); el.hidden = true;
  doc.body.append(el);
  let ctrlTimer = null, peek = false;
  const view = (sel) => doc.querySelector(`#view ${sel}`);
  const show = (fromCtrl) => {
    const prefs = loadKeys(); if (fromCtrl && !prefs.show) return;
    peek = fromCtrl;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    el.innerHTML = `<h2>Keyboard shortcuts</h2><dl>${bindingsFor(ctx.screen(), prefs.keys).map(([k, t]) => `<div><dt><kbd>${esc(k)}</kbd></dt><dd>${esc(t)}</dd></div>`).join('')}</dl>
      <p>Keys rest while you type in a box or play the Test rig. Change some in Settings, Shortcuts.</p>
      <button class="btn sm ghostbtn" type="button" title="Hide this list (? or Esc)">Close</button>`;
    el.querySelector('button').onclick = hide;
    el.hidden = false; requestAnimationFrame(() => el.classList.add('on'));
  };
  const hide = () => { clearTimeout(ctrlTimer); ctrlTimer = null; peek = false; el.classList.remove('on'); setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 160); };
  const shown = () => el.classList.contains('on');
  // Runs one shortcut, from a key or from the Ctrl+K palette.
  const act = (id) => {
    const s = byId(id);
    if (!s) return;
    if (id === 'help') return shown() ? hide() : show(false);
    if (s.click) { const b = view(s.click); if (!b || b.disabled) return ctx.say(s.none); return b.click(); }
    if (s.cycle) {
      const cards = [...doc.querySelectorAll('#view [data-light]')];
      if (!cards.length) return ctx.say('Load a model first');
      const next = cards[cycle(cards.length, cards.findIndex((b) => b.getAttribute('aria-checked') === 'true'), s.cycle)];
      next.click(); return ctx.say(`Lighting: ${next.textContent.trim()}`);
    }
    ctx.run(id);
  };
  const down = (e) => {
    if (pausedBy(e, doc)) return;
    if (e.key === 'Escape' && shown()) { e.preventDefault(); hide(); return; }
    if (e.key === 'Control' && !e.repeat) { if (!shown()) ctrlTimer = setTimeout(() => show(true), 700); return; }
    clearTimeout(ctrlTimer); ctrlTimer = null;
    const s = shortcutFor(e, ctx.screen(), loadKeys().keys);
    if (!s) { if (peek && e.key !== 'Shift') hide(); return; }
    e.preventDefault();
    if (e.repeat) return; // holding a key down does it once
    if (peek && s.id !== 'help') hide();
    act(s.id);
  };
  const up = (e) => { if (e.key === 'Control' && peek) hide(); else if (e.key === 'Control') { clearTimeout(ctrlTimer); ctrlTimer = null; } };
  doc.addEventListener('keydown', down); doc.addEventListener('keyup', up); globalThis.addEventListener?.('blur', () => { if (peek) hide(); });
  return { act, off: () => { doc.removeEventListener('keydown', down); doc.removeEventListener('keyup', up); el.remove(); } };
}
