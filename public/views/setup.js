// 02 · Generate setup: the photos, the provider, a preset and (only if you want) the engine's own options, then
// Generate. Calm rows: a label on the left, a fixed-width control on the right. Groups stay collapsed to a one-line
// summary, one open at a time; options that don't apply to the current choices are hidden or explained by a tooltip.
import { $, esc, state, stepper, findModel, toast, go, refresh, refreshAccount, openKeyDialog, takePhotos, addFiles, enqueue,
  savedSetup, rememberSetup, accountOf, fmtBalance, busy, send, arrowRadios, confirmDialog } from '../app.js';
import { icon } from '../lib/icons.js';
import { PROVIDERS, ENGINES, PRESETS, VIEWS, GROUPS, groupName, normalize, presetConfig, matchPreset, summary, optionSpecs,
  valuesOf, valueLabel, engineList, customFrom, detailWarning, SMART_LOW_POLY } from '../lib/engines.js';
import { estimate } from '../lib/pricing.js';

const VIEW_NAMES = { front: 'Front', left: 'Left', back: 'Back', right: 'Right' };
// The hover tip of each Recipe option, in plain words (option keys are the engines' own names).
const TIPS = {
  model: 'Which Tripo version makes the model', geometry_quality: 'How much shape detail. Ultra costs more.',
  texture: 'Paint: none, one plain color, or real metal and shine', texture_quality: 'How sharp the paint is',
  texture_model: 'Which paint version Tripo uses', lighting_removal: "Take the photo's shadows off the paint",
  texture_alignment: 'Line the paint up with the photo or the shape', enable_image_autofix: 'Let the engine tidy the photo first',
  face_limit: 'How many pieces make the model. More is finer.', face_count: 'How many pieces make the model. More is finer.',
  decimation_target: 'How many pieces make the model. More is finer.', quad: 'Build it from square pieces, easier to edit',
  smart_low_poly: 'Fewer, cleaner pieces for games: 500 to 10,000', generate_parts: 'Split the model into parts you can move',
  auto_size: 'Make it its real size', export_uv: 'Keep the paint map in the file', compress: 'Make the file smaller',
  model_seed: 'Use the same number to get the same shape again', texture_seed: 'Use the same number to get the same paint again',
  seed: 'Use the same number to get the same result again', texture_size: 'Paint picture size. Bigger is sharper.',
  steps: 'More passes look better but take longer', simplify: 'How much detail to remove', detail_boost: 'A free extra pass for sharper detail',
  generate_type: 'What to make', enable_pbr: 'Add real metal and shine', polygon_type: 'Make it from triangles or squares',
  resolution: 'How fine the model is', textures: 'Paint the model', generate_thumbnail: 'Also make a small preview picture',
  shading: 'How much photo lighting to remove',
};
const tipOf = (spec) => esc(TIPS[spec.key] || spec.label);
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
  <section class="setup v3">
    <aside class="su-panel card" aria-labelledby="suRecipe">
      <h2 class="su-title" id="suRecipe">Recipe</h2>
      <div class="su-scroll" id="suPanel"></div>
    </aside>
    <div class="su-center">
      <div class="su-left" id="suLeft"></div>
      <div class="su-ready card"><h2>Ready to build</h2><p class="muted" id="suReadyLine"></p><div id="suWarn"></div><div class="foot" id="suFoot"></div></div>
    </div>
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
  // Quad or game-ready low detail caps the detail: say so where Make 3D model is, so it is seen before paying.
  put('#suWarn', detailWarning(setup) ? `<p class="su-warn" role="status">${esc(detailWarning(setup))}</p>` : '');
  const photo = setup.mode === 'views' ? pending().views.front : singlePhotos()[0];
  const preset = PRESETS[setup.provider].find((x) => x.id === matchPreset(setup))?.name || 'Custom';
  $('#suReadyLine', root).textContent = `${photo ? photo.name : 'No photo yet'} · ${preset} recipe`;
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
  const title = model ? `Make ${esc(model.name)} again` : !views && photos.length > 1 ? `Set up ${photos.length} models` : 'Set up this model';
  const lede = !views && photos.length > 1 && !model ? 'Each photo becomes its own model, all with this recipe.'
    : 'Pick a recipe. Open a group only to change it.';
  let stage;
  if (views) {
    stage = `<div class="su-views">${VIEWS.map((v) => {
      const ph = p.views[v];
      if (ph) {
        return `<div class="slot full" data-slot="${v}"><img src="${photoUrl(ph)}" alt="${VIEW_NAMES[v]} view: ${esc(ph.name)}"><span class="sl-name">${VIEW_NAMES[v]}</span>
          <button class="sl-x" type="button" data-unslot="${v}" aria-label="Remove the ${v} photo" title="Remove the ${v} photo">${icon('close', 14)}</button></div>`;
      }
      return `<button class="slot empty" type="button" data-slot="${v}" data-pickslot="${v}" title="Add the ${v} photo">${icon('plus', 20)}<span class="sl-name">${VIEW_NAMES[v]}${v === 'front' ? ' · required' : ''}</span><span class="sl-hint help">Drop or choose a photo</span></button>`;
    }).join('')}</div>`;
  } else if (photos.length) {
    stage = `<div class="su-photo" data-drop><img id="suMain" src="${photoUrl(photos[0])}" alt="${esc(photos[0].name)}"></div>
      ${photos.length > 1 ? `<div class="su-strip">${photos.map((ph) => `<div class="st-item"><img src="${photoUrl(ph)}" alt="${esc(ph.name)}">
        <button class="sl-x" type="button" data-unphoto="${ph.id}" aria-label="Remove ${esc(ph.name)}">${icon('close', 12)}</button></div>`).join('')}</div>` : ''}`;
  } else {
    stage = `<button class="su-photo su-empty" type="button" data-act="add" data-drop title="Pick a photo. PNG, JPEG or HEIC, up to 20 MB.">${icon('upload', 30)}<b>Add a photo</b><span class="help">One clear thing · up to 20 MB</span></button>`;
  }
  const filled = VIEWS.filter((v) => p.views[v]).length;
  const info = views ? `<span><b>${filled} of 4 sides</b> · ${VIEWS.filter((v) => p.views[v]).join(', ') || 'front first'}</span>`
    : photos.length ? `<span><b>${esc(photos[0].file.name)}</b><span id="suDims"></span>${photos.length > 1 ? ` · ${photos.length} photos` : ''}</span>` : '<span></span>';
  const more = views || !photos.length ? '' : `<button class="link" type="button" data-act="add" title="${model ? 'Pick a different photo' : 'Add more photos, one model each'}">${model ? 'Other photo' : 'Add photos'}</button>`;
  const toggle = !e.views
    ? `<span class="muted">${p.mode === 'views' ? `${esc(e.label)} takes one photo, so only the front is sent` : `${esc(e.label)} takes one photo`}</span>`
    : `<button class="link" type="button" data-act="mode" title="${views ? 'Use one photo' : 'Use up to 4 photos from different sides'}">${views ? 'Use one photo' : 'Use 4 sides'}</button>`;
  return `<h1 class="sh">${title}</h1><p class="lede help">${lede}</p>${stage}<div class="su-cap">${info}<span class="su-acts">${more}${toggle}</span></div>`;
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
const radio = (on, attrs, inner, cls = '', tip = '') => `<button type="button" role="radio" class="${cls}${on ? ' on' : ''}" aria-checked="${on}" tabindex="${on ? 0 : -1}" title="${tip}" ${attrs}>${inner}</button>`;
const plain = (html) => html.replace(/<[^>]+>/g, '');
const info = (html) => `<button type="button" class="info" aria-label="${esc(plain(html))}">i<span class="tipbox" aria-hidden="true">${html}</span></button>`;
const row = (id, label, control, tip = '') => `<div class="r"><div class="l"><span id="su-l-${id}">${label}</span>${tip}</div><div class="c">${control}</div></div>`;

function panelHtml() {
  const provider = setup.provider;
  const current = matchPreset(setup);
  const presets = PRESETS[provider].map((x) => ({ ...x, credits: estimate(presetConfig(provider, x.id, pending().mode)).credits }));
  presets.push({ id: 'custom', name: 'Custom', desc: 'Your own mix', credits: current === 'custom' ? estimate(setup).credits : '—' });
  return `
    <div class="prov" role="radiogroup" aria-label="Provider">${Object.entries(PROVIDERS).map(([id, p]) => radio(id === provider, `data-provider="${id}" data-fk="prov:${id}"`, `<b>${p.name}</b><span>${p.sub}</span>`, '', p.local ? 'Make it free on this computer' : `Make it with ${p.name} (uses credits)`)).join('')}</div>
    <h2 class="k" id="suPresetK">Pick a recipe</h2>
    <div class="presets" role="radiogroup" aria-labelledby="suPresetK">${presets.map((x) => radio(x.id === current, `data-preset="${x.id}" data-fk="pre:${x.id}"`,
      `<b>${x.name}</b><p>${x.desc}</p><em>${x.credits}${typeof x.credits === 'number' ? '<span class="sr-only"> credits</span>' : ''}</em>`, 'pre', esc(x.id === 'custom' ? 'Change the details yourself' : `${x.name}: ${x.desc}`))).join('')}</div>
    <h2 class="k">Change details</h2>
    <div class="groups">${GROUPS.map(groupHtml).join('')}</div>
    <h2 class="k">Clean up</h2>
    <div class="groups"><div class="g">${cleanRow()}</div></div>`;
}

// Fill small holes: an app setting (on unless turned off), done after every model is made (server.mjs cleanUp).
const FILL_TIP = 'Close small gaps and cracks in each part after the model is made. Big openings stay open.';
const cleanRow = () => row('fill', 'Fill small holes', `<span class="tgc"><input type="checkbox" role="switch" class="sw" aria-labelledby="su-l-fill" title="${FILL_TIP}" data-setting="fillHoles" data-fk="fillHoles"${state.settings?.fillHoles === false ? '' : ' checked'}></span>`, info(FILL_TIP));

function groupHtml(g) {
  const rows = rowsOf(g);
  const name = groupName(g, setup.provider);
  const text = esc(summary(setup, g));
  if (!rows.length) return `<div class="g"><div class="gh static"><b>${name}</b><span>${text}</span><i></i></div></div>`;
  const open = openGroup === g;
  return `<div class="g${open ? ' open' : ''}">
    <button class="gh" type="button" aria-expanded="${open}" aria-controls="su-g-${g}" data-group="${g}" data-fk="g:${g}" title="${open ? 'Hide' : 'Show'} the ${esc(name.toLowerCase())} choices"><b>${name}</b><span>${open ? '' : text}</span><i>${icon(open ? 'chevronUp' : 'chevronDown', 14)}</i></button>
    <div class="rows" id="su-g-${g}" role="group" aria-label="${name}"${open ? '' : ' hidden'}>${rows.join('')}</div></div>`;
}

function rowsOf(g) {
  const e = ENGINES[setup.engine];
  const rows = [];
  if (g === 'quality' && e.provider === '3daistudio') {
    rows.push(row('engine', 'Engine', `<select class="selc" aria-labelledby="su-l-engine" data-engine data-fk="engine" title="Which engine makes the model">${engineList('3daistudio')
      .map((id) => `<option value="${id}"${id === setup.engine ? ' selected' : ''}>${esc(ENGINES[id].label)}</option>`).join('')}</select>`));
  }
  if (g === 'input') rows.push(modeRow(e));
  for (const spec of optionSpecs(setup.engine)) if (spec.group === g && spec.key in setup.options) rows.push(optionRow(spec));
  return rows;
}

function modeRow(e) {
  if (!e.views) {
    return row('mode', 'Photos', '<span class="static">One photo</span>', info(e.provider === 'tripo'
      ? 'Tripo takes one photo. For 2 to 4 sides, use 3D AI Studio.' : `${esc(e.label)} makes the model from one photo.`));
  }
  const views = setup.mode === 'views';
  const tip = e.viewsPlus ? `2 to 4 sides cost ${e.viewsPlus} more credits.` : setup.engine.startsWith('tripo-') ? 'Same price. Order: front, left, back, right.' : 'Same price with 2 to 4 sides.';
  return row('mode', 'Photos', `<div class="segc" role="radiogroup" aria-labelledby="su-l-mode">${[['single', 'One photo'], ['views', '4 sides']]
    .map(([m, label]) => radio((m === 'views') === views, `data-mode="${m}" data-fk="mode:${m}"`, label, '', m === 'views' ? 'Up to 4 photos from different sides' : 'One photo')).join('')}</div>`, info(tip));
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
      `data-key="${k}" data-value="${esc(JSON.stringify(val[0]))}" data-fk="${k}:${esc(String(val[0]))}"`, esc(valueLabel(spec, val)), '', tipOf(spec))).join('')}</div>`;
  } else if (spec.type === 'select') {
    const values = valuesOf(spec, o).some(([x]) => x === v) ? valuesOf(spec, o) : [[v, v], ...valuesOf(spec, o)];
    control = `<select class="selc" ${labelled} data-key="${k}" data-fk="${k}" title="${tipOf(spec)}">${values.map(([x, label]) => `<option value="${esc(JSON.stringify(x))}"${x === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  } else if (spec.type === 'toggle') {
    control = `<span class="tgc"><input type="checkbox" role="switch" class="sw" ${labelled} title="${tipOf(spec)}" data-key="${k}" data-fk="${k}"${v ? ' checked' : ''}${off ? ' disabled' : ''}></span>`;
  } else if (spec.type === 'slider') {
    control = slider(spec, v);
  } else if (spec.type === 'seed') {
    control = `<input type="number" class="seedin" ${labelled} title="${tipOf(spec)}" data-key="${k}" data-fk="${k}" min="0" max="2147483647" step="1" placeholder="Random" value="${v ?? ''}">`;
  }
  const label = `${spec.label}${spec.plus ? ` <em class="plus">+${spec.plus}</em>` : ''}`;
  return row(k, label, control, off || spec.info ? info(off || spec.info) : '');
}

// Sliders over wide ranges (face counts) move on a log scale and snap to two significant digits. The far left of
// an optional one is "Adaptive" (the engine decides).
const autoOf = (spec) => spec.auto && !spec.noAuto?.(setup.options); // smart low poly: no Adaptive end
function slider(spec, v) {
  const [min, max] = spec.range(setup.options);
  const lo = spec.log ? (autoOf(spec) ? 0 : 1) : min;
  const hi = spec.log ? 1000 : max;
  const pos = !spec.log ? v : v == null ? 0 : Math.round(1 + (999 * Math.log(v / min)) / Math.log(max / min));
  const text = v == null ? spec.auto : spec.format(v);
  return `<div class="slc"><input type="range" class="range" aria-labelledby="su-l-${spec.key}" title="${tipOf(spec)}" data-key="${spec.key}" data-fk="${spec.key}" min="${lo}" max="${hi}" step="${spec.log ? 1 : spec.step || 1}"
    value="${pos}" style="--p:${((pos - lo) / (hi - lo)) * 100}%" aria-valuetext="${esc(text)}"><output>${esc(text)}</output>
    <span class="sl-ends" aria-hidden="true"><span>${esc(autoOf(spec) ? spec.auto : spec.format(min))}</span><span>${esc(spec.format(max))}</span></span></div>`;
}
function sliderValue(spec, input) {
  const [min, max] = spec.range(setup.options);
  const pos = Number(input.value);
  if (!spec.log) return pos;
  if (pos === 0 && autoOf(spec)) return null;
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
    const why = !n ? (setup.mode === 'views' ? 'Add the front photo' : 'Add a photo') : setup.mode === 'views' && VIEWS.filter((v) => p.views[v]).length < 2 ? 'Add one more side' : '';
    const line = [n > 1 && `${n} models`, why, a && !a.ready && 'needs a one-time download in Settings', 'runs on this computer'].filter(Boolean).join(' · ');
    return `<div class="cost" role="status"><b>Free</b><span>${esc(line)}</span></div><button class="btn pri gen big" type="button" data-act="generate"${why ? ' disabled' : ''} title="${why || 'Make the 3D model on this computer'}">Make 3D model</button>`;
  }
  const noKey = state.settings?.keys?.[provider] === 'none' || a?.hasKey === false;
  const balance = a?.hasKey && a.balance != null ? Number(a.balance) : null;
  const short = balance != null && balance < total;
  const why = !n ? (setup.mode === 'views' ? 'Add the front photo' : 'Add a photo') : setup.mode === 'views' && VIEWS.filter((v) => p.views[v]).length < 2 ? 'Add one more side' : '';
  const line = [
    n > 1 && `${n} models × ${each}`,
    why,
    noKey ? `no ${PROVIDERS[provider].name} key yet` : a?.error ? "can't check your credits" : balance != null ? `${short ? 'not enough · ' : ''}you have ${fmtBalance(balance)}` : 'checking credits…',
  ].filter(Boolean).join(' · ');
  const button = noKey ? `<button class="btn pri gen big" type="button" data-act="key" title="Connect your account first. It takes a minute.">${icon('key')}<span>Add key</span></button>`
    : `<button class="btn pri gen big" type="button" data-act="generate"${why ? ' disabled' : ''} title="${why || 'Send the photo and recipe to make the 3D model'}">Make 3D model</button>`; // short: Generate asks first
  return `<div class="cost" role="status"><b>${total} credits</b><span class="${short ? 'bad' : ''}">${esc(line)}</span></div>${button}`;
}

// ---- events ----
async function onClick(e) {
  const t = e.target.closest('button');
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.provider) return switchProvider(d.provider);
  if (d.preset) {
    if (d.preset === 'custom') { openGroup = 'quality'; if (matchPreset(setup) !== 'custom') setup = customFrom(setup); }
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
  if (t.dataset.setting === 'fillHoles') {
    send('/api/settings', 'POST', { fillHoles: t.checked }).then((s) => { state.settings = s; }, (err) => { toast(err.message); t.checked = !t.checked; });
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
  const faces = k === 'smart_low_poly' && v ? { face_limit: SMART_LOW_POLY.default } : {}; // turned on: 5,000 pieces
  setup = remake({ options: { ...setup.options, [k]: v, ...faces } });
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
    ? [{ name: p.views.front.name, setup: s, files: Object.fromEntries(VIEWS.filter((v) => p.views[v]).map((v) => [v, p.views[v]])), ...(p.drawing && { drawing: p.drawing }) }]
    : singlePhotos().map((ph) => ({ name: ph.name, setup: s, files: { front: ph }, ...(p.drawing && { drawing: p.drawing }) }));
  if (!jobs.length) return;
  if (model) {
    jobs.length = 1;
    Object.assign(jobs[0], { name: model.name, modelId: model.id });
  }
  // More than the balance: the provider will likely refuse it, but the balance may be stale, so ask instead of blocking.
  const total = estimate(s).credits * jobs.length;
  const a = accountOf(s.provider);
  if (a?.balance != null && total > Number(a.balance) && !(await confirmDialog({ title: 'Not enough credits?',
    text: `This costs about ${total} credits. You have ${fmtBalance(a.balance)} with ${PROVIDERS[s.provider].name}. Send it anyway?`, ok: 'Send anyway' }))) return;
  rememberSetup(s).catch((err) => toast(err.message));
  Object.assign(p, { photos: [], views: {}, modelId: null, setup: null, drawing: null });
  jobs.forEach((job, i) => enqueue(job, i === 0));
  go(model ? `#/generate/${model.id}` : '#/generate');
}
