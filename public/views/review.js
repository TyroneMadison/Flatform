// 03 · Review: the source photo next to the 3D model, versions, regenerate, clean-up toggles, then into a scene.
import { $, $$, esc, state, api, send, toast, go, stepper, findModel, fileUrl, upsert, refresh, statusText, isGenerating, busy } from '../app.js';
import { icon } from '../lib/icons.js';
import { Studio, defaultScene } from '../lib/studio.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let root;
let m;
let studio;
let controls;
let observer;
let raf;
let display = 'side';
let loadedGlb = null;

export async function mount(el, { id }) {
  root = el;
  m = findModel(id);
  loadedGlb = null;
  if (!m) { el.innerHTML = `${stepper('review')}<p class="muted">Pick a model from the <a class="link" href="#/library">library</a>.</p>`; return; }
  el.innerHTML = `${stepper('review', m)}
  <section class="review">
    <div class="cmp glass">
      <div class="cmp-top">
        <div class="chips seg" role="radiogroup" aria-label="Compare view">
          ${[['side', 'Side by side'], ['overlay', 'Overlay'], ['wire', 'Wireframe'], ['flat', 'Textures off']].map(([k, l]) => `<button class="chip" type="button" role="radio" data-display="${k}" aria-checked="${k === display}">${l}</button>`).join('')}
        </div>
        <div class="vtools"><button class="btn icon ghostbtn" type="button" id="resetView" title="Reset view" aria-label="Reset view">${icon('orbit', 18)}</button></div>
      </div>
      <div class="cmp-panes" id="panes">
        <div class="pane src"><span class="plabel">Source photo</span><img id="srcImg" alt=""></div>
        <div class="pane live"><span class="plabel">3D model · drag to orbit</span>
          <img class="overlay-img" id="overlayImg" alt="" hidden>
          <canvas id="cv" tabindex="0" aria-label="3D model of ${esc(m.name)}. Drag to orbit, scroll to zoom."></canvas>
          <div class="pane-msg" id="paneMsg" role="status"></div>
          <div class="orbithint">${icon('orbit')} Drag to orbit · scroll to zoom</div>
        </div>
      </div>
    </div>
    <aside class="insp glass" id="insp"></aside>
    <input type="file" id="betterPhoto" accept="image/png,image/jpeg,image/heic,image/heif,.heic,.heif" hidden>
  </section>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('keydown', (e) => { if (e.target.matches('.rename') && e.key === 'Enter') e.target.blur(); });
  renderInspector();
  try {
    studio = new Studio($('#cv', el));
    studio.freeCamera = true;
  } catch {
    $('#paneMsg', el).textContent = 'The 3D view needs WebGL, which is not available here.';
    return;
  }
  controls = new OrbitControls(studio.camera, $('#cv', el));
  controls.minDistance = 3;
  controls.maxDistance = 25;
  controls.maxPolarAngle = Math.PI * 0.495; // stay above the floor
  controls.addEventListener('change', draw);
  let framed = false;
  observer = new ResizeObserver(() => {
    const r = $('#cv', root)?.getBoundingClientRect();
    if (!r || !studio) return;
    studio.resize(Math.max(1, r.width), Math.max(1, r.height), Math.min(devicePixelRatio, 2));
    if (!framed) { framed = true; resetView(); }
    draw();
  });
  observer.observe($('#cv', el));
  const s = studio;
  await s.setState({ ...defaultScene(state.settings), ...m.scene, preset: 'transparent' });
  if (studio === s) await showVersion(); // unless the screen was left meanwhile
}

export function unmount() {
  observer?.disconnect();
  cancelAnimationFrame(raf);
  controls?.dispose();
  studio?.dispose();
  studio = null;
}

// Front ¾ view from slightly above, far enough back that the whole car fits the pane, portrait or not.
function resetView() {
  const cam = studio.camera;
  cam.fov = 32;
  const tanV = Math.tan(((cam.fov / 2) * Math.PI) / 180);
  const distance = 2.8 / Math.sin(Math.atan(Math.min(tanV, tanV * (studio.width / studio.height)))); // the narrower side decides
  controls.target.set(0, 0.6, 0);
  cam.position.set(0.58 * distance, 0.6 + 0.25 * distance, 0.77 * distance);
  cam.updateProjectionMatrix();
  controls.update();
  draw();
}

function draw() {
  if (!studio) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => studio?.render());
}

// Loads the active version's GLB (once per file) and shows its source photo.
async function showVersion() {
  $('#srcImg', root).src = m.source ? fileUrl(m, m.source) : '';
  $('#srcImg', root).alt = `Source photo of ${m.name}`;
  $('#overlayImg', root).src = $('#srcImg', root).src;
  const msg = $('#paneMsg', root);
  if (m.status !== 'ready') {
    msg.innerHTML = m.status === 'failed' ? `${esc(statusText(m))}` : `Version ${m.activeVersion} is still generating · ${m.progress || 0}% <a class="link" href="#/generate/${m.id}">Show progress</a>`;
    return;
  }
  if (loadedGlb === m.glb || !studio) return;
  const s = studio;
  const glb = m.glb;
  msg.textContent = 'Loading model…';
  try {
    await s.load(fileUrl(m, glb));
    if (studio !== s) return; // a newer screen owns the view now
    loadedGlb = glb;
    msg.textContent = '';
    applyDisplay();
  } catch (e) {
    if (studio === s) msg.textContent = `Could not load the model: ${e.message}`;
  }
  draw();
}

function applyDisplay() {
  $('#panes', root).classList.toggle('overlay', display === 'overlay');
  $('#overlayImg', root).hidden = display !== 'overlay';
  studio?.setDisplay({ wireframe: display === 'wire', textures: display !== 'flat' });
  draw();
}

function renderInspector() {
  const scene = { ...defaultScene(state.settings), ...m.scene };
  const thumb = (v) => (v.thumb ? fileUrl(m, v.thumb) : v.source ? fileUrl(m, v.source) : '');
  const html = `
    <label class="sr-only" for="rename">Model name</label>
    <input class="it rename" id="rename" value="${esc(m.name)}" maxlength="100" spellcheck="false">
    <p class="sub">${m.status === 'ready' ? `Ready · saved to library · GLB${m.credits != null ? ` · ${m.credits} credits` : ''}` : esc(statusText(m))}</p>
    <div class="grp"><h3>Versions</h3>
      <div class="vers">${m.versions.map((v) => `
        <button class="ver" type="button" data-version="${v.n}" aria-pressed="${v.n === m.activeVersion}">
          <div class="stage s-clear"><div class="checker"></div>${thumb(v) ? `<img class="thumb" src="${thumb(v)}" alt="Version ${v.n} of ${esc(m.name)}">` : ''}</div>
          <span>Version ${v.n}</span><small>${v.status === 'ready' ? 'Ready' : v.status === 'failed' ? 'Failed' : `${v.progress || 0}%`}</small>
        </button>`).join('')}</div>
    </div>
    <div class="grp"><h3>Not right?</h3>
      <button class="btn sec" type="button" data-act="regen" ${isGenerating(m) ? 'disabled' : ''}>${icon('retry')}<span>Regenerate from same photo</span></button>
      <button class="btn ghostbtn" type="button" data-act="better" ${isGenerating(m) ? 'disabled' : ''}>${icon('upload')}<span>Regenerate with a better photo</span></button>
      <p class="fine">Each regeneration is a new Tripo task and uses credits. Older versions stay in the library.</p>
    </div>
    <div class="grp"><h3>Clean up</h3>
      <label class="tg"><span>Auto-orient<small>Wheels down, nose facing the camera</small></span><input class="sw" type="checkbox" role="switch" data-clean="autoOrient" ${scene.autoOrient ? 'checked' : ''}></label>
      <label class="tg"><span>Center and ground on floor<small>Applied in the composer and every render</small></span><input class="sw" type="checkbox" role="switch" data-clean="center" ${scene.center ? 'checked' : ''}></label>
      <label class="tg"><span>Flip front and back<small>If the tail faces the camera</small></span><input class="sw" type="checkbox" role="switch" data-clean="flip" ${scene.flip ? 'checked' : ''}></label>
    </div>
    <div class="cta"><a class="btn pri ${m.status === 'ready' ? '' : 'disabled'}" ${m.status === 'ready' ? `href="#/compose/${m.id}"` : 'aria-disabled="true"'}>${icon('scene')}<span>Place in a scene</span></a></div>`;
  const box = $('#insp', root);
  if (box.dataset.html !== html && document.activeElement?.id !== 'rename') { box.dataset.html = html; box.innerHTML = html; }
}

async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.display) {
    display = t.dataset.display;
    $$('[data-display]', root).forEach((b) => b.setAttribute('aria-checked', String(b === t)));
    applyDisplay();
  }
  if (t.id === 'resetView') resetView();
  if (t.dataset.version) {
    try { m = upsert(await send(`/api/models/${m.id}`, 'PATCH', { activeVersion: Number(t.dataset.version) })); } catch (err) { return toast(err.message); }
    refresh();
    await showVersion();
  }
  if (t.dataset.act === 'regen') {
    await busy(t, async () => {
      try { upsert(await api(`/api/models/${m.id}/versions`, { method: 'POST' })); go(`#/generate/${m.id}`); } catch (err) { toast(err.message); }
    });
  }
  if (t.dataset.act === 'better') $('#betterPhoto', root).click();
}

async function onChange(e) {
  const t = e.target;
  if (t.id === 'rename') {
    const name = t.value.trim();
    if (!name || name === m.name) { t.value = m.name; return; }
    try { m = upsert(await send(`/api/models/${m.id}`, 'PATCH', { name })); refresh(); } catch (err) { toast(err.message); t.value = m.name; }
  }
  if (t.dataset.clean) {
    const key = t.dataset.clean;
    const scene = { ...defaultScene(state.settings), ...m.scene, [key]: t.checked, ...(key === 'center' && { snap: t.checked }) };
    try { m = upsert(await send(`/api/models/${m.id}`, 'PATCH', { scene })); } catch (err) { return toast(err.message); }
    await studio?.setState({ ...scene, preset: 'transparent' });
    draw();
  }
  if (t.id === 'betterPhoto' && t.files[0]) {
    const file = t.files[0];
    t.value = '';
    const type = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.hei[cf]$/i.test(file.name) ? 'image/heic' : 'image/jpeg');
    await busy($('[data-act=better]', root), async () => {
      try {
        upsert(await api(`/api/models/${m.id}/versions`, { method: 'POST', headers: { 'Content-Type': type }, body: file }));
        go(`#/generate/${m.id}`);
      } catch (err) { toast(err.message); }
    });
  }
}

export function update() {
  const fresh = findModel(m?.id);
  if (!fresh || !root.isConnected) return;
  m = fresh;
  renderInspector();
  if (m.status === 'ready' && loadedGlb !== m.glb) showVersion();
}
