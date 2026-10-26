// Usage: what Flatform has cost in time, money and disk. Three big numbers with bars, then spend by service.
import { esc, api, send, toast, confirmDialog } from '../app.js';

const LIMIT_KEY = 'flatform.spendLimit';
export const human = (b) => (b < 1048576 ? `${Math.round(b / 1024)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
export const dur = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
export const pct = (a, b) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
const SERVICE = { tripo: 'Tripo', '3daistudio': '3D AI Studio' };
const CACHE = { cache: 'Temporary files', tmp: 'Work files', thumbs: 'Small previews' };
let root, u = null;

export async function mount(el) {
  root = el;
  el.addEventListener('click', onClick); el.addEventListener('change', onChange);
  await load();
}
async function load() { try { u = await api('/api/usage'); } catch (e) { toast(e.message); } draw(); }
const limit = () => Number(localStorage.getItem(LIMIT_KEY)) || 50;
const bar = (p, label) => `<div class="ubar" role="img" aria-label="${label}"><span style="width:${p}%"></span></div>`;

function draw() {
  if (!root?.isConnected) return;
  if (!u) { root.innerHTML = `<h1 class="ph">Usage</h1><p class="sub">Loading…</p>`; return; }
  const svc = Object.entries(u.spend?.services || {});
  const usd = svc.reduce((s, [, v]) => s + (v.month?.usd || 0), 0);
  const jobs = u.renders?.jobs || []; const ms = jobs.reduce((s, j) => s + j.ms, 0);
  const disk = u.disk || {}; const big = Math.max(...svc.map(([, v]) => v.month?.usd || 0), 0.01);
  root.innerHTML = `<div class="libhead"><div><h1 class="ph">Usage</h1><p class="sub">This month. Nothing here costs anything to look at.</p></div></div>
  <section class="usage">
    <div class="ustats">
      <div class="card glass ustat"><p class="label">Render time</p><p class="unum">${dur(ms)}</p><p class="fine">${jobs.length} renders timed</p>${bar(pct(jobs.length, Math.max(jobs.length, 20)), `${jobs.length} renders`)}</div>
      <div class="card glass ustat"><p class="label">Money spent</p><p class="unum">$${usd.toFixed(2)} <small>of $${limit()} limit</small></p><p class="fine">${pct(usd, limit())}% of your limit</p>${bar(pct(usd, limit()), `${pct(usd, limit())} percent of the limit`)}</div>
      <div class="card glass ustat"><p class="label">Storage</p><p class="unum">${human(disk.total || 0)}</p><p class="fine">Models ${human(disk.models || 0)}</p>${bar(pct(disk.models || 0, disk.total || 1), 'Share used by models')}</div>
    </div>
    <div class="card glass"><h2 class="label">Spend by service</h2>
      ${svc.map(([k, v]) => `<div class="urow"><span>${esc(SERVICE[k] || k)}</span>${bar(pct(v.month?.usd || 0, big), `${SERVICE[k] || k}`)}<b>$${(v.month?.usd || 0).toFixed(2)}</b></div>`).join('') || '<p class="fine">No spending yet.</p>'}
      ${u.enhance?.calls ? `<p class="fine">Picture clean-ups: ${u.enhance.calls}, ${u.enhance.credits} credits.</p>` : ''}
    </div>
    <details class="adjust"><summary>Adjust (more options)</summary>
      <div class="field"><label for="uLimit">Monthly money limit ($)</label><input id="uLimit" type="number" min="1" step="1" value="${limit()}"></div>
      <p class="label">Free up space</p>
      ${Object.entries(CACHE).map(([k, l]) => `<div class="urow"><span>${l}</span><b>${human(disk[k] || 0)}</b><button class="btn ghostbtn sm" type="button" data-clear="${k}" ${disk[k] ? '' : 'disabled'}>Clear</button></div>`).join('')}
      ${Object.keys(u.renders?.avgMs || {}).length ? `<p class="fine">Average render: ${Object.entries(u.renders.avgMs).map(([k, v]) => `${esc(k)} ${dur(v)}`).join(', ')}</p>` : ''}
    </details>
  </section>`;
}

async function onClick(e) {
  const k = e.target.closest('[data-clear]')?.dataset.clear; if (!k) return;
  if (!(await confirmDialog({ title: `Clear ${CACHE[k].toLowerCase()}?`, text: 'Flatform makes these again when it needs them. Your models and renders are not touched.', ok: 'Clear' }))) return;
  try { await send(`/api/usage/cache/${k}`, 'DELETE'); toast('Cleared.', 'ok'); } catch (err) { toast(err.message); }
  load();
}
function onChange(e) { if (e.target.id === 'uLimit' && Number(e.target.value) > 0) { localStorage.setItem(LIMIT_KEY, String(Number(e.target.value))); draw(); } }

export function update() {}
export function unmount() { root = null; }
