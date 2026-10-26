// Compose · Render: the render area under the scene (it was its own Render tab before v0.6). Renders the composed
// scene to the handoff folder. Every render you start goes into the queue tray and runs one at a time.
// In-app renderer: the same Three.js studio, offscreen at full size, turning only the car 5° per frame.
// Blender renderer (optional): render/blender_turntable.py writes the frames; sprites are made here either way.
// A render belongs to the car it started on and keeps going if you leave Compose; the top-bar light follows it.
import { mountExport } from './compose-video.js';
import { $, $$, esc, state, api, send, toast, findModel, fileUrl, upsert, refresh, native, announce, providerOf, FORMATS, setRenderLight, go } from '../app.js';
import { statusLight, taskLabel, resultFile, nextTask, waitingCount, trimQueue, STATUS_TEXT } from '../lib/render-status.js';
import { icon } from '../lib/icons.js';
import * as P from '../lib/pipeline.js';
import { Studio, defaultScene, kelvinColor } from '../lib/studio.js';
import { tennogenApplies, tennogenCard, onTennogen, onTennogenSubmit, tennogenGate } from '../lib/tennogen-ui.js';
import { makeSheets as makeSheetSet, downscale, toBlob } from '../lib/sheets.js';

let root;
let m; // the car on screen
let opts;
let previewLook = 'showroom';
let job = null; // { model, opts, task, yaw, renderer, frame, total, t0, f0, paused, cancelled, done, error, phaseText }
let queue = []; // the queue tray: { id, model, opts, label, status, error, outDir, file }
let hooks = {};
const CELL = 64; // preview cell width
const LOOK_KEYS = Object.keys(P.LOOKS); // showroom, studio (the composed scene), transparent
let rigTimer;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sep = () => (state.settings?.platform === 'win32' ? '\\' : '/');
const outDir = () => (state.settings?.outputRoot ? `${state.settings.outputRoot}${sep()}${m.slug}` : '');
const blenderReady = () => Boolean(state.blender?.found);
const running = () => Boolean(job && !job.done);
const onScreen = () => Boolean(job && m && job.model.id === m.id && root?.isConnected);

// Draws the render area into el (a box inside Compose) for model m. hooks.onRig: the light rig changed.
export function mountRender(el, model, h = {}) {
  root = el;
  m = model;
  hooks = h;
  const intent = state.renderIntent;
  state.renderIntent = null;
  opts ||= freshOpts();
  if (intent === 'still') Object.assign(opts, { still: true, t360: false, t180: false });
  if (intent === 'turntable') Object.assign(opts, { t360: true, t180: true });
  if (!running()) opts.renderer = state.settings?.renderer === 'blender' && blenderReady() ? 'blender' : 'three';
  el.innerHTML = `<div class="rowhead ra-head"><h2 class="ph2">${icon('film', 18)} Render</h2><span class="sub">Pick what you want below, then press the orange button. Finished renders go to your handoff folder and show up in Library.</span></div>
  <div class="export">
    <div class="ex-left" id="left"></div>
    <div class="ex-mid">
      <div class="rowhead sheethead"><h2 class="label">Sprite preview · 360°</h2>
        <div class="chips seg sm" role="radiogroup" aria-label="Preview look">
          <button class="chip" type="button" role="radio" data-preview="showroom" title="Show the Showroom look in the preview">Showroom</button>
          <button class="chip" type="button" role="radio" data-preview="studio" title="Show your Compose scene in the preview">Compose scene</button>
          <button class="chip" type="button" role="radio" data-preview="transparent" title="Show the see-through look in the preview">Transparent</button>
        </div></div>
      <div class="sheet"><canvas id="sheet360" aria-label="Preview of the 360° sprite sheet. It fills in frame by frame while rendering."></canvas></div>
      <div class="sheet-meta"><span>${P.COLUMNS} columns × ${P.spriteGrid(P.FRAMES).rows} rows</span><span>Frame 000 is front ¾</span><span>Web copies at 512 and 256 px, WebP + PNG</span></div>
      <div class="rowhead sheethead"><h2 class="label">180° half turn · detail page</h2><span class="sub">Cut from the same ${P.FRAMES} frames, no extra rendering</span></div>
      <div class="sheet"><canvas id="sheet180" aria-label="Preview of the 180° sprite sheet. It fills in frame by frame while rendering."></canvas></div>
      <div class="renderbar">
        <div><b id="rbTitle">Ready to render</b><span id="rbSub" aria-live="polite"></span></div>
        <div class="pbar big" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" id="rbBar"><i style="width:0"></i></div>
        <div class="rb-act" id="rbAct"></div>
      </div>
    </div>
    <aside class="ex-right" id="right"></aside>
  </div>`;
  // The area sits inside Compose: its clicks and slider moves are its own, not the scene composer's.
  const own = (fn) => (e) => { e.stopPropagation(); fn(e); };
  el.addEventListener('click', own(onClick));
  el.addEventListener('change', own(onChange));
  el.addEventListener('submit', own(onSubmit));
  el.addEventListener('input', own(onInput));
  renderLeft();
  renderRight();
  renderBar();
  resetPreview();
  mountExport(el, m, { track });
  if (intent) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function freshOpts() {
  const o = { still: false, t360: true, t180: true, models: false, formats: new Set(), ...Object.fromEntries(LOOK_KEYS.map((l) => [l, P.DEFAULT_LOOKS.includes(l)])) };
  if (state.settings?.alsoTransparent === false && !running()) o.transparent = false;
  return o;
}
// Reset scene: render options, light rig and glass back to how they start. Returns a function that undoes it.
export function resetRenderOptions() {
  const before = { opts, lighting: state.settings?.lighting, glass: state.settings?.glass };
  const apply = (o, lighting, glass) => {
    opts = { renderer: state.settings?.renderer === 'blender' && blenderReady() ? 'blender' : 'three', ...o };
    saveRig('lighting', lighting);
    saveRig('glass', glass);
    if (root?.isConnected) { renderLeft(); renderRight(); }
  };
  apply(freshOpts(), { ...P.DEFAULT_LIGHTING }, { ...P.DEFAULT_GLASS });
  return () => apply(before.opts || freshOpts(), before.lighting, before.glass);
}

export function updateRender() {
  if (!root?.isConnected || !m) return;
  m = findModel(m.id) || m;
  renderLeft();
  renderRight();
}

// ---- panels ----
function renderLeft() {
  const busy = running(); // options stay open while rendering: the next render waits in the queue
  const card = (key, title, desc, tip) => `<label class="oc" title="${tip}"><input type="checkbox" data-opt="${key}" ${opts[key] ? 'checked' : ''}><span class="cb">${icon('check', 12)}</span><div><b>${title}</b><span class="d">${desc}</span></div></label>`;
  const look = (key, title, desc, art, tip) => `<button class="look" type="button" data-look="${key}" aria-pressed="${opts[key]}" title="${tip}"><div class="lk">${art}</div><b>${title}</b><span>${desc}</span></button>`;
  const f = (x) => `<button class="chip" type="button" data-format="${x}" aria-pressed="${opts.formats.has(x)}" title="Also save the model as ${x}">${x}${m.exports?.[x]?.status === 'ready' ? ' ✓' : ''}</button>`;
  const tripo = providerOf(m) === 'tripo'; // only Tripo can convert its own models to other formats
  const html = `<h2 class="label">What to render</h2>
    ${card('still', 'Still picture', `PNG · 2048 px · the angle you see now (${stillYaw(m)}°)`, 'One sharp picture from the angle the scene is turned to right now')}
    ${card('t360', '360° turntable', `${P.FRAMES} frames · ${P.STEP}° steps · loops`, 'A full spin you can drag on a website. Makes the sprite sheets and a viewer page.')}
    ${card('t180', '180° half turn', `Frames 000–0${P.HALF - 1} · stops at both ends`, 'Half a spin, front to back, for a detail page. Uses the same frames as the 360.')}
    ${card('models', 'Model files', tripo ? 'GLB · GLTF · FBX · USDZ · OBJ · STL · 3MF' : 'GLB', 'Copy the 3D model itself into the handoff folder')}
    ${opts.models && tripo ? `<div class="fmtpick" role="group" aria-label="Extra formats"><span class="chip on" aria-label="GLB is always included" title="GLB is always included">GLB</span>${FORMATS.map(f).join('')}</div>
      <p class="fine" style="margin:-4px 0 10px 32px">GLB is copied straight away. Other formats are converted by Tripo the first time, then copied.</p>` : ''}
    ${opts.models && !tripo ? '<p class="fine" style="margin:-4px 0 10px 32px">Other formats come from Tripo’s converter, which only works on models made with Tripo direct.</p>' : ''}
    <h2 class="label">Looks</h2>
    <div class="looks">
      ${look('showroom', 'Showroom', '4:3 photo room', `<div class="stage"><img class="thumb" src="${P.plateThumb('showroom')}" alt=""></div>`, 'Render in the Showroom photo, the website’s house look')}
      ${look('studio', 'Compose scene', 'What you set up above · 4:3', sceneArt(), 'Render exactly the scene you set up in Compose (White Cyc Studio unless you picked another)')}
      ${look('transparent', 'Transparent', '1:1 · see-through PNG', '<div class="stage s-clear"><div class="checker"></div><div class="sc-shadow"></div></div>', 'No background, just the model and a soft shadow, for lists and cut-outs')}
    </div>
    ${rigPanel(busy)}
    ${tennogenApplies(m) ? tennogenCard(m, busy) : ''}
    <div class="renderer-pick">
      <h2 class="label">Quality</h2>
      <div class="chips" role="radiogroup" aria-label="Renderer">
        <button class="chip" type="button" role="radio" data-renderer="three" aria-checked="${opts.renderer === 'three'}" title="Renders right here in Flatform. Quick, and looks like the viewport.">Quick (in Flatform)</button>
        <button class="chip" type="button" role="radio" data-renderer="blender" aria-checked="${opts.renderer === 'blender'}" ${!blenderReady() ? 'disabled' : ''} title="${blenderReady() ? 'Renders in Blender with Cycles. Slower, more realistic light.' : 'Needs Blender installed. Find it in Settings.'}">Best (Blender)</button>
      </div>
      <p class="fine">${blenderReady() ? `Blender: ${esc(state.blender.path)}` : 'Blender not found. Quick works fine; install Blender 4.x or find it in Settings for the Best option.'}</p>
    </div>`;
  const box = $('#left', root);
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

// The composed scene's thumbnail for the "Scene" look tile.
function sceneArt() {
  const preset = sceneFor(m, 'studio').preset;
  return P.PLATES[preset] ? `<div class="stage"><img class="thumb" src="${P.plateThumb(preset)}" alt=""></div>`
    : '<div class="stage s-ring"><div class="sg-wall"></div><div class="sg-panel"></div><div class="sg-bar l"></div><div class="sg-bar r"></div><div class="sg-floor"></div><div class="sg-ring"></div></div>';
}

// Light rig and glass: saved in settings, used by every look and by Blender.
const pct = (v) => `${Math.round(v * 100)}%`;
const RIG_TEXT = {
  key: pct, fill: pct, rim: pct, azimuth: (v) => `${Math.round(v)}°`, elevation: (v) => `${Math.round(v)}°`, kelvin: (v) => `${Math.round(v)} K`, opacity: pct,
};
const RIG_TIP = {
  key: 'How bright the main light is', azimuth: 'Which side the main light comes from', elevation: 'How high the main light is',
  kelvin: 'Warm (low) or cool (high) light', fill: 'Soft light that lifts the shadows', rim: 'Edge light and reflections from around the room', opacity: 'How see-through the windows are',
};
function rigSlider(group, key, label, min, max, step, value, disabled) {
  const p = ((value - min) / (max - min)) * 100;
  return `<div class="sl" title="${RIG_TIP[key]}"><label for="rig-${key}">${label}</label>
    <input class="range" type="range" id="rig-${key}" data-rig="${group}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${p}%" ${disabled ? 'disabled' : ''}>
    <span class="v" id="rv-${key}">${RIG_TEXT[key](value)}</span></div>`;
}
function rigPanel(busy) {
  const l = { ...P.DEFAULT_LIGHTING, ...state.settings?.lighting };
  const g = { ...P.DEFAULT_GLASS, ...state.settings?.glass };
  const swatch = `rgb(${kelvinColor(l.kelvin).map((v) => Math.round(v * 255)).join(',')})`;
  return `<div class="grp rig"><h3>${icon('light', 14)} Render lighting <button class="link" type="button" data-act="rig-reset" ${busy ? 'disabled' : ''} title="Put the render lights back the way they started">Reset</button></h3>
      ${rigSlider('lighting', 'key', 'Key', 0, 2, 0.05, l.key, busy)}
      ${rigSlider('lighting', 'azimuth', 'Direction', -180, 180, 5, l.azimuth, busy)}
      ${rigSlider('lighting', 'elevation', 'Height', 5, 85, 1, l.elevation, busy)}
      ${rigSlider('lighting', 'kelvin', `Colour <i class="kswatch" id="kswatch" style="background:${swatch}"></i>`, 2700, 9000, 100, l.kelvin, busy)}
      ${rigSlider('lighting', 'fill', 'Fill', 0, 2, 0.05, l.fill, busy)}
      ${rigSlider('lighting', 'rim', 'Rim · env', 0, 2, 0.05, l.rim, busy)}
    </div>
    <div class="grp rig"><h3>${icon('cube', 14)} Glass</h3>
      <label class="tg" title="Darken the windows like real tinted glass"><span>Tinted glass<small>Found by name, or dark glossy texture on Tripo scans</small></span><input class="sw" type="checkbox" role="switch" data-glass="on" ${g.on ? 'checked' : ''} ${busy ? 'disabled' : ''}></label>
      ${g.on ? `<div class="sl"><label for="rig-tint">Tint</label><input class="tint" type="color" id="rig-tint" title="The colour of the window tint" data-glass="tint" value="${esc(g.tint)}" ${busy ? 'disabled' : ''}><span class="v">${esc(g.tint)}</span></div>
      ${rigSlider('glass', 'opacity', 'Opacity', 0, 1, 0.05, g.opacity, busy)}` : ''}
    </div>`;
}
function saveRig(group, patch) {
  state.settings = { ...state.settings, [group]: { ...state.settings?.[group], ...patch } };
  hooks.onRig?.(); // the Compose viewport shows the new light at once
  clearTimeout(rigTimer);
  rigTimer = setTimeout(() => send('/api/settings', 'POST', { lighting: state.settings.lighting, glass: state.settings.glass })
    .then((s) => { state.settings = s; }).catch((e) => toast(e.message)), 300);
}

function renderRight() {
  const s = state.settings || {};
  const busy = running();
  const dir = outDir();
  const d = sep();
  const html = `<h2 class="label">Handoff folder</h2>
    <div class="path" title="Where finished renders are saved">${icon('folder')}<code>${dir ? esc(dir) : `Not chosen yet · suggested ${esc(s.suggestedOutputRoot || '')}`}</code></div>
    <button class="btn ghostbtn wide" type="button" data-act="folder" title="Pick the folder renders are saved in" ${busy ? 'disabled' : ''}><span>${dir ? 'Change folder' : 'Choose folder'}</span></button>
    <form class="field pathform" id="folderForm" hidden><label for="folderIn">Folder</label><input class="inp mono" id="folderIn" name="outputRoot" value="${esc(s.outputRoot || s.suggestedOutputRoot || '')}" spellcheck="false" title="The full path of the folder"><button class="btn ghostbtn" type="submit" title="Use this folder">Save</button></form>
    <div class="cta">
      <button class="btn pri" type="button" data-act="render" title="${busy ? 'Something is rendering: this waits in the queue and starts next' : 'Start rendering what you picked on the left'}">${icon('film')}<span>${busy ? 'Add to queue' : 'Render to handoff folder'}</span></button>
      <button class="btn ghostbtn" type="button" data-act="open" title="Open the handoff folder on this computer" ${native && (m.renders?.outDir || s.outputRoot) ? '' : 'disabled'}>${icon('folder')}<span>Open folder</span></button>
    </div>
    ${trayHtml()}
    <details class="ra-more"><summary title="What ends up in the handoff folder">What’s in the folder</summary>
    <div class="tree">
      <div class="tr-l">${icon('folder', 14)}<div><code>web${d}</code><span>360 + 180 sheets · 512 and 256 px · sprite json · posters</span></div></div>
      <div class="tr-l">${icon('folder', 14)}<div><code>frames${d}</code><span>${P.FRAMES} PNGs per look · 2048 px</span></div></div>
      <div class="tr-l">${icon('cube', 14)}<div><code>spin-viewer.js · viewer.html</code><span>Drag-to-spin viewer for the site and admin</span></div></div>
      <div class="tr-l">${icon('cube', 14)}<div><code>HANDOFF.md</code><span>What goes where, for the web team</span></div></div>
    </div>
    <div class="dest"><h3>Where each piece goes</h3>${P.DESTINATIONS.map((x) => `<p><b>${x.label}</b>${esc(x.use)}</p>`).join('')}</div></details>`;
  const box = $('#right', root);
  if (box.dataset.html !== html && !box.contains(document.activeElement?.id === 'folderIn' ? document.activeElement : null)) {
    const open = box.querySelector('.ra-more')?.open;
    box.dataset.html = html; box.innerHTML = html;
    if (open) box.querySelector('.ra-more').open = true;
  }
}

// The queue tray: every render and video started from here, newest last.
function trayHtml() {
  if (!queue.length) return '<div class="tray" aria-label="Queue"><h3>Queue</h3><p class="fine">Nothing waiting. Renders you start line up here and run one after another.</p></div>';
  const row = (t) => `<li class="tq ${t.status}" title="${esc(t.error || STATUS_TEXT[t.status])}"><i class="dot ${t.status === 'done' ? 'ok' : t.status === 'running' ? 'busy' : t.status === 'waiting' ? 'wait' : ''}"></i>
    <span><b>${esc(t.model.name)}</b><small>${esc(t.label)}</small></span><em>${t.status === 'running' && job?.task === t ? `${statusLight(job).pct}%` : STATUS_TEXT[t.status]}</em>
    ${t.status === 'waiting' ? `<button class="link" type="button" data-remove="${t.id}" title="Take this one out of the queue">Remove</button>` : ''}
    ${t.status === 'done' && t.file ? `<button class="link" type="button" data-reveal="${t.id}" title="Show the finished file in its folder" ${native ? '' : 'hidden'}>Show</button>` : ''}</li>`;
  return `<div class="tray" aria-label="Queue"><h3>Queue <button class="link" type="button" data-act="clear-tray" title="Clear finished renders from this list">Clear finished</button></h3><ol>${queue.map(row).join('')}</ol></div>`;
}

function renderBar() {
  const other = job && job.model.id !== m?.id;
  const light = statusLight(job, waitingCount(queue));
  setRenderLight(light, job?.model.id); // the top bar shows it on every screen
  document.getElementById('vp')?.classList.toggle('rendering', running()); // the Compose viewport glows while rendering
  const bar = root?.isConnected && $('#rbBar', root);
  if (!bar) return;
  const pct = job?.done && !job.error && !job.cancelled ? 100 : light.pct;
  $('#rbTitle', root).textContent = !job ? 'Ready to render'
    : job.done ? `${other ? `${job.model.name}: ` : ''}${job.error ? 'Render stopped' : job.cancelled ? 'Render cancelled' : 'Render finished'}`
      : `Rendering ${other ? job.model.name : ''} ${job.renderer === 'blender' ? 'in Blender' : 'in Flatform'}${job.paused ? ' · paused' : ''}`.replace(/\s+/g, ' ');
  $('#rbSub', root).textContent = !job ? (outDir() ? 'Saves into the handoff folder on the right' : 'Choose a handoff folder first')
    : job.error || (running() ? `${job.phaseText || ''} · ${light.text.split(' · ').slice(1).join(' · ')}` : job.phaseText) || '';
  bar.setAttribute('aria-valuenow', pct);
  bar.firstElementChild.style.width = `${pct}%`;
  const act = running() ? `${job.renderer === 'three' ? `<button class="btn ghostbtn" type="button" data-act="pause" title="${job.paused ? 'Carry on rendering' : 'Pause for now, carry on later'}">${job.paused ? 'Resume' : 'Pause'}</button>` : ''}<button class="btn ghostbtn" type="button" data-act="cancel" title="Stop this render. The queue moves on to the next one.">Cancel</button>` : '';
  if ($('#rbAct', root).dataset.html !== act) { $('#rbAct', root).dataset.html = act; $('#rbAct', root).innerHTML = act; }
}

// ---- sprite preview: a 12-column grid (360) and the 37 frames of the 180 ----
function previewCanvas(id, frames, cols) {
  const c = $(`#${id}`, root);
  const { height } = P.frameSize(previewLook, CELL);
  const rows = Math.ceil(frames / cols);
  c.width = cols * CELL + (cols - 1) * 3;
  c.height = rows * height + (rows - 1) * 3;
  return c;
}
function cell(id, i, cols, source, sx = 0, sy = 0, sw = source.width, sh = source.height) {
  const c = root?.isConnected && $(`#${id}`, root);
  if (!c) return;
  const g = c.getContext('2d');
  const { height } = P.frameSize(previewLook, CELL);
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, sx, sy, sw, sh, (i % cols) * (CELL + 3), Math.floor(i / cols) * (height + 3), CELL, height);
}
function resetPreview() {
  if (!root?.isConnected || !$('#sheet360', root)) return;
  $$('[data-preview]', root).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.preview === previewLook)));
  for (const [id, frames, cols] of [['sheet360', P.FRAMES, P.COLUMNS], ['sheet180', P.HALF, 19]]) {
    const c = previewCanvas(id, frames, cols);
    const g = c.getContext('2d');
    const { height } = P.frameSize(previewLook, CELL);
    g.fillStyle = '#0d0b09';
    for (let i = 0; i < frames; i++) g.fillRect((i % cols) * (CELL + 3), Math.floor(i / cols) * (height + 3), CELL, height);
  }
  // Show the last render of this look, straight from the handoff folder.
  if (!running() && (m.renders?.[`${previewLook}360`] || m.renders?.[`${previewLook}180`])) {
    const turn = m.renders[`${previewLook}360`] ? 360 : 180;
    const img = new Image();
    img.onload = () => {
      const w = img.width / P.COLUMNS;
      const h = P.frameSize(previewLook, w).height;
      for (let i = 0; i < P.turnFrames(turn); i++) {
        const { col, row } = P.cellOf(i);
        if (turn === 360) cell('sheet360', i, P.COLUMNS, img, col * w, row * h, w, h);
        if (i < P.HALF) cell('sheet180', i, 19, img, col * w, row * h, w, h);
      }
    };
    img.src = `/api/renders/${m.id}/file?path=${encodeURIComponent(`web/${P.sheetName(previewLook, turn, 256)}`)}&t=${Date.now()}`;
  }
}

// ---- events ----
const redrawLeft = () => { m = findModel(m.id) || m; $('#left', root).dataset.html = ''; renderLeft(); };
async function onClick(e) {
  if (await onTennogen(e, m, redrawLeft)) return;
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.preview && !(running() && onScreen())) { previewLook = t.dataset.preview; resetPreview(); }
  if (t.dataset.act === 'rig-reset') { saveRig('lighting', P.DEFAULT_LIGHTING); renderLeft(); }
  if (t.dataset.look) { opts[t.dataset.look] = !opts[t.dataset.look]; renderLeft(); }
  if (t.dataset.renderer) { opts.renderer = t.dataset.renderer; renderLeft(); }
  if (t.dataset.format) {
    const f = t.dataset.format;
    opts.formats.has(f) ? opts.formats.delete(f) : opts.formats.add(f);
    renderLeft();
  }
  const act = t.dataset.act;
  if (act === 'folder') {
    if (native) {
      const dir = await native.pickFolder();
      if (dir) await saveFolder(dir);
    } else { $('#folderForm', root).hidden = false; $('#folderIn', root).focus(); }
  }
  if (act === 'open') native?.openPath(m.renders?.outDir || state.settings.outputRoot).catch(() => native.openPath(state.settings.outputRoot)).catch((err) => toast(err.message));
  if (act === 'render') enqueue();
  if (act === 'clear-tray') { queue = queue.filter((q) => ['waiting', 'running'].includes(q.status)); renderRight(); }
  if (t.dataset.remove) { queue = queue.filter((q) => q.id !== t.dataset.remove || q.status !== 'waiting'); renderRight(); renderBar(); }
  if (t.dataset.reveal) reveal(queue.find((q) => q.id === t.dataset.reveal));
  if (act === 'pause' && job) { job.paused = !job.paused; renderBar(); }
  if (act === 'cancel' && job) {
    job.cancelled = true;
    if (job.renderer === 'blender') api(`/api/renders/${job.model.id}/blender`, { method: 'DELETE' }).catch(() => {});
    renderBar();
  }
}
function onChange(e) {
  if (e.target.dataset.tg) return onTennogen(e, m, redrawLeft);
  const k = e.target.dataset.opt;
  if (k) { opts[k] = e.target.checked; renderLeft(); }
  const g = e.target.dataset.glass;
  if (g === 'on') { saveRig('glass', { on: e.target.checked }); renderLeft(); }
}
// Sliders update their own text while dragging; the panel is not redrawn so the thumb keeps focus.
function onInput(e) {
  const t = e.target;
  if (t.dataset.glass === 'tint') { t.nextElementSibling.textContent = t.value; saveRig('glass', { tint: t.value }); return; }
  if (!t.dataset.rig) return;
  const v = Number(t.value);
  t.style.setProperty('--p', `${((v - t.min) / (t.max - t.min)) * 100}%`);
  $(`#rv-${t.dataset.key}`, root).textContent = RIG_TEXT[t.dataset.key](v);
  if (t.dataset.key === 'kelvin') $('#kswatch', root).style.background = `rgb(${kelvinColor(v).map((c) => Math.round(c * 255)).join(',')})`;
  saveRig(t.dataset.rig, { [t.dataset.key]: v });
  $('#left', root).dataset.html = ''; // the next redraw picks up the new value
}
async function onSubmit(e) {
  if (await onTennogenSubmit(e, m, redrawLeft)) return;
  e.preventDefault();
  await saveFolder($('#folderIn', root).value.trim());
}
async function saveFolder(dir) {
  try { state.settings = await send('/api/settings', 'POST', { outputRoot: dir }); } catch (err) { return toast(err.message); }
  refresh();
  renderBar();
}

// ---- rendering ----
function stillYaw(model) {
  const scene = { ...defaultScene(state.settings), ...model.scene };
  return (((scene.turn + (state.frames[model.id] ?? 0) * P.STEP) % 360) + 360) % 360;
}

async function put(rel, body) {
  const r = await fetch(`/api/renders/${job.model.id}/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not write ${rel}`);
}

function progress(text, frame, total) {
  if (total !== job.total || !job.t0 || frame < job.frame) Object.assign(job, { t0: Date.now(), f0: frame }); // a new phase: time it afresh
  Object.assign(job, { phaseText: text, frame, total });
  renderBar();
}

async function checkpoint() {
  if (job.paused) { while (job.paused && !job.cancelled) await sleep(150); Object.assign(job, { t0: Date.now(), f0: job.frame }); }
  if (job.cancelled) throw new Error('Cancelled');
}

// The scene for a look: the studio look uses the composed scene (or the default studio if it was composed as
// transparent); the transparent look reuses the same car, camera and lights with no background.
function sceneFor(model, look) {
  const s = { ...defaultScene(state.settings), ...model.scene };
  if (look === 'transparent') return { ...s, preset: 'transparent' };
  if (look === 'showroom') return { ...s, preset: 'showroom', backdrop: null };
  if (s.preset === 'transparent') return { ...s, preset: state.settings?.defaultScene && state.settings.defaultScene !== 'transparent' ? state.settings.defaultScene : 'cyclorama', backdrop: null };
  return s;
}
// The photo plate a look is laid over, or null (3D scenes and the modeled showroom).
function plateFor(model, look) {
  const s = sceneFor(model, look);
  return look !== 'transparent' && P.PLATES[s.preset] && !(s.preset === 'showroom' && s.modeled) ? s.preset : null;
}
// Blender renders a photo scene's car on a transparent shadow catcher; this lays it over the plate (cover-fit).
async function overPlate(img, plate) {
  const c = document.createElement('canvas');
  Object.assign(c, { width: img.naturalWidth, height: img.naturalHeight });
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const s = Math.max(c.width / plate.naturalWidth, c.height / plate.naturalHeight);
  g.drawImage(plate, (c.width - plate.naturalWidth * s) / 2, (c.height - plate.naturalHeight * s) / 2, plate.naturalWidth * s, plate.naturalHeight * s);
  g.drawImage(img, 0, 0);
  return c;
}

// Draws frames into the web sprite sheets as they arrive (lib/sheets.js), in Flatform's own web/ layout.
function makeSheets(look, turns) {
  const files = turns.flatMap((turn) => P.sheetFiles(look, turn).map((f) => ({ turn, width: f.width, type: f.type, name: `web/${f.name}` })));
  return makeSheetSet(look, files, { put, posterNames: { webp: `web/${P.posterName(look, 'webp')}`, png: `web/${P.posterName(look, 'png')}` } });
}


// "Render to handoff folder": checks the picks, then lines the render up in the queue tray.
async function enqueue() {
  const looks = LOOK_KEYS.filter((l) => opts[l]);
  if (!state.settings?.outputRoot) return toast('Choose a handoff folder first');
  if (!looks.length && (opts.still || opts.t360 || opts.t180)) return toast('Pick at least one look');
  if (!opts.t360 && !opts.t180 && !opts.still && !opts.models) return toast('Pick something to render');
  if (!(await tennogenGate(m))) { redrawLeft(); return; } // TennoGen names and sizes, for Warframe models with a texture folder
  const snap = { ...opts, formats: new Set(opts.formats), yaw: stillYaw(m) }; // the still uses the angle on screen now
  queue = trimQueue([...queue, { id: crypto.randomUUID(), model: m, opts: snap, label: taskLabel(snap), status: 'waiting' }]);
  if (running()) toast(`Added to the queue. It starts when the current render is done.`, 'info');
  renderRight();
  renderBar();
  pump();
}

// Tracks work done elsewhere (a video export) in the same tray. Returns fn's result.
async function track(model, label, fn) {
  const t = { id: crypto.randomUUID(), model, label, status: 'running' };
  queue = trimQueue([...queue, t]);
  renderRight();
  try { const r = await fn(); Object.assign(t, { status: 'done', file: r?.output }); return r; } catch (e) { Object.assign(t, { status: 'failed', error: e.message }); throw e; } finally { renderRight(); }
}

function pump() {
  if (running()) return;
  const t = nextTask(queue);
  if (t) start(t).finally(pump);
}

const join = (dir, rel) => `${dir}${sep()}${rel.replaceAll('/', sep())}`;
function reveal(t) {
  if (!native || !t?.file) return;
  native.showItemInFolder(t.outDir ? join(t.outDir, t.file) : t.file).catch(() => native.openPath(t.outDir)).catch((err) => toast(err.message));
}

async function start(task) {
  const o = task.opts;
  const looks = LOOK_KEYS.filter((l) => o[l]);
  const turns = [o.t360 && 360, o.t180 && 180].filter(Boolean);
  const model = findModel(task.model.id) || task.model;
  task.status = 'running';
  job = { model, opts: o, task, yaw: o.yaw, renderer: o.renderer, frame: 0, total: 0, paused: false, cancelled: false, done: false };
  if (root?.isConnected) { renderLeft(); renderRight(); }
  renderBar();
  try {
    const formats = o.models && providerOf(model) === 'tripo' ? [...o.formats] : [];
    const started = await send(`/api/renders/${model.id}/start`, 'POST', { looks: turns.length || o.still ? looks : [], formats });
    const slug = started.slug;
    const frames = turns.length ? Math.max(...turns.map(P.turnFrames)) : 0;
    const manifests = {};
    if (turns.length || o.still) {
      if (job.renderer === 'blender') await renderBlender(slug, looks, turns, frames, manifests);
      else await renderInApp(slug, looks, turns, frames, manifests);
    }
    progress('Writing the handoff files', job.total, job.total);
    const version = state.settings?.version;
    if (turns.length) {
      await put('spin-viewer.js', await (await fetch('/lib/spin-viewer.js')).blob());
      await put('viewer.html', new Blob([P.viewerHtml({ name: model.name, manifests })]));
    }
    const stills = o.still ? looks.map((look) => ({ look, angle: job.yaw })) : [];
    const models = [`${slug}.glb`, ...formats.map((f) => `${slug}.${f.toLowerCase()} (when Tripo finishes converting)`)];
    await put('HANDOFF.md', new Blob([P.handoffText({ slug, name: model.name, looks: turns.length ? looks : [], turns, stills, models, renderer: job.renderer, version })]));
    upsert(await api(`/api/models/${model.id}`)); // the Library picks up the new poster and badges from this
    job.done = true;
    Object.assign(task, { status: 'done', outDir: started.outDir, file: resultFile({ slug, still: o.still, t360: o.t360, t180: o.t180, looks, yaw: job.yaw }) });
    progress(`Saved to ${started.outDir}`, job.total, job.total);
    announce(`${model.name}: render finished`);
    toast(`${model.name} is rendered. It's in Library and your handoff folder.`, 'info', [
      { label: 'Open', title: 'See the finished render in Library', run: () => go(`#/model/${model.id}`) },
      ...(native ? [{ label: 'Show in folder', title: 'Show the finished file on this computer', run: () => reveal(task) }] : []),
    ]);
  } catch (e) {
    job.done = true;
    task.status = job.cancelled ? 'cancelled' : 'failed';
    if (!job.cancelled) { job.error = task.error = e.message; toast(e.message); }
  }
  refresh();
  if (root?.isConnected) { renderLeft(); renderRight(); }
  renderBar();
}

async function renderInApp(slug, looks, turns, frames, manifests) {
  const { model } = job;
  const total = looks.length * (frames + (job.opts.still ? 1 : 0));
  let done = 0;
  for (const look of looks) {
    if (onScreen()) { previewLook = look; resetPreview(); }
    const { width, height } = P.LOOKS[look];
    const canvas = document.createElement('canvas');
    const studio = new Studio(canvas, { preserveDrawingBuffer: true });
    // Supersampling: render at twice the size (on top of MSAA) and scale down to the frame size.
    const ss = studio.renderer.capabilities.maxTextureSize >= width * 2 ? 2 : 1;
    const frame = document.createElement('canvas');
    Object.assign(frame, { width, height });
    const fg = frame.getContext('2d');
    fg.imageSmoothingQuality = 'high';
    const capture = () => {
      fg.clearRect(0, 0, width, height);
      fg.drawImage(ss > 1 ? downscale(canvas, width, height) : canvas, 0, 0);
      return frame;
    };
    try {
      studio.resize(width, height, ss);
      studio.setRig(state.settings || {});
      progress(`${P.LOOKS[look].label} · loading the scene`, done, total);
      await studio.setState(sceneFor(model, look));
      await studio.load(fileUrl(model, model.glb));
      const sheets = turns.length ? makeSheets(look, turns) : null;
      // Up to 4 frame uploads in flight. Every upload is kept so a failed one fails the render.
      const uploads = [];
      const inflight = new Set();
      const queue = async (p) => {
        uploads.push(p);
        inflight.add(p);
        p.then(() => inflight.delete(p), () => inflight.delete(p));
        while (inflight.size >= 4) await Promise.race(inflight).catch(() => {});
      };
      let poster;
      for (let i = 0; i < frames; i++) {
        await checkpoint();
        studio.setFrame(i);
        await studio.applySkyFrame();
        studio.render();
        const out = capture();
        await queue(toBlob(out, 'image/png').then((b) => put(P.framePath(slug, look, i), b)));
        const small = sheets.draw(i, out);
        if (i === 0) poster = small[512];
        if (onScreen() && previewLook === look) {
          if (turns.includes(360)) cell('sheet360', i, P.COLUMNS, small[256]);
          if (i < P.HALF) cell('sheet180', i, 19, small[256]);
        }
        progress(`${P.LOOKS[look].label} · frame ${P.pad3(i + 1)} of ${P.pad3(frames)}`, ++done, total);
        if (i % 4 === 3) await sleep(0); // let the page breathe
      }
      if (job.opts.still) {
        await checkpoint();
        studio.frame = 0;
        studio.state.turn = job.yaw;
        studio.applyYaw();
        studio.render();
        await put(`stills/${P.stillName(slug, look, job.yaw)}`, await toBlob(capture(), 'image/png'));
        progress(`${P.LOOKS[look].label} · still image`, ++done, total);
      }
      await Promise.all(uploads);
      if (sheets) {
        progress(`${P.LOOKS[look].label} · writing sprite sheets`, done, total);
        await sheets.write(poster);
        await writeManifests(slug, look, turns, 'three', manifests);
      }
    } finally {
      studio.dispose();
    }
  }
}

async function renderBlender(slug, looks, turns, frames, manifests) {
  const { model } = job;
  await send(`/api/renders/${model.id}/blender`, 'POST', { looks, frames, ...(job.opts.still && { still: job.yaw }) });
  for (;;) {
    await sleep(700);
    const b = await api(`/api/renders/${model.id}/blender`);
    const index = Math.max(0, looks.indexOf(b.look));
    progress(`${P.LOOKS[b.look]?.label || ''} · frame ${P.pad3(b.frame)} of ${P.pad3(frames)}`, index * frames + b.frame, looks.length * frames || 1);
    if (b.status === 'done') break;
    if (b.status !== 'running') throw new Error(b.error || `Blender ${b.status}`);
    if (job.cancelled) throw new Error('Cancelled');
  }
  const load = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };
  const fileSrc = (rel) => `/api/renders/${model.id}/file?path=${encodeURIComponent(rel)}&t=${Date.now()}`;
  // Photo scenes: Blender's frames (and still) go over the plate first, written back in place.
  const plates = {};
  for (const look of looks) {
    const slug_ = plateFor(model, look);
    if (!slug_) continue;
    try { plates[look] = await load(P.plateUrl(slug_)); } catch { toast(`Backplate ${slug_}.jpg is missing · frames keep a transparent background`); }
  }
  if (job.opts.still) {
    for (const look of looks.filter((l) => plates[l])) {
      const rel = `stills/${P.stillName(slug, look, job.yaw)}`;
      await put(rel, await toBlob(await overPlate(await load(fileSrc(rel)), plates[look]), 'image/png'));
    }
  }
  // Same sprite step as the in-app renderer, from the PNGs Blender wrote.
  for (const look of turns.length ? looks : []) {
    if (onScreen()) { previewLook = look; resetPreview(); }
    const sheets = makeSheets(look, turns);
    let poster;
    for (let i = 0; i < frames; i++) {
      await checkpoint();
      let img = await load(fileSrc(P.framePath(slug, look, i)));
      if (plates[look]) {
        img = await overPlate(img, plates[look]);
        await put(P.framePath(slug, look, i), await toBlob(img, 'image/png'));
      }
      const small = sheets.draw(i, img);
      if (i === 0) poster = small[512];
      if (onScreen() && previewLook === look) {
        if (turns.includes(360)) cell('sheet360', i, P.COLUMNS, img);
        if (i < P.HALF) cell('sheet180', i, 19, img);
      }
      progress(`${P.LOOKS[look].label} · sprite frame ${P.pad3(i + 1)} of ${P.pad3(frames)}`, i + 1, frames);
    }
    await sheets.write(poster);
    await writeManifests(slug, look, turns, 'blender', manifests);
  }
}

async function writeManifests(slug, look, turns, renderer, manifests) {
  for (const turn of turns) {
    const json = P.manifest({ slug, name: job.model.name, look, turn, renderer, version: state.settings?.version });
    manifests[`${look}${turn}`] = json;
    await put(`web/${P.spriteJsonName(look, turn)}`, new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
  }
}
