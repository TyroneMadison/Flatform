// Flatform Test only: the v3 checklist. Each line has Pass and Fail (click again to clear) and an Open link to the
// sample model it starts from; results are kept in the test app's data folder.
import { $, esc, api, send, toast, state, native } from '../app.js';
import { CHECKLIST, CHECK_IDS } from '../lib/checklist.js';

let root, data = null;

export async function mount(el) {
  root = el;
  el.addEventListener('click', onClick);
  try { data = await api('/api/test-checklist'); } catch (e) { toast(e.message); data = { results: {}, seed: {} }; }
  draw();
}

function draw() {
  if (!root?.isConnected) return;
  const r = data.results || {};
  const done = CHECK_IDS.filter((id) => r[id]);
  const failed = done.filter((id) => r[id].result === 'fail');
  const models = data.seed?.models || {};
  const line = (i) => {
    const res = r[i.id]?.result;
    const open = i.open && models[i.open] ? ` <a class="link" href="#/compose/${models[i.open]}">Open</a>` : '';
    return `<li class="chk ${res || ''}"><span>${esc(i.text)}${open}</span>
      <span class="chips seg sm" role="group" aria-label="Result">
        <button class="chip" type="button" data-item="${i.id}" data-result="pass" aria-pressed="${res === 'pass'}">Pass</button>
        <button class="chip" type="button" data-item="${i.id}" data-result="fail" aria-pressed="${res === 'fail'}">Fail</button>
      </span></li>`;
  };
  root.innerHTML = `<div class="libhead"><div><h1 class="ph">Flatform Test · v3 checklist</h1>
    <p class="sub">${done.length} of ${CHECK_IDS.length} checked · ${failed.length} failed. Tripo, 3D AI Studio and Blender are mocks here: nothing is paid for and your Flatform library is never touched.</p></div></div>
    <p class="fine">Data folder: <code>${esc(state.settings?.libraryDir || '')}</code>${data.seed?.photosDir ? ` · Sample photos: <code>${esc(data.seed.photosDir)}</code> ${native?.openPath ? '<button class="btn sm sec" type="button" data-act="photos">Open folder</button>' : ''}` : ''}</p>
    ${CHECKLIST.map((g) => `<section class="glass chkgrp"><h2 class="label">${esc(g.group)}</h2><ul class="chklist">${g.items.map(line).join('')}</ul></section>`).join('')}`;
}

async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.act === 'photos') return native.openPath(data.seed.photosDir).catch((err) => toast(err.message));
  if (!t.dataset.item) return;
  const same = data.results?.[t.dataset.item]?.result === t.dataset.result;
  try { data = await send('/api/test-checklist', 'POST', { item: t.dataset.item, result: same ? null : t.dataset.result }); } catch (err) { return toast(err.message); }
  draw();
  $(`[data-item="${t.dataset.item}"][data-result="${t.dataset.result}"]`, root)?.focus();
}
