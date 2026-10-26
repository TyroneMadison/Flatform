// Library: search, filters and cards. A card opens the model page; the side panel keeps quick actions (downloads,
// retry, regenerate, delete) for the last model looked at.
import { activeWorkspace } from '../app.js';
import { $, $$, esc, state, api, send, toast, go, findModel, upsert, fileUrl, thumbOf, statusText, statusClass, isGenerating,
  isRendered, renderedTurns, retryModel, confirmDialog, refresh, openPicker, busy, setupFor, engineLabel, providerOf, FORMATS } from '../app.js';
import { icon } from '../lib/icons.js';

const FILTERS = [['all', 'All'], ['ready', 'Ready'], ['generating', 'Making'], ['failed', 'Failed'], ['rendered', 'Rendered'], ['needs', 'Not rendered']];
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
  if (w?.kind === 'warframe') return `<button class="btn pri" type="button" id="newPhoto" title="Make a 3D model from a drawing or picture">${icon('plus')}<span>New from drawing</span></button>
      <button class="btn sec" type="button" data-quick="import" title="Add a 3D file you already have"><span>Add 3D file</span></button>
      <button class="btn ghostbtn" type="button" data-quick="tenno" title="Check the model is ready to send to TennoGen"><span>TennoGen check</span></button>`;
  return `<button class="btn pri" type="button" id="newPhoto" title="Make a 3D model from a photo">${icon('plus')}<span>New from photo</span></button>${w ? `
      <button class="btn ghostbtn" type="button" data-quick="batch" title="Render the model in several colors at once"><span>Many colors</span></button>
      <button class="btn ghostbtn" type="button" data-quick="render" title="Make a video of the model turning around"><span>Spin video</span></button>` : ''}`;
}

export function mount(el) {
  root = el;
  selectedId = findModel(state.lastId) ? state.lastId : state.models[0]?.id ?? null;
  el.innerHTML = `
  <div class="libhead">
    <div><h1 class="ph">Library</h1><p class="sub">Saved on this computer in <span class="mono">${esc(state.settings?.libraryDir || 'the app data folder')}</span></p></div>
    <div class="lh-act">
      <label class="search glass">${icon('search')}<span class="sr-only">Search models</span><input type="search" id="q" placeholder="Search models" autocomplete="off" title="Type part of a name to find a model"></label>
      ${quickActions()}
    </div>
  </div>
  <div class="chips filters" role="group" aria-label="Filter models">${FILTERS.map(([k, l]) => `<button class="chip" type="button" data-filter="${k}" aria-pressed="${k === filter}" title="Show ${k === 'all' ? 'all models' : `only ${l.toLowerCase()} models`}">${l}</button>`).join('')}</div>
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
    if (!(await confirmDialog({ title: 'Enhance this model?', text: 'Tripo paints it again in more detail. About 20 credits. The Spend page shows the real cost.', ok: 'Enhance' }))) return;
    return busy(t, async () => { try { await api(`/api/models/${m.id}/enhance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'texture' }) }); toast('Working on it. It shows up as a new version when Tripo is done.', 'info'); } catch (err) { toast(err.message); } });
  }
  if (t.dataset.act === 'regen') await busy(t, () => setupFor(m).catch((err) => toast(err.message)));
  if (t.dataset.act === 'delete') {
    if (!(await confirmDialog({ title: `Delete “${m.name}”?`, text: 'This removes the model, every version and its files from this computer. Folders you rendered to are kept.', ok: 'Delete model' }))) return;
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
    ? `${renderedTurns(m).map((t) => `<em title="Has a ${t}° spin video">${t}</em>`).join('')}${m.renders?.stills?.length ? '<em title="Has a still picture">Still</em>' : ''}`
    : '<em class="dim" title="No pictures or spin videos yet">Not rendered</em>';
  return `<article class="lc glass${m.id === selectedId ? ' on' : ''}">
    <button class="lc-select" type="button" data-select="${m.id}" aria-pressed="${m.id === selectedId}" title="Open ${esc(m.name)}"><span class="sr-only">Select ${esc(m.name)}</span></button>
    <div class="lc-th"><div class="stage ${poster ? 's-ring' : 's-clear'}">${poster ? '' : '<div class="checker"></div>'}${img ? `<img class="thumb${poster ? '' : ' contain'}" src="${img}" alt="${esc(m.name)}">` : ''}</div></div>
    <div class="lc-b">
      <div><b>${esc(m.name)}</b><span class="st ${statusClass(m)}">${esc(statusText(m))}</span>${isGenerating(m) ? `<div class="pbar"><i style="width:${m.progress || 0}%"></i></div>` : ''}</div>
      <div class="badges">${m.status === 'failed' ? `<button class="btn sm pri" type="button" data-act="retry" data-id="${m.id}" title="Try making it again">${icon('retry')}<span>Try again</span></button>` : badges}</div>
    </div>
  </article>`;
}

function formatButton(m, f) {
  const e = m.exports?.[f];
  const base = m.slug || 'model';
  if (e?.status === 'ready') return `<a class="fmt ok" href="${fileUrl(m, e.file)}" download="${esc(base + e.file.slice(e.file.lastIndexOf('.')))}" aria-label="Download ${f}" title="Download the ${f} file">${f}</a>`;
  if (e?.status === 'converting') return `<span class="fmt busy" role="status">${f}…</span>`;
  if (e?.status === 'failed') return `<button class="fmt bad" type="button" data-fmt="${f}" title="${esc(e.error || 'It did not work. Click to try again.')}">Retry ${f}</button>`;
  return `<button class="fmt" type="button" data-fmt="${f}" aria-label="Make a ${f} copy" title="Make a ${f} copy to download">${f}</button>`;
}

function side(m) {
  if (!m) return '<p class="muted">Select a model to see what you can do with it.</p>';
  const ready = m.status === 'ready';
  const rendered = isRendered(m) ? `spin ${renderedTurns(m).map((t) => `${t}°`).join(' and ')}` : 'not rendered yet';
  const sub = [statusText(m), engineLabel(m), `${m.versions.length} version${m.versions.length > 1 ? 's' : ''}`, ready && rendered].filter(Boolean).join(' · ');
  const tripo = providerOf(m) === 'tripo';
  return `
    <div class="ls-th"><div class="stage ${m.renders?.poster ? 's-ring' : 's-clear'}">${m.renders?.poster ? '' : '<div class="checker"></div>'}${thumbOf(m) ? `<img class="thumb${m.renders?.poster ? '' : ' contain'}" src="${thumbOf(m)}" alt="${esc(m.name)}">` : ''}</div></div>
    <label class="sr-only" for="rename">Model name</label>
    <input class="it rename" id="rename" value="${esc(m.name)}" maxlength="100" spellcheck="false" title="Click to change the name">
    <p class="sub keep">${esc(sub)}</p>
    <div class="grp">
      ${ready ? `<a class="btn pri" href="#/compose/${m.id}" title="Open the model in the Scene step">${icon('scene')}<span>Open in Scene</span></a>
      <a class="btn sec" href="#/compose/${m.id}/render" title="Open the Scene step at Render">${icon('film')}<span>${isRendered(m) ? 'Render again' : 'Render'}</span></a>` : ''}
      ${isGenerating(m) ? `<a class="btn sec" href="#/generate/${m.id}" title="See how far along it is">${icon('eye')}<span>Show progress</span></a>` : ''}
      ${m.status === 'failed' ? `<button class="btn pri" type="button" data-act="retry" data-id="${m.id}" title="Try making it again">${icon('retry')}<span>Try again</span></button>` : ''}
      <a class="btn ghostbtn" href="#/model/${m.id}" title="See everything about this model">${icon('eye')}<span>Model page</span></a>
      <button class="btn ghostbtn" type="button" data-act="enhance" ${m.status === 'ready' && m.versions?.find?.((v) => v.n === m.activeVersion)?.provider === 'tripo' ? '' : 'hidden'} title="Sharper paint from Tripo, about 20 credits">${icon('light')}<span>Enhance</span></button>
        <button class="btn ghostbtn" type="button" data-act="regen" ${isGenerating(m) ? 'disabled' : ''} title="Make it again, with new settings if you like">${icon('retry')}<span>Make again</span></button>
    </div>
    <div class="grp"><h3>Download</h3>
      ${ready ? `<div class="fmts"><a class="fmt ok" href="${fileUrl(m, m.glb)}" download="${esc(m.slug || 'model')}.glb" aria-label="Download the 3D file" title="Download the 3D file (.glb)">3D file</a>${tripo ? FORMATS.map((f) => formatButton(m, f)).join('') : ''}</div>
      <p class="fine">${tripo ? 'The 3D file is ready now. Tripo makes the other types the first time you click.'
        : 'The 3D file is ready now. Other types only work for models made with Tripo.'}</p>` : '<p class="fine keep">Downloads open up when the model is ready.</p>'}
    </div>
    <div class="grp danger"><button class="btn dangerbtn" type="button" data-act="delete" title="Delete this model and its files from this computer">Delete model</button></div>`;
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
