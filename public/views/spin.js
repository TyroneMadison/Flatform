// Spin set for Dud Rents. Two ways in: drop a folder of car photos (sorted by angle, gaps and duplicates flagged,
// the car named by auto-identify) or press Generate Spin Set on a car with a 3D model (Max realism, Blender).
// Either way the frames, sheets and manifests land in the handoff folder, and Send to Dud Rents zips them.
import { $, $$, esc, state, api, send, toast, findModel, upsert, refresh, native, announce, fileUrl, confirmDialog } from '../app.js';
import { icon } from '../lib/icons.js';
import * as S from '../lib/spinset.js';
import * as H from '../lib/handoff.js';
import * as P from '../lib/pipeline.js';
import { identifyLocal, suggestName } from '../lib/identify.js';
import { makeSheets, toBlob } from '../lib/sheets.js';

let root;
let m; // the car (null while photos are being gathered for a new one)
let photos = []; // [{ name, file, url, time, hash }] in angle order
let selected = [];
let anchor = null;
let guess = null; // auto-identify's answer
let notes = []; // gaps and duplicates
let job = null; // { phase, frame, total, done, error }
let more = false;
let opts = { option: 72, interpolate: true, interior: false, look: 'showroom' };
let identifyToken = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = () => Boolean(job && !job.done);
const hasModel = () => Boolean(m?.glb && m.status === 'ready');

export function mount(el, { id }) {
  root = el;
  m = findModel(id) || null;
  if (m && m.id !== state.spinLast) { photos = []; selected = []; guess = null; notes = []; }
  state.spinLast = m?.id ?? null;
  el.innerHTML = `
  <div class="libhead"><div><h1 class="ph">${icon('retry', 36)} Spin set</h1><p class="sub">Drop car photos in. Flatform names the car and builds the 360.</p></div></div>
  <section class="spin">
    <div class="spin-top">
      <div class="dropzone glass big" id="dz"><div class="dz-hit" role="button" tabindex="0" aria-label="Drop photos here or tap to pick"></div>
        ${icon('upload', 40)}<h2>Drop photos here</h2><p class="muted">or tap to pick</p><p class="dz-status" id="dzNote" aria-live="polite"></p></div>
      <div class="glass card" id="who"></div>
    </div>
    <button class="btn pri huge" type="button" data-act="generate" id="genBtn">${icon('retry')}<span>Generate Spin Set</span></button>
    <div class="renderbar" id="bar" hidden><div><b id="barTitle"></b><span id="barSub" aria-live="polite"></span></div><div class="pbar big" role="progressbar" id="barBar"><i style="width:0"></i></div><div class="rb-act"><button class="btn ghostbtn" type="button" data-act="cancel">Cancel</button></div></div>
    <div class="rowhead"><h2 class="label">Frames (drag to reorder)</h2><div class="chips sm" id="frameTools"></div></div>
    <div class="strip" id="strip" role="listbox" aria-label="Frames" aria-multiselectable="true"></div>
    <div class="sendrow"><button class="btn pri" type="button" data-act="send">${icon('upload')}<span>Send to Dud Rents</span></button><span class="muted">Saves to <code class="mono" data-dest title="Where Send to Dud Rents saves">${esc(state.settings?.outputRoot || 'no folder yet')}</code></span>
      <button class="btn sec" type="button" data-act="dest">${icon('folder')}<span>Change folder</span></button>
      <button class="btn ghostbtn" type="button" data-act="open" ${native ? '' : 'disabled'}>${icon('folder')}<span>Open folder</span></button></div>
    <details class="adjust" id="adjust"><summary>Adjust (more options)</summary><div id="adjustBody"></div></details>
  </section>
  <input id="spinPicker" type="file" accept="image/*,.heic,.heif" multiple hidden>`;
  const dz = $('#dz', el);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('hot'); });
  dz.addEventListener('dragleave', (e) => { if (!dz.contains(e.relatedTarget)) dz.classList.remove('hot'); });
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('hot'); takeFiles(e.dataTransfer); });
  const pick = () => $('#spinPicker', el).click();
  $('.dz-hit', el).addEventListener('click', pick);
  $('.dz-hit', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  $('#spinPicker', el).addEventListener('change', (e) => { addPhotos([...e.target.files]); e.target.value = ''; });
  $('#adjust', el).open = more;
  $('#adjust', el).addEventListener('toggle', () => { more = $('#adjust', el).open; });
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('dragstart', onDragStart);
  el.addEventListener('dragover', (e) => { if (e.target.closest('.fr')) e.preventDefault(); });
  el.addEventListener('drop', onDrop);
  update();
}
export function unmount() { for (const p of photos) URL.revokeObjectURL(p.url); }

// Folders dropped from Explorer: walk them for images.
async function takeFiles(dt) {
  const files = [];
  const walk = async (entry) => {
    if (entry.isFile) await new Promise((ok) => entry.file((f) => { files.push(f); ok(); }, ok));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (let batch; (batch = await new Promise((ok) => reader.readEntries(ok, () => ok([])))).length;) for (const e of batch) await walk(e);
    }
  };
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e);
  else files.push(...dt.files);
  addPhotos(files);
}

async function addPhotos(files) {
  const list = files.filter((f) => S.IMAGE_RE.test(f.name));
  if (!list.length) return toast('Drop car photos (JPG, PNG, WebP or HEIC)');
  for (const file of list) {
    const bytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', await file.arrayBuffer())).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
    photos.push({ name: file.name, file, url: URL.createObjectURL(file), time: S.exifTime(bytes) ?? file.lastModified, hash });
  }
  const sorted = S.sortFrames(S.dedupe(photos));
  const dupes = S.findDuplicates(photos);
  photos = sorted.frames;
  notes = [
    `${photos.length} photos, sorted by ${sorted.order === 'number' ? 'file name number' : sorted.order === 'time' ? 'capture time' : 'file name'}`,
    ...S.findGaps(photos).map((g) => `Gap after ${g.after}: ${g.missing.length} missing (${opts.interpolate ? 'filled by blending' : 'left out'})`),
    ...dupes.map((d) => `Duplicate dropped: ${d.slice(1).join(', ')}`),
  ];
  selected = [];
  if (!m) identify();
  update();
}

async function identify() {
  const token = ++identifyToken;
  const names = photos.map((p) => p.name);
  guess = { ...identifyLocal({ names }), pending: true };
  update();
  try {
    const r = await send('/api/identify', 'POST', { names });
    if (token === identifyToken) guess = r;
  } catch { if (token === identifyToken) guess.pending = false; }
  update();
}

// ---- panels ----
function whoHtml() {
  const car = m?.car;
  const name = m ? m.name : guess ? suggestName(guess, photos[0]?.name.replace(/\.[^.]+$/, '')) : '';
  if (!photos.length && !m) return `<h2 class="label">We think this is</h2><p class="muted">Drop photos and Flatform names the car for you.</p>`;
  const detail = guess || car ? [car?.bodyStyle || guess?.bodyStyle, car?.color || guess?.color].filter(Boolean).join(' · ') : '';
  return `<h2 class="label">${m ? 'This car' : 'We think this is'}</h2><p class="who-name">${esc(name || 'Untitled car')}</p>${detail ? `<p class="sub">${esc(detail)}</p>` : ''}
    <div class="row">${m ? '' : `<button class="btn ok-btn" type="button" data-act="yes">✓ Yes</button>`}<button class="btn ghostbtn" type="button" data-act="change">✎ Change</button></div>
    <p class="fine">${guess?.pending ? 'Looking closer…' : 'Best quality is turned on for you.'}</p>
    <form class="field pathform" id="nameForm" hidden><label class="sr-only" for="nameIn">Car name</label><input class="inp" id="nameIn" value="${esc(name)}" maxlength="100"><button class="btn ghostbtn" type="submit">Save</button></form>`;
}
function stripHtml() {
  const frames = photos.length ? photos.map((p, i) => ({ src: p.url, label: p.name })) : m?.spin ? Array.from({ length: Math.min(m.spin.frames, 72) }, (_, i) => ({ src: `/api/renders/${m.id}/file?path=${encodeURIComponent(H.frameFile(m.slug, m.spin.look, i))}`, label: `Frame ${P.pad3(i)}` })) : [];
  if (!frames.length) return `<p class="muted empty">${hasModel() ? 'Press Generate Spin Set, or drop photos to use those instead.' : 'Your frames show up here.'}</p>`;
  return frames.map((f, i) => `<button class="fr${selected.includes(i) ? ' on' : ''}" type="button" role="option" aria-selected="${selected.includes(i)}" data-i="${i}" draggable="${photos.length ? 'true' : 'false'}" title="${esc(f.label)}"><img src="${esc(f.src)}" alt="${esc(f.label)}" loading="lazy"><span>${P.pad3(i)}</span></button>`).join('');
}
function toolsHtml() {
  if (!photos.length) return '';
  const n = selected.length;
  return `<button class="chip" type="button" data-act="reverse">Reverse</button><button class="chip" type="button" data-act="start" ${n === 1 ? '' : 'disabled'}>Set as frame 000</button>
    <button class="chip" type="button" data-act="delete" ${n ? '' : 'disabled'}>Delete${n ? ` ${n}` : ''}</button><button class="chip" type="button" data-act="build">${icon('film', 12)} Build from these photos</button>`;
}
function adjustHtml() {
  const seg = Object.entries(S.SPIN_OPTIONS).map(([k, o]) => `<button class="chip" type="button" role="radio" aria-checked="${Number(k) === opts.option}" data-option="${k}">${o.label}</button>`).join('');
  return `<div class="field"><span class="flabel">Frames</span><div class="chips seg" role="radiogroup" aria-label="Frame count">${seg}</div></div>
    <label class="tg"><span>Fill missing frames by blending neighbours<small>For photo sets with gaps or fewer photos than frames</small></span><input class="sw" type="checkbox" role="switch" name="interpolate" ${opts.interpolate ? 'checked' : ''}></label>
    <label class="tg"><span>Also render an interior spin<small>Camera inside the cabin, same frame count</small></span><input class="sw" type="checkbox" role="switch" name="interior" ${opts.interior ? 'checked' : ''} ${hasModel() ? '' : 'disabled'}></label>
    <p class="fine">Generate Spin Set uses the Max realism profile: Dud Rents showroom, Blender Cycles final quality, see-through glass with a lit cabin, denoised, AgX. Your own render settings are not changed.</p>`;
}
function bar() {
  const b = $('#bar', root);
  if (!b) return;
  b.hidden = !job;
  if (!job) return;
  const pct = job.total ? Math.round((job.frame / job.total) * 100) : job.done && !job.error ? 100 : 0;
  $('#barTitle', root).textContent = job.done ? (job.error ? 'Stopped' : 'Spin set ready') : 'Making the spin set';
  $('#barSub', root).textContent = job.error || job.phase || '';
  $('#barBar', root).firstElementChild.style.width = `${pct}%`;
  $('[data-act=cancel]', b).hidden = Boolean(job.done);
}

export function update() {
  if (!root?.isConnected) return;
  m = findModel(m?.id) || m;
  const set = (sel, html) => { const el = $(sel, root); if (el && el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; } };
  set('#who', whoHtml());
  set('#strip', stripHtml());
  set('#frameTools', toolsHtml());
  set('#adjustBody', adjustHtml());
  $('#dzNote', root).innerHTML = notes.map((n) => `<span>${esc(n)}</span>`).join('<br>');
  const gen = $('#genBtn', root);
  gen.disabled = running() || !hasModel() || !state.blender?.found;
  gen.title = !hasModel() ? 'Open a car with a 3D model, or build from photos below' : !state.blender?.found ? 'Install Blender 4.x or locate it in Settings' : '';
  $('[data-act=send]', root).disabled = running() || !m?.spin;
  $('[data-act=open]', root).disabled = !native || !m?.renders?.outDir;
  bar();
}

// ---- events ----
async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  const act = t.dataset.act;
  if (t.dataset.i != null) {
    const i = Number(t.dataset.i);
    selected = S.select(selected, i, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey, anchor });
    if (!e.shiftKey) anchor = i;
    return update();
  }
  if (t.dataset.option) { opts.option = Number(t.dataset.option); return update(); }
  if (act === 'reverse') { photos = S.reverse(photos); selected = []; }
  if (act === 'start') { photos = S.setStart(photos, selected[0]); selected = []; }
  if (act === 'delete') { for (const i of selected) URL.revokeObjectURL(photos[i].url); photos = S.removeAt(photos, selected); selected = []; }
  if (act === 'yes') await confirmCar();
  if (act === 'change') { const f = $('#nameForm', root); f.hidden = false; f.querySelector('input').focus(); f.onsubmit = (ev) => { ev.preventDefault(); rename(f.querySelector('input').value.trim()); }; }
  if (act === 'build') await buildFromPhotos();
  if (act === 'generate') await generate();
  if (act === 'send') await sendToDud();
  if (act === 'dest') await changeDest();
  if (act === 'open') native?.openPath(m.renders.outDir).catch((err) => toast(err.message));
  if (act === 'cancel' && job) { job.cancelled = true; if (m) api(`/api/spin/${m.id}`, { method: 'DELETE' }).catch(() => {}); }
  update();
}
function onChange(e) {
  if (e.target.name === 'interpolate') opts.interpolate = e.target.checked;
  if (e.target.name === 'interior') opts.interior = e.target.checked;
  update();
}
let dragFrom = null;
function onDragStart(e) { const t = e.target.closest('.fr'); if (t) { dragFrom = Number(t.dataset.i); e.dataTransfer.effectAllowed = 'move'; } }
function onDrop(e) {
  const t = e.target.closest('.fr');
  if (!t || dragFrom == null || !photos.length) return;
  e.preventDefault();
  e.stopPropagation();
  photos = S.reorder(photos, dragFrom, Number(t.dataset.i));
  dragFrom = null;
  selected = [];
  update();
}

// The car: confirm auto-identify's answer and make the car record (photos only) or save the details on this car.
async function confirmCar(name) {
  const car = guess && { make: guess.make, model: guess.model, yearRange: guess.yearRange, bodyStyle: guess.bodyStyle, color: guess.color };
  name ||= suggestName(guess || {}, photos[0]?.name.replace(/\.[^.]+$/, '') || 'Untitled car');
  try {
    if (m) upsert(await send(`/api/models/${m.id}`, 'PATCH', { name, ...(car && { car }) }));
    else { m = upsert(await send('/api/spin/import', 'POST', { name, car })); state.spinLast = m.id; history.replaceState(null, '', `#/spin/${m.id}`); }
    announce(`${m.name} saved`);
  } catch (err) { toast(err.message); }
  refresh();
}
async function rename(name) {
  if (!name) return;
  if (m) { try { upsert(await send(`/api/models/${m.id}`, 'PATCH', { name })); } catch (err) { toast(err.message); } } else await confirmCar(name);
  update();
}

// ---- building ----
const put = (rel, body) => fetch(`/api/renders/${m.id}/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body })
  .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not write ${rel}`); });
const progress = (phase, frame, total) => { Object.assign(job, { phase, frame, total }); bar(); };
const check = () => { if (job.cancelled) throw new Error('Cancelled'); };
const load = async (src) => { const img = new Image(); img.src = src; await img.decode(); return img; };

// A photo normalised to the frame: contained on a neutral fill, centred. Two neighbours blend for a filled gap.
function normalise(img, img2, t) {
  const { width, height } = P.LOOKS.showroom;
  const c = document.createElement('canvas');
  Object.assign(c, { width, height });
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.fillStyle = '#0b0a09';
  g.fillRect(0, 0, width, height);
  const draw = (im, alpha) => {
    const s = Math.min(width / im.naturalWidth, height / im.naturalHeight);
    g.globalAlpha = alpha;
    g.drawImage(im, (width - im.naturalWidth * s) / 2, (height - im.naturalHeight * s) / 2, im.naturalWidth * s, im.naturalHeight * s);
  };
  draw(img, 1);
  if (img2 && t > 0) draw(img2, t);
  g.globalAlpha = 1;
  return c;
}
function sheetFiles(look, turns) {
  return turns.flatMap((turn) => H.sheetSet(look, turn).map((s) => ({ turn, width: s.size, type: s.type, name: s.file })));
}
// Frames (canvases or images, in order) → sheets, posters and manifests in the handoff layout.
async function finish(look, frames, framesOf, source, renderer) {
  const o = S.SPIN_OPTIONS[opts.option];
  const turns = o.turn === 360 ? [360, 180] : [180];
  const sheets = makeSheets(look, sheetFiles(look, turns), { put, posterNames: { webp: H.posterFile(look), png: H.posterFile(look, 'png') } });
  let poster;
  for (let i = 0; i < frames; i++) {
    check();
    const small = sheets.draw(i, await framesOf(i));
    if (i === 0) poster = small[512];
    progress(`Sprite frame ${P.pad3(i + 1)} of ${P.pad3(frames)}`, i + 1, frames);
    if (i % 4 === 3) await sleep(0);
  }
  progress('Writing sprite sheets', frames, frames);
  await sheets.write(poster);
  const r = await send(`/api/spin/${m.id}/meta`, 'POST', { look, option: opts.option, source, renderer });
  upsert(await api(`/api/models/${m.id}`));
  return r;
}

async function buildFromPhotos() {
  if (running() || !photos.length) return;
  if (!m) await confirmCar();
  if (!m) return;
  if (!state.settings?.outputRoot) return toast('Pick where to save first: tap Change folder');
  job = { phase: 'Starting', frame: 0, total: 0, done: false };
  update();
  try {
    await send(`/api/renders/${m.id}/start`, 'POST', { looks: [] });
    const plan = S.planSequence(photos.length, opts.option, { interpolate: opts.interpolate });
    const images = new Map();
    const image = async (i) => { if (!images.has(i)) images.set(i, await load(photos[i].url)); return images.get(i); };
    const look = opts.look;
    const made = [];
    for (const p of plan) {
      check();
      const c = normalise(await image(p.from), p.t ? await image(p.to) : null, p.t);
      await put(H.frameFile(m.slug, look, p.i), await toBlob(c, 'image/png'));
      made.push(c);
      progress(`Frame ${P.pad3(p.i + 1)} of ${P.pad3(plan.length)}`, p.i + 1, plan.length);
    }
    await finish(look, plan.length, (i) => made[i], `${photos.length} photos`, 'photos');
    job.done = true;
    progress(`Saved to ${m.renders?.outDir || 'the handoff folder'}`, plan.length, plan.length);
    toast(`${m.name}: spin set ready`, 'info');
  } catch (err) { job.done = true; if (!job.cancelled) { job.error = err.message; toast(err.message); } }
  refresh();
}

async function generate() {
  if (running() || !hasModel()) return;
  if (!state.settings?.outputRoot) return toast('Pick where to save first: tap Change folder');
  job = { phase: 'Max realism · starting Blender', frame: 0, total: 0, done: false };
  update();
  try {
    await send(`/api/spin/${m.id}/start`, 'POST', { option: opts.option, interior: opts.interior });
    for (;;) {
      await sleep(700);
      const b = await api(`/api/spin/${m.id}`);
      progress(`${b.look === 'interior' ? 'Interior' : 'Showroom'} · Cycles frame ${P.pad3(b.frame)} of ${P.pad3(b.frames)}`, b.frame, b.frames || 1);
      if (b.status === 'done') break;
      if (b.status !== 'running') throw new Error(b.error || `Blender ${b.status}`);
      check();
    }
    const looks = ['showroom', ...(opts.interior ? ['interior'] : [])];
    const plate = await load(P.plateUrl('showroom'));
    const over = (img) => { const c = document.createElement('canvas'); Object.assign(c, { width: img.naturalWidth, height: img.naturalHeight }); const g = c.getContext('2d'); const s = Math.max(c.width / plate.naturalWidth, c.height / plate.naturalHeight); g.drawImage(plate, (c.width - plate.naturalWidth * s) / 2, (c.height - plate.naturalHeight * s) / 2, plate.naturalWidth * s, plate.naturalHeight * s); g.drawImage(img, 0, 0); return c; };
    const frames = S.SPIN_OPTIONS[opts.option].frames;
    for (const look of looks) {
      await finish(look, frames, async (i) => {
        const img = await load(`/api/renders/${m.id}/file?path=${encodeURIComponent(H.frameFile(m.slug, look, i))}&t=${Date.now()}`);
        if (look !== 'showroom') return img;
        const c = over(img); // Blender's showroom frames come on a shadow catcher; the plate goes under them
        await put(H.frameFile(m.slug, look, i), await toBlob(c, 'image/png'));
        return c;
      }, `${m.slug}.glb`, 'blender');
    }
    job.done = true;
    progress(`Saved to ${m.renders?.outDir}`, frames, frames);
    announce(`${m.name}: spin set ready`);
    toast(`${m.name}: spin set ready`, 'info');
  } catch (err) { job.done = true; if (!job.cancelled) { job.error = err.message; toast(err.message); } }
  refresh();
}

// One click: pick any folder on any drive. Saved in settings, change it anytime.
async function changeDest() {
  const dir = native ? await native.pickFolder() : prompt('Folder to save to (full path)', state.settings?.outputRoot || '');
  if (!dir) return;
  try { state.settings = await send('/api/settings', 'POST', { outputRoot: dir }); } catch (err) { return toast(err.message); }
  const el = $('[data-dest]', root); if (el) el.textContent = state.settings.outputRoot;
  announce(`Send to Dud Rents now saves to ${state.settings.outputRoot}`);
  toast(`Saving to ${state.settings.outputRoot}`, 'info');
}

async function sendToDud() {
  if (!m?.spin) return;
  if (!(await confirmDialog({ title: `Send ${m.name} to Dud Rents?`, text: `Zips the spin set with its details into ${m.renders?.outDir || 'the handoff folder'} and writes ready.json so the website bots pick it up. Nothing leaves this computer.`, ok: 'Send' }))) return;
  try {
    const r = await send(`/api/spin/${m.id}/send`, 'POST', { meta: {} });
    upsert(await api(`/api/models/${m.id}`));
    toast(`${m.name} is ready for Dud Rents: ${r.zip}`, 'info');
  } catch (err) { toast(err.message); }
  refresh();
}
