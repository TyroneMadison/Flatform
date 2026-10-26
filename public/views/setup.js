// 02 · Generate setup: the photos, the provider, a preset and (only if you want) the engine's own options, then
// Generate. Calm rows: a label on the left, a fixed-width control on the right. Groups stay collapsed to a one-line
// summary, one open at a time; options that don't apply to the current choices are hidden or explained by a tooltip.
import { $, esc, state, stepper, findModel, toast, go, refresh, refreshAccount, openKeyDialog, takePhotos, addFiles, enqueue,
  savedSetup, rememberSetup, accountOf, fmtBalance, busy, send, arrowRadios, confirmDialog } from '../app.js';
import { icon } from '../lib/icons.js';
import { PROVIDERS, ENGINES, PRESETS, VIEWS, GROUPS, groupName, normalize, presetConfig, matchPreset, summary, optionSpecs,
  valuesOf, valueLabel, engineList } from '../lib/engines.js';
import { estimate } from '../lib/pricing.js';

const VIEW_NAMES = { front: 'Front', left: 'Left', back: 'Back', right: 'Right' };
let root;
let setup; // the normalised setup on screen
let openGroup = null;
let model = null; // set when regenerating a model
let dragging = false; // a slider is being dragged: don't redraw under it
const urls = new Map(); // photo id → preview URL

const pending = () => state.pending;
const photoUrl = (p) => {
  if (!urls.has(p.id)) urls.set(p.id, URL.createObjectURL(p.file));
  return urls.get(p.id);
};
const remake = (changes) => normalize({ ...setup, ...changes, mode: pending().mode });
// In single-photo mode: the photos, or the front view if you picked 4 views for an engine that takes one.
const singlePhotos = () => (pending().mode === 'views' ? [pending().views.front].filter(Boolean) : pending().photos);
const jobCount = () => (setup.mode === 'views' ? (pending().views.front ? 1 : 0) : Math.min(singlePhotos().length, model ? 1 : Infinity));

export function mount(el, { id }) {
  root = el;
  model = id ? findModel(id) : null;
  const p = pending();
  if (!model && p.modelId) Object.assign(p, { photos: [], views: {}, modelId: null, setup: null }); // left a regeneration
  p.mode ||= 'single';
  const provider = state.settings?.provider || 'tripo';
  try { setup = normalize({ ...(model && p.setup?.engine ? p.setup : savedSetup(provider)), mode: p.mode }); } catch { setup = presetConfig(provider, 'balanced', p.mode); }
  openGroup = null;
  el.innerHTML = `
  <section class="setup">
    <div class="su-left" id="suLeft"></div>
    <aside class="su-panel glass" aria-label="Generation setup">
      <div class="su-scroll" id="suPanel"></div>
      <div class="foot" id="suFoot"></div>
    </aside>
    <input type="file" id="suPick" accept="image/png,image/jpeg,image/heic,image/heif,.heic,.heif" multiple hidden>
  </section>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  el.addEventListener('keydown', arrowRadios); // provider, presets and segmented controls
  el.addEventListener('pointerdown', (e) => { if (e.target.matches?.('.range')) dragging = true; });
  el.addEventListener('pointerup', () => { dragging = false; });
  el.addEventListener('dragover', (e) => {
    const zone = e.target.closest('[data-drop], [data-slot]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('hot');
  });
  el.addEventListener('dragleave', (e) => e.target.closest?.('[data-drop], [data-slot]')?.classList.remove('hot'));
  el.addEventListener('drop', (e) => {
    const zone = e.target.closest('[data-drop], [data-slot]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('hot');
    addPhotos(e.dataTransfer.files, zone.dataset.slot);
  });
  render();
  if (!accountOf(setup.provider)) refreshAccount(setup.provider);
}

export function unmount() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

export function update() { render(); }

function render() {
  if (!root?.isConnected) return;
  if (model && pending().photos.length > 1) pending().photos = pending().photos.slice(-1); // one photo per regeneration
  put('#suLeft', leftHtml());
  if (!dragging) put('#suPanel', panelHtml());
  put('#suFoot', footHtml());
  const main = $('#suMain', root);
  if (main) main.onload = () => { const d = $('#suDims', root); if (d) d.textContent = ` · ${main.naturalWidth} × ${main.naturalHeight}`; };
}

// Replaces a part of the screen only when it changed, and keeps keyboard focus on the same control.
function put(selector, html) {
  const box = $(selector, root);
  if (box.dataset.html === html) return;
  const fk = box.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  box.dataset.html = html;
  box.innerHTML = html;
  if (fk) box.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus();
}

// ---- left: the photos ----
function leftHtml() {
  const p = pending();
  const e = ENGINES[setup.engine];
  const views = setup.mode === 'views';
  const photos = singlePhotos();
  const title = model ? `Regenerate ${esc(model.name)}` : !views && photos.length > 1 ? `Set up ${photos.length} models` : 'Set up this model';
  const lede = !views && photos.length > 1 && !model ? 'Each photo becomes its own model, all with the setup on the right.'
    : 'Choose a preset. Open a group only if you want to change something.';
  let stage;
  if (views) {
    stage = `<div class="su-views">${VIEWS.map((v) => {
      const ph = p.views[v];
      if (ph) {
        return `<div class="slot full" data-slot="${v}"><img src="${photoUrl(ph)}" alt="${VIEW_NAMES[v]} view: ${esc(ph.name)}"><span class="sl-name">${VIEW_NAMES[v]}</span>
          <button class="sl-x" type="button" data-unslot="${v}" aria-label="Remove the ${v} view">${icon('close', 14)}</button></div>`;
      }
      return `<button class="slot empty" type="button" data-slot="${v}" data-pickslot="${v}">${icon('plus', 20)}<span class="sl-name">${VIEW_NAMES[v]}${v === 'front' ? ' · required' : ''}</span><span class="sl-hint">Drop or choose a photo</span></button>`;
    }).join('')}</div>`;
  } else if (photos.length) {
    stage = `<div class="su-photo" data-drop><img id="suMain" src="${photoUrl(photos[0])}" alt="${esc(photos[0].name)}"></div>
      ${photos.length > 1 ? `<div class="su-strip">${photos.map((ph) => `<div class="st-item"><img src="${photoUrl(ph)}" alt="${esc(ph.name)}">
        <button class="sl-x" type="button" data-unphoto="${ph.id}" aria-label="Remove ${esc(ph.name)}">${icon('close', 12)}</button></div>`).join('')}</div>` : ''}`;
  } else {
    stage = `<button class="su-photo su-empty" type="button" data-act="add" data-drop>${icon('upload', 30)}<b>Drop a photo here or choose one</b><span>PNG, JPEG or HEIC · up to 20 MB · one clear subject</span></button>`;
  }
  const filled = VIEWS.filter((v) => p.views[v]).length;
  const info = views ? `<span><b>${filled} of 4 views</b> · ${VIEWS.filter((v) => p.views[v]).join(', ') || 'front first'}</span>`
    : photos.length ? `<span><b>${esc(photos[0].file.name)}</b><span id="suDims"></span>${photos.length > 1 ? ` · ${photos.length} photos` : ''}</span>` : '<span></span>';
  const more = views || !photos.length ? '' : `<button class="link" type="button" data-act="add">${model ? 'Use another photo' : 'Add photos'}</button>`;
  const toggle = !e.views
    ? `<span class="muted">${p.mode === 'views' ? `${esc(e.label)} takes one photo: only the front view is sent` : `${esc(e.label)} takes one photo`}</span>`
    : `<button class="link" type="button" data-act="mode">${views ? 'Back to single photo' : 'Single photo · switch to 4 views'}</button>`;
  return `<h1 class="sh">${title}</h1><p class="lede">${lede}</p>${stage}<div class="su-cap">${info}<span class="su-acts">${more}${toggle}</span></div>`;
}

function addPhotos(files, slot) {
  const p = pending();
  if (!slot) return addFiles(files); // fills empty view slots in 4-view mode, or adds photos
  const photos = takePhotos(files);
  if (!photos.length) return;
  p.views[slot] = photos.shift();
  for (const ph of photos) { const free = VIEWS.find((v) => !p.views[v]); if (free) p.views[free] = ph; }
  render();
}

function pick(slot = '') {
  const input = $('#suPick', root);
  input.dataset.slot = slot;
  input.multiple = !slot;
  input.click();
}

// ---- right: provider, presets, groups ----
const radio = (on, attrs, inner, cls = '') => `<button type="button" role="radio" class="${cls}${on ? ' on' : ''}" aria-checked="${on}" tabindex="${on ? 0 : -1}" ${attrs}>${inner}</button>`;
const plain = (html) => html.replace(/<[^>]+>/g, '');
const info = (html) => `<button type="button" class="info" aria-label="${esc(plain(html))}">i<span class="tipbox" aria-hidden="true">${html}</span></button>`;
const row = (id, label, control, tip = '') => `<div class="r"><div class="l"><span id="su-l-${id}">${label}</span>${tip}</div><div class="c">${control}</div></div>`;

function panelHtml() {
  const provider = setup.provider;
  const current = matchPreset(setup);
  const presets = PRESETS[provider].map((x) => ({ ...x, credits: estimate(presetConfig(provider, x.id, pending().mode)).credits }));
  presets.push({ id: 'custom', name: 'Custom', desc: 'Your own mix', credits: current === 'custom' ? estimate(setup).credits : '—' });
  return `
    <div class="prov" role="radiogroup" aria-label="Provider">${Object.entries(PROVIDERS).map(([id, p]) => radio(id === provider, `data-provider="${id}" data-fk="prov:${id}"`, `<b>${p.name}</b><span>${p.sub}</span>`)).join('')}</div>
    <h2 class="k" id="suPresetK">Preset</h2>
    <div class="presets" role="radiogroup" aria-labelledby="suPresetK">${presets.map((x) => radio(x.id === current, `data-preset="${x.id}" data-fk="pre:${x.id}"`,
      `<b>${x.name}</b><p>${x.desc}</p><em>${x.credits}${typeof x.credits === 'number' ? '<span class="sr-only"> credits</span>' : ''}</em>`, 'pre')).join('')}</div>
    <h2 class="k">Fine-tune</h2>
    <div class="groups">${GROUPS.map(groupHtml).join('')}</div>`;
}

function groupHtml(g) {
  const rows = rowsOf(g);
  const name = groupName(g, setup.provider);
  const text = esc(summary(setup, g));
  if (!rows.length) return `<div class="g"><div class="gh static"><b>${name}</b><span>${text}</span><i></i></div></div>`;
  const open = openGroup === g;
  return `<div class="g${open ? ' open' : ''}">
    <button class="gh" type="button" aria-expanded="${open}" aria-controls="su-g-${g}" data-group="${g}" data-fk="g:${g}"><b>${name}</b><span>${open ? '' : text}</span><i>${icon(open ? 'chevronUp' : 'chevronDown', 14)}</i></button>
    <div class="rows" id="su-g-${g}" role="group" aria-label="${name}"${open ? '' : ' hidden'}>${rows.join('')}</div></div>`;
}

function rowsOf(g) {
  const e = ENGINES[setup.engine];
  const rows = [];
  if (g === 'quality' && e.provider === '3daistudio') {
    rows.push(row('engine', 'Engine', `<select class="selc" aria-labelledby="su-l-engine" data-engine data-fk="engine">${engineList('3daistudio')
      .map((id) => `<option value="${id}"${id === setup.engine ? ' selected' : ''}>${esc(ENGINES[id].label)}</option>`).join('')}</select>`));
  }
  if (g === 'input') rows.push(modeRow(e));
  for (const spec of optionSpecs(setup.engine)) if (spec.group === g && spec.key in setup.options) rows.push(optionRow(spec));
  return rows;
}

function modeRow(e) {
  if (!e.views) {
    return row('mode', 'Photos', '<span class="static">Single photo</span>', info(e.provider === 'tripo'
      ? 'Flatform sends Tripo direct one photo. For 2–4 views of the same car, use a 3D AI Studio engine.' : `${esc(e.label)} builds the model from one photo.`));
  }
  const views = setup.mode === 'views';
  const tip = e.viewsPlus ? `2–4 views add ${e.viewsPlus} credits.` : setup.engine.startsWith('tripo-') ? 'Same price. Tripo reads the views in order: front, left, back, right.' : 'Same price with 2–4 views.';
  return row('mode', 'Photos', `<div class="segc" role="radiogroup" aria-labelledby="su-l-mode">${[['single', 'Single photo'], ['views', '4 views']]
    .map(([m, label]) => radio((m === 'views') === views, `data-mode="${m}" data-fk="mode:${m}"`, label)).join('')}</div>`, info(tip));
}

function optionRow(spec) {
  const o = setup.options;
  const k = spec.key;
  const v = o[k];
  const off = spec.off?.(o);
  const labelled = `aria-labelledby="su-l-${k}"`;
  let control = '';
  if (spec.type === 'seg') {
    control = `<div class="segc" role="radiogroup" ${labelled}>${valuesOf(spec, o).map((val) => radio(val[0] === v,
      `data-key="${k}" data-value="${esc(JSON.stringify(val[0]))}" data-fk="${k}:${esc(String(val[0]))}"`, esc(valueLabel(spec, val)))).join('')}</div>`;
  } else if (spec.type === 'select') {
    const values = valuesOf(spec, o).some(([x]) => x === v) ? valuesOf(spec, o) : [[v, v], ...valuesOf(spec, o)];
    control = `<select class="selc" ${labelled} data-key="${k}" data-fk="${k}">${values.map(([x, label]) => `<option value="${esc(JSON.stringify(x))}"${x === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  } else if (spec.type === 'toggle') {
    control = `<span class="tgc"><input type="checkbox" role="switch" class="sw" ${labelled} data-key="${k}" data-fk="${k}"${v ? ' checked' : ''}${off ? ' disabled' : ''}></span>`;
  } else if (spec.type === 'slider') {
    control = slider(spec, v);
  } else if (spec.type === 'seed') {
    control = `<input type="number" class="seedin" ${labelled} data-key="${k}" data-fk="${k}" min="0" max="2147483647" step="1" placeholder="Random" value="${v ?? ''}">`;
  }
  const label = `${spec.label}${spec.plus ? ` <em class="plus">+${spec.plus}</em>` : ''}`;
  return row(k, label, control, off || spec.info ? info(off || spec.info) : '');
}

// Sliders over wide ranges (face counts) move on a log scale and snap to two significant digits. The far left of
// an optional one is "Adaptive" (the engine decides).
function slider(spec, v) {
  const [min, max] = spec.range(setup.options);
  const lo = spec.log ? (spec.auto ? 0 : 1) : min;
  const hi = spec.log ? 1000 : max;
  const pos = !spec.log ? v : v == null ? 0 : Math.round(1 + (999 * Math.log(v / min)) / Math.log(max / min));
  const text = v == null ? spec.auto : spec.format(v);
  return `<div class="slc"><input type="range" class="range" aria-labelledby="su-l-${spec.key}" data-key="${spec.key}" data-fk="${spec.key}" min="${lo}" max="${hi}" step="${spec.log ? 1 : spec.step || 1}"
    value="${pos}" style="--p:${((pos - lo) / (hi - lo)) * 100}%" aria-valuetext="${esc(text)}"><output>${esc(text)}</output></div>`;
}
function sliderValue(spec, input) {
  const [min, max] = spec.range(setup.options);
  const pos = Number(input.value);
  if (!spec.log) return pos;
  if (pos === 0 && spec.auto) return null;
  const raw = min * (max / min) ** ((pos - 1) / 999);
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1);
  return Math.min(max, Math.max(min, Math.round(raw / unit) * unit));
}

// ---- footer: one cost line and Generate ----
function footHtml() {
  const provider = setup.provider;
  const p = pending();
  const each = estimate(setup).credits;
  const n = jobCount();
  const total = each * Math.max(1, n);
  const a = accountOf(provider);
  if (PROVIDERS[provider].local) { // free: no key, no balance
    const why = !n ? (setup.mode === 'views' ? 'Add the front view' : 'Add a photo') : setup.mode === 'views' && VIEWS.filter((v) => p.views[v]).length < 2 ? 'Add at least one more view' : '';
    const line = [n > 1 && `${n} models`, why, a && !a.ready && 'one-time download needed, see Settings', 'runs on your graphics card'].filter(Boolean).join(' · ');
    return `<div class="cost" role="status"><b>Free</b><span>${esc(line)}</span></div><button class="btn pri gen" type="button" data-act="generate"${why ? ' disabled' : ''}>Generate</button>`;
  }
  const noKey = state.settings?.keys?.[provider] === 'none' || a?.hasKey === false;
  const balance = a?.hasKey && a.balance != null ? Number(a.balance) : null;
  const short = balance != null && balance < total;
  const why = !n ? (setup.mode === 'views' ? 'Add the front view' : 'Add a photo') : setup.mode === 'views' && VIEWS.filter((v) => p.views[v]).length < 2 ? 'Add at least one more view' : '';
  const line = [
    n > 1 && `${n} models × ${each}`,
    why,
    noKey ? `no ${PROVIDERS[provider].name} key yet` : a?.error ? 'balance unavailable' : balance != null ? `${short ? 'not enough · ' : ''}balance ${fmtBalance(balance)}` : 'balance …',
  ].filter(Boolean).join(' · ');
  const button = noKey ? `<button class="btn pri gen" type="button" data-act="key">${icon('key')}<span>Add key</span></button>`
    : `<button class="btn pri gen" type="button" data-act="generate"${why ? ' disabled' : ''}>Generate</button>`; // short: Generate asks first
  return `<div class="cost" role="status"><b>${total} credits</b><span class="${short ? 'bad' : ''}">${esc(line)}</span></div>${button}`;
}

// ---- events ----
async function onClick(e) {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.provider) return switchProvider(d.provider);
  if (d.preset) {
    if (d.preset === 'custom') openGroup = 'quality';
    else setup = presetConfig(setup.provider, d.preset, pending().mode);
    return render();
  }
  if (d.group) { openGroup = openGroup === d.group ? null : d.group; return render(); }
  if (d.key && d.value !== undefined) { setup = remake({ options: { ...setup.options, [d.key]: JSON.parse(d.value) } }); return render(); }
  if (d.mode) return setMode(d.mode);
  if (d.act === 'mode') return setMode(setup.mode === 'views' ? 'single' : 'views');
  if (d.act === 'add') return pick();
  if (d.pickslot) return pick(d.pickslot);
  if (d.unslot) { delete pending().views[d.unslot]; return render(); }
  if (d.unphoto) { pending().photos = pending().photos.filter((p) => p.id !== d.unphoto); return render(); }
  if (d.act === 'key') return openKeyDialog(setup.provider);
  if (d.act === 'generate') return busy(t, generate);
}

function onChange(e) {
  const t = e.target;
  if (t.id === 'suPick') {
    if (t.files.length) addPhotos(t.files, t.dataset.slot);
    t.value = '';
    return;
  }
  if (t.dataset.engine !== undefined) { setup = normalize({ provider: setup.provider, engine: t.value, mode: pending().mode, options: setup.options }); return render(); }
  const k = t.dataset.key;
  if (!k) return;
  let v;
  if (t.type === 'checkbox') v = t.checked;
  else if (t.tagName === 'SELECT') v = JSON.parse(t.value);
  else if (t.type === 'number') v = t.value === '' ? null : Number(t.value);
  else if (t.type === 'range') { dragging = false; v = setup.options[k]; } // already set while dragging
  setup = remake({ options: { ...setup.options, [k]: v } });
  render();
}

// Sliders update their readout while dragging; nothing else depends on them.
function onInput(e) {
  const t = e.target;
  if (t.type !== 'range') return;
  const spec = optionSpecs(setup.engine).find((s) => s.key === t.dataset.key);
  const v = sliderValue(spec, t);
  setup.options[spec.key] = v;
  const text = v == null ? spec.auto : spec.format(v);
  t.nextElementSibling.textContent = text;
  t.setAttribute('aria-valuetext', text);
  t.style.setProperty('--p', `${((t.value - t.min) / (t.max - t.min)) * 100}%`);
}

async function switchProvider(provider) {
  if (provider === setup.provider) return;
  setup = normalize({ ...savedSetup(provider), mode: pending().mode });
  openGroup = null;
  render();
  if (!accountOf(provider)) refreshAccount(provider);
  try { state.settings = await send('/api/settings', 'POST', { provider }); refresh(); } catch (err) { toast(err.message); } // remembered for next time
}

function setMode(mode) {
  const p = pending();
  if (mode === p.mode) return;
  if (mode === 'views') { for (const v of VIEWS) if (!p.views[v] && p.photos.length) p.views[v] = p.photos.shift(); } // photos fill the slots in order
  else if (!p.photos.length && p.views.front) p.photos = [p.views.front];
  p.mode = mode;
  setup = remake({});
  render();
}

async function generate() {
  const p = pending();
  const s = setup;
  const jobs = s.mode === 'views'
    ? [{ name: p.views.front.name, setup: s, files: Object.fromEntries(VIEWS.filter((v) => p.views[v]).map((v) => [v, p.views[v]])) }]
    : singlePhotos().map((ph) => ({ name: ph.name, setup: s, files: { front: ph } }));
  if (!jobs.length) return;
  if (model) {
    jobs.length = 1;
    Object.assign(jobs[0], { name: model.name, modelId: model.id });
  }
  // More than the balance: the provider will likely refuse it, but the balance may be stale, so ask instead of blocking.
  const total = estimate(s).credits * jobs.length;
  const a = accountOf(s.provider);
  if (a?.balance != null && total > Number(a.balance) && !(await confirmDialog({ title: 'Not enough credits?',
    text: `This costs about ${total} credits and your ${PROVIDERS[s.provider].name} balance is ${fmtBalance(a.balance)}. Send it anyway?`, ok: 'Generate anyway' }))) return;
  rememberSetup(s).catch((err) => toast(err.message));
  Object.assign(p, { photos: [], views: {}, modelId: null, setup: null });
  jobs.forEach((job, i) => enqueue(job, i === 0));
  go(model ? `#/generate/${model.id}` : '#/generate');
}
