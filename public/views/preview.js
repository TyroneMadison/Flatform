// Client preview: one model, full screen, nothing else on show. Drag to look around,
// T turns the turntable on and off, Esc ends it (asks for the PIN when one is set).
import { $, esc, state, api, findModel, fileUrl, toast, go } from '../app.js';
import { Studio, defaultScene } from '../lib/studio.js';

let root, studio, raf = 0, spin = false, frame = 0, m, locked = false;

export async function mount(el, { id }) {
  root = el; m = findModel(id); spin = false; frame = 0;
  if (!m?.glb) { el.innerHTML = `<div class="pv-empty"><p class="ph">Nothing to show</p><p class="sub">Pick a finished model first.</p><button class="btn pri" data-pv="exit">Back</button></div>`; el.addEventListener('click', onClick); return; }
  locked = !!(await api('/api/preview').catch(() => ({}))).hasPin;
  state.presenting = true; document.documentElement.classList.add('presenting');
  el.innerHTML = `<div class="pv"><canvas id="pvc" aria-label="${esc(m.name)}, drag to look around"></canvas>
    <div class="pv-bar"><span class="pv-name">${esc(m.name)}</span>
      <button class="btn sec sm" data-pv="spin" aria-pressed="false">Turntable (T)</button>
      <button class="btn ghostbtn sm" data-pv="exit">End preview (Esc)</button></div>
    <div class="pv-pin" id="pvpin" hidden><form class="card glass"><label class="label" for="pvpinin">Enter the PIN to end the preview</label>
      <input id="pvpinin" inputmode="numeric" autocomplete="off" maxlength="8" type="password"><div class="row"><button class="btn pri">End preview</button><button type="button" class="btn ghostbtn" data-pv="stay">Keep showing</button></div><p class="fine" id="pvmsg" role="status"></p></form></div></div>`;
  el.addEventListener('click', onClick);
  el.querySelector('form').addEventListener('submit', onPin);
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', fit);
  try {
    studio = new Studio($('#pvc', el));
    studio.setRig?.(state.settings);
    studio.setState({ ...defaultScene(state.settings), ...m.scene, view: 'free' });
    await studio.load(fileUrl(m, m.glb));
    studio.enableOrbit?.(() => {});
    if (studio.controls) studio.controls.enabled = true;
    fit(); loop();
  } catch (e) { toast(`Could not show this model: ${e.message}`, 'bad'); }
}

function fit() { const c = $('#pvc', root); if (c && studio) studio.resize(innerWidth, innerHeight, Math.min(devicePixelRatio, 2)); }
function loop() { raf = requestAnimationFrame(loop); if (spin) { frame += 0.15; studio.setFrame(frame); } studio.render(); }

function onKey(e) {
  if (e.target.closest?.('input')) return;
  if (e.key === 't' || e.key === 'T') { e.preventDefault(); toggleSpin(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askExit(); }
}
function toggleSpin() { spin = !spin; const b = root.querySelector('[data-pv="spin"]'); b?.setAttribute('aria-pressed', String(spin)); }
function askExit() { if (!locked) return leave(); const p = $('#pvpin', root); p.hidden = false; $('#pvpinin', root).focus(); }
async function onPin(e) {
  e.preventDefault();
  const r = await fetch('/api/preview/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: $('#pvpinin', root).value }) }).then(r => r.json());
  if (r.ok) return leave();
  $('#pvmsg', root).textContent = r.error || 'That PIN is not right.'; $('#pvpinin', root).value = '';
}
function onClick(e) {
  const a = e.target.closest('[data-pv]')?.dataset.pv;
  if (a === 'spin') toggleSpin();
  else if (a === 'exit') askExit();
  else if (a === 'stay') $('#pvpin', root).hidden = true;
}
function leave() { state.presenting = false; document.documentElement.classList.remove('presenting'); go(m ? `#/model/${m.id}` : '#/library'); }

export function update() {}
export function unmount() {
  cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true); removeEventListener('resize', fit);
  studio?.dispose(); studio = null; state.presenting = false; document.documentElement.classList.remove('presenting');
}
