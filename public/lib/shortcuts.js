// Every keyboard shortcut in Flatform, in one list. The cheat sheet (?), the Ctrl+K palette and the key handler all
// read it, so a key is written down once. where: the screens it works on ('*' everywhere). click: the button it
// presses on that screen; none: what to say when that button isn't there or can't be used right now.
// editable: can be changed in Settings > Shortcuts (hotkeys.js keeps the person's choice).
export const SHORTCUTS = [
  { id: 'help', keys: '?', label: 'Show or hide this list of keys', where: '*' },
  { id: 'palette', keys: 'Ctrl+K', label: 'Find anything, reopen recent work', where: '*' },
  { id: 'preview', keys: 'Ctrl+Shift+P', label: 'Client preview (clean full screen)', where: '*', editable: true },
  { id: 'finish', keys: 'Ctrl+Shift+H', label: 'Check before export', where: '*', editable: true },
  { id: 'share', keys: 'S', label: 'Share: send someone a link', where: '*' },
  { id: 'history', keys: 'V', label: 'Version history of your renders', where: '*' },
  { id: 'shelf', keys: 'A', label: 'Add things: people, cars and props', where: ['compose'] },
  { id: 'still', keys: 'R', label: 'Render a still picture', where: ['compose'] },
  { id: 'turntable', keys: 'T', label: 'Render a 360° turntable', where: ['compose'] },
  { id: 'undo', keys: 'Ctrl+Z', label: 'Undo', where: ['compose'], click: '#undoBtn', none: 'Nothing to undo' },
  { id: 'redo', keys: 'Ctrl+Shift+Z', also: ['Ctrl+Y'], label: 'Redo', where: ['compose'], click: '#redoBtn', none: 'Nothing to redo' },
  { id: 'reset', keys: 'Ctrl+Shift+N', label: 'Reset scene (asks first, and you can undo it)', where: ['compose'], click: '[data-act="reset-scene"]', none: 'Open a model in Compose first' },
  { id: 'frame', keys: 'F', label: 'Frame all: fit the whole model in view', where: ['compose'], click: '[data-act="frame"]', none: 'Load a model first' },
  { id: 'envNext', keys: ']', label: 'Next lighting place', where: ['compose'], cycle: 1 },
  { id: 'envPrev', keys: '[', label: 'Previous lighting place', where: ['compose'], cycle: -1 },
  { id: 'pose', keys: 'P', label: 'Pose by hand on or off', where: ['compose'], click: '[data-hp="toggle"]', none: 'Pose by hand works on characters with a skeleton' },
  { id: 'testrig', keys: 'G', label: 'Test rig: play the character', where: ['compose'], click: '[data-tr="start"]', none: 'Test rig works on characters with a skeleton' },
  { id: 'export', keys: 'Ctrl+E', label: 'Export the model as a GLB file', where: ['compose'], click: '[data-act="export-glb"]', none: 'Export is not ready yet. Choose a handoff folder in the render area first.' },
];

// Keys something else already owns: the window menu (reload, zoom, devtools, close), text editing, Ctrl+1 to 9
// (workspaces), 1 to 9 (saved camera spots in Compose), Esc and the arrows (close, move sliders and frames).
export const TAKEN = ['Ctrl+R', 'Ctrl+Shift+R', 'F5', 'Ctrl+W', 'Ctrl+Q', 'Ctrl+Shift+I', 'F11', 'F12', 'Ctrl+0', 'Ctrl+=', 'Ctrl+-',
  'Ctrl+C', 'Ctrl+X', 'Ctrl+V', 'Ctrl+A', 'Escape', 'Enter', ' ', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab',
  ...'123456789'.split('').flatMap((d) => [d, `Ctrl+${d}`])];

export const byId = (id) => SHORTCUTS.find((s) => s.id === id);
/** The keys for one shortcut, as shown to people ('' when unknown). keys: the person's own choices for editable ones. */
export const keyOf = (id, keys = {}) => keys[id] || byId(id)?.keys || '';
export const worksOn = (s, screen) => s.where === '*' || s.where.includes(screen);
const overlap = (a, b) => a.where === '*' || b.where === '*' || a.where.some((w) => b.where.includes(w));

/** 'Ctrl+Shift+Z' style for a key event. Shift is left out for symbols like ? and [ that need it on some keyboards. */
export function comboOf(e) {
  const k = e.key?.length === 1 ? e.key.toUpperCase() : e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
  const symbol = k.length === 1 && !/[A-Z0-9 ]/.test(k);
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey && !symbol ? 'Shift' : '', e.altKey ? 'Alt' : '', k].filter(Boolean).join('+');
}

/** The shortcut a key event asks for on this screen, or null. */
export function shortcutFor(e, screen, keys = {}) {
  const c = comboOf(e);
  return c ? SHORTCUTS.find((s) => worksOn(s, screen) && [keyOf(s.id, keys), ...(s.also || [])].includes(c)) || null : null;
}

/** Pairs of shortcut ids that share a key on the same screen, plus [id, key] for any that use a TAKEN key. */
export function clashes(list = SHORTCUTS, keys = {}) {
  const out = [];
  const all = (s) => [keys[s.id] || s.keys, ...(s.also || [])];
  list.forEach((a, i) => {
    for (const k of all(a)) if (TAKEN.includes(k)) out.push([a.id, k]);
    for (const b of list.slice(i + 1)) if (overlap(a, b) && all(a).some((k) => all(b).includes(k))) out.push([a.id, b.id]);
  });
  return out;
}

/** Whether the person is typing: then letters, Ctrl+Z and friends belong to the text box, not to Flatform. */
export function isTyping(t) {
  if (!t?.tagName) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes((t.type || 'text').toLowerCase());
}

/** Index of the next item when stepping dir (1 or -1) through n items from i (-1 when none is picked yet). */
export const cycle = (n, i, dir) => (n ? (i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n) : -1);
