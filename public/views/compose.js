// 04 · Compose: the scene composer. One Three.js studio, five scene presets, an inspector and a turntable timeline.
// The scene is saved per model (scene.json next to the model) so a render reproduces it exactly.
import { $, $$, esc, state, api, send, toast, stepper, findModel, fileUrl, upsert, refresh } from '../app.js';
import { icon } from '../lib/icons.js';
import { FRAMES, HALF, STEP, pad3 } from '../lib/pipeline.js';
import { Studio, PRESETS, CAMERAS, defaultScene, lookOf } from '../lib/studio.js';

let root;
let m;
let studio;
let scene;
let frame = 0;
let mode = 360;
let tool = 'turn';
let playing = null;
let observer;
let saveTimer;
let raf;

const fixed = (n, d = 2) => Number(n).toFixed(d);
const level = (v) => (v <= 0.02 ? 'Off' : v < 0.35 ? 'Soft' : v < 0.7 ? 'Medium' : 'Strong');
const softness = (v) => (v < 0.3 ? 'Hard' : v < 0.7 ? 'Soft' : 'Very soft');

export async function mount(el, { id }) {
  root = el;
  m = findModel(id);
  frame = state.frames[id] ?? 0;
  if (!m || m.status !== 'ready') {
    el.innerHTML = `${stepper('compose', m)}<p class="muted">${m ? 'This model is not ready yet.' : 'Pick a model from the library first.'} <a class="link" href="${m ? `#/generate/${m.id}` : '#/library'}">${m ? 'Show progress' : 'Open library'}</a></p>`;
    return;
  }
  scene = { ...defaultScene(state.settings), ...m.scene };
  el.innerHTML = `
  <div class="comp-top">${stepper('compose', m)}
    <div class="ctop-act">
      <button class="btn sec" type="button" data-render="still">${icon('camera')}<span>Render still</span></button>
      <button class="btn pri" type="button" data-render="turntable">${icon('film')}<span>Render turntable</span></button>
    </div>
  </div>
  <section class="compose">
    <aside class="scenes glass" aria-label="Scene">
      <h2 class="label">Scene</h2>
      <div class="scnlist" id="scenes"></div>
      <input type="file" id="backdropFile" accept=".hdr,.exr,.jpg,.jpeg,.png" hidden>
    </aside>
    <div class="vp-col">
      <div class="viewport glass" id="vp">
        <canvas id="cv" tabindex="0" aria-label="3D scene of ${esc(m.name)}. Drag or use the arrow keys to turn the car."></canvas>
        <div class="safe" id="safe" aria-hidden="true"></div>
        <div class="hud h1" id="hudScene"></div>
        <div class="hud h2" id="hudCam"></div>
        <div class="hud h3" id="hudLook"></div>
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
        <button class="chip" type="button" data-jump="grp-model" aria-selected="true">Model</button>
        <button class="chip" type="button" data-jump="grp-camera">Camera</button>
        <button class="chip" type="button" data-jump="grp-light">Light</button>
        <button class="chip" type="button" data-jump="grp-ground">Ground</button>
      </div>
      <div id="inspector"></div>
    </aside>
  </section>`;

  renderScenes();
  renderInspector();
  renderTimeline();
  bind();
  let s;
  try {
    s = studio = new Studio($('#cv', el));
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
  } catch (e) {
    if (studio !== s) return;
    $('#hudMsg', el).textContent = `Could not load the model: ${e.message}`;
  }
  draw();
}

export function unmount() {
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
  });
  renderHud();
}

function renderHud() {
  const cam = CAMERAS[scene.camera] || CAMERAS.front34;
  $('#hudScene', root).innerHTML = `${icon('scene', 14)} ${esc(PRESETS[scene.preset].label)}`;
  $('#hudCam', root).innerHTML = `${icon('camera', 14)} ${cam.label} · ${scene.lens} mm · ${cam.height}`;
  $('#hudLook', root).textContent = lookOf(scene.preset) === 'studio' ? 'Studio look · 4:3 · 2048 px' : 'Transparent look · 1:1 · 2048 px';
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

async function change(next, { inspector = true } = {}) {
  Object.assign(scene, next);
  if (studio) await studio.setState(scene);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
  if (inspector) renderInspector();
  renderScenes();
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
    gold: '<div class="stage s-gold"><div class="sg-wall"></div><div class="sg-panel"></div><div class="sg-bar l"></div><div class="sg-bar r"></div><div class="sg-floor"></div><div class="sg-ring"></div></div>',
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
    return `<button class="scn" type="button" data-preset="${key}" aria-pressed="${scene.preset === key}">
      <div class="scn-th">${photo ? `<div class="stage">${photo}</div>` : art[key]}${needs ? `<div class="up">${icon('upload', 18)}</div>` : ''}</div>
      <div class="scn-t"><b>${p.label}</b><span>${esc(note)}</span></div></button>`;
  }).join('');
  const box = $('#scenes', root);
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function slider(key, label, min, max, step, value, text, disabled = false) {
  const p = ((value - min) / (max - min)) * 100;
  return `<div class="sl"><label for="sl-${key}">${label}</label>
    <input class="range" type="range" id="sl-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${p}%" ${disabled ? 'disabled' : ''}>
    <span class="v" id="v-${key}">${text}</span></div>`;
}
const toggle = (key, label, small, checked) => `<label class="tg"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input class="sw" type="checkbox" role="switch" data-key="${key}" ${checked ? 'checked' : ''}></label>`;
const valueText = {
  x: (v) => `${fixed(v)} m`, y: (v) => `${fixed(v)} m`, turn: (v) => `${Math.round(v)}°`,
  scale: (v) => (scene.sameSize || Math.abs(v - 1) < 0.005 ? 'Fit' : `×${fixed(v)}`), lens: (v) => `${Math.round(v)} mm`,
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
      ${slider('scale', 'Scale', 0.5, 1.5, 0.01, s.sameSize ? 1 : s.scale, valueText.scale(s.scale), s.sameSize)}
      ${toggle('sameSize', 'Same size for every car', 'Locks length so the fleet matches', s.sameSize)}
      ${toggle('flip', 'Flip front and back', 'Use it if the tail faces the camera at 0°', s.flip)}
    </div>
    <div class="grp" id="grp-camera"><h3>${icon('camera', 14)} Camera</h3>
      <div class="chips" role="radiogroup" aria-label="Camera preset">${Object.entries(CAMERAS).map(([k, c]) => `<button class="chip" type="button" role="radio" data-camera="${k}" aria-checked="${s.camera === k}">${c.label}</button>`).join('')}</div>
      ${slider('lens', 'Lens', 18, 135, 1, s.lens, valueText.lens(s.lens))}
    </div>
    <div class="grp" id="grp-light"><h3>${icon('light', 14)} Light</h3>
      ${toggle('matchLighting', 'Match lighting to scene', 'Key, fill and rim follow the studio', s.matchLighting)}
      ${s.matchLighting ? '' : `<div class="lights">${slider('key', 'Key', 0, 3, 0.1, s.key, valueText.key(s.key))}${slider('fill', 'Fill', 0, 3, 0.1, s.fill, valueText.fill(s.fill))}${slider('rim', 'Rim', 0, 3, 0.1, s.rim, valueText.rim(s.rim))}</div>`}
    </div>
    <div class="grp" id="grp-ground"><h3>Ground</h3>
      ${slider('reflection', 'Reflection', 0, 1, 0.01, s.reflection, s.preset === 'gold' ? level(s.reflection) : 'n/a', s.preset !== 'gold')}
      ${slider('shadow', 'Shadow', 0, 1, 0.01, s.shadow, softness(s.shadow))}
    </div>`;
}

function bind() {
  const el = root;
  el.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.render) { state.renderIntent = t.dataset.render; location.hash = `#/render/${m.id}`; }
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
      await change({ camera: t.dataset.camera, turn: c.turn, lens: c.lens });
    }
    if (t.dataset.mode) { mode = Number(t.dataset.mode); if (mode === 180 && frame >= HALF) setFrame(0); renderTimeline(); }
    if (t.id === 'play') play();
  });
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.key;
    if (!k || e.target.type !== 'range') return;
    const v = Number(e.target.value);
    e.target.style.setProperty('--p', `${((v - e.target.min) / (e.target.max - e.target.min)) * 100}%`);
    $(`#v-${k}`, el).textContent = k === 'reflection' && scene.preset !== 'gold' ? 'n/a' : valueText[k](v);
    change({ [k]: v }, { inspector: false });
  });
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.key;
    if (k && e.target.type === 'checkbox') change({ [k]: e.target.checked, ...(k === 'sameSize' && e.target.checked && { scale: 1 }) });
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

  // Viewport: drag to turn the car through the turntable frames, or to move it with the move tool.
  const cv = $('#cv', el);
  cv.addEventListener('keydown', keys);
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { stop(); cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, frame, sx: scene.x, sy: scene.y }; });
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
}
