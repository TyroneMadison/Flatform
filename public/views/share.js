// Share: one big button makes a link, then copy it, pick how long it works, or turn it off. Until the share
// Worker is deployed and its address is set, links are practice links that only work inside Flatform.
import { esc, state, api, send, toast, findModel, focusModel, fileUrl, thumbOf, announce } from '../app.js';

export const EXPIRY = { 1: '1 day', 7: '7 days', forever: 'Forever' };
export const expiryKey = (s) => (!s.expiresAt ? 'forever' : Math.round((Date.parse(s.expiresAt) - Date.parse(s.createdAt)) / 864e5) <= 1 ? '1' : '7');
let root, m, links = [], title = '';

export async function mount(el, { id }) {
  root = el; m = (id && findModel(id)) || focusModel(); title = m?.name || '';
  el.addEventListener('click', onClick); el.addEventListener('input', (e) => { if (e.target.id === 'shTitle') title = e.target.value; });
  await load();
}
async function load() { try { links = await api('/api/shares'); } catch (e) { toast(e.message); links = []; } draw(); }

const mine = () => links.filter((s) => s.modelId === m?.id && !s.expired);
function draw() {
  if (!root?.isConnected) return;
  const ready = m && (m.renders?.poster || m.renders?.video);
  const cur = mine().at(-1);
  root.innerHTML = `<div class="libhead"><div><h1 class="ph">Share</h1><p class="sub">${m ? esc(m.name) : 'Pick a model in the Library first.'}</p></div></div>
  <section class="share">
    <div class="card glass">
      ${m && thumbOf(m) ? `<img class="sh-thumb" src="${thumbOf(m)}" alt="">` : ''}
      ${!ready ? `<p class="sub">Render this model first. The share page shows its picture or video.</p>${m ? `<a class="btn pri" href="#/compose/${esc(m.id)}/render" title="Open Compose at its render options">Render it in Compose</a>` : ''}`
        : !cur ? `<button class="btn pri huge" type="button" data-sh="make">Make a share link</button>`
        : `<p class="label">Your link</p>
          <div class="sh-link"><code id="shUrl">${esc(cur.url)}</code><button class="btn pri" type="button" data-sh="copy" data-url="${esc(cur.url)}">Copy</button></div>
          ${cur.mock ? `<p class="fine">Practice link. It starts working for other people once the share page is set up (not done yet).</p>` : ''}
          <p class="label">Link works for</p>
          <div class="seg" role="radiogroup" aria-label="Link works for">${Object.entries(EXPIRY).map(([k, l]) => `<button class="chip" type="button" role="radio" aria-checked="${expiryKey(cur) === k}" data-sh="expiry" data-days="${k}" data-id="${esc(cur.id)}">${l}</button>`).join('')}</div>
          <p class="fine">${cur.expiresAt ? `Stops working ${esc(new Date(cur.expiresAt).toLocaleString())}.` : 'Works until you turn it off.'}</p>
          <button class="btn dangerbtn" type="button" data-sh="off" data-id="${esc(cur.id)}">Turn off link</button>`}
      ${ready ? `<details class="adjust"><summary>Adjust (more options)</summary>
        <div class="field"><label for="shTitle">Title on the share page</label><input id="shTitle" maxlength="120" value="${esc(title)}"></div>
        <p class="fine">Shares ${m.renders?.video ? 'the video and the poster picture' : 'the poster picture'}. New links use this title.</p>
        ${cur ? `<button class="btn sec sm" type="button" data-sh="make">Make another link</button>` : ''}</details>` : ''}
    </div>
    ${links.length ? `<div class="card glass"><h2 class="label">All share links</h2><ul class="sh-list">${links.map((s) => `<li class="${s.expired ? 'expired' : ''}">
      <span>${esc(s.title)}</span><code>${esc(s.url)}</code><span class="fine">${s.expired ? 'Ended' : s.expiresAt ? `Until ${esc(new Date(s.expiresAt).toLocaleDateString())}` : 'Forever'}</span>
      <button class="btn ghostbtn sm" type="button" data-sh="off" data-id="${esc(s.id)}">${s.expired ? 'Remove' : 'Turn off'}</button></li>`).join('')}</ul></div>` : ''}
  </section>`;
}

async function onClick(e) {
  const b = e.target.closest('[data-sh]'); if (!b) return;
  const a = b.dataset.sh;
  try {
    if (a === 'make') {
      await send('/api/shares', 'POST', { modelId: m.id, title: title || m.name, video: m.renders?.video || null, poster: m.renders?.poster || null, expiresInDays: 7 });
      announce('Share link made'); await load();
    } else if (a === 'copy') {
      await navigator.clipboard.writeText(b.dataset.url); toast('Link copied.', 'ok');
    } else if (a === 'expiry') {
      await send(`/api/shares/${encodeURIComponent(b.dataset.id)}`, 'PATCH', { expiresInDays: b.dataset.days === 'forever' ? null : Number(b.dataset.days) }); await load();
    } else if (a === 'off') {
      await send(`/api/shares/${encodeURIComponent(b.dataset.id)}`, 'DELETE'); toast('Link turned off.', 'ok'); await load();
    }
  } catch (err) { toast(err.message); }
}

export function update() {}
export function unmount() { root = null; }
