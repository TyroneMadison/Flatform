// Compose · Render: the Render tool's card (v3). Pick one type (lib/render-types.js), press Run. The older controls
// (what to render, looks, light rig, engine, file types, folder) live under More settings and ride along with every
// type. Every render you start goes into the queue tray and runs one at a time.
// In-app renderer: the same Three.js studio, offscreen at full size, turning only the car 5° per frame.
// Blender renderer (optional): render/blender_turntable.py writes the frames; sprites are made here either way.
// A render belongs to the car it started on and keeps going if you leave Compose; the top-bar light follows it.
import { mountExport } from './compose-video.js';
import { $, $$, esc, state, api, send, toast, findModel, fileUrl, upsert, refresh, native, announce, providerOf, FORMATS, setRenderLight, go, pickDock } from '../app.js';
import { statusLight, rigLight, blockedByRig, taskLabel, resultFile, nextTask, waitingCount, trimQueue, STATUS_TEXT } from '../lib/render-status.js';
import { icon } from '../lib/icons.js';
import * as P from '../lib/pipeline.js';
import { Studio, defaultScene, kelvinColor } from '../lib/studio.js';
import { tennogenApplies, tennogenCard, onTennogen, onTennogenSubmit, tennogenGate } from '../lib/tennogen-ui.js';
import { makeSheets as makeSheetSet, downscale, toBlob } from '../lib/sheets.js';
import { RENDER_TYPES, typeOf, defaultOption, planRun, cleanExtras } from '../lib/render-types.js';
import { applyEffect, styled, poster, vertical } from '../lib/render-effects.js';

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
let pick = { type: 'picture', option: null, extras: {} }; // the type card picked, its option and a Render idea's extras

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
  pickIntent(intent);
  if (!running()) opts.renderer = state.settings?.renderer === 'blender' && blenderReady() ? 'blender' : 'three';
  el.innerHTML = `<div class="ra-types" id="raTypes" role="radiogroup" aria-label="What to make"></div>
  <div class="ra-opts" id="raOpts"></div>
  <div class="renderbar">
    <div><b id="rbTitle">Ready to render</b><span id="rbSub" aria-live="polite"></span></div>
    <div class="pbar big" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" id="rbBar"><i style="width:0"></i></div>
    <div class="rb-act" id="rbAct"></div>
  </div>
  <button class="btn pri big ra-run" type="button" data-act="run" id="raRun" title="Start making it. You can keep working while it renders."></button>
  <div id="raIdeasSlot"></div>
  <details class="ra-settings" id="raMore"><summary title="What to make, looks, light, quality, file types and the save folder">More settings</summary>
  <div class="export">
    <div class="ex-left" id="left"></div>
    <div class="ex-mid">
      <div class="rowhead sheethead"><h2 class="label">Spin preview · 360°</h2>
        <div class="chips seg sm" role="radiogroup" aria-label="Preview look">
          <button class="chip" type="button" role="radio" data-preview="showroom" title="Show the Showroom look in the preview">Showroom</button>
          <button class="chip" type="button" role="radio" data-preview="studio" title="Show your own scene in the preview">My scene</button>
          <button class="chip" type="button" role="radio" data-preview="transparent" title="Show the see-through background in the preview">See-through</button>
        </div></div>
      <div class="sheet"><canvas id="sheet360" aria-label="Preview of the 360° spin. It fills in picture by picture while rendering."></canvas></div>
      <div class="sheet-meta"><span>${P.COLUMNS} columns × ${P.spriteGrid(P.FRAMES).rows} rows</span><span>Picture 000 is front ¾</span><span>Web copies at 512 and 256 px, WebP + PNG</span></div>
      <div class="rowhead sheethead"><h2 class="label">180° half spin · detail page</h2><span class="sub">Made from the same ${P.FRAMES} pictures, no extra wait</span></div>
      <div class="sheet"><canvas id="sheet180" aria-label="Preview of the 180° half spin. It fills in picture by picture while rendering."></canvas></div>
    </div>
    <aside class="ex-right" id="right"></aside>
  </div></details>`;
  // The area sits inside Compose: its clicks and slider moves are its own, not the scene composer's.
  const own = (fn) => (e) => { if (e.target.closest?.('#renderIdeas')) return; e.stopPropagation(); fn(e); }; // the ideas are Compose's
  el.addEventListener('click', own(onClick));
  el.addEventListener('change', own(onChange));
  el.addEventListener('submit', own(onSubmit));
  el.addEventListener('input', own(onInput));
  renderTypes();
  renderLeft();
  renderRight();
  renderBar();
  resetPreview();
  mountExport($('#raMore', el), m, { track });
  if (intent) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// 'still' or 'turntable' (the R and T keys, Library's Render): pick Picture or Spin video.
function pickIntent(intent) {
  if (intent === 'still') { Object.assign(opts, { still: true, t360: false, t180: false }); pick = { type: 'picture', option: null, extras: {} }; }
  if (intent === 'turntable') { Object.assign(opts, { t360: true, t180: true }); pick = { type: 'spin', option: 'full', extras: {} }; }
}
/** The R and T keys in Compose: pick a still or a turntable and bring the Render button into view. */
export function showRenderIntent(intent) {
  if (!root?.isConnected || !opts) return;
  pickIntent(intent);
  renderTypes();
  renderLeft();
  root.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`${intent === 'still' ? 'Picture' : 'Spin video'} picked. Press Run to start.`, 'info');
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

/** A render idea (lib/render-ideas.js) ticks what to render ({ still, t360, t180, showroom, studio, transparent }) and
 * picks its type card, option and extras (poster title, exploded parts, clay or blueprint, phone 9:16). */
export function pickRender(patch, idea = {}) {
  if (!opts) return;
  Object.assign(opts, patch);
  if (idea.type) pick = { type: idea.type, option: idea.option ?? defaultOption(idea.type), extras: { ...(idea.extras || {}) } };
  if (pick.extras.poster === '') pick.extras.poster = m?.name || '';
  if (root?.isConnected) { renderTypes(); renderLeft(); }
}

export function updateRender() {
  if (!root?.isConnected || !m) return;
  m = findModel(m.id) || m;
  renderLeft();
  renderRight();
}

// ---- panels ----
// The type cards (Picture, Spin video ...), the picked type's options and a Render idea's extras, and the Run button.
const EXTRA_TEXT = { poster: 'Title text on top', vertical: 'Tall 9:16 for phones', explode: 'Parts pulled apart', override: 'Clay or blueprint' };
function renderTypes() {
  const box = $('#raTypes', root);
  if (!box) return;
  const t = typeOf(pick.type);
  pick.option ??= defaultOption(t.id);
  const cards = RENDER_TYPES.map((x) => `<button class="ra-type" type="button" role="radio" aria-checked="${x.id === t.id}" data-rtype="${x.id}" title="${esc(x.desc)}"><span class="rt-top"><b>${esc(x.label)}</b><span class="rt-time">${esc(x.time)}</span></span><small>${esc(x.desc)}</small></button>`).join('');
  if (box.dataset.html !== cards) { box.dataset.html = cards; box.innerHTML = cards; }
  const ex = pick.extras;
  const chips = [
    ...(t.options ? [`<div class="chips" role="radiogroup" aria-label="${esc(t.label)} options">${t.options.map(([k, label, tip]) => `<button class="chip" type="button" role="radio" data-ropt="${k}" aria-checked="${k === pick.option}" title="${esc(tip)}">${esc(label)}</button>`).join('')}</div>`] : []),
    ...(ex.effect?.override ? [`<div class="chips" role="radiogroup" aria-label="Clay or blueprint"><button class="chip" type="button" role="radio" data-rover="clay" aria-checked="${ex.effect.override === 'clay'}" title="One plain matte clay colour all over">Clay</button><button class="chip" type="button" role="radio" data-rover="blueprint" aria-checked="${ex.effect.override === 'blueprint'}" title="White lines on blueprint blue">Blueprint</button></div>`] : []),
    ...(ex.poster != null ? [`<label class="field ra-title" title="The big words on the poster"><span>Poster title</span><input class="inp" id="raTitle" data-rtitle maxlength="60" value="${esc(ex.poster)}" placeholder="${esc(m?.name || 'Your title')}"></label>`] : []),
    ...Object.entries({ poster: ex.poster != null, vertical: ex.vertical, explode: ex.effect?.explode > 0, override: Boolean(ex.effect?.override) }).filter(([, on]) => on).map(([k]) => `<button class="chip on" type="button" data-rdrop="${k}" title="Take this idea off: render without it">${EXTRA_TEXT[k]} ✕</button>`),
  ];
  const html = chips.join('');
  const o = $('#raOpts', root);
  if (o.dataset.html !== html && !o.contains(document.activeElement?.id === 'raTitle' ? document.activeElement : null)) { o.dataset.html = html; o.innerHTML = html; }
  const run = $('#raRun', root);
  const label = t.id === 'spin' && pick.option === 'photos' ? 'Open photo frames' : `${running() ? 'Add to queue' : 'Run'} ${t.label}`;
  const runHtml = `${icon('film')}<span>${esc(label)}</span>`;
  if (run.dataset.html !== runHtml) { run.dataset.html = runHtml; run.innerHTML = runHtml; }
  run.title = running() ? 'Something is rendering: this waits in the queue and starts next' : `Start: ${t.desc}. You can keep working while it renders.`;
}

function renderLeft() {
  const busy = running(); // options stay open while rendering: the next render waits in the queue
  const card = (key, title, desc, tip) => `<label class="oc" title="${tip}"><input type="checkbox" data-opt="${key}" ${opts[key] ? 'checked' : ''}><span class="cb">${icon('check', 12)}</span><div><b>${title}</b><span class="d">${desc}</span></div></label>`;
  const look = (key, title, desc, art, tip) => `<button class="look" type="button" data-look="${key}" aria-pressed="${opts[key]}" title="${tip}"><div class="lk">${art}</div><b>${title}</b><span>${desc}</span></button>`;
  const f = (x) => `<button class="chip" type="button" data-format="${x}" aria-pressed="${opts.formats.has(x)}" title="Also save the model as ${x}">${x}${m.exports?.[x]?.status === 'ready' ? ' ✓' : ''}</button>`;
  const tripo = providerOf(m) === 'tripo'; // only Tripo can convert its own models to other formats
  const html = `<h2 class="label">What to render</h2>
    ${card('still', 'Still picture', `PNG · 2048 px · the angle you see now (${stillYaw(m)}°)`, 'One sharp picture from the angle the scene is turned to right now')}
    ${card('t360', '360° spin', `${P.FRAMES} pictures · ${P.STEP}° apart · loops`, 'A full spin people can drag on a website, plus a viewer page')}
    ${card('t180', '180° half spin', `Pictures 000–0${P.HALF - 1} · stops at both ends`, 'Half a spin, front to back, for a detail page. Uses the same pictures.')}
    ${card('models', 'Model files', tripo ? '.glb · .gltf · .fbx · .usdz · .obj · .stl · .3mf' : '.glb', 'Copy the 3D model itself into the save folder')}
    ${opts.models && tripo ? `<div class="fmtpick" role="group" aria-label="Extra formats"><span class="chip on" aria-label="The .glb file is always included" title="The .glb file is always included">.glb</span>${FORMATS.map(f).join('')}</div>
      <p class="fine" style="margin:-4px 0 10px 32px">The .glb file is copied right away. Tripo makes the other types the first time.</p>` : ''}
    ${opts.models && !tripo ? '<p class="fine" style="margin:-4px 0 10px 32px">Other file types come from Tripo, and only for models made with Tripo.</p>' : ''}
    <h2 class="label">Looks</h2>
    <div class="looks">
      ${look('showroom', 'Showroom', '4:3 room', `<div class="stage"><img class="thumb" src="${P.envThumb('showroom')}" alt=""></div>`, 'Render in the Showroom, the website’s usual look')}
      ${look('studio', 'My scene', 'What you set up · 4:3', sceneArt(), 'Render the scene you set up here (White studio unless you picked another)')}
      ${look('transparent', 'See-through', '1:1 · no background', '<div class="stage s-clear"><div class="checker"></div><div class="sc-shadow"></div></div>', 'No background, just the model and a soft shadow, for lists and cut-outs')}
    </div>
    ${rigPanel(busy)}
    ${tennogenApplies(m) ? tennogenCard(m, busy) : ''}
    <div class="renderer-pick">
      <h2 class="label">Quality</h2>
      <div class="chips" role="radiogroup" aria-label="Renderer">
        <button class="chip" type="button" role="radio" data-renderer="three" aria-checked="${opts.renderer === 'three'}" title="Renders right here in Flatform. Quick, and looks like what you see.">Quick (in Flatform)</button>
        <button class="chip" type="button" role="radio" data-renderer="blender" aria-checked="${opts.renderer === 'blender'}" ${!blenderReady() ? 'disabled' : ''} title="${blenderReady() ? 'Renders in Blender with Cycles. Slower, more real light.' : 'Needs Blender. Show where it is in Settings.'}">Best (Blender)</button>
      </div>
      <p class="fine keep">${blenderReady() ? `Blender: ${esc(state.blender.path)}` : 'Blender not found. Quick works fine. For Best, install Blender 4 or show where it is in Settings.'}</p>
    </div>`;
  const box = $('#left', root);
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

// The composed scene's thumbnail for the "Scene" look tile.
function sceneArt() {
  const preset = sceneFor(m, 'studio').preset;
  return P.ENVIRONMENTS[preset] ? `<div class="stage"><img class="thumb" src="${P.envThumb(preset)}" alt="" onerror="this.remove()"></div>`
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
  return `<div class="sl"><label for="rig-${key}">${label}</label>
    <input class="range" type="range" id="rig-${key}" data-rig="${group}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${p}%" title="${RIG_TIP[key]}" ${disabled ? 'disabled' : ''}>
    <span class="v" id="rv-${key}">${RIG_TEXT[key](value)}</span></div>`;
}
function rigPanel(busy) {
  const l = { ...P.DEFAULT_LIGHTING, ...state.settings?.lighting };
  const g = { ...P.DEFAULT_GLASS, ...state.settings?.glass };
  const swatch = `rgb(${kelvinColor(l.kelvin).map((v) => Math.round(v * 255)).join(',')})`;
  return `<div class="grp rig"><h3>${icon('light', 14)} Render light <button class="link" type="button" data-act="rig-reset" ${busy ? 'disabled' : ''} title="Put the render lights back the way they started">Reset</button></h3>
      ${rigSlider('lighting', 'key', 'Main light', 0, 2, 0.05, l.key, busy)}
      ${rigSlider('lighting', 'azimuth', 'Direction', -180, 180, 5, l.azimuth, busy)}
      ${rigSlider('lighting', 'elevation', 'Height', 5, 85, 1, l.elevation, busy)}
      ${rigSlider('lighting', 'kelvin', `Colour <i class="kswatch" id="kswatch" style="background:${swatch}"></i>`, 2700, 9000, 100, l.kelvin, busy)}
      ${rigSlider('lighting', 'fill', 'Soft light', 0, 2, 0.05, l.fill, busy)}
      ${rigSlider('lighting', 'rim', 'Edge light', 0, 2, 0.05, l.rim, busy)}
    </div>
    <div class="grp rig"><h3>${icon('cube', 14)} Glass</h3>
      <label class="tg" title="Darken the windows like real tinted glass"><span>Tinted glass<small>Finds windows by name, or by a dark shiny look</small></span><input class="sw" type="checkbox" role="switch" data-glass="on" ${g.on ? 'checked' : ''} ${busy ? 'disabled' : ''}></label>
      ${g.on ? `<div class="sl"><label for="rig-tint">Tint</label><input class="tint" type="color" id="rig-tint" title="The colour of the window tint" data-glass="tint" value="${esc(g.tint)}" ${busy ? 'disabled' : ''}><span class="v">${esc(g.tint)}</span></div>
      ${rigSlider('glass', 'opacity', 'See-through', 0, 1, 0.05, g.opacity, busy)}` : ''}
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
  const html = `<h2 class="label">Save folder</h2>
    <div class="path" title="Where finished renders are saved">${icon('folder')}<code>${dir ? esc(dir) : `Not chosen yet · suggested ${esc(s.suggestedOutputRoot || '')}`}</code></div>
    <button class="btn ghostbtn wide" type="button" data-act="folder" title="Pick the folder renders are saved in" ${busy ? 'disabled' : ''}><span>${dir ? 'Change folder' : 'Choose folder'}</span></button>
    <form class="field pathform" id="folderForm" hidden><label for="folderIn">Folder</label><input class="inp mono" id="folderIn" name="outputRoot" value="${esc(s.outputRoot || s.suggestedOutputRoot || '')}" spellcheck="false" title="The full path of the folder"><button class="btn ghostbtn" type="submit" title="Use this folder">Save</button></form>
    <div class="cta">
      <button class="btn ghostbtn" type="button" data-act="open" title="Open the save folder on this computer" ${native && (m.renders?.outDir || s.outputRoot) ? '' : 'disabled'}>${icon('folder')}<span>Open folder</span></button>
    </div>
    <details class="ra-more"><summary title="What ends up in the save folder">What’s in the folder</summary>
    <div class="tree">
      <div class="tr-l">${icon('folder', 14)}<div><code>web${d}</code><span>Spin pictures for the website · 512 and 256 px · posters</span></div></div>
      <div class="tr-l">${icon('folder', 14)}<div><code>frames${d}</code><span>${P.FRAMES} pictures per look · 2048 px</span></div></div>
      <div class="tr-l">${icon('cube', 14)}<div><code>spin-viewer.js · viewer.html</code><span>Drag-to-spin viewer for the site and admin</span></div></div>
      <div class="tr-l">${icon('cube', 14)}<div><code>HANDOFF.md</code><span>What goes where, for the web team</span></div></div>
    </div>
    <div class="dest"><h3>Where each piece goes</h3>${P.DESTINATIONS.map((x) => `<p><b>${x.label}</b>${esc(x.use)}</p>`).join('')}</div></details>`;
  drawTray();
  const box = $('#right', root);
  if (box.dataset.html !== html && !box.contains(document.activeElement?.id === 'folderIn' ? document.activeElement : null)) {
    const open = box.querySelector('.ra-more')?.open;
    box.dataset.html = html; box.innerHTML = html;
    if (open) box.querySelector('.ra-more').open = true;
  }
}

// The queue tray: every render and video started from here, newest last.
function trayHtml() {
  if (!queue.length) return '<div class="tray" aria-label="Queue"><h3>Queue</h3><p class="fine keep">Nothing waiting. Renders you start line up here and run one after another.</p></div>';
  const row = (t) => `<li class="tq ${t.status}" title="${esc(t.error || STATUS_TEXT[t.status])}"><i class="dot ${t.status === 'done' ? 'ok' : t.status === 'running' ? 'busy' : t.status === 'waiting' ? 'wait' : ''}"></i>
    <span><b>${esc(t.model.name)}</b><small>${esc(t.label)}</small></span><em>${t.status === 'running' && job?.task === t ? `${statusLight(job).pct}%` : STATUS_TEXT[blockedByRig(t, rigs()) ? 'rigging' : t.status]}</em>
    ${t.status === 'waiting' ? `<button class="link" type="button" data-remove="${t.id}" title="Take this one out of the queue">Remove</button>` : ''}
    ${t.status === 'done' && t.file ? `<button class="link" type="button" data-reveal="${t.id}" title="Show the finished file in its folder" ${native ? '' : 'hidden'}>Show</button>` : ''}</li>`;
  return `<div class="tray" aria-label="Queue"><h3>Queue <button class="link" type="button" data-act="clear-tray" title="Clear finished renders from this list">Clear finished</button></h3><ol>${queue.map(row).join('')}</ol></div>`;
}

// The queue tray, floating bottom right on every screen (index.html #queueTray). It opens by itself when a render
// starts; ✕ hides it and the top bar's render pill opens it again.
let trayShownFor = null;
function drawTray() {
  const tray = document.getElementById('queueTray');
  if (!tray) return;
  const html = queue.length ? `<header class="tc-head"><h2>Render queue</h2><button class="btn icon ghostbtn" type="button" data-act="hide-tray" title="Hide the queue. The render pill in the top bar opens it again." aria-label="Hide the queue">✕</button></header>${trayHtml()}` : '';
  if (tray.dataset.html !== html) { tray.dataset.html = html; tray.innerHTML = html; }
  tray.onclick = (e) => (e.target.closest('[data-act="hide-tray"]') ? (tray.hidden = true) : onClick(e));
  if (!queue.length) tray.hidden = true;
  else if (running() && trayShownFor !== job) { trayShownFor = job; tray.hidden = false; }
}

// Models being rigged (compose-motion.js sets state.rigging): their renders wait in the queue until the joints are in.
const rigs = () => state.rigging || new Set();
function renderBar() {
  const other = job && job.model.id !== m?.id;
  const rigId = !running() && [...rigs()][0];
  const light = rigId ? rigLight(findModel(rigId)?.name, queue.filter((t) => blockedByRig(t, rigs())).length) : statusLight(job, waitingCount(queue));
  setRenderLight(light, job?.model.id); // the top bar shows it on every screen
  drawTray();
  document.getElementById('vp')?.classList.toggle('rendering', running()); // the Compose viewport glows while rendering
  const tag = document.getElementById('renderTag'); // "Rendering this view · frame 33 of 72"
  if (tag) {
    tag.hidden = !(running() && onScreen());
    if (!tag.hidden) tag.textContent = job.total ? `Rendering this view · frame ${Math.min(job.frame + 1, job.total)} of ${job.total}${job.paused ? ' · paused' : ''}` : 'Rendering this view';
  }
  const bar = root?.isConnected && $('#rbBar', root);
  if (!bar) return;
  const pct = job?.done && !job.error && !job.cancelled ? 100 : light.pct;
  bar.closest('.renderbar').hidden = !job; // the progress shows once something renders
  renderTypes(); // Run becomes "Add to queue" while one renders
  $('#rbTitle', root).textContent = !job ? 'Ready to render'
    : job.done ? `${other ? `${job.model.name}: ` : ''}${job.error ? 'Render stopped' : job.cancelled ? 'Render cancelled' : 'Render finished'}`
      : `Rendering ${other ? job.model.name : ''} ${job.renderer === 'blender' ? 'in Blender' : 'in Flatform'}${job.paused ? ' · paused' : ''}`.replace(/\s+/g, ' ');
  $('#rbSub', root).textContent = !job ? ''
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
  if (t.dataset.rtype) { pick = { type: t.dataset.rtype, option: defaultOption(t.dataset.rtype), extras: {} }; renderTypes(); } // a Render idea's extras belong to the type it picked
  if (t.dataset.ropt) { pick.option = t.dataset.ropt; renderTypes(); }
  if (t.dataset.rover) { pick.extras.effect = { ...pick.extras.effect, override: t.dataset.rover }; renderTypes(); }
  if (t.dataset.rdrop) {
    const k = t.dataset.rdrop;
    if (k === 'explode' || k === 'override') { if (pick.extras.effect) delete pick.extras.effect[k]; if (!Object.keys(pick.extras.effect || {}).length) delete pick.extras.effect; } else delete pick.extras[k];
    renderTypes();
  }
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
  if (act === 'run') run();
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
  if (t.dataset.rtitle !== undefined) { pick.extras.poster = t.value; return; }
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
  if (s.preset === 'transparent') return { ...s, preset: P.roomFor(state.settings?.defaultScene), backdrop: null };
  return s;
}
// Draws frames into the web sprite sheets as they arrive (lib/sheets.js), in Flatform's own web/ layout.
function makeSheets(look, turns) {
  const files = turns.flatMap((turn) => P.sheetFiles(look, turn).map((f) => ({ turn, width: f.width, type: f.type, name: `web/${f.name}` })));
  return makeSheetSet(look, files, { put, posterNames: { webp: `web/${P.posterName(look, 'webp')}`, png: `web/${P.posterName(look, 'png')}` } });
}


// Run: the picked type becomes one or more tasks (render-types.js planRun), laid over the More settings options.
async function run() {
  const plan = planRun(pick.type, pick.option, { paint: m.scene?.paint, cameraMove: Boolean(m.scene?.cameraPath?.on), extras: cleanExtras(pick.extras) });
  if (plan.go === 'spin') return go(`#/spin/${m.id}`);
  if (plan.error) return toast(plan.error, 'info', plan.fix ? [{ label: plan.fix === 'camera' ? 'Open Camera' : 'Open Look', title: 'Go to the tool that sets this up', run: () => pickDock(plan.fix) }] : []);
  if (!state.settings?.outputRoot) { // a sensible default: the suggested folder, said out loud, changeable under More settings
    const dir = state.settings?.suggestedOutputRoot;
    if (!dir) return toast('Choose a folder for renders first: open More settings below.');
    await saveFolder(dir);
    if (!state.settings?.outputRoot) return;
    toast(`Renders go to ${dir}. Change it under More settings.`, 'info');
  }
  if (!(await tennogenGate(m))) { redrawLeft(); return; } // TennoGen names and sizes, for Warframe models with a texture folder
  let overnight = null;
  if (plan.overnight) {
    try { overnight = await send('/api/overnight', 'POST', { modelId: m.id, ...plan.overnight }); } catch (e) { return toast(e.message); }
    toast(`${plan.tasks.length} renders lined up for tonight. Leave Flatform open; it keeps the computer awake until they are done.`, 'info');
  }
  for (const t of plan.tasks) enqueue({ ...t.patch, ...(overnight && { job: t.job }) }, t.label);
}

// Checks one task's picks, then lines it up in the queue tray.
function enqueue(patch = {}, label = null) {
  const o = { ...opts, ...patch };
  const looks = LOOK_KEYS.filter((l) => o[l]);
  if (!looks.length && (o.still || o.t360 || o.t180)) return toast('Pick at least one look under More settings');
  if (!o.t360 && !o.t180 && !o.still && !o.models) return toast('Pick something to render under More settings');
  const snap = { ...o, formats: new Set(opts.formats), yaw: stillYaw(m) }; // the still uses the angle on screen now
  queue = trimQueue([...queue, { id: crypto.randomUUID(), model: m, opts: snap, label: label || taskLabel(snap), status: 'waiting' }]);
  if (running()) toast(`Added to the queue. It starts when the current render is done.`, 'info');
  else if (rigs().has(m.id)) toast('Added to the queue. It starts when the joints are added (Rigging…).', 'info');
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
  if (!t) return;
  if (blockedByRig(t, rigs())) { renderBar(); return; } // rigChanged() starts it once the joints are in
  start(t).finally(pump);
}
/** compose-motion.js: a rig started or finished. Redraws the light and the tray, and starts a render that waited. */
export function rigChanged() { renderBar(); pump(); }

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
  if (o.job) overnightMark(task, 'running');
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
    const extra = await afterRender(slug, looks, turns, started.outDir);
    progress('Saving the files', job.total, job.total);
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
    Object.assign(task, { status: 'done', outDir: started.outDir, file: extra || resultFile({ slug, still: o.still, t360: o.t360, t180: o.t180, looks, yaw: job.yaw }) });
    if (o.job) overnightMark(task, 'done');
    progress(`Saved to ${started.outDir}`, job.total, job.total);
    announce(`${model.name}: render finished`);
    toast(`${model.name} is rendered. It's in Library and your save folder.`, 'ok', [
      { label: 'Open', title: 'See the finished render in Library', run: () => go(`#/model/${model.id}`) },
      ...(native ? [{ label: 'Show in folder', title: 'Show the finished file on this computer', run: () => reveal(task) }] : []),
    ]);
  } catch (e) {
    job.done = true;
    task.status = job.cancelled ? 'cancelled' : 'failed';
    if (!job.cancelled) { job.error = task.error = e.message; toast(e.message); }
    if (o.job) overnightMark(task, job.cancelled ? 'cancelled' : 'failed', e.message);
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
      await studio.setState({ ...sceneFor(model, look), ...(job.opts.paint && { paint: job.opts.paint }) });
      await studio.load(fileUrl(model, model.glb));
      if (job.opts.effect && !applyEffect(studio, job.opts.effect) && job.opts.effect.explode) toast('This model is one piece, so there are no parts to pull apart. It renders whole.', 'info');
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
        progress(`${P.LOOKS[look].label} · picture`, ++done, total);
      }
      await Promise.all(uploads);
      if (sheets) {
        progress(`${P.LOOKS[look].label} · putting the pictures together`, done, total);
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
  const o = job.opts;
  await send(`/api/renders/${model.id}/blender`, 'POST', { looks, frames, ...(o.still && { still: job.yaw }), ...(o.effect && { effect: o.effect }), ...(o.paint && { paint: o.paint }) });
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
  // Same sprite step as the in-app renderer, from the PNGs Blender wrote.
  for (const look of turns.length ? looks : []) {
    if (onScreen()) { previewLook = look; resetPreview(); }
    const sheets = makeSheets(look, turns);
    let poster;
    for (let i = 0; i < frames; i++) {
      await checkpoint();
      const img = await load(fileSrc(P.framePath(slug, look, i)));
      const small = sheets.draw(i, img);
      if (i === 0) poster = small[512];
      if (onScreen() && previewLook === look) {
        if (turns.includes(360)) cell('sheet360', i, P.COLUMNS, img);
        if (i < P.HALF) cell('sheet180', i, 19, img);
      }
      progress(`${P.LOOKS[look].label} · picture ${P.pad3(i + 1)} of ${P.pad3(frames)}`, i + 1, frames);
    }
    await sheets.write(poster);
    await writeManifests(slug, look, turns, 'blender', manifests);
  }
}

// After the frames, on the finished PNGs so both engines get it: painted or cartoon, the poster title, colour names
// on the file, the 9:16 crop and the video. Returns the main file it made (relative to the handoff folder), or null.
async function afterRender(slug, looks, turns, outDir) {
  const o = job.opts;
  const src = (rel) => `/api/renders/${job.model.id}/file?path=${encodeURIComponent(rel)}&t=${Date.now()}`;
  const png = async (canvas) => toBlob(canvas, 'image/png');
  const named = (rel, tag) => rel.replace(/\.png$/, `_${tag}.png`);
  let file = null;
  const tag = [o.suffix, o.effect?.override, o.effect?.explode && 'exploded'].filter(Boolean).join('_'); // colours and effects keep their own files
  if (o.still) {
    for (const look of looks) {
      await checkpoint();
      let rel = `stills/${P.stillName(slug, look, job.yaw)}`;
      if (tag) { const out = named(rel, tag); await put(out, await (await fetch(src(rel))).blob()); rel = out; }
      if (o.style) {
        progress(`${P.LOOKS[look].label} · drawing it ${o.style === 'cel' ? 'as a cartoon' : 'as a painting'}`, job.total, job.total);
        const out = named(rel, o.style === 'cel' ? 'cartoon' : 'painted');
        await put(out, await png(await styled(src(rel), o.style)));
        rel = out;
      }
      if (o.poster != null) { const out = named(rel, 'poster'); await put(out, await png(await poster(src(rel), o.poster || job.model.name))); rel = out; }
      file ||= rel;
    }
  }
  if (o.video && turns.length) {
    const look = looks.includes('studio') ? 'studio' : looks[0];
    const frames = P.turnFrames(Math.max(...turns));
    let dir = `frames/${look}`;
    if (o.vertical) {
      dir = `frames/${look}-phone`;
      for (let i = 0; i < frames; i++) {
        await checkpoint();
        await put(`${dir}/${P.framePath(slug, look, i).split('/').pop()}`, await png(await vertical(src(P.framePath(slug, look, i)))));
        progress(`Cutting the tall phone version · frame ${P.pad3(i + 1)} of ${P.pad3(frames)}`, i + 1, frames);
      }
    }
    progress('Making the video', job.total, job.total);
    const name = [slug, look, o.video, tag].filter(Boolean).join('_');
    try {
      const r = await send('/api/video', 'POST', { modelId: job.model.id, frames: dir, pattern: `${slug}_%03d.png`, name, outDir, format: 'mp4', resolution: o.vertical ? 'vertical' : '1080p', fps: 24, quality: 'good', seconds: 0 });
      file = r.output.split(/[\\/]/).pop();
    } catch (e) { toast(`The spin frames are saved, but the video could not be made: ${e.message}`, 'info'); }
  }
  return file;
}

// Overnight list jobs (overnight.mjs): the server keeps the computer awake while any wait, counts tries and puts a
// failed one back in line; this page runs them, so a job back in line goes back in the queue tray too.
async function overnightMark(task, status, error) {
  try {
    const view = await send(`/api/overnight/jobs/${encodeURIComponent(task.opts.job)}`, 'PATCH', { status, error });
    if (status === 'failed' && view.jobs?.find((j) => j.id === task.opts.job)?.status === 'queued') {
      queue = trimQueue([...queue, { ...task, id: crypto.randomUUID(), status: 'waiting', error: null }]);
      pump();
    }
  } catch { /* the list was cleared: the render itself still counts */ }
}

async function writeManifests(slug, look, turns, renderer, manifests) {
  for (const turn of turns) {
    const json = P.manifest({ slug, name: job.model.name, look, turn, renderer, version: state.settings?.version });
    manifests[`${look}${turn}`] = json;
    await put(`web/${P.spriteJsonName(look, turn)}`, new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
  }
}
