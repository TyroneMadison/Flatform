// The model page (Library and Recent models open it): top to bottom, what was dropped, the prompt and settings
// it was generated with, the model itself in its composed scene (nothing else drawn on it), and what was rendered.
import { $, esc, state, api, toast, go, findModel, fileUrl, refresh, native, statusText, engineLabel, isRendered, renderedTurns,
  confirmDialog, isGenerating } from '../app.js';
import { icon } from '../lib/icons.js';
import { PROVIDERS, ENGINES, optionSpecs } from '../lib/engines.js';
import { Studio, PRESETS, defaultScene } from '../lib/studio.js';
import { LOOKS } from '../lib/pipeline.js';

let root;
let m;
let studio;
let observer;

export async function mount(el, { id }) {
  root = el;
  m = findModel(id);
  if (!m) { el.innerHTML = '<p class="muted">Pick a model from the <a class="link" href="#/library">library</a>.</p>'; return; }
  el.innerHTML = `<div class="mpage" id="mpage"></div>`;
  update();
  el.addEventListener('click', onClick);
  if (m.status === 'ready') await showModel();
}

export function unmount() {
  observer?.disconnect();
  studio?.dispose();
  studio = null;
}

export function update() {
  m = findModel(m?.id) || m;
  const box = $('#mpage', root);
  if (!box || !m) return;
  const html = page();
  if (box.dataset.html === html) return;
  const canvas = $('#mcv', root);
  box.dataset.html = html;
  box.innerHTML = html;
  if (canvas) $('#mcv', root).replaceWith(canvas); // keep the live view across redraws
}

const version = () => m.versions.find((v) => v.n === m.activeVersion) || m.versions.at(-1);

function dropSection(v) {
  if (v.provider === 'upload') {
    return `<p>Imported 3D file <b class="mono">${esc(v.fileName || 'model.glb')}</b>${v.file ? ' · converted to GLB' : ''}</p>
      ${v.file ? `<a class="btn ghostbtn sm" href="${fileUrl(m, v.file)}" download="${esc(v.fileName)}">${icon('download', 14)}<span>Original file</span></a>` : ''}`;
  }
  const views = v.views || (v.source ? { front: v.source } : {});
  if (!Object.keys(views).length) return '<p class="muted">No source photo saved.</p>';
  return `<div class="mp-photos">${Object.entries(views).map(([view, file]) => `<figure><img src="${fileUrl(m, file)}" alt="${esc(view)} photo of ${esc(m.name)}"><figcaption>${esc(view)}</figcaption></figure>`).join('')}</div>`;
}

function settingsSection(v) {
  if (v.provider === 'upload') return '<p class="muted">Not generated: this model was dropped in as a 3D file.</p>';
  const g = v.generation;
  if (!g) return `<p class="muted">Not recorded. This version was made before Flatform kept its prompt and settings${v.engine ? `; it ran on ${esc(engineLabel(v))}` : ''}.</p>`;
  const specs = ENGINES[g.engine] ? optionSpecs(g.engine) : [];
  const label = (k) => specs.find((s) => s.key === k)?.label || k;
  const value = (val) => (val === true ? 'On' : val === false ? 'Off' : val == null ? 'Auto' : String(val));
  const rows = [
    ['Provider', PROVIDERS[g.provider]?.name || g.provider], ['Engine', ENGINES[g.engine]?.label || g.engine],
    ['Photos', g.mode === 'views' ? 'Four views' : 'One photo'], ['Estimate', `${g.credits} credits`],
    ...Object.entries(g.options || {}).filter(([k]) => k !== 'prompt').map(([k, val]) => [label(k), value(val)]),
  ];
  return `<p><b>Prompt</b> ${g.prompt ? esc(g.prompt) : '<span class="muted">none (made from the photo alone)</span>'}</p>
    <dl class="mp-dl">${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>`;
}

function rendersSection() {
  const r = m.renders;
  if (!isRendered(m) && !r?.stills?.length) {
    return `<p class="muted">Not rendered yet.</p>${m.status === 'ready' ? `<a class="btn pri" href="#/render/${m.id}">${icon('film')}<span>Render</span></a>` : ''}`;
  }
  const looks = Object.keys(LOOKS).filter((l) => [360, 180].some((t) => r[`${l}${t}`]));
  return `${r.poster ? `<img class="mp-poster" src="${fileUrl(m, r.poster)}" alt="Rendered poster of ${esc(m.name)}">` : ''}
    <dl class="mp-dl"><dt>Turntables</dt><dd>${renderedTurns(m).map((t) => `${t}°`).join(' and ') || 'none'}</dd>
      <dt>Looks</dt><dd>${looks.map((l) => esc(LOOKS[l].label)).join(', ') || 'none'}</dd>
      ${r.stills?.length ? `<dt>Stills</dt><dd>${r.stills.length}</dd>` : ''}
      <dt>Folder</dt><dd class="mono">${esc(r.outDir || '')}</dd>${r.at ? `<dt>Rendered</dt><dd>${esc(new Date(r.at).toLocaleString())}</dd>` : ''}</dl>
    <div class="mp-act">${native && r.outDir ? `<button class="btn ghostbtn" type="button" data-act="open">${icon('folder')}<span>Open folder</span></button>` : ''}
      <a class="btn sec" href="#/render/${m.id}">${icon('film')}<span>Render again</span></a></div>`;
}

function page() {
  const v = version();
  const scene = { ...defaultScene(state.settings), ...m.scene };
  const ready = m.status === 'ready';
  return `
    <div class="libhead"><div><a class="link" href="#/library">${icon('library', 14)} Library</a><h1 class="ph">${esc(m.name)}</h1>
      <p class="sub">${esc(statusText(m))}${ready && v.provider !== 'upload' ? ` · ${esc(engineLabel(m))}` : ''}${m.approved ? ' · Approved' : ''}${m.versions.length > 1 ? ` · version ${m.activeVersion} of ${m.versions.length}` : ''}</p></div>
      <div class="lh-act">${ready ? `<a class="btn ghostbtn" href="${fileUrl(m, m.glb)}" download="${esc(m.slug || 'model')}.glb">${icon('download')}<span>GLB</span></a>` : ''}
        ${isGenerating(m) ? `<a class="btn sec" href="#/generate/${m.id}">${icon('eye')}<span>Show progress</span></a>` : ''}
        <button class="btn dangerbtn" type="button" data-act="delete">Delete</button></div></div>
    <section class="mp-sec glass"><h2 class="label">Drop</h2>${dropSection(v)}</section>
    <section class="mp-sec glass"><h2 class="label">Prompt and settings</h2>${settingsSection(v)}</section>
    <section class="mp-sec glass"><div class="rowhead"><h2 class="label">Compose</h2>${ready ? `<a class="btn pri sm" href="#/compose/${m.id}">${icon('scene', 14)}<span>Open in Compose</span></a>` : ''}</div>
      ${ready ? `<p class="sub">${esc(PRESETS[scene.preset]?.label || scene.preset)} · turn ${Math.round(scene.turn)}°</p>
      <div class="mp-view"><canvas id="mcv" aria-label="${esc(m.name)} in its scene"></canvas></div>` : '<p class="muted">The model is not ready yet.</p>'}</section>
    <section class="mp-sec glass"><h2 class="label">Rendered outputs</h2>${rendersSection()}</section>`;
}

// The model in its composed scene, exactly as Compose and the renders frame it. Nothing drawn over it.
async function showModel() {
  const canvas = $('#mcv', root);
  if (!canvas) return;
  try { studio = new Studio(canvas); } catch { return; }
  const s = studio;
  s.setRig(state.settings || {});
  const draw = () => s.render();
  observer = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || studio !== s) return;
    s.resize(r.width, r.width * 0.75, Math.min(devicePixelRatio, 2));
    s.coverBackground();
    draw();
  });
  observer.observe(canvas);
  await s.setState({ ...defaultScene(state.settings), ...m.scene });
  if (studio !== s) return;
  s.setFrame(state.frames[m.id] ?? 0);
  try { await s.load(fileUrl(m, m.glb)); } catch (e) { toast(`Could not load the model: ${e.message}`); }
  if (studio === s) draw();
}

async function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (t.dataset.act === 'open') native?.openPath(m.renders.outDir).catch((err) => toast(err.message));
  if (t.dataset.act === 'delete') {
    if (!(await confirmDialog({ title: `Delete “${m.name}”?`, text: 'This removes the model, every version and its files from this computer. Rendered handoff folders are not touched.', ok: 'Delete model' }))) return;
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' });
      state.models = state.models.filter((x) => x.id !== m.id);
      if (state.lastId === m.id) state.lastId = null;
      refresh();
      go('#/library');
    } catch (err) { toast(err.message); }
  }
}
