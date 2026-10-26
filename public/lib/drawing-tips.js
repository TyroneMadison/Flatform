// Tips for a great model: the card beside the Drop screen's drop zone in Warframe mode (views/drop.js). Short drawing
// rules, Download template (the bundled PDF from the drawing kit) and, once a dropped photo turned out to be a template
// page (views/drawing.js reads it), Template detected with the sheet id and the views found. Opens and closes like
// a <details>; closed is remembered.

export const TIPS_KEY = 'flatform.drawingTipsClosed';
export const TEMPLATE_URL = '/template/Flatform-Drawing-Template.pdf';
const VIEW_WORD = { front: 'Front', back: 'Back', left: 'Left side', right: 'Right side' };

const svg = (d) => `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const TIPS = [
  { text: 'A front view is a must', icon: svg('<circle cx="10" cy="4" r="2"/><path d="M10 6v6M10 8l-4 4M10 8l4 4M10 12l-3 6M10 12l3 6"/>') },
  { text: 'Up to 4 views: front, back, left and right', icon: svg('<path d="M4 10a6 6 0 1 0 2-4.5M4 3v3h3"/>') },
  { text: 'Plain white or light background', icon: svg('<rect x="3" y="3" width="14" height="14" rx="2"/>') },
  { text: 'Dark, clean lines and flat colors', icon: svg('<path d="M4 16L14 6l2 2L6 18H4z"/>') },
  { text: 'Arms out a little, with gaps at the armpits and legs', icon: svg('<path d="M7 5v10M13 5v10"/><path d="M4 10h2M14 10h2" stroke-dasharray="1 1.5"/>') },
  { text: 'One character per sheet, whole body in view', icon: svg('<path d="M3 6V3h3M14 3h3v3M17 14v3h-3M6 17H3v-3"/><circle cx="10" cy="7" r="1.6"/><path d="M10 9v4M8 16l2-3 2 3"/>') },
];

/** True when the card was closed before. store: localStorage or anything with getItem. */
export const isClosed = (store) => { try { return store?.getItem(TIPS_KEY) === '1'; } catch { return false; } };
export function remember(store, closed) {
  try { if (closed) store?.setItem(TIPS_KEY, '1'); else store?.removeItem(TIPS_KEY); } catch { /* private window: not kept */ }
}

/** What Template detected shows, from the drawing kit's precheck(): { sheet, views } or null when no sheet was read. */
export function foundOf(r) {
  return r?.sheet ? { sheet: r.sheet, views: r.views.slice() } : null;
}
/** "Front and Back found", "Front, Back and Left side found", or a nudge when the front box is not drawn yet. */
export function viewsText(views) {
  const w = views.map((v) => VIEW_WORD[v] || v);
  if (!w.length) return 'No views found yet. Draw on the FRONT page first.';
  return `${w.length > 1 ? `${w.slice(0, -1).join(', ')} and ${w.at(-1)}` : w[0]} found`;
}

/** The card's markup. found: foundOf() or null; closed: start folded. esc: the page's HTML escaper. */
export function tipsCard({ found = null, closed = false, esc = String } = {}) {
  const detected = found ? `<div class="dt-found" role="status"><span class="dt-ok" aria-hidden="true">✓</span>
    <div><b>Template detected</b><span>Sheet <span class="mono">${esc(found.sheet)}</span> · ${esc(viewsText(found.views))}</span></div>
    <button class="btn ghostbtn dt-open" type="button" data-act="kit" title="Open the check for this drawing again">See check</button></div>` : '';
  return `<details class="dtips glass" id="dtips"${closed ? '' : ' open'}>
    <summary title="Show or hide the drawing tips"><span class="dt-tag">Tips for a great model</span><span class="dt-chev" aria-hidden="true"></span></summary>
    ${detected}
    <ul class="dt-list">${TIPS.map((t) => `<li><span class="dt-ic">${t.icon}</span><span>${t.text}</span></li>`).join('')}</ul>
    <div class="dt-dl"><div><b>Best results: use our template</b><span>7 pages to print. Only the FRONT page is a must.</span></div>
      <a class="btn pri" href="${TEMPLATE_URL}" download="Flatform-Drawing-Template.pdf" title="Save the 7 page drawing template (PDF) to print on US Letter paper">Download template</a></div>
  </details>`;
}
