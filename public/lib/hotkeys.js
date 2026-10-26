// Hotkey overlay: hold ? (or hold Ctrl on its own) to fade in a cheat sheet for the current screen; it fades out on
// release. The keys Flatform owns (preview, overlay) can be changed in Settings > Shortcuts and are kept on this
// computer (localStorage), so nothing here touches the shared settings file.
export const ACTIONS = { preview: { label: 'Client preview (clean full screen)', key: 'Ctrl+Shift+P' }, finish: { label: 'Check before export', key: 'Ctrl+Shift+H' } };
// Single keys (no Ctrl), ignored while typing. A works in Compose; V and S on any screen with a model. Taken
// elsewhere, so never used here: F (frame all), T (preview turntable), 1 to 9 (camera spots), ? (this list).
export const SINGLE_KEYS = { shelf: 'A', history: 'V', share: 'S' };
export const TAKEN_KEYS = ['F', 'T', '1', '2', '3', '4', '5', '6', '7', '8', '9', '?'];
const FIXED = {
  all: [['Hold ?', 'Show this list'], [SINGLE_KEYS.history, 'Version history'], [SINGLE_KEYS.share, 'Share'], ['Ctrl+1 to Ctrl+9', 'Switch workspace']],
  drop: [['Ctrl+V', 'Paste a photo'], ['Enter', 'Choose photos']],
  setup: [['Ctrl+V', 'Paste a photo']],
  generate: [['Ctrl+V', 'Add a photo to the queue']],
  compose: [[SINGLE_KEYS.shelf, 'Add things (people, cars and props)'], ['F', 'Fit the whole model in view'], ['Drag', 'Spin the model'], ['Scroll', 'Zoom'], ['Right drag', 'Move the view'], ['Ctrl+Z', 'Undo'], ['Ctrl+Shift+Z', 'Redo']],
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
export function comboOf(e) {
  const k = e.key?.length === 1 ? e.key.toUpperCase() : e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', k].filter(Boolean).join('+');
}
export const matches = (e, combo) => comboOf(e) === combo;
export function conflicts(keys) { const seen = {}; const out = []; for (const [a, c] of Object.entries(keys)) { if (seen[c]) out.push([seen[c], a]); seen[c] = a; } return out; }

/** Rows for the overlay on one screen. */
export function bindingsFor(screen, keys = loadKeys().keys) {
  return [...(FIXED[screen] || []), ...Object.entries(ACTIONS).map(([k, a]) => [keys[k], a.label]), ...FIXED.all];
}

/** Wires the overlay and the action keys. ctx: { screen(), run(action) }. Returns a cleanup function. */
export function installHotkeys(ctx, doc = document) {
  const el = doc.createElement('div');
  el.className = 'hk'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Keyboard shortcuts'); el.hidden = true;
  doc.body.append(el);
  let ctrlTimer = null;
  const typing = (e) => e.target?.closest?.('input, textarea, select, [contenteditable=true]');
  const show = () => {
    const prefs = loadKeys(); if (!prefs.show) return;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    el.innerHTML = `<h2>Shortcuts</h2><dl>${bindingsFor(ctx.screen(), prefs.keys).map(([k, t]) => `<div><dt><kbd>${esc(k)}</kbd></dt><dd>${esc(t)}</dd></div>`).join('')}</dl><p>Change these in Settings, Shortcuts.</p>`;
    el.hidden = false; requestAnimationFrame(() => el.classList.add('on'));
  };
  const hide = () => { clearTimeout(ctrlTimer); ctrlTimer = null; el.classList.remove('on'); setTimeout(() => { if (!el.classList.contains('on')) el.hidden = true; }, 160); };
  const down = (e) => {
    if (typing(e)) return;
    if (e.key === '?' && !e.repeat) { e.preventDefault(); show(); return; }
    if (e.key === 'Control' && !e.repeat) { ctrlTimer = setTimeout(show, 700); return; }
    clearTimeout(ctrlTimer); ctrlTimer = null; if (e.key !== '?' && e.key !== 'Shift' && el.classList.contains('on') && e.key !== 'Control') hide();
    const keys = loadKeys().keys;
    for (const [action, combo] of Object.entries(keys)) if (matches(e, combo)) { e.preventDefault(); ctx.run(action); return; }
    const single = !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && e.key?.length === 1 && e.key.toUpperCase();
    for (const action of ['history', 'share']) if (single === SINGLE_KEYS[action]) { e.preventDefault(); ctx.run(action); return; }
  };
  const up = (e) => { if (e.key === '?' || e.key === '/' || e.key === 'Shift' || e.key === 'Control') hide(); };
  doc.addEventListener('keydown', down); doc.addEventListener('keyup', up); globalThis.addEventListener?.('blur', hide);
  return () => { doc.removeEventListener('keydown', down); doc.removeEventListener('keyup', up); el.remove(); };
}
