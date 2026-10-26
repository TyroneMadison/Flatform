// Drop: the big drop zone, tips with the next setup and the real balance, and recent models.
// Photos go on to the setup screen, where the provider and quality are chosen before anything is paid for.
// 3D models (GLB, GLTF, FBX, OBJ, USDZ) skip Generate and open in Compose (app.js addFiles). Warframe mode adds the
// Drawing kit (views/drawing.js): the printable template and photos of it, and the drawing tips card beside the
// drop zone (lib/drawing-tips.js).
import { $, esc, state, addFiles, openPicker, pasteFromClipboard, creditsText, savedSetup, setupLabel, activeWorkspace, costOf, thumbOf, statusText, statusClass, recentItems, openRecent } from '../app.js';
import { icon } from '../lib/icons.js';
import { timeAgo } from '../lib/session.js';
import { tipsCard, isClosed, remember } from '../lib/drawing-tips.js';

let root;

export function mount(el) {
  root = el;
  // The Car / Warframe switch in the top bar changes the words, and Warframe mode adds From template.
  const wf = state.mode === 'warframe';
  el.innerHTML = `
  <section class="dropwrap">
    <div class="dz-row${wf ? ' with-tips' : ''}">
    <div class="dropzone glass breathe" id="dropzone">
      <div class="dz-hit" role="button" tabindex="0" aria-label="Choose photos, or drop them here" aria-describedby="dzLead"></div>
      <div class="dz-orb" aria-hidden="true"><div class="dz-ring"></div><div class="dz-ring r2"></div><div class="ghost" id="ghost"></div></div>
      <h1>${wf ? 'Drop a picture. Get a 3D Warframe.' : 'Drop a photo. Get a 3D car.'}</h1>
      <p class="lead" id="dzLead">Keep the whole ${wf ? 'Warframe' : 'car'} in view. Nothing is paid for until you press Make 3D model. Have a 3D file? Drop it too.</p>
      <div class="dz-actions">
        <button class="btn pri big" type="button" data-act="pick" title="Pick photos or a 3D file from this computer">${icon('upload')}<span>Choose photos</span></button>
        <button class="btn ghostbtn big" type="button" data-act="paste" title="Paste a photo you copied (Ctrl+V)"><span>Paste</span><kbd>Ctrl V</kbd></button>
        <a class="btn ghostbtn big" href="#/library" title="Open something you made before">Open library</a>
        ${wf ? '<a class="btn ghostbtn big" href="#/warframe" title="Start from a Warframe template">From template</a>' : ''}
        ${wf ? '<button class="btn ghostbtn big" type="button" data-act="kit" title="Draw your character on our printable sheet, then add photos of the pages">Drawing kit</button>' : ''}
      </div>
      <div class="dz-meta"><span>Photos: PNG, JPEG or HEIC, up to 20 MB</span><span>3D files: .glb, .gltf, .fbx, .obj, .usdz</span><span>One clear subject</span></div>
      <p class="dz-status" id="dzStatus" aria-live="polite"></p>
    </div>
    ${wf ? '<div id="tipsSlot"></div>' : ''}
    </div>
    <div class="tips">
      <div class="tip glass"><b>Shoot from a front corner</b><span>One photo then shows the side and the wheels too. Or use 4 photos with 3D AI Studio.</span></div>
      <div class="tip glass"><b>Keep the whole car in frame</b><span>Parts cut off in the photo come out missing.</span></div>
      <div class="tip glass"><b id="modelTip"></b><span id="creditTip"></span></div>
    </div>
    <div id="resume"></div>
    <div class="rowhead"><h2 class="label">Recent models</h2><a class="link" href="#/library">Open library</a></div>
    <div class="recent" id="recent"></div>
  </section>`;

  const zone = $('#dropzone', el);
  const hot = (on) => {
    zone.classList.toggle('hot', on);
    $('#dzLead', el).textContent = on ? 'Let go to set it up. Nothing is sent until you press Make 3D model.'
      : `Keep the whole ${wf ? 'Warframe' : 'car'} in view. Nothing is paid for until you press Make 3D model. Have a 3D file? Drop it too.`;
  };
  zone.addEventListener('dragover', (e) => { e.preventDefault(); hot(true); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) hot(false); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); hot(false); addFiles(e.dataTransfer.files); });
  const hit = $('.dz-hit', el);
  hit.addEventListener('click', () => openPicker());
  hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
  el.querySelector('[data-act=pick]').addEventListener('click', () => openPicker());
  el.querySelector('[data-act=paste]').addEventListener('click', pasteFromClipboard);
  el.querySelector('[data-act=kit]')?.addEventListener('click', () => import('./drawing.js').then((kit) => kit.openDrawing()));
  const slot = $('#tipsSlot', el);
  slot?.addEventListener('click', (e) => { if (e.target.closest('[data-act=kit]')) import('./drawing.js').then((kit) => kit.openDrawing()); });
  slot?.addEventListener('toggle', (e) => remember(localStorage, !e.target.open), true);
  $('#resume', el).addEventListener('click', (e) => {
    const r = recentItems().find((x) => x.id === e.target.closest('[data-recent]')?.dataset.recent);
    if (r) openRecent(r);
  });
  update();
}

export function update() {
  const latest = state.models.find((m) => thumbOf(m));
  const sending = state.queue.find((q) => q.status === 'uploading');
  const ghost = latest ? `<img src="${thumbOf(latest)}" alt="">` : `<span class="ghost-empty">${icon('image', 40)}</span>`;
  const tag = `<span class="ghost-tag">${esc(sending ? sending.name : 'PNG · JPEG · HEIC')}</span>`;
  const g = $('#ghost', root);
  if (g.dataset.html !== ghost + tag) { g.dataset.html = ghost + tag; g.innerHTML = ghost + tag; }

  const slot = $('#tipsSlot', root);
  const card = slot && tipsCard({ found: state.drawingFound, esc });
  if (slot && slot.dataset.html !== card) { slot.dataset.html = card; slot.innerHTML = tipsCard({ found: state.drawingFound, closed: isClosed(localStorage), esc }); }

  const waiting = state.queue.filter((q) => q.status === 'waiting').length;
  const failed = state.queue.filter((q) => q.status === 'error');
  $('#dzStatus', root).textContent = state.importing ? `Adding ${state.importing}…` : sending ? `Sending ${sending.name}…${waiting ? ` ${waiting} more waiting.` : ''}`
    : failed.length ? `${failed.length} photo${failed.length > 1 ? 's' : ''} could not be sent. See the list on the 3D model step.` : '';

  const next = savedSetup();
  $('#modelTip', root).textContent = `Next: ${setupLabel(next)} · ${costOf(next)} credits`;
  $('#creditTip', root).textContent = `Change it on the next screen. ${creditsText(next.provider) || 'Your balance shows in Settings.'}`;

  const recent = state.models.slice(0, 4).map((m) => {
    const href = `#/model/${m.id}`; // the model page: drop, settings, compose, renders
    const img = thumbOf(m) ? `<img class="thumb" src="${thumbOf(m)}" alt="${esc(m.name)}">` : '';
    return `<a class="mini glass" href="${href}"><div class="stage s-ring">${img}</div><div class="mt"><b>${esc(m.name)}</b><span class="st ${statusClass(m)}">${esc(statusText(m))}</span></div></a>`;
  }).join('') || '<p class="muted empty">Your models will show up here.</p>';
  // Pick up where you left off: the last scenes you edited, reopened exactly as they were.
  const items = recentItems();
  const resume = items.length ? `<div class="rowhead"><h2 class="label">Pick up where you left off</h2><span class="sub">Ctrl+K finds these anywhere</span></div>
    <div class="recent">${items.map((x) => `<button class="mini glass" type="button" data-recent="${esc(x.id)}" title="Open ${esc(x.model.name)} in Scene, just as you left it">
      <div class="stage s-ring">${thumbOf(x.model) ? `<img class="thumb" src="${thumbOf(x.model)}" alt="">` : ''}</div>
      <div class="mt"><b>${esc(x.model.name)}</b><span class="st">Edited ${esc(timeAgo(x.at))}</span></div></button>`).join('')}</div>` : '';
  const rs = $('#resume', root);
  if (rs.dataset.html !== resume) { rs.dataset.html = resume; rs.innerHTML = resume; }
  const r = $('#recent', root);
  if (r.dataset.html !== recent) { r.dataset.html = recent; r.innerHTML = recent; }
}
