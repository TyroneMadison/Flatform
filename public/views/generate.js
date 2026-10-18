// 02 · Generate: staged progress for one model, the "forming" preview and the queue of every job.
// Tripo's API has no cancel endpoint, so submitted jobs can't be cancelled; only photos still in
// Flatform's own upload queue can be removed.
import { $, esc, state, route, stepper, findModel, fileUrl, sourceType, STAGES, stageOf, statusText, addFiles, openPicker,
  removeQueued, retryQueued, retryModel, creditsText, modelLabel, isGenerating, go } from '../app.js';
import { icon } from '../lib/icons.js';

let root;
let model;
let shownReady = false;
let observer;

export function unmount() { observer?.disconnect(); }

export function mount(el, { id }) {
  root = el;
  model = findModel(id);
  shownReady = model?.status === 'ready';
  el.innerHTML = `${stepper('generate', model)}
  <section class="genwrap">
    <div class="gen-left">
      <figure class="srcphoto glass">
        <div class="photo">${model?.source ? `<img src="${fileUrl(model, model.source)}" alt="Source photo of ${esc(model.name)}">` : ''}</div>
        <figcaption class="cap"><b>Source photo</b><span>${model ? `${esc(model.name)} · ${sourceType(model.source)}` : 'Nothing selected'}</span></figcaption>
      </figure>
      <div class="stages glass">
        <h2 class="label">Progress</h2>
        <ol class="stl" id="stages"></ol>
        <p class="fine">Tripo links expire after 5 minutes. Flatform saves the model locally the moment it's ready.</p>
      </div>
    </div>
    <div class="forming glass">
      <div class="fhud tl"><span class="pulse" aria-hidden="true"></span><span id="fhudText">Generating 3D model</span></div>
      <div class="fhud tr">${esc(modelLabel())}</div>
      <div class="fstage-wrap">${model?.source ? `
        <div class="fstage" id="fstage" style="--src:url('${fileUrl(model, model.source)}')">
          <img class="fghost" src="${fileUrl(model, model.source)}" alt="">
          <img class="freveal" src="${fileUrl(model, model.source)}" alt="">
          <div class="fwire"></div><div class="fdots"></div><div class="fscan"></div>
        </div>` : `<p class="muted">Drop a photo to start a model.</p>`}
      </div>
      <div class="fbottom">
        <div class="bigpct" id="bigpct" aria-hidden="true"></div>
        <div class="fb2"><b id="stageName" aria-live="polite"></b><div class="pbar big" role="progressbar" aria-label="Generation progress" aria-valuemin="0" aria-valuemax="100" id="pbar"><i></i></div><span id="fbNote"></span></div>
        <div class="facts" id="facts"></div>
      </div>
    </div>
    <aside class="queue glass" aria-label="Queue">
      <h2 class="label">Queue</h2>
      <div class="qlist" id="qlist"></div>
      <p class="fine" id="credits"></p>
      <button class="qadd" type="button" id="qadd">${icon('plus')} Drop more photos to queue them</button>
    </aside>
  </section>`;

  const img = $('.fghost', el);
  const fit = () => {
    const box = $('.fstage-wrap', el);
    if (!img?.naturalWidth || !box) return;
    const ratio = img.naturalWidth / img.naturalHeight;
    const w = Math.min(box.clientWidth, box.clientHeight * ratio);
    Object.assign($('#fstage', el).style, { width: `${w}px`, height: `${w / ratio}px` });
  };
  img?.addEventListener('load', fit);
  observer = new ResizeObserver(fit);
  observer.observe($('.fstage-wrap', el));
  const add = $('#qadd', el);
  add.addEventListener('click', () => openPicker(false));
  add.addEventListener('dragover', (e) => { e.preventDefault(); add.classList.add('hot'); });
  add.addEventListener('dragleave', () => add.classList.remove('hot'));
  add.addEventListener('drop', (e) => { e.preventDefault(); add.classList.remove('hot'); addFiles(e.dataTransfer.files, { open: false }); });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const { act, id: target } = b.dataset;
    if (act === 'remove') removeQueued(target);
    if (act === 'requeue') retryQueued(target);
    if (act === 'retry') retryModel(findModel(target));
  });
  update();
}

export function update() {
  model = findModel(route.id) || model;
  const m = model;
  if (m) {
    const stage = stageOf(m);
    const failed = m.status === 'failed';
    const pct = m.status === 'ready' ? 100 : m.progress || 0;
    $('#stages', root).innerHTML = STAGES.map((s, i) => {
      const cls = i < stage ? 'done' : i === stage && !failed ? 'on' : '';
      return `<li class="${cls}"><b>${i < stage ? icon('check', 12) : ''}</b>${s}${i === stage && failed ? ' <span class="st fail">· failed</span>' : ''}</li>`;
    }).join('');
    $('#bigpct', root).innerHTML = `${pct}<small>%</small>`;
    $('#stageName', root).textContent = failed ? statusText(m) : m.status === 'ready' ? 'Saved to your library' : `${STAGES[stage]} · ${pct}%`;
    $('#stageName', root).className = failed ? 'st fail' : '';
    $('#pbar', root).setAttribute('aria-valuenow', pct);
    $('#pbar i', root).style.width = `${pct}%`;
    $('#fhudText', root).textContent = failed ? 'Generation failed' : m.status === 'ready' ? '3D model ready' : 'Generating 3D model';
    $('#fbNote', root).textContent = failed ? 'Retry sends the same photo to Tripo again as a new task.'
      : m.status === 'ready' ? 'Check it from every side before you place it in a scene.' : 'You can keep working. This job runs in the background.';
    $('#fstage', root)?.style.setProperty('--p', `${m.status === 'ready' ? 100 : Math.max(4, pct)}%`);
    root.querySelector('.forming').classList.toggle('done', m.status === 'ready');
    const facts = failed ? `<button class="btn pri" type="button" data-act="retry" data-id="${m.id}">${icon('retry')}<span>Retry</span></button>`
      : m.status === 'ready' ? `<a class="btn pri" href="#/review/${m.id}">${icon('eye')}<span>Review the model</span></a>`
        : '<a class="btn sec" href="#/library">Run in background</a>';
    if ($('#facts', root).dataset.html !== facts) { $('#facts', root).dataset.html = facts; $('#facts', root).innerHTML = facts; }
    // Move on to Review by itself when the model you're watching finishes.
    if (m.status === 'ready' && !shownReady) { shownReady = true; setTimeout(() => { if (route.name === 'generate' && route.id === m.id) go(`#/review/${m.id}`); }, 1200); }
  } else {
    $('#stageName', root).textContent = state.queue.length ? 'Sending your photo to Tripo…' : 'Nothing is generating right now';
  }

  const local = state.queue.map((q) => `
    <div class="qi${q.status === 'error' ? ' qfail' : ''}">
      <div class="qt"><b>${esc(q.name)}</b><span>${q.status === 'uploading' ? 'Uploading to Tripo…' : q.status === 'error' ? esc(q.error) : 'Waiting to upload'}</span></div>
      ${q.status === 'error' ? `<button class="btn sm pri" type="button" data-act="requeue" data-id="${q.qid}">${icon('retry')}<span>Retry</span></button>` : ''}
      ${q.status !== 'uploading' ? `<button class="btn sm ghostbtn" type="button" data-act="remove" data-id="${q.qid}" aria-label="Remove ${esc(q.name)} from the queue">${icon('close')}<span>Remove</span></button>` : ''}
    </div>`).join('');
  const jobs = state.models.filter((x) => isGenerating(x) || x.status === 'failed').map((x) => `
    <div class="qi${x.status === 'failed' ? ' qfail' : ''}${x === m ? ' on' : ''}">
      <div class="qt"><a href="#/generate/${x.id}"><b>${esc(x.name)}</b></a><span>${esc(statusText(x))}</span>
        ${x.status === 'failed' ? '' : `<div class="pbar"><i style="width:${x.progress || 0}%"></i></div>`}</div>
      ${x.status === 'failed' ? `<button class="btn sm pri" type="button" data-act="retry" data-id="${x.id}">${icon('retry')}<span>Retry</span></button>` : ''}
    </div>`).join('');
  const html = local + jobs || '<p class="muted qempty">No jobs. Photos you drop wait here until Tripo has them.</p>';
  const q = $('#qlist', root);
  if (q.dataset.html !== html) { q.dataset.html = html; q.innerHTML = html; }
  $('#credits', root).textContent = creditsText();
}
