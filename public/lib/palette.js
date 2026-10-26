// Ctrl+K: a small "find anything" box. Recent work first, then the main screens and every shortcut. Type to narrow,
// Enter to open.

/** Commands whose label (or hint) has every typed word, in their given order. cmd: { label, hint?, run }. */
export function filterCommands(cmds, query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return cmds.filter((c) => words.every((w) => `${c.label} ${c.hint || ''}`.toLowerCase().includes(w)));
}
export const isPaletteKey = (e) => (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key?.toLowerCase() === 'k';

/** Wires the palette dialog in index.html. commands(): the list to show each time it opens. */
export function installPalette({ commands }, doc = document) {
  const dlg = doc.getElementById('palette');
  const input = doc.getElementById('paletteInput');
  const list = doc.getElementById('paletteList');
  let shown = [];
  let pick = 0;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const draw = () => {
    shown = filterCommands(commands(), input.value);
    pick = Math.min(pick, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length ? shown.map((c, i) => `<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${i === pick}" title="${esc(c.title || c.label)}">
      ${c.thumb ? `<img src="${esc(c.thumb)}" alt="">` : '<span class="pal-ico" aria-hidden="true"></span>'}<b>${esc(c.label)}</b>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</li>`).join('')
      : '<li class="muted" aria-disabled="true">Nothing matches. Try fewer letters.</li>';
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${pick}` : '');
  };
  const run = (i) => { const c = shown[i]; if (!c) return; dlg.close(); c.run(); };
  const open = () => { if (dlg.open) return dlg.close(); input.value = ''; pick = 0; draw(); dlg.showModal(); input.focus(); };
  input.addEventListener('input', () => { pick = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick = (pick + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); draw(); }
    if (e.key === 'Enter') { e.preventDefault(); run(pick); }
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) run(Number(li.dataset.i)); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // a click outside the box closes it
  return { open }; // Ctrl+K itself is wired with the other shortcuts (hotkeys.js)
}
