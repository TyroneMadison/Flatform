// 05 · Render / Export: renders the composed scene to the handoff folder.
// In-app renderer: the same Three.js studio, offscreen at full size, turning only the car 5° per frame.
// Blender renderer (optional): render/blender_turntable.py writes the frames; sprites are made here either way.
// A render belongs to the car it started on and keeps going if you leave this screen.
import { $, $$, esc, state, api, send, toast, stepper, findModel, fileUrl, upsert, refresh, native, announce, providerOf, FORMATS } from '../app.js';
import { icon } from '../lib/icons.js';
import * as P from '../lib/pipeline.js';
import { Studio, defaultScene } from '../lib/studio.js';

let root;
let m; // the car on screen
let opts;
let previewLook = 'studio';
let job = null; // { model, yaw, renderer, frame, total, paused, cancelled, done, error, phaseText }
const CELL = 64; // preview cell width

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sep = () => (state.settings?.platform === 'win32' ? '\\' : '/');
const outDir = () => (state.settings?.outputRoot ? `${state.settings.outputRoot}${sep()}${m.slug}` : '');
const blenderReady = () => Boolean(state.blender?.found);
const running = () => Boolean(job && !job.done);
const onScreen = () => Boolean(job && m && job.model.id === m.id && root?.isConnected);

export function mount(el, { id }) {
  root = el;
  m = findModel(id);
  if (!m || m.status !== 'ready') {
    el.innerHTML = `${stepper('render', m)}<p class="muted">${m ? 'This model is not ready yet.' : 'Pick a model from the library first.'} <a class="link" href="${m ? `#/generate/${m.id}` : '#/library'}">${m ? 'Show progress' : 'Open library'}</a></p>`;
    return;
  }
  const intent = state.renderIntent;
  state.renderIntent = null;
  opts ||= { still: false, t360: true, t180: true, models: false, formats: new Set(), studio: true, transparent: state.settings?.alsoTransparent !== false };
  if (intent === 'still') Object.assign(opts, { still: true, t360: false, t180: false });
  if (intent === 'turntable') Object.assign(opts, { t360: true, t180: true });
  if (!running()) opts.renderer = state.settings?.renderer === 'blender' && blenderReady() ? 'blender' : 'three';
  el.innerHTML = `${stepper('render', m)}
  <section class="export">
    <div class="ex-left glass" id="left"></div>
    <div class="ex-mid glass">
      <div class="rowhead sheethead"><h2 class="label">Sprite sheet preview · 360°</h2>
        <div class="chips seg sm" role="radiogroup" aria-label="Preview look">
          <button class="chip" type="button" role="radio" data-preview="studio">Studio</button>
          <button class="chip" type="button" role="radio" data-preview="transparent">Transparent</button>
        </div></div>
      <div class="sheet"><canvas id="sheet360" aria-label="Preview of the 360° sprite sheet"></canvas></div>
      <div class="sheet-meta"><span>${P.COLUMNS} columns × ${P.spriteGrid(P.FRAMES).rows} rows</span><span>Frame 000 is front ¾</span><span>Web copies at 512 and 256 px, WebP + PNG</span></div>
      <div class="rowhead sheethead"><h2 class="label">180° half turn · detail page</h2><span class="sub">Cut from the same ${P.FRAMES} frames, no re-render</span></div>
      <div class="sheet"><canvas id="sheet180" aria-label="Preview of the 180° sprite sheet"></canvas></div>
      <div class="renderbar">
        <div><b id="rbTitle">Ready to render</b><span id="rbSub" aria-live="polite"></span></div>
        <div class="pbar big" role="progressbar" aria-label="Render progress" aria-valuemin="0" aria-valuemax="100" id="rbBar"><i style="width:0"></i></div>
        <div class="rb-act" id="rbAct"></div>
      </div>
    </div>
    <aside class="ex-right glass" id="right"></aside>
  </section>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('submit', onSubmit);
  renderLeft();
  renderRight();
  renderBar();
  resetPreview();
}

export function update() {
  if (!root?.isConnected || !m) return;
  m = findModel(m.id) || m;
  renderLeft();
  renderRight();
}

// ---- panels ----
function renderLeft() {
  const busy = running();
  const card = (key, title, desc) => `<label class="oc"><input type="checkbox" data-opt="${key}" ${opts[key] ? 'checked' : ''} ${busy ? 'disabled' : ''}><span class="cb">${icon('check', 12)}</span><div><b>${title}</b><span class="d">${desc}</span></div></label>`;
  const look = (key, title, desc, art) => `<button class="look" type="button" data-look="${key}" aria-pressed="${opts[key]}" ${busy ? 'disabled' : ''}><div class="lk">${art}</div><b>${title}</b><span>${desc}</span></button>`;
  const f = (x) => `<button class="chip" type="button" data-format="${x}" aria-pressed="${opts.formats.has(x)}" ${busy ? 'disabled' : ''}>${x}${m.exports?.[x]?.status === 'ready' ? ' ✓' : ''}</button>`;
  const tripo = providerOf(m) === 'tripo'; // only Tripo can convert its own models to other formats
  const html = `<h2 class="label">What to render</h2>
    ${card('still', 'Still image', `PNG · 2048 px · current angle (${stillYaw(m)}°)`)}
    ${card('t360', '360° turntable', `${P.FRAMES} frames · ${P.STEP}° steps · loops`)}
    ${card('t180', '180° half turn', `Frames 000–0${P.HALF - 1} · stops at both ends`)}
    ${card('models', 'Model files', tripo ? 'GLB · GLTF · FBX · USDZ · OBJ · STL · 3MF' : 'GLB')}
    ${opts.models && tripo ? `<div class="fmtpick" role="group" aria-label="Extra formats"><span class="chip on" aria-label="GLB is always included">GLB</span>${FORMATS.map(f).join('')}</div>
      <p class="fine" style="margin:-4px 0 10px 32px">GLB is copied straight away. Other formats are converted by Tripo the first time, then copied.</p>` : ''}
    ${opts.models && !tripo ? '<p class="fine" style="margin:-4px 0 10px 32px">Other formats come from Tripo’s converter, which only works on models made with Tripo direct.</p>' : ''}
    <h2 class="label">Looks</h2>
    <div class="looks">
      ${look('studio', 'Studio backdrop', '4:3 · 2048 px wide', '<div class="stage s-ring"><div class="sg-wall"></div><div class="sg-panel"></div><div class="sg-bar l"></div><div class="sg-bar r"></div><div class="sg-floor"></div><div class="sg-ring"></div></div>')}
      ${look('transparent', 'Transparent', 'RGBA · 2048 × 2048', '<div class="stage s-clear"><div class="checker"></div><div class="sc-shadow"></div></div>')}
    </div>
    <div class="renderer-pick">
      <h2 class="label">Renderer</h2>
      <div class="chips" role="radiogroup" aria-label="Renderer">
        <button class="chip" type="button" role="radio" data-renderer="three" aria-checked="${opts.renderer === 'three'}" ${busy ? 'disabled' : ''}>In-app</button>
        <button class="chip" type="button" role="radio" data-renderer="blender" aria-checked="${opts.renderer === 'blender'}" ${busy || !blenderReady() ? 'disabled' : ''}>Render with Blender (Cycles)</button>
      </div>
      <p class="fine">${blenderReady() ? `Blender: ${esc(state.blender.path)}` : 'Blender: Not found · install Blender 4.x to render with Cycles, or locate it in Settings.'}</p>
    </div>`;
  const box = $('#left', root);
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}

function renderRight() {
  const s = state.settings || {};
  const busy = running();
  const dir = outDir();
  const d = sep();
  const html = `<h2 class="label">Output folder</h2>
    <div class="path">${icon('folder')}<code>${dir ? esc(dir) : `Not chosen yet · suggested ${esc(s.suggestedOutputRoot || '')}`}</code></div>
    <button class="btn ghostbtn wide" type="button" data-act="folder" ${busy ? 'disabled' : ''}><span>${dir ? 'Change folder' : 'Choose folder'}</span></button>
    <form class="field pathform" id="folderForm" hidden><label for="folderIn">Folder</label><input class="inp mono" id="folderIn" name="outputRoot" value="${esc(s.outputRoot || s.suggestedOutputRoot || '')}" spellcheck="false"><button class="btn ghostbtn" type="submit">Save</button></form>
    <div class="tree">
      <div class="tr-l">${icon('folder', 14)}<div><code>web${d}</code><span>360 + 180 sheets · 512 and 256 px · sprite json · posters</span></div></div>
      <div class="tr-l">${icon('folder', 14)}<div><code>frames${d}</code><span>${P.FRAMES} studio PNGs · ${P.FRAMES} transparent PNGs</span></div></div>
      <div class="tr-l">${icon('cube', 14)}<div><code>spin-viewer.js · viewer.html</code><span>Drag-to-spin viewer for the site and admin</span></div></div>
      <div class="tr-l">${icon('cube', 14)}<div><code>HANDOFF.md</code><span>What goes where, for the web team</span></div></div>
    </div>
    <div class="dest"><h3>Where each piece goes</h3>${P.DESTINATIONS.map((x) => `<p><b>${x.label}</b>${esc(x.use)}</p>`).join('')}</div>
    <div class="cta">
      <button class="btn pri" type="button" data-act="render" ${busy ? 'disabled' : ''}>${icon('film')}<span>Render to handoff folder</span></button>
      <button class="btn ghostbtn" type="button" data-act="open" ${native && (m.renders?.outDir || s.outputRoot) ? '' : 'disabled'}>${icon('folder')}<span>Open folder</span></button>
    </div>`;
  const box = $('#right', root);
  if (box.dataset.html !== html && !box.contains(document.activeElement?.id === 'folderIn' ? document.activeElement : null)) { box.dataset.html = html; box.innerHTML = html; }
}

function renderBar() {
  const bar = $('#rbBar', root);
  if (!bar || !root.isConnected) return;
  const other = job && job.model.id !== m.id;
  const pct = job?.total ? Math.round((job.frame / job.total) * 100) : job?.done && !job.error && !job.cancelled ? 100 : 0;
  $('#rbTitle', root).textContent = !job ? 'Ready to render'
    : job.done ? `${other ? `${job.model.name}: ` : ''}${job.error ? 'Render stopped' : job.cancelled ? 'Render cancelled' : 'Render finished'}`
      : `Rendering ${other ? job.model.name : ''} ${job.renderer === 'blender' ? 'in Blender' : 'in-app'}${job.paused ? ' · paused' : ''}`.replace(/\s+/g, ' ');
  $('#rbSub', root).textContent = !job ? (outDir() ? 'Writes into the output folder on the right' : 'Choose an output folder first')
    : job.error || job.phaseText || '';
  bar.setAttribute('aria-valuenow', pct);
  bar.firstElementChild.style.width = `${pct}%`;
  const act = running() ? `${job.renderer === 'three' ? `<button class="btn ghostbtn" type="button" data-act="pause">${job.paused ? 'Resume' : 'Pause'}</button>` : ''}<button class="btn ghostbtn" type="button" data-act="cancel">Cancel</button>` : '';
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
async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.preview && !(running() && onScreen())) { previewLook = t.dataset.preview; resetPreview(); }
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
  if (act === 'render') start();
  if (act === 'pause' && job) { job.paused = !job.paused; renderBar(); }
  if (act === 'cancel' && job) {
    job.cancelled = true;
    if (job.renderer === 'blender') api(`/api/renders/${job.model.id}/blender`, { method: 'DELETE' }).catch(() => {});
    renderBar();
  }
}
function onChange(e) {
  const k = e.target.dataset.opt;
  if (k) { opts[k] = e.target.checked; renderLeft(); }
}
async function onSubmit(e) {
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
const toBlob = (canvas, type, quality) => new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error(`Could not encode ${type}`))), type, quality));

function progress(text, frame, total) {
  Object.assign(job, { phaseText: text, frame, total });
  renderBar();
}

async function checkpoint() {
  while (job.paused && !job.cancelled) await sleep(150);
  if (job.cancelled) throw new Error('Cancelled');
}

// The scene for a look: the studio look uses the composed scene (or the default studio if it was composed as
// transparent); the transparent look reuses the same car, camera and lights with no background.
function sceneFor(model, look) {
  const s = { ...defaultScene(state.settings), ...model.scene };
  if (look === 'transparent') return { ...s, preset: 'transparent' };
  if (s.preset === 'transparent') return { ...s, preset: state.settings?.defaultScene && state.settings.defaultScene !== 'transparent' ? state.settings.defaultScene : 'ring', backdrop: null };
  return s;
}

// Draws frames into the web sprite sheets as they arrive, so nothing is rendered twice.
function makeSheets(look, turns) {
  const sheets = [];
  for (const turn of turns) {
    for (const file of P.sheetFiles(look, turn)) {
      const same = sheets.find((s) => s.turn === turn && s.width === file.width);
      if (same) { same.also = file; continue; } // the 512 PNG shares the 512 WebP's canvas
      const canvas = document.createElement('canvas');
      Object.assign(canvas, P.sheetSize(look, turn, file.width));
      sheets.push({ turn, width: file.width, type: file.type, name: file.name, canvas, frames: P.turnFrames(turn) });
    }
  }
  return {
    draw(i, source) {
      for (const s of sheets) {
        if (i >= s.frames) continue;
        const { col, row } = P.cellOf(i);
        const f = P.frameSize(look, s.width);
        const g = s.canvas.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(source, col * f.width, row * f.height, f.width, f.height);
      }
    },
    async write(poster) {
      for (const s of sheets) {
        await put(`web/${s.name}`, await toBlob(s.canvas, s.type, 0.9));
        if (s.also) await put(`web/${s.also.name}`, await toBlob(s.canvas, s.also.type));
        s.canvas.width = s.canvas.height = 0; // free the memory
      }
      await put(`web/${P.posterName(look, 'webp')}`, await toBlob(poster, 'image/webp', 0.92));
      await put(`web/${P.posterName(look, 'png')}`, await toBlob(poster, 'image/png'));
    },
  };
}

function posterFrom(source, look) {
  const f = P.frameSize(look, 512);
  const c = document.createElement('canvas');
  Object.assign(c, f);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, f.width, f.height);
  return c;
}

async function start() {
  const looks = ['studio', 'transparent'].filter((l) => opts[l]);
  const turns = [opts.t360 && 360, opts.t180 && 180].filter(Boolean);
  if (running()) return;
  if (!state.settings?.outputRoot) return toast('Choose an output folder first');
  if (!looks.length) return toast('Pick at least one look');
  if (!turns.length && !opts.still && !opts.models) return toast('Pick something to render');
  const model = m;
  job = { model, yaw: stillYaw(model), renderer: opts.renderer, frame: 0, total: 0, paused: false, cancelled: false, done: false };
  renderLeft();
  renderRight();
  renderBar();
  try {
    const formats = opts.models && providerOf(model) === 'tripo' ? [...opts.formats] : [];
    const started = await send(`/api/renders/${model.id}/start`, 'POST', { looks: turns.length || opts.still ? looks : [], formats });
    const slug = started.slug;
    const frames = turns.length ? Math.max(...turns.map(P.turnFrames)) : 0;
    const manifests = {};
    if (turns.length || opts.still) {
      if (job.renderer === 'blender') await renderBlender(slug, looks, turns, frames, manifests);
      else await renderInApp(slug, looks, turns, frames, manifests);
    }
    progress('Writing the handoff files', job.total, job.total);
    const version = state.settings?.version;
    if (turns.length) {
      await put('spin-viewer.js', await (await fetch('/lib/spin-viewer.js')).blob());
      await put('viewer.html', new Blob([P.viewerHtml({ name: model.name, manifests })]));
    }
    const stills = opts.still ? looks.map((look) => ({ look, angle: job.yaw })) : [];
    const models = [`${slug}.glb`, ...formats.map((f) => `${slug}.${f.toLowerCase()} (when Tripo finishes converting)`)];
    await put('HANDOFF.md', new Blob([P.handoffText({ slug, name: model.name, looks: turns.length ? looks : [], turns, stills, models, renderer: job.renderer, version })]));
    upsert(await api(`/api/models/${model.id}`));
    job.done = true;
    progress(`Saved to ${started.outDir}`, job.total, job.total);
    announce(`${model.name}: render finished`);
    toast(`${model.name} rendered to ${started.outDir}`, 'info');
  } catch (e) {
    job.done = true;
    if (!job.cancelled) { job.error = e.message; toast(e.message); }
  }
  refresh();
  renderBar();
}

async function renderInApp(slug, looks, turns, frames, manifests) {
  const { model } = job;
  const total = looks.length * (frames + (opts.still ? 1 : 0));
  let done = 0;
  for (const look of looks) {
    if (onScreen()) { previewLook = look; resetPreview(); }
    const { width, height } = P.LOOKS[look];
    const canvas = document.createElement('canvas');
    Object.assign(canvas, { width, height });
    const studio = new Studio(canvas, { preserveDrawingBuffer: true });
    try {
      studio.resize(width, height, 1);
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
        studio.render();
        await queue(toBlob(canvas, 'image/png').then((b) => put(P.framePath(slug, look, i), b)));
        sheets.draw(i, canvas);
        if (i === 0) poster = posterFrom(canvas, look);
        if (onScreen() && previewLook === look) {
          if (turns.includes(360)) cell('sheet360', i, P.COLUMNS, canvas);
          if (i < P.HALF) cell('sheet180', i, 19, canvas);
        }
        progress(`${P.LOOKS[look].label} · frame ${P.pad3(i + 1)} of ${P.pad3(frames)}`, ++done, total);
        if (i % 4 === 3) await sleep(0); // let the page breathe
      }
      if (opts.still) {
        await checkpoint();
        studio.frame = 0;
        studio.state.turn = job.yaw;
        studio.applyYaw();
        studio.render();
        await put(`stills/${P.stillName(slug, look, job.yaw)}`, await toBlob(canvas, 'image/png'));
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
  await send(`/api/renders/${model.id}/blender`, 'POST', { looks, frames, ...(opts.still && { still: job.yaw }) });
  for (;;) {
    await sleep(700);
    const b = await api(`/api/renders/${model.id}/blender`);
    const index = Math.max(0, looks.indexOf(b.look));
    progress(`${P.LOOKS[b.look]?.label || ''} · frame ${P.pad3(b.frame)} of ${P.pad3(frames)}`, index * frames + b.frame, looks.length * frames || 1);
    if (b.status === 'done') break;
    if (b.status !== 'running') throw new Error(b.error || `Blender ${b.status}`);
    if (job.cancelled) throw new Error('Cancelled');
  }
  // Same sprite step as the in-app renderer, from the PNGs Blender wrote.
  for (const look of turns.length ? looks : []) {
    if (onScreen()) { previewLook = look; resetPreview(); }
    const sheets = makeSheets(look, turns);
    let poster;
    for (let i = 0; i < frames; i++) {
      await checkpoint();
      const img = new Image();
      img.src = `/api/renders/${model.id}/file?path=${encodeURIComponent(P.framePath(slug, look, i))}`;
      await img.decode();
      sheets.draw(i, img);
      if (i === 0) poster = posterFrom(img, look);
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
