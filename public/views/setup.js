// 02 · Generate setup: the photos, the provider, a preset and (only if you want) the engine's own options, then
// Generate. Calm rows: a label on the left, a fixed-width control on the right. Groups stay collapsed to a one-line
// summary, one open at a time; options that don't apply to the current choices are hidden or explained by a tooltip.
import { $, esc, state, stepper, findModel, toast, go, refresh, refreshAccount, openKeyDialog, addFiles, enqueue,
  savedSetup, rememberSetup, accountOf, fmtBalance, busy, send, arrowRadios, confirmDialog } from '../app.js';
import { icon } from '../lib/icons.js';
import { PROVIDERS, ENGINES, PRESETS, VIEWS, GROUPS, groupName, normalize, presetConfig, matchPreset, summary, optionSpecs,
  valuesOf, valueLabel, engineList, customFrom, detailWarning, SMART_LOW_POLY } from '../lib/engines.js';
import { estimate } from '../lib/pricing.js';
import { ANGLES, ANGLE_NAMES, planJobs, planLine, guessPhotos } from '../lib/photo-set.js';

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
// All the photos make one model (the default), or each its own when Separate models is on (never when remaking one).
const separate = () => Boolean(pending().separate && !model);
const plan = () => planJobs(pending().photos, setup, { separate: separate() });
// The mode follows the photos: 2 or more sides sent together is 'views', else 'single'.
function syncMode() {
  const mode = plan().jobs[0]?.setup.mode || 'single';
  pending().mode = mode;
  if (setup.mode !== mode) setup = remake({});
}
// Photos the drawing kit (or an older screen) put in side slots join the list with their side already set.
function foldViews(p) {
  for (const v of VIEWS) if (p.views?.[v]) p.photos.push({ ...p.views[v], angle: v, sure: 1, angleSet: true });
  p.views = {};
}

export function mount(el, { id }) {
  root = el;
  model = id ? findModel(id) : null;
  const p = pending();
  if (!model && p.modelId) Object.assign(p, { photos: [], views: {}, modelId: null, setup: null }); // left a regeneration
  foldViews(p);
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
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.add('hot');
  });
  el.addEventListener('dragleave', (e) => e.target.closest?.('[data-drop]')?.classList.remove('hot'));
  el.addEventListener('drop', (e) => {
    const zone = e.target.closest('[data-drop]');
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove('hot');
    addFiles(e.dataTransfer.files);
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
  foldViews(pending());
  const unread = pending().photos.filter((ph) => !ph.angle && !ph.reading);
  if (unread.length) { unread.forEach((ph) => { ph.reading = true; }); guessPhotos(unread).then(() => render()); }
  syncMode();
  put('#suLeft', leftHtml());
  if (!dragging) put('#suPanel', panelHtml());
  put('#suFoot', footHtml());
  // Quad or game-ready low detail caps the detail: say so where Make 3D model is, so it is seen before paying.
  put('#suWarn', detailWarning(setup) ? `<p class="su-warn" role="status">${esc(detailWarning(setup))}</p>` : '');
  const photo = frontPhoto();
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
const byId = (id) => pending().photos.find((ph) => ph.id === id);
// The photo shown big: the one sent as the front.
function frontPhoto() {
  const j = plan().jobs[0];
  return j ? byId(j.files.front) : null;
}
const ANGLE_TIP = 'Which side of the thing this photo shows. Click to change it.';
const SEP_TIP = 'Make one model from each photo, instead of one model from all of them';

function leftHtml() {
  const photos = pending().photos;
  const n = photos.length;
  const many = n > 1 && separate();
  const title = model ? `Make ${esc(model.name)} again` : many ? `Set up ${n} models` : 'Set up this model';
  const lede = many ? 'Each photo becomes its own model, all with this recipe.'
    : n > 1 ? 'These photos show one thing from different sides. They make one model.' : 'Pick a recipe. Open a group only to change it.';
  const { jobs } = plan();
  const sent = new Set(jobs.flatMap((j) => Object.values(j.files)));
  const front = frontPhoto();
  let stage;
  if (front) {
    stage = `<div class="su-photo" data-drop><img id="suMain" src="${photoUrl(front)}" alt="${esc(front.name)}"></div>
      ${n > 1 ? `<div class="su-strip" role="list" aria-label="Your photos">${photos.map((ph) => chipCard(ph, sent.has(ph.id))).join('')}</div>` : ''}`;
  } else {
    stage = `<button class="su-photo su-empty" type="button" data-act="add" data-drop title="Pick photos of one thing. PNG, JPEG or HEIC, up to 20 MB each.">${icon('upload', 30)}<b>Add photos</b><span class="help">One thing, from 1 or more sides · up to 20 MB each</span></button>`;
  }
  const line = esc(planLine(photos, setup, { separate: separate() }));
  // Several photos: the line says where they go. One: its name and size.
  const info = line ? `<span class="su-plan" role="status">${line}</span>`
    : front ? `<span><b>${esc(front.file.name)}</b><span id="suDims"></span></span>` : '<span></span>';
  const more = !n ? '' : `<button class="link" type="button" data-act="add" title="${model ? 'Add more photos of this thing' : 'Add more photos of the same thing'}">Add photos</button>`;
  const sep = n > 1 && !model ? `<label class="sep-tg" title="${SEP_TIP}"><input type="checkbox" role="switch" class="sw" data-sep data-fk="sep"${separate() ? ' checked' : ''}><span>Separate models</span></label>` : '';
  return `<h1 class="sh">${title}</h1><p class="lede help">${lede}</p>${stage}<div class="su-cap">${info}<span class="su-acts">${more}${sep}</span></div>`;
}

// A photo in the strip: its angle chip (a menu), remove, and a note on a photo that is kept, not sent.
function chipCard(ph, isSent) {
  const angle = ph.angle || 'other';
  const kept = !isSent && !separate();
  return `<div class="st-item${kept ? ' kept' : ''}" role="listitem"><img src="${photoUrl(ph)}" alt="${esc(ph.name)}">
    <button class="sl-x" type="button" data-unphoto="${ph.id}" aria-label="Remove ${esc(ph.name)}" title="Remove this photo">${icon('close', 12)}</button>
    ${separate() ? '' : `<select class="angle" data-angle="${ph.id}" data-fk="angle:${ph.id}" title="${ANGLE_TIP}" aria-label="Side shown in ${esc(ph.name)}">${ANGLES.map((a) => `<option value="${a}"${a === angle ? ' selected' : ''}>${ANGLE_NAMES[a]}${ph.angle ? '' : '…'}</option>`).join('')}</select>`}
    ${kept ? '<span class="st-use" title="Kept with the model to compare details. Not sent, no extra cost.">Used for checking detail</span>' : ''}</div>`;
}

function pick() {
  $('#suPick', root).click();
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
  presets.push({ id: 'custom', name: 'Custom', desc: 'Your own mix', credits: current === 'custom' ? estimate(setup).credits : '' }); // priced once picked
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
    return row('mode', 'Photos', '<span class="static">One photo</span>', info(`${esc(e.label)} makes the model from one photo. With more, the clearest one is sent.`));
  }
  const tip = e.viewsPlus ? `2 to 4 sides cost ${e.viewsPlus} more credits.` : 'Same price with 2 to 4 sides.';
  return row('mode', 'Photos', '<span class="static">Up to 4 sides</span>', info(`Photos of the same thing from the front, left, back and right make one model. ${tip}`));
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
  const { jobs } = plan();
  const n = jobs.length;
  const each = estimate(jobs[0]?.setup || setup).credits; // one model's price: all the photos in one job
  const total = each * Math.max(1, n);
  const a = accountOf(provider);
  const why = n ? '' : 'Add a photo';
  if (PROVIDERS[provider].local) { // free: no key, no balance
    const line = [n > 1 && `${n} models`, why, a && !a.ready && 'needs a one-time download in Settings', 'runs on this computer'].filter(Boolean).join(' · ');
    return `<div class="cost" role="status"><b>Free</b><span>${esc(line)}</span></div><button class="btn pri gen big" type="button" data-act="generate"${why ? ' disabled' : ''} title="${why || 'Make the 3D model on this computer'}">Make 3D model</button>`;
  }
  const noKey = state.settings?.keys?.[provider] === 'none' || a?.hasKey === false;
  const balance = a?.hasKey && a.balance != null ? Number(a.balance) : null;
  const short = balance != null && balance < total;
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
  if (d.act === 'add') return pick();
  if (d.unphoto) { pending().photos = pending().photos.filter((p) => p.id !== d.unphoto); return render(); }
  if (d.act === 'key') return openKeyDialog(setup.provider);
  if (d.act === 'generate') return busy(t, generate);
}

function onChange(e) {
  const t = e.target;
  if (t.id === 'suPick') {
    if (t.files.length) addFiles(t.files);
    t.value = '';
    return;
  }
  if (t.dataset.angle) { Object.assign(byId(t.dataset.angle), { angle: t.value, sure: 1, angleSet: true }); return render(); }
  if (t.dataset.sep !== undefined) { pending().separate = t.checked; return render(); }
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

async function generate() {
  const p = pending();
  const extra = p.drawing ? { drawing: p.drawing } : {};
  const jobs = plan().jobs.map((j) => {
    const files = Object.fromEntries(Object.entries(j.files).map(([v, id]) => [v, byId(id)]));
    return { name: files.front.name, setup: j.setup, files, refs: j.refs.map(byId), ...extra };
  });
  if (!jobs.length) return;
  if (model) {
    jobs.length = 1;
    Object.assign(jobs[0], { name: model.name, modelId: model.id });
  }
  const s = jobs[0].setup;
  // More than the balance: the provider will likely refuse it, but the balance may be stale, so ask instead of blocking.
  const total = estimate(s).credits * jobs.length; // every job has the same recipe and photo count rules
  const a = accountOf(s.provider);
  if (a?.balance != null && total > Number(a.balance) && !(await confirmDialog({ title: 'Not enough credits?',
    text: `This costs about ${total} credits. You have ${fmtBalance(a.balance)} with ${PROVIDERS[s.provider].name}. Send it anyway?`, ok: 'Send anyway' }))) return;
  rememberSetup(s).catch((err) => toast(err.message));
  Object.assign(p, { photos: [], views: {}, modelId: null, setup: null, drawing: null, separate: false });
  jobs.forEach((job, i) => enqueue(job, i === 0));
  go(model ? `#/generate/${model.id}` : '#/generate');
}
