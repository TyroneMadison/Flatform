// Library: search, filters and cards. A card opens the model page; the side panel keeps quick actions (downloads,
// retry, regenerate, delete) for the last model looked at.
import { activeWorkspace } from '../app.js';
import { $, $$, esc, state, api, send, toast, go, findModel, upsert, fileUrl, thumbOf, statusText, statusClass, isGenerating,
  isRendered, renderedTurns, retryModel, confirmDialog, refresh, openPicker, busy, setupFor, engineLabel, providerOf, FORMATS } from '../app.js';
import { icon } from '../lib/icons.js';

const FILTERS = [['all', 'All'], ['ready', 'Ready'], ['generating', 'Generating'], ['failed', 'Failed'], ['rendered', 'Rendered'], ['needs', 'Needs render']];
// A model counts as rendered once it has a turntable or a still from Compose's render area.
const hasRender = (m) => isRendered(m) || Boolean(m.renders?.stills?.length);
const MATCH = {
  all: () => true, ready: (m) => m.status === 'ready', generating: isGenerating, failed: (m) => m.status === 'failed',
  rendered: hasRender, needs: (m) => m.status === 'ready' && !hasRender(m),
};
let root;
let filter = 'all';
let query = '';
let selectedId = null;

// Each workspace has its own home: Warframe gets drawing, import and the TennoGen check; Car gets photo, batch and render.
function quickActions() {
  const w = activeWorkspace();
  if (w?.kind === 'warframe') return `<button class="btn pri" type="button" id="newPhoto">${icon('plus')}<span>New from drawing</span></button>
      <button class="btn sec" type="button" data-quick="import"><span>Import model</span></button>
      <button class="btn ghostbtn" type="button" data-quick="tenno"><span>TennoGen export check</span></button>`;
  return `<button class="btn pri" type="button" id="newPhoto">${icon('plus')}<span>New from photo</span></button>${w ? `
      <button class="btn ghostbtn" type="button" data-quick="batch"><span>Batch color variants</span></button>
      <button class="btn ghostbtn" type="button" data-quick="render"><span>Render turntable</span></button>` : ''}`;
}

export function mount(el) {
  root = el;
  selectedId = findModel(state.lastId) ? state.lastId : state.models[0]?.id ?? null;
  el.innerHTML = `
  <div class="libhead">
    <div><h1 class="ph">Library</h1><p class="sub">Every model is saved on this computer, in <span class="mono">${esc(state.settings?.libraryDir || 'the app data folder')}</span></p></div>
    <div class="lh-act">
      <label class="search glass">${icon('search')}<span class="sr-only">Search models</span><input type="search" id="q" placeholder="Search models" autocomplete="off"></label>
      ${quickActions()}
    </div>
  </div>
  <div class="chips filters" role="group" aria-label="Filter models">${FILTERS.map(([k, l]) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${k === filter}">${l}</button>`).join('')}</div>
  <section class="library">
    <div class="lgrid" id="grid"></div>
    <aside class="insp glass lib-side" id="side" aria-label="Selected model"></aside>
  </section>`;
  $('#q', el).value = query;
  $('#q', el).addEventListener('input', (e) => { query = e.target.value; update(); });
  $('#newPhoto', el)?.addEventListener('click', () => { go('#/drop'); setTimeout(openPicker, 50); });
  el.addEventListener('click', (e) => {
    const q = e.target.closest('[data-quick]')?.dataset.quick;
    if (q === 'import') { go('#/drop'); setTimeout(openPicker, 50); }
    if (q === 'render' || q === 'batch' || q === 'tenno') { const id = selectedId || state.models[0]?.id; if (!id) return toast('Add a model first', 'info'); if (q === 'render') state.renderIntent = 'turntable'; go(q === 'tenno' ? `#/compose/${id}` : `#/compose/${id}/render`); }
  });
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', (e) => {
    if (e.target.matches('.rename') && e.key === 'Enter') e.target.blur();
    if (e.target.matches('.rename') && e.key === 'Escape') { e.target.value = findModel(selectedId)?.name ?? ''; e.target.blur(); }
  });
  el.addEventListener('change', (e) => { if (e.target.matches('.rename')) rename(e.target); });
  update();
}

async function rename(input) {
  const m = findModel(selectedId);
  const name = input.value.trim();
  if (!m || !name || name === m.name) { input.value = m?.name ?? ''; return; }
  try { upsert(await send(`/api/models/${m.id}`, 'PATCH', { name })); refresh(); } catch (e) { toast(e.message); input.value = m.name; }
}

async function onClick(e) {
  const t = e.target.closest('[data-filter],[data-select],[data-act],[data-fmt]');
  if (!t) return;
  if (t.dataset.filter) { filter = t.dataset.filter; $$('[data-filter]', root).forEach((b) => b.setAttribute('aria-pressed', b === t)); return update(); }
  if (t.dataset.select) { selectedId = t.dataset.select; state.lastId = selectedId; return go(`#/model/${selectedId}`); } // the model page
  const m = findModel(t.dataset.id || selectedId);
  if (!m) return;
  if (t.dataset.act === 'retry') return busy(t, () => retryModel(m));
  if (t.dataset.act === 'enhance') {
    if (!(await confirmDialog({ title: 'Enhance this model?', text: 'Tripo redoes the paint in detailed quality. About 20 credits; the Spend page shows what it really cost.', ok: 'Enhance' }))) return;
    return busy(t, async () => { try { await api(`/api/models/${m.id}/enhance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'texture' }) }); toast('Enhancing. It shows up as a new file when Tripo is done.', 'info'); } catch (err) { toast(err.message); } });
  }
  if (t.dataset.act === 'regen') await busy(t, () => setupFor(m).catch((err) => toast(err.message)));
  if (t.dataset.act === 'delete') {
    if (!(await confirmDialog({ title: `Delete â€œ${m.name}â€?`, text: 'This removes the model, every version and its files from this computer. Rendered handoff folders are not touched.', ok: 'Delete model' }))) return;
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' });
      state.models = state.models.filter((x) => x.id !== m.id); // by id: polling may have swapped the object
      if (state.lastId === m.id) state.lastId = null;
      selectedId = state.models[0]?.id ?? null;
      refresh();
    } catch (err) { toast(err.message); }
  }
  if (t.dataset.fmt) {
    const f = t.dataset.fmt;
    m.exports ||= {};
    m.exports[f] = { status: 'converting' };
    update();
    try { m.exports[f] = await api(`/api/models/${m.id}/exports/${f}`, { method: 'POST' }); } catch (err) { m.exports[f] = { status: 'failed', error: err.message }; toast(`${f}: ${err.message}`); }
    update();
  }
}

function card(m) {
  const img = thumbOf(m);
  const poster = Boolean(m.renders?.poster);
  const badges = m.status !== 'ready' ? '' : hasRender(m)
    ? `${renderedTurns(m).map((t) => `<em title="Has a ${t}° turntable">${t}</em>`).join('')}${m.renders?.stills?.length ? '<em title="Has a still picture">Still</em>' : ''}`
    : '<em class="dim">Not rendered</em>';
  return `<article class="lc glass${m.id === selectedId ? ' on' : ''}">
    <button class="lc-select" type="button" data-select="${m.id}" aria-pressed="${m.id === selectedId}"><span class="sr-only">Select ${esc(m.name)}</span></button>
    <div class="lc-th"><div class="stage ${poster ? 's-ring' : 's-clear'}">${poster ? '' : '<div class="checker"></div>'}${img ? `<img class="thumb${poster ? '' : ' contain'}" src="${img}" alt="${esc(m.name)}">` : ''}</div></div>
    <div class="lc-b">
      <div><b>${esc(m.name)}</b><span class="st ${statusClass(m)}">${esc(statusText(m))}</span>${isGenerating(m) ? `<div class="pbar"><i style="width:${m.progress || 0}%"></i></div>` : ''}</div>
      <div class="badges">${m.status === 'failed' ? `<button class="btn sm pri" type="button" data-act="retry" data-id="${m.id}">${icon('retry')}<span>Retry</span></button>` : badges}</div>
    </div>
  </article>`;
}

function formatButton(m, f) {
  const e = m.exports?.[f];
  const base = m.slug || 'model';
  if (e?.status === 'ready') return `<a class="fmt ok" href="${fileUrl(m, e.file)}" download="${esc(base + e.file.slice(e.file.lastIndexOf('.')))}" aria-label="Download ${f}">${f}</a>`;
  if (e?.status === 'converting') return `<span class="fmt busy" role="status">${f}â€¦</span>`;
  if (e?.status === 'failed') return `<button class="fmt bad" type="button" data-fmt="${f}" title="${esc(e.error || '')}">Retry ${f}</button>`;
  return `<button class="fmt" type="button" data-fmt="${f}" aria-label="Convert to ${f}">${f}</button>`;
}

function side(m) {
  if (!m) return '<p class="muted">Select a model to see what you can do with it.</p>';
  const ready = m.status === 'ready';
  const rendered = isRendered(m) ? `rendered ${renderedTurns(m).join(' and ')}` : 'not rendered yet';
  const sub = [statusText(m), engineLabel(m), `${m.versions.length} version${m.versions.length > 1 ? 's' : ''}`, ready && rendered].filter(Boolean).join(' · ');
  const tripo = providerOf(m) === 'tripo';
  return `
    <div class="ls-th"><div class="stage ${m.renders?.poster ? 's-ring' : 's-clear'}">${m.renders?.poster ? '' : '<div class="checker"></div>'}${thumbOf(m) ? `<img class="thumb${m.renders?.poster ? '' : ' contain'}" src="${thumbOf(m)}" alt="${esc(m.name)}">` : ''}</div></div>
    <label class="sr-only" for="rename">Model name</label>
    <input class="it rename" id="rename" value="${esc(m.name)}" maxlength="100" spellcheck="false">
    <p class="sub">${esc(sub)}</p>
    <div class="grp">
      ${ready ? `<a class="btn pri" href="#/compose/${m.id}">${icon('scene')}<span>Open in scene composer</span></a>
      <a class="btn sec" href="#/compose/${m.id}/render" title="Open Compose at its render options">${icon('film')}<span>${isRendered(m) ? 'Render again' : 'Render'}</span></a>` : ''}
      ${isGenerating(m) ? `<a class="btn sec" href="#/generate/${m.id}">${icon('eye')}<span>Show progress</span></a>` : ''}
      ${m.status === 'failed' ? `<button class="btn pri" type="button" data-act="retry" data-id="${m.id}">${icon('retry')}<span>Retry</span></button>` : ''}
      <a class="btn ghostbtn" href="#/model/${m.id}">${icon('eye')}<span>Model page</span></a>
      <button class="btn ghostbtn" type="button" data-act="enhance" ${m.status === 'ready' && m.versions?.find?.((v) => v.n === m.activeVersion)?.provider === 'tripo' ? '' : 'hidden'} title="Sharper paint through Tripo, about 20 credits">${icon('light')}<span>Enhance</span></button>
        <button class="btn ghostbtn" type="button" data-act="regen" ${isGenerating(m) ? 'disabled' : ''}>${icon('retry')}<span>Regenerate</span></button>
    </div>
    <div class="grp"><h3>Download model</h3>
      ${ready ? `<div class="fmts"><a class="fmt ok" href="${fileUrl(m, m.glb)}" download="${esc(m.slug || 'model')}.glb" aria-label="Download GLB">GLB</a>${tripo ? FORMATS.map((f) => formatButton(m, f)).join('') : ''}</div>
      <p class="fine">${tripo ? 'GLB is saved right away. Other formats are converted by Tripo on first click.'
        : 'GLB is saved right away. Other formats come from Tripoâ€™s converter, which only works on models made with Tripo direct.'}</p>` : '<p class="fine">Downloads unlock when the model is ready.</p>'}
    </div>
    <div class="grp danger"><button class="btn dangerbtn" type="button" data-act="delete">Delete model and its files</button></div>`;
}

export function update() {
  const q = query.trim().toLowerCase();
  const list = state.models.filter((m) => MATCH[filter](m) && (!q || m.name.toLowerCase().includes(q)))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const grid = list.map(card).join('') || `<p class="muted empty">${state.models.length ? 'No models match.' : 'No models yet. Drop a photo to make your first one.'}</p>`;
  const g = $('#grid', root);
  if (g.dataset.html !== grid) { g.dataset.html = grid; g.innerHTML = grid; }
  const m = findModel(selectedId);
  const html = side(m);
  const s = $('#side', root);
  // Don't rebuild the panel under someone typing a new name.
  if (s.dataset.html !== html && !s.contains(document.activeElement?.matches('.rename') ? document.activeElement : null)) { s.dataset.html = html; s.innerHTML = html; }
}
