// 01 · Drop: the big drop zone, tips with the next setup and the real balance, and recent models.
// Photos go on to the setup screen, where the provider and quality are chosen before anything is paid for.
import { $, esc, state, stepper, addFiles, openPicker, pasteFromClipboard, creditsText, savedSetup, setupLabel, costOf, thumbOf, statusText, statusClass } from '../app.js';
import { icon } from '../lib/icons.js';

let root;

export function mount(el) {
  root = el;
  el.innerHTML = `${stepper('drop')}
  <section class="dropwrap">
    <div class="dropzone glass" id="dropzone">
      <div class="dz-hit" role="button" tabindex="0" aria-label="Choose photos, or drop them here" aria-describedby="dzLead"></div>
      <div class="dz-orb" aria-hidden="true"><div class="dz-ring"></div><div class="dz-ring r2"></div><div class="ghost" id="ghost"></div></div>
      <h1>Drop a photo. Get a 3D car.</h1>
      <p class="lead" id="dzLead">Drop photos here or choose them. Next you pick the provider and quality, then each car becomes a 3D model you can place in any scene.</p>
      <div class="dz-actions">
        <button class="btn pri" type="button" data-act="pick">${icon('upload')}<span>Choose photos</span></button>
        <button class="btn ghostbtn" type="button" data-act="paste"><span>Paste from clipboard</span></button>
      </div>
      <div class="dz-meta"><span>PNG, JPEG or HEIC</span><span>Up to 20 MB</span><span>One clear subject</span><span>Clean background</span></div>
      <p class="dz-status" id="dzStatus" aria-live="polite"></p>
    </div>
    <div class="tips">
      <div class="tip glass"><b>Front ¾ angle works best</b><span>One shot shows more of the body and wheels. Or use 4 views with 3D AI Studio.</span></div>
      <div class="tip glass"><b>Keep the whole car in frame</b><span>Cropped bumpers and mirrors come back missing.</span></div>
      <div class="tip glass"><b id="modelTip"></b><span id="creditTip"></span></div>
    </div>
    <div class="rowhead"><h2 class="label">Recent models</h2><a class="link" href="#/library">Open library</a></div>
    <div class="recent" id="recent"></div>
  </section>`;

  const zone = $('#dropzone', el);
  const hot = (on) => {
    zone.classList.toggle('hot', on);
    $('#dzLead', el).textContent = on ? 'Release to set it up. Nothing is sent until you press Generate.'
      : 'Drop photos here or choose them. Next you pick the provider and quality, then each car becomes a 3D model you can place in any scene.';
  };
  zone.addEventListener('dragover', (e) => { e.preventDefault(); hot(true); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) hot(false); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); hot(false); addFiles(e.dataTransfer.files); });
  const hit = $('.dz-hit', el);
  hit.addEventListener('click', () => openPicker());
  hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
  el.querySelector('[data-act=pick]').addEventListener('click', () => openPicker());
  el.querySelector('[data-act=paste]').addEventListener('click', pasteFromClipboard);
  update();
}

export function update() {
  const latest = state.models.find((m) => thumbOf(m));
  const sending = state.queue.find((q) => q.status === 'uploading');
  const ghost = latest ? `<img src="${thumbOf(latest)}" alt="">` : `<span class="ghost-empty">${icon('image', 40)}</span>`;
  const tag = `<span class="ghost-tag">${esc(sending ? sending.name : 'PNG · JPEG · HEIC')}</span>`;
  const g = $('#ghost', root);
  if (g.dataset.html !== ghost + tag) { g.dataset.html = ghost + tag; g.innerHTML = ghost + tag; }

  const waiting = state.queue.filter((q) => q.status === 'waiting').length;
  const failed = state.queue.filter((q) => q.status === 'error');
  $('#dzStatus', root).textContent = sending ? `Sending ${sending.name}…${waiting ? ` ${waiting} more waiting.` : ''}`
    : failed.length ? `${failed.length} photo${failed.length > 1 ? 's' : ''} could not be sent. See the queue on the Generate screen.` : '';

  const next = savedSetup();
  $('#modelTip', root).textContent = `Next: ${setupLabel(next)} · ${costOf(next)} credits`;
  $('#creditTip', root).textContent = `Change it on the next screen. ${creditsText(next.provider) || 'Your balance shows in Settings.'}`;

  const recent = state.models.slice(0, 4).map((m) => {
    const href = m.status === 'ready' ? `#/review/${m.id}` : `#/generate/${m.id}`;
    const img = thumbOf(m) ? `<img class="thumb" src="${thumbOf(m)}" alt="${esc(m.name)}">` : '';
    return `<a class="mini glass" href="${href}"><div class="stage s-ring">${img}</div><div class="mt"><b>${esc(m.name)}</b><span class="st ${statusClass(m)}">${esc(statusText(m))}</span></div></a>`;
  }).join('') || '<p class="muted empty">Your models will show up here.</p>';
  const r = $('#recent', root);
  if (r.dataset.html !== recent) { r.dataset.html = recent; r.innerHTML = recent; }
}
