// Compose: the scene composer, and the model's own panel (versions, approve, regenerate, clean up; this used to be
// the Review step). One Three.js studio, the scene presets (Showroom first), an inspector and a turntable timeline.
// The scene is saved per model (scene.json next to the model) so a render reproduces it exactly.
import { createHistory, isUndo, isRedo } from '../lib/history.js';
import { dimensions, gridSpec, REFERENCES } from '../lib/grid.js';
import { $, $$, esc, state, api, send, toast, stepper, findModel, fileUrl, upsert, refresh, statusText, isGenerating, busy, setupFor, engineLabel, activeWorkspace } from '../app.js';
import { icon } from '../lib/icons.js';
import { SINGLE_KEYS } from '../lib/hotkeys.js';
import { FRAMES, HALF, STEP, pad3, LOOKS, ENVIRONMENTS } from '../lib/pipeline.js';
import { Studio, PRESETS, CAMERAS, VIEWS, defaultScene, lookOf } from '../lib/studio.js';
import { initMotion, renderMotionGroup, onMotionClick, onMotionInput, onMotionChange, stopMotion } from './compose-motion.js';
import { initTools, renderToolsGroup, onToolsClick, onToolsChange, onCanvasClick, onToolsKey } from './compose-tools.js';
import { initPath, renderPathGroup, onPathClick, onPathChange } from './compose-path.js';
import { initLighting, renderLightingGroup, onLightingClick } from './compose-lighting.js';
import { initShelf, renderShelf, onShelfClick, onShelfInput, onShelfDragStart, onShelfDrop, isShelfDrag } from './compose-shelf.js';
import { initPaint, renderPaintGroups, afterRender, onPaintClick, onPaintInput, onPaintChange, selectPiece, onPaintDragStart, onTextureDrop, onDecalCanvasClick } from './compose-paint.js';

let root;
let m;
let studio;
let scene;
const hist = createHistory();
let lastPush = 0;
let gridOn = false;
let frame = 0;
let mode = 360;
let tool = 'turn';
let playing = null;
let observer;
let saveTimer;
let raf;
let aside = 'places'; // the left panel: 'places' (the scene list) or 'shelf' (Add things)

const fixed = (n, d = 2) => Number(n).toFixed(d);
const level = (v) => (v <= 0.02 ? 'Off' : v < 0.35 ? 'Soft' : v < 0.7 ? 'Medium' : 'Strong');
const hasFloor = () => scene.preset === 'ring' || scene.preset === 'showroom'; // the presets with a reflective floor
const softness = (v) => (v < 0.3 ? 'Hard' : v < 0.7 ? 'Soft' : 'Very soft');
const carLike = () => studio?.carLike ?? true; // a tall model (humanoid) is never size-locked
const sizeLocked = () => scene.sameSize && carLike();

export async function mount(el, { id }) {
  root = el;
  m = findModel(id);
  frame = state.frames[id] ?? 0;
  if (!m || m.status !== 'ready') {
    el.innerHTML = `${stepper('compose', m)}<p class="muted">${m ? 'This model is not ready yet.' : 'Pick a model from the library first.'} <a class="link" href="${m ? `#/generate/${m.id}` : '#/library'}">${m ? 'Show progress' : 'Open library'}</a></p>`;
    return;
  }
  scene = { ...defaultScene(state.settings), ...(activeWorkspace()?.camera === 'free' && { view: 'free' }), ...m.scene }; // Warframe workspaces start in free roam
  initPaint({ root: el, model: () => m, scene: () => scene, studio: () => studio, change, draw, renderInspector });
  initMotion({ root: el, model: () => m, scene: () => scene, studio: () => studio, change, draw, renderInspector, reload: async (next, { glb = true } = {}) => { m = upsert(next); if (studio) studio.kind = m.kind; renderModel(); if (glb) await loadModel(); refresh(); } });
  initTools({ root: el, scene: () => scene, studio: () => studio, change, draw, renderInspector });
  initPath({ scene: () => scene, studio: () => studio, change, draw, renderInspector });
  initShelf({ root: el, model: () => m, scene: () => scene, studio: () => studio, change, redraw: () => renderAside(true) });
  initLighting({ scene: () => scene, studio: () => studio, change, renderInspector, modelUrl: () => (m?.glb ? fileUrl(m, m.glb) : null) });
  el.innerHTML = `
  <div class="comp-top">${stepper('compose', m)}
    <div class="ctop-act">
      <a class="btn ghostbtn" href="#/share/${esc(m.id)}" title="Shortcut: S">${icon('external')}<span>Share</span><kbd>S</kbd></a>
      <button class="btn sec" type="button" data-render="still">${icon('camera')}<span>Render still</span></button>
      <button class="btn pri" type="button" data-render="turntable">${icon('film')}<span>Render turntable</span></button>
    </div>
  </div>
  <section class="compose">
    <aside class="scenes glass" aria-label="Scene">
      <div class="chips seg sm aside-tabs" role="tablist" aria-label="Left panel">
        <button class="chip" type="button" role="tab" data-aside="places" aria-selected="true">Places</button>
        <button class="chip" type="button" role="tab" data-aside="shelf" aria-selected="false" title="Shortcut: A">Add things <kbd>A</kbd></button>
      </div>
      <div class="scnlist" id="scenes"></div>
      <div class="shelf" id="shelf" hidden></div>
      <input type="file" id="backdropFile" accept=".hdr,.exr,.jpg,.jpeg,.png" hidden>
    </aside>
    <div class="vp-col">
      <div class="viewport glass" id="vp">
        <canvas id="cv" tabindex="0" aria-label="3D scene of ${esc(m.name)}. Drag or use the arrow keys to turn the car."></canvas>
        <div class="safe" id="safe" aria-hidden="true"></div>
        <div class="hud h1" id="hudScene"></div>
        <div class="hud h2" id="hudCam"></div>
        <div class="hud h3" id="hudLook"></div>
        <div class="hud dims" id="hudDims" hidden></div>
        <div class="hud measure" id="hudMeasure" hidden></div>
        <div class="hud msg" id="hudMsg" role="status">Loading model…</div>
        <div class="vtool" role="toolbar" aria-label="Viewport tools">
          <button class="vt" type="button" data-tool="move" aria-pressed="false" title="Move the car" aria-label="Move the car">${icon('move')}</button>
          <button class="vt" type="button" data-tool="turn" aria-pressed="true" title="Turn the car" aria-label="Turn the car">${icon('orbit')}</button>
          <button class="vt" type="button" data-jump="grp-camera" title="Camera settings" aria-label="Camera settings">${icon('camera')}</button>
          <button class="vt" type="button" data-jump="grp-light" title="Light settings" aria-label="Light settings">${icon('light')}</button>
        </div>
      </div>
      <div class="timeline glass">
        <div class="tl-head">
          <button class="btn icon" type="button" id="play" aria-label="Play turntable">${icon('play')}</button>
          <b>Turntable</b>
          <div class="chips seg sm" role="radiogroup" aria-label="Turntable range">
            <button class="chip" type="button" role="radio" data-mode="360">360° · ${FRAMES} frames</button>
            <button class="chip" type="button" role="radio" data-mode="180">180° · ${HALF} frames</button>
          </div>
          <span class="tl-read" id="readout" aria-live="polite"></span><span class="tl-step">${STEP}° per frame</span>
        </div>
        <div class="ticks" id="ticks" role="slider" tabindex="0" aria-label="Turntable frame" aria-valuemin="0" aria-valuemax="${FRAMES - 1}">${'<i></i>'.repeat(FRAMES)}</div>
        <div class="tl-lab" aria-hidden="true"><span>0°</span><span>90°</span><span>180°</span><span>270°</span><span>355°</span></div>
      </div>
    </div>
    <aside class="insp glass" aria-label="Inspector">
      <div class="chips tabs" id="tabs">
        <button class="chip" type="button" data-jump="modelGroup" aria-selected="true">Model</button>
        <button class="chip" type="button" data-jump="grp-model">Place</button>
        <button class="chip" type="button" data-jump="grp-tools">Tools</button>
        <button class="chip" type="button" data-jump="grp-path">Camera move</button>
        <button class="chip" type="button" data-jump="grp-lighting">Lighting</button>
        <button class="chip" type="button" data-jump="grp-camera">Camera</button>
        <button class="chip" type="button" data-jump="grp-light">Light</button>
        <button class="chip" type="button" data-jump="grp-ground">Ground</button>
        <button class="chip" type="button" data-jump="grp-parts">Parts</button>
        <button class="chip" type="button" data-jump="grp-color">Color</button>
        <button class="chip" type="button" data-jump="grp-material">Material</button>
        <button class="chip" type="button" data-jump="grp-scene">Scene</button>
        <button class="chip" type="button" data-jump="grp-export">Export</button>
      </div>
      <div id="modelGroup"></div>
      <div id="inspector"></div>
      <input type="file" id="betterPhoto" accept="image/png,image/jpeg,image/heic,image/heif,.heic,.heif" hidden>
      <input type="file" id="lookFile" hidden>
    </aside>
  </section>`;

  renderScenes();
  renderModel();
  renderInspector();
  renderTimeline();
  bind();
  let s;
  try {
    s = studio = new Studio($('#cv', el));
    s.kind = m.kind; // humanoid or car; unset on models from before v3, then motion.js detects it
    s.setRig(state.settings || {}); // the light rig and glass set on the Render step
    s.enableOrbit(onOrbit); // free roam: drag orbits, wheel zooms, right or Shift drag pans
  } catch {
    $('#hudMsg', el).textContent = 'The scene composer needs WebGL, which is not available here.';
    return;
  }
  observer = new ResizeObserver(resize);
  observer.observe($('#vp', el));
  resize();
  await s.setState(scene);
  if (studio !== s) return; // left the screen while the scene loaded
  s.setFrame(frame);
  try {
    await s.load(fileUrl(m, m.glb));
    if (studio !== s) return;
    $('#hudMsg', el).hidden = !s.message;
    $('#hudMsg', el).textContent = s.message;
    renderInspector(); // the size lock depends on the model's shape
  } catch (e) {
    if (studio !== s) return;
    $('#hudMsg', el).textContent = `Could not load the model: ${e.message}`;
  }
  draw();
}

// The orbit camera moved (free roam): redraw at once, save once the drag ends.
function onOrbit(orbit, settled) {
  scene.orbit = orbit;
  if (settled) change({ orbit }, { inspector: false });
  else draw();
}

export function unmount() {
  hist.clear();
  gridOn = false;
  stopMotion();
  stop();
  observer?.disconnect();
  cancelAnimationFrame(raf);
  if (saveTimer) { clearTimeout(saveTimer); save(); }
  studio?.dispose();
  studio = null;
}

function resize() {
  const vp = $('#vp', root);
  if (!vp || !studio) return;
  const r = vp.getBoundingClientRect();
  studio.resize(Math.max(1, r.width), Math.max(1, r.height), Math.min(devicePixelRatio, 2));
  studio.coverBackground();
  draw();
}

// Render on demand: changes ask for one frame instead of running a loop.
function draw() {
  if (!studio) return;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => {
    studio.render();
    const f = studio.frameRect;
    Object.assign($('#safe', root).style, { left: `${f.x + 6}px`, top: `${f.y + 6}px`, width: `${f.width - 12}px`, height: `${f.height - 12}px` });
    if (studio.tracing && !studio.pt?.done) { // progressive path tracing: one sample per frame until done
      $('#hudLook', root).textContent = `Path traced · ${studio.samples} samples`;
      draw();
    } else if (studio.animating) draw(); // rain keeps falling
  });
  renderHud();
}

function renderHud() {
  const cam = CAMERAS[scene.camera] || CAMERAS.front34;
  $('#hudScene', root).innerHTML = `${icon('scene', 14)} ${esc(PRESETS[scene.preset].label)}`;
  $('#hudCam', root).innerHTML = `${icon('camera', 14)} ${scene.view === 'free' ? `Free roam · ${scene.lens} mm · F frames all` : ENVIRONMENTS[scene.preset] ? 'Eye-level camera · real-world scale' : `${cam.label} · ${scene.lens} mm · ${cam.height}`}`;
  $('#cv', root).classList.toggle('orbit', scene.view === 'free');
  const look = lookOf(scene.preset);
  $('#hudLook', root).textContent = `${look === 'studio' ? 'Studio' : LOOKS[look].label} look · ${look === 'transparent' ? '1:1' : '4:3'} · 2048 px`;
  $('#vp', root).classList.toggle('clear', scene.preset === 'transparent');
  $('#vp', root).classList.toggle('light', scene.preset === 'transparent' || scene.preset === 'cyclorama');
  if (studio && !$('#hudMsg', root).textContent.startsWith('Loading')) {
    $('#hudMsg', root).hidden = !studio.message;
    $('#hudMsg', root).textContent = studio.message || '';
  }
}

function save() {
  saveTimer = null;
  send(`/api/models/${m.id}`, 'PATCH', { scene }).then(upsert).catch((e) => toast(e.message));
}

async function change(next, { inspector = true, fromHistory = false } = {}) {
  if (!fromHistory && Object.keys(next).length) {
    if (Date.now() - lastPush > 600) hist.push(scene, Object.keys(next).join(', ')); // one step per burst (a slider drag)
    lastPush = Date.now();
  }
  Object.assign(scene, next);
  if (studio) {
    await studio.setState(scene);
    if (scene.view === 'free') scene.orbit = studio.state.orbit; // the first switch starts from the car camera
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  if (inspector) renderInspector();
  if ('autoOrient' in next || 'center' in next) renderModel();
  renderScenes();
  draw();
  if (gridOn) renderGrid();
}

async function stepHistory(redo) {
  const prev = redo ? hist.redo(scene) : hist.undo(scene);
  if (!prev) return toast(redo ? 'Nothing to redo' : 'Nothing to undo', 'info');
  for (const k of Object.keys(scene)) if (!(k in prev)) delete scene[k];
  lastPush = 0;
  await change(prev, { fromHistory: true });
  renderGrid();
}
const gridUnit = () => state.settings?.gridUnit || 'm';
function renderGrid() {
  if (!studio) return;
  const size = studio.modelSize();
  if (gridOn && size) studio.setGrid(true, { ...gridSpec(size, gridUnit()), refs: [REFERENCES.human, REFERENCES.car] });
  else studio.setGrid(false);
  const el = $('#hudDims', root);
  if (el) { el.hidden = !gridOn || !size; el.textContent = size ? dimensions(size, gridUnit()).text : ''; }
}

function frameAll() {
  const changed = studio?.frameAll();
  if (!changed) return;
  Object.assign(scene, changed);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  draw();
}

function setFrame(f) {
  frame = ((f % FRAMES) + FRAMES) % FRAMES;
  state.frames[m.id] = frame;
  studio?.setFrame(frame);
  renderTimeline();
  draw();
}

function stop() {
  clearInterval(playing);
  playing = null;
  const b = $('#play', root);
  if (b) { b.innerHTML = icon('play'); b.setAttribute('aria-label', 'Play turntable'); }
}

function play() {
  if (playing) return stop();
  let dir = 1;
  playing = setInterval(() => {
    if (mode === 180) {
      if (frame >= HALF - 1) dir = -1;
      if (frame <= 0) dir = 1;
      setFrame(Math.min(HALF - 1, frame + dir));
    } else setFrame(frame + 1);
  }, 1000 / 12);
  $('#play', root).innerHTML = icon('pause');
  $('#play', root).setAttribute('aria-label', 'Pause turntable');
}

function renderTimeline() {
  $$('[data-mode]', root).forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.mode) === mode)));
  $$('#ticks i', root).forEach((t, i) => { t.className = `${i < HALF ? 'in' : ''}${i % 18 === 0 ? ' maj' : ''}${i === frame ? ' cur' : ''}`; });
  const ticks = $('#ticks', root);
  ticks.setAttribute('aria-valuenow', frame);
  ticks.setAttribute('aria-valuetext', `Frame ${pad3(frame)}, ${frame * STEP}°`);
  $('#readout', root).textContent = `Frame ${pad3(frame)} · ${frame * STEP}°`;
}

function renderScenes() {
  const art = {
    ring: '<div class="stage s-ring"><div class="sg-wall"></div><div class="sg-panel"></div><div class="sg-bar l"></div><div class="sg-bar r"></div><div class="sg-floor"></div><div class="sg-ring"></div></div>',
    transparent: '<div class="stage s-clear"><div class="checker"></div><div class="sc-shadow"></div></div>',
    cyclorama: '<div class="stage s-cyc"><div class="sc-shadow"></div></div>',
    miami: '<div class="stage s-miami"><div class="sm-sky"></div><div class="sm-city"></div><div class="sm-road"></div><div class="sm-neon"></div></div>',
    custom: '<div class="stage s-hdri"></div>',
  };
  const files = state.settings?.backdrops || {};
  const html = Object.entries(PRESETS).map(([key, p]) => {
    const file = files[key];
    const photo = file && /\.(jpe?g|png)$/i.test(file) ? `<img class="thumb" src="/backdrops/${encodeURIComponent(file)}" alt="">` : '';
    const note = (key === 'miami' || key === 'custom') && file ? `${file.endsWith('.hdr') || file.endsWith('.exr') ? 'HDRI' : 'Backdrop'} added · click again to replace` : p.note;
    const needs = (key === 'miami' || key === 'custom') && !file;
    const thumb = p.env ? `<div class="stage"><img class="thumb" src="${p.thumb}" alt="" onerror="this.remove()"></div>` : '';
    return `<button class="scn${key === 'white-cyc-studio' ? ' pinned' : ''}" type="button" data-preset="${key}" aria-pressed="${scene.preset === key}">
      <div class="scn-th">${thumb || (photo ? `<div class="stage">${photo}</div>` : art[key])}${needs ? `<div class="up">${icon('upload', 18)}</div>` : ''}${key === 'white-cyc-studio' ? '<span class="pin">Default</span>' : ''}</div>
      <div class="scn-t"><b>${p.label}</b><span>${esc(note)}</span></div></button>`;
  }).join('');
  const box = $('#scenes', root);
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
  renderAside();
}

// Places or Add things (the shelf) in the left panel. The shelf redraws only when its content changed, so a
// scene edit never steals the search box's focus.
function renderAside(force = false) {
  $('#scenes', root).hidden = aside !== 'places';
  $('#shelf', root).hidden = aside !== 'shelf';
  $$('[data-aside]', root).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aside === aside)));
  if (aside !== 'shelf') return;
  const box = $('#shelf', root);
  const html = renderShelf();
  if (force || box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}
function toggleShelf(to = aside === 'shelf' ? 'places' : 'shelf') {
  aside = to;
  renderAside(true);
  if (aside === 'shelf') $('#shelfQ', root)?.focus();
}

function slider(key, label, min, max, step, value, text, disabled = false) {
  const p = ((value - min) / (max - min)) * 100;
  return `<div class="sl"><label for="sl-${key}">${label}</label>
    <input class="range" type="range" id="sl-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${p}%" ${disabled ? 'disabled' : ''}>
    <span class="v" id="v-${key}">${text}</span></div>`;
}
const toggle = (key, label, small, checked, disabled = false) => `<label class="tg"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input class="sw" type="checkbox" role="switch" data-key="${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
const valueText = {
  x: (v) => `${fixed(v)} m`, y: (v) => `${fixed(v)} m`, turn: (v) => `${Math.round(v)}°`,
  scale: (v) => (sizeLocked() || Math.abs(v - 1) < 0.005 ? 'Fit' : `×${fixed(v)}`), lens: (v) => `${Math.round(v)} mm`,
  key: (v) => fixed(v, 1), fill: (v) => fixed(v, 1), rim: (v) => fixed(v, 1), reflection: level, shadow: softness,
};

function renderInspector() {
  const s = scene;
  $('#inspector', root).innerHTML = `
    <div class="grp" id="grp-model"><h3>${icon('move', 14)} Position</h3>
      ${slider('x', 'X', -3, 3, 0.01, s.x, valueText.x(s.x))}
      ${slider('y', 'Y', -1, 1, 0.01, s.y, valueText.y(s.y), s.snap)}
      ${toggle('snap', 'Snap tires to floor', '', s.snap)}
    </div>
    <div class="grp"><h3>Rotation and scale</h3>
      ${slider('turn', 'Turn', 0, 359, 1, s.turn, valueText.turn(s.turn))}
      ${slider('scale', 'Scale', 0.2, 1.5, 0.01, sizeLocked() ? 1 : s.scale, valueText.scale(s.scale), sizeLocked())}
      ${toggle('sameSize', 'Same size for every car', carLike() ? 'Locks length so the fleet matches' : 'Off for this model: it is taller than it is long, so it is not a car', s.sameSize, !carLike())}
      ${toggle('flip', 'Flip front and back', 'Use it if the tail faces the camera at 0°', s.flip)}
    </div>
    <div class="grp" id="grp-camera"><h3>${icon('camera', 14)} Camera</h3>
      <div class="viewmode"><div class="chips seg sm" role="radiogroup" aria-label="View mode">${Object.entries(VIEWS).map(([k, label]) => `<button class="chip" type="button" role="radio" data-view="${k}" aria-checked="${(s.view || 'car') === k}">${label}</button>`).join('')}</div>
      <button class="btn sm ghostbtn" type="button" data-act="frame" title="Fit the whole model in view (F)">Frame all</button></div>
      ${s.view === 'free' ? `<p class="fine">Drag to orbit · scroll to zoom · right-drag or Shift-drag to pan · F frames the whole model. Car view keeps its own camera.</p>
      ${slider('lens', 'Lens', 18, 135, 1, s.lens, valueText.lens(s.lens))}`
      : ENVIRONMENTS[s.preset] ? '<p class="fine">Set by the place: eye level, at real-world scale, with the car on its floor. Turn the car with Turn, or use Free roam to look around.</p>'
      : `<div class="chips" role="radiogroup" aria-label="Camera preset">${Object.entries(CAMERAS).map(([k, c]) => `<button class="chip" type="button" role="radio" data-camera="${k}" aria-checked="${s.camera === k}">${c.label}</button>`).join('')}</div>
      ${slider('lens', 'Lens', 18, 135, 1, s.lens, valueText.lens(s.lens))}`}
    </div>
    <div class="grp" id="grp-light"><h3>${icon('light', 14)} Light</h3>
      ${toggle('matchLighting', 'Match lighting to scene', 'Key, fill and rim follow the studio', s.matchLighting)}
      ${s.matchLighting ? '' : `<div class="lights">${slider('key', 'Key', 0, 3, 0.1, s.key, valueText.key(s.key))}${slider('fill', 'Fill', 0, 3, 0.1, s.fill, valueText.fill(s.fill))}${slider('rim', 'Rim', 0, 3, 0.1, s.rim, valueText.rim(s.rim))}</div>`}
    </div>
    <div class="grp" id="grp-grid"><h3>Reference grid</h3>
      <label class="tg"><span>Show grid and scale<small>Person 1.8 m and car 4.5 m for size. Not rendered.</small></span><input class="sw" type="checkbox" role="switch" data-grid="on" ${gridOn ? 'checked' : ''}></label>
      <div class="chips seg sm" role="radiogroup" aria-label="Units">${[['m', 'Meters'], ['ft', 'Feet']].map(([k, l]) => `<button class="chip" type="button" role="radio" data-unit="${k}" aria-checked="${gridUnit() === k}">${l}</button>`).join('')}</div>
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-act="undo" ${hist.canUndo ? '' : 'disabled'} title="Ctrl+Z">Undo</button><button class="btn sm ghostbtn" type="button" data-act="redo" ${hist.canRedo ? '' : 'disabled'} title="Ctrl+Shift+Z">Redo</button></div>
      ${hist.canUndo ? `<ol class="histlist fine">${hist.list().slice(0, 8).map((h) => `<li>${esc(h.label)}</li>`).join('')}</ol>` : ''}
    </div>
    <div class="grp" id="grp-ground"><h3>Ground</h3>
      ${slider('reflection', 'Reflection', 0, 1, 0.01, s.reflection, hasFloor() ? level(s.reflection) : 'n/a', !hasFloor())}
      ${slider('shadow', 'Shadow', 0, 1, 0.01, s.shadow, softness(s.shadow))}
    </div>${renderLightingGroup()}${renderToolsGroup()}${renderPathGroup()}${renderMotionGroup()}${renderPaintGroups()}`;
  afterRender();
}

// The model itself: versions, approve, regenerate and clean up (what the Review step used to hold).
function renderModel() {
  const box = $('#modelGroup', root);
  if (!box) return;
  const thumb = (v) => (v.thumb ? fileUrl(m, v.thumb) : v.source ? fileUrl(m, v.source) : '');
  const html = `<div class="grp model-grp"><h3>${icon('cube', 14)} Model</h3>
      <p class="sub">${esc(m.name)} · ${m.status === 'ready' ? `${esc(engineLabel(m))}${m.credits != null ? ` · ${m.credits} credits` : ''}` : esc(statusText(m))}</p>
      ${m.versions.length > 1 ? `<div class="vers">${m.versions.map((v) => `
        <button class="ver" type="button" data-version="${v.n}" aria-pressed="${v.n === m.activeVersion}" title="${esc(engineLabel(v))}" ${v.status === 'ready' ? '' : 'disabled'}>
          <div class="stage s-clear"><div class="checker"></div>${thumb(v) ? `<img class="thumb" src="${thumb(v)}" alt="Version ${v.n} of ${esc(m.name)}">` : ''}</div>
          <span>Version ${v.n}</span><small>${v.status === 'ready' ? esc(engineLabel(v).replace('3D AI Studio · ', '')) : v.status === 'failed' ? 'Failed' : `${v.progress || 0}%`}</small>
        </button>`).join('')}</div>` : ''}
      <button class="btn sm ${m.approved ? 'ghostbtn' : 'pri'}" type="button" data-act="approve" aria-pressed="${Boolean(m.approved)}">${icon('check', 14)}<span>${m.approved ? 'Approved · undo' : 'Approve'}</span></button>
      ${m.provider === 'upload' ? '' : `<div class="mg-row"><button class="btn sm sec" type="button" data-act="regen" title="Regenerate from the same photo" ${isGenerating(m) ? 'disabled' : ''}>${icon('retry', 14)}<span>Regenerate</span></button>
      <button class="btn sm ghostbtn" type="button" data-act="better" title="Regenerate with a better photo" ${isGenerating(m) ? 'disabled' : ''}>${icon('upload', 14)}<span>New photo</span></button></div>
      <p class="fine">Regenerating is a new paid job on the setup screen; older versions stay here.</p>`}
      ${toggle('autoOrient', 'Auto-orient', 'Wheels down, nose to the camera', scene.autoOrient)}
      ${toggle('center', 'Center and ground on floor', 'Applied here and in every render', scene.center)}
    </div>`;
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

export function update() {
  const fresh = findModel(m?.id);
  if (!fresh || !root?.isConnected) return;
  const glb = m.glb;
  m = fresh;
  renderModel();
  if (m.status === 'ready' && m.glb !== glb) loadModel();
}

async function loadModel() {
  const s = studio;
  if (!s) return;
  $('#hudMsg', root).hidden = false;
  $('#hudMsg', root).textContent = 'Loading model…';
  try {
    await s.load(fileUrl(m, m.glb));
    if (studio !== s) return;
    $('#hudMsg', root).hidden = !s.message;
    $('#hudMsg', root).textContent = s.message;
    renderInspector();
  } catch (e) {
    if (studio === s) $('#hudMsg', root).textContent = `Could not load the model: ${e.message}`;
  }
  draw();
}

function bind() {
  const el = root;
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.aside) return toggleShelf(t.dataset.aside);
    if (onShelfClick(e)) return;
    if (await onToolsClick(t)) return;
    if (await onPathClick(t)) return;
    if (await onLightingClick(t)) return;
    if (await onMotionClick(t)) return;
    if (await onPaintClick(t)) return;
    if (t.dataset.render) { state.renderIntent = t.dataset.render; location.hash = `#/render/${m.id}`; }
    if (t.dataset.version) {
      try { m = upsert(await send(`/api/models/${m.id}`, 'PATCH', { activeVersion: Number(t.dataset.version) })); } catch (err) { return toast(err.message); }
      renderModel();
      await loadModel();
      refresh();
    }
    if (t.dataset.act === 'approve') {
      try { m = upsert(await send(`/api/models/${m.id}`, 'PATCH', { approved: !m.approved })); } catch (err) { return toast(err.message); }
      renderModel();
      refresh();
    }
    if (t.dataset.act === 'regen') await busy(t, () => setupFor(m).catch((err) => toast(err.message)));
    if (t.dataset.act === 'better') $('#betterPhoto', el).click();
    if (t.dataset.preset) {
      const key = t.dataset.preset;
      const file = state.settings?.backdrops?.[key];
      if ((key === 'miami' || key === 'custom') && (!file || scene.preset === key)) {
        const input = $('#backdropFile', el);
        input.dataset.slot = key;
        input.click();
        if (!file) return;
      }
      if (scene.preset !== key) await change({ preset: key, backdrop: file || null });
    }
    if (t.dataset.tool) {
      tool = t.dataset.tool;
      $$('[data-tool]', el).forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      $('#cv', el).classList.toggle('moving', tool === 'move');
    }
    if (t.dataset.jump) {
      $(`#${t.dataset.jump}`, el)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $$('#tabs .chip', el).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.jump === t.dataset.jump)));
    }
    if (t.dataset.camera) {
      const c = CAMERAS[t.dataset.camera];
      await change({ camera: t.dataset.camera, turn: c.turn, lens: c.lens, fit: 'footprint' });
    }
    if (t.dataset.view) await change({ view: t.dataset.view }); // the car preset and the orbit are both kept
    if (t.dataset.act === 'frame') frameAll();
    if (t.dataset.mode) { mode = Number(t.dataset.mode); if (mode === 180 && frame >= HALF) setFrame(0); renderTimeline(); }
    if (t.id === 'play') play();
  });
  el.addEventListener('input', (e) => {
    if (onShelfInput(e)) return;
    if (onMotionInput(e.target)) return;
    if (onPaintInput(e.target)) return;
    const k = e.target.dataset.key;
    if (!k || e.target.type !== 'range') return;
    const v = Number(e.target.value);
    e.target.style.setProperty('--p', `${((v - e.target.min) / (e.target.max - e.target.min)) * 100}%`);
    $(`#v-${k}`, el).textContent = k === 'reflection' && !hasFloor() ? 'n/a' : valueText[k](v);
    change({ [k]: v }, { inspector: false });
  });
  el.addEventListener('change', async (e) => {
    if (onToolsChange(e.target)) return;
    if (onPathChange(e.target)) return;
    if (await onMotionChange(e.target)) return;
    if (await onPaintChange(e.target)) return;
    const k = e.target.dataset.key;
    if (k && e.target.type === 'checkbox') change({ [k]: e.target.checked, ...(k === 'sameSize' && e.target.checked && { scale: 1 }), ...(k === 'center' && { snap: e.target.checked }) });
    if (e.target.id === 'betterPhoto' && e.target.files[0]) {
      const files = [...e.target.files];
      e.target.value = '';
      setupFor(m, files).catch((err) => toast(err.message));
    }
  });
  $('#backdropFile', el).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const slot = e.target.dataset.slot;
    e.target.value = '';
    if (!file) return;
    $('#hudMsg', el).hidden = false;
    $('#hudMsg', el).textContent = `Uploading ${file.name}…`;
    try {
      state.settings.backdrops = await api(`/api/backdrops?slot=${slot}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      $('#hudMsg', el).textContent = 'Loading backdrop…';
      await change({ preset: slot, backdrop: state.settings.backdrops[slot] });
      refresh();
    } catch (err) { toast(err.message); }
    $('#hudMsg', el).hidden = !studio?.message;
    $('#hudMsg', el).textContent = studio?.message || '';
  });

  // Timeline: click or drag across the ticks, arrow keys step one frame.
  const ticks = $('#ticks', el);
  const pick = (e) => {
    const r = ticks.getBoundingClientRect();
    const f = Math.round(((e.clientX - r.left) / r.width) * (FRAMES - 1));
    setFrame(Math.max(0, Math.min(mode === 180 ? HALF - 1 : FRAMES - 1, f)));
  };
  ticks.addEventListener('pointerdown', (e) => { stop(); ticks.setPointerCapture(e.pointerId); pick(e); ticks.onpointermove = pick; });
  ticks.addEventListener('pointerup', () => { ticks.onpointermove = null; });
  const keys = (e) => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    stop();
    setFrame(mode === 180 ? Math.max(0, Math.min(HALF - 1, frame + d)) : frame + d);
  };
  ticks.addEventListener('keydown', keys);

  // Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y): undo and redo scene edits, except while typing in a text field.
  el.addEventListener('keydown', (e) => {
    if (e.target.closest('input[type=text], input[type=search], textarea')) return;
    if (isUndo(e)) { e.preventDefault(); stepHistory(false); } else if (isRedo(e)) { e.preventDefault(); stepHistory(true); }
  });
  // Grid controls live in the inspector.
  el.addEventListener('click', async (e) => {
    const u = e.target.closest('[data-unit]');
    if (u) { try { state.settings = await send('/api/settings', 'POST', { gridUnit: u.dataset.unit }); } catch (err) { toast(err.message); } renderInspector(); renderGrid(); }
    const a = e.target.closest('[data-act="undo"], [data-act="redo"]');
    if (a) stepHistory(a.dataset.act === 'redo');
  });
  el.addEventListener('change', (e) => { if (e.target.dataset.grid) { gridOn = e.target.checked; renderGrid(); } });

  // F frames the whole model, anywhere on the screen but in a text field.
  el.addEventListener('keydown', (e) => {
    if (onToolsKey(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select')) return;
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); frameAll(); }
    if (e.key.toLowerCase() === SINGLE_KEYS.shelf.toLowerCase()) { e.preventDefault(); toggleShelf(); }
  });

  // Viewport: drag to turn the car through the turntable frames, or to move it with the move tool.
  // In free roam the drag belongs to the orbit camera (OrbitControls on the same canvas).
  const cv = $('#cv', el);
  cv.addEventListener('keydown', keys);
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { if (scene.view === 'free') return; stop(); cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, frame, sx: scene.x, sy: scene.y }; });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (tool === 'turn') setFrame(drag.frame - Math.round(dx / 8));
    else {
      const perPx = 9.2 / (studio?.frameRect.width || 800); // metres per pixel at the car
      change({ x: Math.max(-3, Math.min(3, drag.sx + dx * perPx)), ...(!scene.snap && { y: Math.max(-1, Math.min(1, drag.sy - dy * perPx)) }) });
    }
  });
  cv.addEventListener('pointerup', () => { drag = null; });
  // Drag a texture tile from the Material group onto a piece.
  el.addEventListener('dragstart', (e) => { if (!onShelfDragStart(e)) onPaintDragStart(e); });
  cv.addEventListener('dragover', (e) => { if (isShelfDrag(e) || e.dataTransfer.types.includes('application/x-flatform-texture')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  cv.addEventListener('drop', (e) => {
    if (isShelfDrag(e)) { e.preventDefault(); e.stopPropagation(); $('#vp', el).classList.remove('dropping'); onShelfDrop(e, cv); return; }
    const id = e.dataTransfer.getData('application/x-flatform-texture');
    if (!id || !studio?.model) return;
    e.preventDefault();
    e.stopPropagation();
    const r = cv.getBoundingClientRect();
    const key = studio.pick(e.clientX - r.left, e.clientY - r.top);
    if (key) onTextureDrop(id, key); else toast('Drop the texture on a piece of the model');
  });
  // A click (not a drag) on the model picks that piece for the Parts, Color and Material groups.
  let down = null;
  cv.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; }, true);
  cv.addEventListener('click', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !studio?.model) return;
    const r = cv.getBoundingClientRect();
    if (onDecalCanvasClick(e.clientX - r.left, e.clientY - r.top)) return;
    if (onCanvasClick(e.clientX - r.left, e.clientY - r.top)) return;
    const key = studio.pick(e.clientX - r.left, e.clientY - r.top);
    if (key) { selectPiece(key); $('#grp-parts', el)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  });
}
