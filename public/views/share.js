// Share (key S): one big button makes a link, then copy it, pick how long it works, or turn it off. Until the
// share page (share-worker/) is deployed and its address and password are saved here, the screen says sharing isn't
// set up yet and offers only that (SHARE-DEPLOY.md has the steps). Links made before then stay practice links.
import { esc, state, api, send, toast, findModel, focusModel, fileUrl, thumbOf, announce } from '../app.js';

export const EXPIRY = { 1: '1 day', 7: '7 days', forever: 'Forever' };
export const expiryKey = (s) => (!s.expiresAt ? 'forever' : Math.round((Date.parse(s.expiresAt) - Date.parse(s.createdAt)) / 864e5) <= 1 ? '1' : '7');
let root, m, links = [], title = '', setup = { ready: false }, setupOpen = false, latest = null;
// The picture a link shows: the poster, else the newest render in version history (a still has no poster).
const picture = () => m?.renders?.poster || latest;

export async function mount(el, { id }) {
  root = el; m = (id && findModel(id)) || focusModel(); title = m?.name || '';
  el.addEventListener('click', onClick); el.addEventListener('input', (e) => { if (e.target.id === 'shTitle') title = e.target.value; });
  el.addEventListener('submit', async (e) => {
    if (e.target.id !== 'shSetup') return;
    e.preventDefault();
    const f = new FormData(e.target);
    try { setup = await send('/api/shares/setup', 'POST', { url: f.get('url'), token: f.get('token') }); setupOpen = false; toast('Sharing is on.', 'ok'); announce('Sharing is on'); draw(); } catch (err) { toast(err.message); }
  });
  await load();
}
async function load() {
  try {
    let hist;
    [links, setup, hist] = await Promise.all([api('/api/shares'), api('/api/shares/setup'), m ? api(`/api/models/${m.id}/history`) : []]);
    latest = hist.at(-1)?.picture || null;
  } catch (e) { toast(e.message); links = []; }
  draw();
}

function notSetUp() {
  return `<div class="card glass sh-off">
    <h2 class="hv-h">Sharing isn't set up yet</h2>
    <p class="sub">Then Share makes a link anyone can open to see your render. They need no account. You only set it up once.</p>
    ${setupOpen ? `<form class="sh-setup" id="shSetup">
        <p class="fine">Paste the two things you get when the share page is set up. The steps are in SHARE-DEPLOY.md.</p>
        <div class="field"><label for="shAddr">Share page address</label><input class="inp mono" id="shAddr" name="url" required placeholder="https://flatform-share.yourname.workers.dev" spellcheck="false" autocomplete="off" title="The web address of your share page"></div>
        <div class="field"><label for="shPass">Share password</label><input class="inp mono" id="shPass" name="token" type="password" required minlength="16" autocomplete="off" title="The password for your share page (16 or more letters)"></div>
        <button class="btn pri" type="submit" title="Save these and turn sharing on">Turn on sharing</button>
      </form>` : '<button class="btn pri huge" type="button" data-sh="setup" title="Set up sharing on this computer">Turn on sharing</button>'}
  </div>`;
}

const mine = () => links.filter((s) => s.modelId === m?.id && !s.expired && !s.mock); // practice links only in the list below
function draw() {
  if (!root?.isConnected) return;
  const ready = m && (picture() || m.renders?.video);
  const cur = mine().at(-1);
  root.innerHTML = `<div class="libhead"><div><h1 class="ph">Share</h1><p class="sub keep">${m ? esc(m.name) : 'Pick a model in the Library first.'}</p></div></div>
  <section class="share">
    ${!setup.ready ? notSetUp() : `<div class="card glass">
      ${m && (picture() || thumbOf(m)) ? `<img class="sh-thumb" src="${picture() ? fileUrl(m, picture()) : thumbOf(m)}" alt="">` : ''}
      ${!ready ? `<p class="sub keep">Render this model first. The share page shows its picture or video.</p>${m ? `<a class="btn pri" href="#/compose/${esc(m.id)}/render" title="Open the Scene step at Render">Render it</a>` : ''}`
        : !cur ? `<button class="btn pri huge" type="button" data-sh="make" title="Make a link anyone can open">Make a link</button>`
        : `<p class="label">Your link</p>
          <div class="sh-link"><code id="shUrl">${esc(cur.url)}</code><button class="btn pri" type="button" data-sh="copy" data-url="${esc(cur.url)}" title="Copy the link so you can paste it">Copy</button></div>
          <p class="label">Link works for</p>
          <div class="seg" role="radiogroup" aria-label="Link works for">${Object.entries(EXPIRY).map(([k, l]) => `<button class="chip" type="button" role="radio" aria-checked="${expiryKey(cur) === k}" data-sh="expiry" data-days="${k}" data-id="${esc(cur.id)}" title="The link works for ${l.toLowerCase()}">${l}</button>`).join('')}</div>
          <p class="fine keep">${cur.expiresAt ? `Stops working ${esc(new Date(cur.expiresAt).toLocaleString())}.` : 'Works until you turn it off.'}</p>
          <button class="btn dangerbtn" type="button" data-sh="off" data-id="${esc(cur.id)}" title="Stop this link from working">Turn off link</button>`}
      ${ready ? `<details class="adjust"><summary>More options</summary>
        <div class="field"><label for="shTitle">Title on the share page</label><input id="shTitle" maxlength="120" value="${esc(title)}" title="The name people see on the share page"></div>
        <p class="fine">Shares ${m.renders?.video ? 'the video and the main picture' : 'the main picture'}. New links use this title.</p>
        ${cur ? `<button class="btn sec sm" type="button" data-sh="make" title="Make one more link with this title">Make another link</button>` : ''}
        <p class="fine">Sharing goes to ${esc(setup.url || '')}.</p><button class="btn ghostbtn sm" type="button" data-sh="unsetup" title="Turn off sharing on this computer. Old links keep working.">Turn off sharing</button></details>` : ''}
    </div>`}
    ${links.length ? `<div class="card glass"><h2 class="label">All share links</h2><ul class="sh-list">${links.map((s) => `<li class="${s.expired ? 'expired' : ''}">
      <span>${esc(s.title)}</span><code>${esc(s.url)}</code><span class="fine keep">${s.mock ? 'Practice link (made before sharing was on) · ' : ''}${s.expired ? 'Ended' : s.expiresAt ? `Until ${esc(new Date(s.expiresAt).toLocaleDateString())}` : 'Forever'}</span>
      <button class="btn ghostbtn sm" type="button" data-sh="off" data-id="${esc(s.id)}" title="${s.expired ? 'Take it off this list' : 'Stop this link from working'}">${s.expired ? 'Remove' : 'Turn off'}</button></li>`).join('')}</ul></div>` : ''}
  </section>`;
}

async function onClick(e) {
  const b = e.target.closest('[data-sh]'); if (!b) return;
  const a = b.dataset.sh;
  try {
    if (a === 'setup') { setupOpen = true; draw(); root.querySelector('#shAddr')?.focus(); return; }
    if (a === 'unsetup') { setup = await send('/api/shares/setup', 'DELETE'); toast('Sharing is off on this computer. Links already made keep working.', 'ok'); draw(); return; }
    if (a === 'make') {
      await send('/api/shares', 'POST', { modelId: m.id, title: title || m.name, video: m.renders?.video || null, poster: picture(), expiresInDays: 7 });
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
