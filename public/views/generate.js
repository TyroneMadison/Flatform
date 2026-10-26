// 02 · Generate: staged progress for one model, the "forming" preview and the queue of every job.
// Neither Tripo nor 3D AI Studio has a cancel endpoint, so submitted jobs can't be cancelled; only photos still in
// Flatform's own upload queue can be removed. Photos dropped on the queue skip the setup screen and use the last setup.
import { $, esc, state, route, stepper, findModel, fileUrl, sourceType, stagesOf, stageOf, statusText, addFiles, openPicker,
  removeQueued, retryQueued, retryModel, creditsText, engineLabel, providerOf, savedSetup, setupLabel, costOf, isGenerating, go, busy,
  accountOf, confirmDialog, fmtBalance } from '../app.js';
import { PROVIDERS } from '../lib/engines.js';
import { ringDash, timeLeft } from '../lib/stage.js';
import { icon } from '../lib/icons.js';

let root;
let model;
let shownReady = false;
export function unmount() {}

export function mount(el, { id }) {
  root = el;
  model = findModel(id);
  shownReady = model?.status === 'ready';
  // v3: one card in the middle with a big ring, the time left and Run in background; the queue floats on the right.
  el.innerHTML = `
  <section class="genwrap v3">
    <div class="gencard card forming">
      <div class="genring-wrap" role="progressbar" aria-label="3D model progress" aria-valuemin="0" aria-valuemax="100" id="pbar">
        <svg class="ring genring" viewBox="0 0 36 36" aria-hidden="true"><circle class="t" cx="18" cy="18" r="15"/><circle class="p" id="genP" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray="0 100"/></svg>
        ${model?.source ? `<img class="genthumb" src="${fileUrl(model, model.source)}" alt="Your photo of ${esc(model.name)}">` : ''}
      </div>
      <h2 id="stageName" aria-live="polite"></h2>
      <p class="muted" id="fbNote"></p>
      <div class="facts" id="facts"></div>
      <details class="genmore"><summary title="Each step the 3D model goes through">Steps</summary>
        <ol class="stl" id="stages"></ol>
        <p class="fine">${model && providerOf(model) === '3daistudio'
          ? '3D AI Studio keeps results for 24 hours and allows 3 requests a minute, so Flatform checks twice a minute and saves the model the moment it is ready.'
          : "Tripo's links expire after 5 minutes. Flatform saves the model locally the moment it's ready."}</p>
        <p class="fine">${model ? `${esc(model.name)} · ${sourceType(model.source)}${model.views ? ` · ${Object.keys(model.views).length} views` : ''} · ${esc(engineLabel(model))}` : ''}</p>
      </details>
    </div>
    <aside class="queue card" aria-label="Queue">
      <h2 class="label">Queue</h2>
      <div class="qlist" id="qlist"></div>
      <p class="fine" id="credits"></p>
      <button class="qadd" type="button" id="qadd" title="Choose more photos. Each one becomes its own 3D model with the same recipe.">${icon('plus')}<span>Drop more photos to queue them<small id="qaddSetup"></small></span></button>
    </aside>
  </section>`;

  const add = $('#qadd', el);
  add.addEventListener('click', () => openPicker({ quick: true }));
  add.addEventListener('dragover', (e) => { e.preventDefault(); add.classList.add('hot'); });
  add.addEventListener('dragleave', () => add.classList.remove('hot'));
  add.addEventListener('drop', async (e) => {
    e.preventDefault();
    add.classList.remove('hot');
    const files = [...e.dataTransfer.files];
    if (await affordable(savedSetup().provider, costOf(savedSetup()) * files.length)) addFiles(files, { quick: true });
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const { act, id: target } = b.dataset;
    if (act === 'remove') removeQueued(target);
    if (act === 'requeue') retryQueued(target);
    if (act === 'retry') {
      busy(b, async () => {
        const m = findModel(target);
        const v = m.versions.find((x) => x.n === m.activeVersion) || m;
        if (await affordable(providerOf(v), v.estimate ?? 0)) await retryModel(m);
      });
    }
  });
  update();
}

// More than the last known balance: ask first (the balance may be stale, so it never blocks outright).
async function affordable(provider, credits) {
  const a = accountOf(provider);
  if (a?.balance == null || credits <= Number(a.balance)) return true;
  return confirmDialog({ title: 'Not enough credits?', text: `This costs about ${credits} credits and your ${PROVIDERS[provider].name} balance is ${fmtBalance(a.balance)}. Send it anyway?`, ok: 'Generate anyway' });
}

export function update() {
  model = findModel(route.id) || model;
  const m = model;
  if (m) {
    const stage = stageOf(m);
    const failed = m.status === 'failed';
    const pct = m.status === 'ready' ? 100 : m.progress || 0;
    const STAGES = stagesOf(m);
    $('#stages', root).innerHTML = STAGES.map((s, i) => {
      const cls = i < stage ? 'done' : i === stage && !failed ? 'on' : '';
      return `<li class="${cls}"><b>${i < stage ? icon('check', 12) : ''}</b>${s}${i === stage && failed ? ' <span class="st fail">· failed</span>' : ''}</li>`;
    }).join('');
    $('#stageName', root).textContent = failed ? 'The 3D model could not be made' : m.status === 'ready' ? 'Your 3D model is ready' : stage <= 1 ? 'Waiting for its turn' : `Building your 3D model · ${pct}%`;
    $('#stageName', root).className = failed ? 'st fail' : '';
    $('#pbar', root).setAttribute('aria-valuenow', pct);
    $('#genP', root).setAttribute('stroke-dasharray', ringDash(pct));
    $('#fbNote', root).textContent = failed ? `${statusText(m)}. Retry sends the same photos and recipe to ${PROVIDERS[providerOf(m)].name} again.`
      : m.status === 'ready' ? 'Opening it in Scene and render…' : `${timeLeft(pct, Date.now() - Date.parse(m.versions?.find((x) => x.n === m.activeVersion)?.created_at || m.created_at))}. You can keep working.`;
    root.querySelector('.forming').classList.toggle('done', m.status === 'ready');
    const facts = failed ? `<button class="btn pri" type="button" data-act="retry" data-id="${m.id}" title="Send the same photos and recipe again">${icon('retry')}<span>Retry</span></button>`
      : m.status === 'ready' ? `<a class="btn pri" href="#/compose/${m.id}" title="Put your model in a scene and make pictures">${icon('scene')}<span>Open in Scene and render</span></a>`
        : '<a class="btn sec" href="#/library" title="Go on with something else. It keeps building and tells you when it is ready.">Run in background</a>';
    if ($('#facts', root).dataset.html !== facts) { $('#facts', root).dataset.html = facts; $('#facts', root).innerHTML = facts; }
    // Move on to Review by itself when the model you're watching finishes.
    if (m.status === 'ready' && !shownReady) { shownReady = true; setTimeout(() => { if (route.name === 'generate' && route.id === m.id) go(`#/compose/${m.id}`); }, 1200); }
  } else {
    const sending = state.queue.find((q) => q.status === 'uploading');
    $('#fbNote', root).textContent = '';
    $('#stageName', root).textContent = sending ? `Sending ${sending.name} to ${PROVIDERS[sending.setup.provider].name}…`
      : state.queue.length ? 'Waiting to send…' : 'Nothing is generating right now';
  }

  // 3D AI Studio allows 3 requests a minute, so a submission can wait a little for its turn.
  const local = state.queue.map((q) => `
    <div class="qi${q.status === 'error' ? ' qfail' : ''}">
      <div class="qt"><b>${esc(q.name)}</b><span>${q.status === 'uploading' ? `Sending to ${PROVIDERS[q.setup.provider].name}${q.setup.provider === '3daistudio' ? ' (3 requests a minute, may wait a moment)' : ''}…`
        : q.status === 'error' ? esc(q.error) : 'Waiting to send'}</span></div>
      ${q.status === 'error' ? `<button class="btn sm pri" type="button" data-act="requeue" data-id="${q.qid}">${icon('retry')}<span>Retry</span></button>` : ''}
      ${q.status !== 'uploading' ? `<button class="btn sm ghostbtn" type="button" data-act="remove" data-id="${q.qid}" aria-label="Remove ${esc(q.name)} from the queue">${icon('close')}<span>Remove</span></button>` : ''}
    </div>`).join('');
  const jobs = state.models.filter((x) => isGenerating(x) || x.status === 'failed').map((x) => `
    <div class="qi${x.status === 'failed' ? ' qfail' : ''}${x === m ? ' on' : ''}">
      <div class="qt"><a href="#/generate/${x.id}"><b>${esc(x.name)}</b></a><span>${esc(statusText(x))}</span>
        ${x.status === 'failed' ? '' : `<div class="pbar"><i style="width:${x.progress || 0}%"></i></div>`}</div>
      ${x.status === 'failed' ? `<button class="btn sm pri" type="button" data-act="retry" data-id="${x.id}">${icon('retry')}<span>Retry</span></button>` : ''}
    </div>`).join('');
  const html = local + jobs || '<p class="muted qempty">No jobs. Photos you drop wait here until they are sent.</p>';
  const q = $('#qlist', root);
  if (q.dataset.html !== html) { q.dataset.html = html; q.innerHTML = html; }
  const next = savedSetup();
  $('#credits', root).textContent = creditsText(m ? providerOf(m) : next.provider);
  $('#qaddSetup', root).textContent = `${setupLabel(next)} · ${costOf(next)} credits each`;
}
