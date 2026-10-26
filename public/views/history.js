// Version history (key V): every render of this model, newest first, each with the settings that made it. Pick a
// version to see it against the one before with a before-and-after slider, then "Use these settings" to go back to
// how that render was set up. Nothing is ever deleted; going back is undone by going back to a newer version.
import { $, esc, state, api, send, toast, findModel, focusModel, fileUrl, upsert, announce } from '../app.js';
import { changedNames, sliderKey } from '../lib/versions.js';

let root, m, list = [], after = null, before = null, t = 0.5;

const when = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const byN = (n) => list.find((v) => v.n === n);

export async function mount(el, { id }) {
  root = el; m = (id && findModel(id)) || focusModel(); t = 0.5;
  el.addEventListener('click', onClick);
  el.addEventListener('input', (e) => { if (e.target.id === 'hvT') { t = Number(e.target.value) / 100; wipe(); } if (e.target.id === 'hvBefore') { before = Number(e.target.value); draw(); } });
  el.addEventListener('keydown', (e) => { if (e.target.id === 'hvWipe') { const n = sliderKey(t, e.key, e.shiftKey); if (n !== t) { e.preventDefault(); t = n; wipe(); } } });
  el.addEventListener('pointerdown', (e) => {
    const w = e.target.closest('#hvWipe'); if (!w) return;
    const move = (ev) => { const r = w.getBoundingClientRect(); t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); wipe(); };
    move(e); w.setPointerCapture(e.pointerId);
    w.addEventListener('pointermove', move); w.addEventListener('pointerup', () => w.removeEventListener('pointermove', move), { once: true });
  });
  await load();
}
async function load() {
  list = [];
  if (m) try { list = await api(`/api/models/${m.id}/history`); } catch (e) { toast(e.message); }
  after = list.at(-1)?.n ?? null;
  before = list.length > 1 ? list.at(-2).n : null;
  draw();
}

function draw() {
  if (!root?.isConnected) return;
  const a = byN(after), b = byN(before);
  const head = `<div class="libhead"><div><h1 class="ph">Version history</h1><p class="sub">${m ? `${esc(m.name)} · every render is kept here with the settings that made it.` : 'Pick a model in the Library first.'}</p></div></div>`;
  if (!m) { root.innerHTML = `${head}<a class="btn pri" href="#/library">Open the Library</a>`; return; }
  if (!list.length) {
    root.innerHTML = `${head}<section class="card glass hv-empty"><h2 class="hv-h">No renders yet</h2><p class="sub">Render this model and each render shows up here, so you can compare them and go back to one.</p>
      <a class="btn pri huge" href="#/render/${esc(m.id)}">Go to Render</a></section>`;
    return;
  }
  const changes = b ? changedNames(b.settings, a.settings) : '';
  root.innerHTML = `${head}<section class="card glass hv">
    <div class="hv-chips" role="radiogroup" aria-label="Version to look at">${[...list].reverse().map((v) => `<button class="chip" type="button" role="radio" data-hv="${v.n}" aria-checked="${v.n === after}">Version ${v.n} · ${esc(when(v.at))}</button>`).join('')}</div>
    ${b ? `<div class="hv-wipe" id="hvWipe" role="slider" tabindex="0" aria-label="Before and after" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(t * 100)}">
        <img src="${fileUrl(m, b.picture)}" alt="Version ${b.n}"><img class="hv-after" id="hvAfter" src="${fileUrl(m, a.picture)}" alt="Version ${a.n}">
        <span class="hv-tag hv-l">Before · version ${b.n}</span><span class="hv-tag hv-r">After · version ${a.n}</span><div class="hv-line" id="hvLine"></div></div>
      <label class="fine" for="hvT">Drag to compare</label><input class="range" id="hvT" type="range" min="0" max="100" value="${Math.round(t * 100)}">
      <p class="sub">${changes ? `What changed since version ${b.n}: ${esc(changes)}.` : `Same settings as version ${b.n}.`}</p>`
      : `<img class="hv-one" src="${fileUrl(m, a.picture)}" alt="Version ${a.n}"><p class="sub">This is the only render so far. Render again to compare.</p>`}
    <div class="hv-act"><button class="btn pri huge" type="button" data-hv-use="${a.n}">Use the settings from version ${a.n}</button>
      <p class="fine">${esc(a.kind || 'Render')} made ${esc(new Date(a.at).toLocaleString())}. Puts the place, colours, camera and light back the way they were.</p></div>
    ${list.length > 2 && b ? `<details class="adjust"><summary>Compare with another version</summary><div class="field"><label for="hvBefore">Before</label>
      <select class="inp" id="hvBefore">${list.filter((v) => v.n !== after).map((v) => `<option value="${v.n}" ${v.n === before ? 'selected' : ''}>Version ${v.n} · ${esc(when(v.at))}</option>`).join('')}</select></div></details>` : ''}
  </section>`;
  wipe();
}
function wipe() {
  const x = Math.round(t * 100);
  const img = $('#hvAfter', root); if (!img) return;
  img.style.clipPath = `inset(0 0 0 ${x}%)`;
  $('#hvLine', root).style.left = `${x}%`;
  $('#hvWipe', root).setAttribute('aria-valuenow', String(x));
  const r = $('#hvT', root); if (r && Number(r.value) !== x) r.value = x;
  r?.style.setProperty('--p', `${x}%`);
}

async function onClick(e) {
  const c = e.target.closest('[data-hv]');
  if (c) {
    after = Number(c.dataset.hv);
    const older = list.filter((v) => v.n < after);
    before = (older.at(-1) || list.find((v) => v.n !== after))?.n ?? null;
    return draw();
  }
  const u = e.target.closest('[data-hv-use]');
  if (!u) return;
  try {
    const r = await send(`/api/models/${m.id}/history/${u.dataset.hvUse}`, 'POST', {});
    m = upsert(r.model); state.settings = r.settings;
    toast(`The settings from version ${u.dataset.hvUse} are back. Open Compose to see them, or render again.`, 'ok');
    announce(`Settings from version ${u.dataset.hvUse} restored`);
  } catch (err) { toast(err.message); }
}

export function update() {}
export function unmount() { root = null; }
