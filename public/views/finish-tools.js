// Finish tools: trim, look, before and after, and light copies for the website. Big choices up front, fine
// controls behind Adjust. Everything is saved as new files in the render folder; nothing existing is overwritten.
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { esc, fileUrl, toast, announce } from '../app.js';
import { bounds, fit } from '../lib/autocrop.js';
import { applyStyle } from '../lib/style.js';
import { addVersion, diffSettings, wipeClip, sliderKey } from '../lib/versions.js';
import { buildLods, table } from '../lib/lod.js';

export const ASPECTS = { free: null, '1:1': 1, '16:9': 16 / 9, '4:5': 4 / 5 };
export const LOOK_NAMES = { none: 'Normal', painterly: 'Painterly', cel: 'Cel' };
/** The picture settings that are saved with each version. */
export const defaults = () => ({ look: 'none', trim: true, padding: 5, shadow: true, aspect: 'free' });
const fileApi = (m, rel) => `/api/renders/${encodeURIComponent(m.id)}/file?path=${encodeURIComponent(rel)}`;
/** Which picture to work on: the first still, else the poster. */
export const sourceOf = (m) => (m?.renders?.stills?.[0] ? { rel: m.renders.stills[0], url: fileApi(m, m.renders.stills[0]) } : m?.renders?.poster ? { rel: m.renders.poster, url: fileUrl(m, m.renders.poster) } : null);

let host, m, getTree, opts, src = null, out = null, list = [], t = 0.5, pickA = 0, pickB = -1, lods = null;

export async function mountTools(el, model, treeFn) {
  host = el; m = model; getTree = treeFn; opts = defaults(); src = null; out = null; list = []; t = 0.5; pickA = 0; pickB = -1; lods = null;
  el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.addEventListener('input', onInput);
  draw();
  const s = sourceOf(m);
  if (!s) return;
  try {
    src = await loadImage(s.url);
    const j = await fetch(fileApi(m, 'versions/versions.json'));
    list = j.ok ? await j.json() : [];
  } catch (e) { toast(`Could not open the picture: ${e.message}`, 'bad'); }
  process(); draw();
}

async function loadImage(url) {
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url; await img.decode();
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}

function process() {
  if (!src) return;
  let img = src;
  if (opts.trim) {
    const r = fit(bounds(src, { includeShadow: opts.shadow }), src, { padding: opts.padding / 100, aspect: ASPECTS[opts.aspect] });
    const c = new OffscreenCanvas(r.w, r.h); const g = c.getContext('2d');
    g.putImageData(src, -r.x, -r.y); img = g.getImageData(0, 0, r.w, r.h);
  }
  out = applyStyle(img, opts.look);
}

const seg = (name, val, items) => `<div class="seg" role="radiogroup" aria-label="${name}">${Object.entries(items).map(([k, l]) => `<button class="chip" type="button" role="radio" aria-checked="${val === k}" data-opt="${name}" data-val="${k}">${l}</button>`).join('')}</div>`;
const toggle = (key, label) => `<label class="toggle"><input type="checkbox" data-opt="${key}" ${opts[key] ? 'checked' : ''}><span>${label}</span></label>`;

function draw() {
  if (!host) return;
  if (!m?.renders?.poster && !m?.renders?.stills?.length) {
    host.innerHTML = `<div class="card glass"><h2 class="label">Picture</h2><p class="sub">Render this model once, then come back here to trim it, change the look and compare versions.</p><a class="btn pri" href="#/compose/${esc(m?.id || '')}/render" title="Open Scene and render at the Render tool">Render it in Scene</a></div>`;
    return;
  }
  const vs = list.length ? list : [];
  host.innerHTML = `
  <div class="card glass ft">
    <h2 class="label">Picture</h2>
    <div class="ft-grid">
      <canvas class="ft-view" id="ftOut" aria-label="Picture with your changes"></canvas>
      <div class="ft-side">
        <p class="ft-h">Look</p>${seg('look', opts.look, LOOK_NAMES)}
        ${toggle('trim', 'Trim empty space')}
        <details class="adjust"><summary>Adjust (more options)</summary>
          <div class="field"><label for="ftPad">Space around the model: <b id="ftPadV">${opts.padding}%</b></label><input id="ftPad" type="range" min="0" max="30" value="${opts.padding}" data-opt="padding"></div>
          <div class="field">${toggle('shadow', 'Keep the shadow inside the trim')}</div>
          <div class="field"><p class="ft-h">Shape</p>${seg('aspect', opts.aspect, { free: 'Free', '1:1': 'Square', '16:9': 'Wide', '4:5': 'Tall' })}</div>
        </details>
        <button class="btn pri huge" type="button" data-ft="save">Save picture</button>
        <p class="fine">Saved as a new version in the render folder. The first render is kept.</p>
      </div>
    </div>
  </div>
  <div class="card glass ft" id="fCompare">
    <h2 class="label">Before and after</h2>
    <div class="ft-wipe" id="ftWipe" role="slider" tabindex="0" aria-label="Compare versions" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(t * 100)}">
      <canvas id="ftA"></canvas><canvas id="ftB"></canvas><div class="ft-handle" id="ftHandle"></div>
    </div>
    <p class="fine">Drag the middle to compare versions. Left: ${esc(nameOf(pickA))}. Right: ${esc(nameOf(pickB))}.</p>
    ${vs.length ? `<details class="adjust"><summary>Adjust (more options)</summary>
      <div class="field"><label for="ftVa">Left side</label><select id="ftVa" data-pick="a">${optList(pickA)}</select></div>
      <div class="field"><label for="ftVb">Right side</label><select id="ftVb" data-pick="b">${optList(pickB)}</select></div>
      <p class="fine">${esc(changes())}</p></details>` : ''}
  </div>
  <div class="card glass ft">
    <h2 class="label">Light copy for website</h2>
    <p class="sub">Smaller 3D files that load fast on a web page. Your full model stays as it is.</p>
    ${lods ? `<table class="ft-lod"><thead><tr><th>Copy</th><th>Triangles</th></tr></thead><tbody>${lods.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.tris.toLocaleString()}</td></tr>`).join('')}</tbody></table>` : ''}
    <button class="btn ${lods ? 'sec' : 'pri'} wide" type="button" data-ft="lod">${lods ? 'Make them again' : 'Make light copies'}</button>
  </div>`;
  paint();
}

// Version 0 is the first render; -1 is what is on screen now (not saved yet).
const nameOf = (i) => (i === -1 ? 'now (not saved)' : i === 0 ? 'first render' : `version ${i}`);
const optList = (sel) => [-1, 0, ...list.map((v) => v.n)].map((i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${nameOf(i)}</option>`).join('');
function changes() {
  const a = pickA > 0 ? list.find((v) => v.n === pickA)?.settings : pickA === 0 ? defaults() : opts;
  const b = pickB > 0 ? list.find((v) => v.n === pickB)?.settings : pickB === 0 ? defaults() : opts;
  const d = diffSettings(a, b);
  return d.length ? `What changed: ${d.map((x) => `${x.key} ${x.a} to ${x.b}`).join(', ')}` : 'Same settings.';
}

const cache = new Map();
async function imageFor(i) {
  if (i === -1) return out;
  if (i === 0) return src;
  if (!cache.has(i)) { const v = list.find((x) => x.n === i); cache.set(i, v ? await loadImage(fileApi(m, v.files[0])) : src); }
  return cache.get(i);
}
const put = (c, img) => { if (!c || !img) return; c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); };

async function paint() {
  put(host.querySelector('#ftOut'), out);
  const [a, b] = await Promise.all([imageFor(pickA), imageFor(pickB)]);
  put(host.querySelector('#ftA'), a); put(host.querySelector('#ftB'), b);
  wipe();
}
function wipe() {
  const w = host.querySelector('#ftWipe'); if (!w) return;
  const r = wipeClip(t, 100, 100);
  host.querySelector('#ftB').style.clipPath = `inset(0 0 0 ${r.x}%)`;
  host.querySelector('#ftHandle').style.left = `${r.x}%`;
  w.setAttribute('aria-valuenow', String(r.x));
}

async function save() {
  if (!out || !m.renders?.outDir) return toast('Render this model once first, so there is a folder to save in.', 'warn');
  const c = new OffscreenCanvas(out.width, out.height); c.getContext('2d').putImageData(out, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const n = (list.at(-1)?.n ?? 0) + 1; const rel = `versions/v${n}.png`;
  try {
    for (const [p, body] of [[rel, blob], ['versions/versions.json', JSON.stringify(addVersion(list, { files: [rel], settings: opts }), null, 2)]]) {
      const r = await fetch(fileApi(m, p), { method: 'PUT', body });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    }
    list = addVersion(list, { files: [rel], settings: opts }); pickA = 0; pickB = n;
    toast(`Saved version ${n}.`, 'ok'); draw();
  } catch (e) { toast(`Could not save: ${e.message}`, 'bad'); }
}

async function makeLods() {
  const tree = getTree(); if (!tree) return toast('Wait for the check to finish loading the model.', 'warn');
  if (!m.renders?.outDir) return toast('Render this model once first, so there is a folder to save in.', 'warn');
  announce('Making light copies');
  const mod = new SimplifyModifier();
  const meshes = []; tree.traverse((o) => o.isMesh && o.geometry && meshes.push(o));
  const perMesh = await Promise.all(meshes.map((o) => buildLods(o.geometry, (g, n) => mod.modify(g, n))));
  const full = meshes.reduce((s, o) => s + (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3, 0);
  const levels = perMesh[0]?.map((l, i) => ({ name: l.name, tris: perMesh.reduce((s, p) => s + p[i].tris, 0), i })) || [];
  const slug = String(m.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
  try {
    for (const l of levels) {
      const copy = tree.clone(true); let k = 0;
      copy.traverse((o) => { if (o.isMesh && o.geometry) o.geometry = perMesh[k++][l.i].geometry; });
      const glb = await new GLTFExporter().parseAsync(copy, { binary: true });
      const r = await fetch(fileApi(m, `lod/${slug}-${l.name}.glb`), { method: 'PUT', body: glb });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    }
    lods = table(Math.round(full), levels); toast('Light copies saved in the lod folder.', 'ok'); draw();
  } catch (e) { toast(`Could not make light copies: ${e.message}`, 'bad'); }
}

function onClick(e) {
  const o = e.target.closest('[data-opt][data-val]');
  if (o) { opts[o.dataset.opt] = o.dataset.val; process(); draw(); return; }
  const a = e.target.closest('[data-ft]')?.dataset.ft;
  if (a === 'save') save(); else if (a === 'lod') makeLods();
}
function onChange(e) {
  const k = e.target.dataset.opt;
  if (k && e.target.type === 'checkbox') { opts[k] = e.target.checked; process(); draw(); }
  if (e.target.dataset.pick) { const v = Number(e.target.value); if (e.target.dataset.pick === 'a') pickA = v; else pickB = v; draw(); }
}
function onInput(e) {
  if (e.target.dataset.opt === 'padding') { opts.padding = Number(e.target.value); host.querySelector('#ftPadV').textContent = `${opts.padding}%`; process(); put(host.querySelector('#ftOut'), out); if (pickB === -1) paint(); }
}

// Wipe slider: drag or arrow keys (Shift for bigger steps).
document.addEventListener('pointerdown', (e) => {
  const w = e.target.closest?.('#ftWipe'); if (!w) return;
  const move = (ev) => { const r = w.getBoundingClientRect(); t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); wipe(); };
  move(e); w.setPointerCapture(e.pointerId);
  w.addEventListener('pointermove', move); w.addEventListener('pointerup', () => w.removeEventListener('pointermove', move), { once: true });
});
document.addEventListener('keydown', (e) => { if (e.target.id === 'ftWipe') { const n = sliderKey(t, e.key, e.shiftKey); if (n !== t) { e.preventDefault(); t = n; wipe(); } } });

export function unmountTools() { host = null; cache.clear(); }
