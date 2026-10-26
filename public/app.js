// Flatform front end: shared state, API calls, routing, the window frame and the upload queue.
// Each screen is a module in views/ with mount(el, params), and optionally update() and unmount().
import { icon } from './lib/icons.js';
import { applyTheme } from './lib/theme.js';
import { PROVIDERS, ENGINES, VIEWS, normalize, presetConfig, matchPreset, PRESETS } from './lib/engines.js';
import { estimate } from './lib/pricing.js';
import { isModelFile, importModel } from './lib/importer.js';
import { installHotkeys, loadKeys } from './lib/hotkeys.js';
import { SHORTCUTS, worksOn, keyOf } from './lib/shortcuts.js';
import { blenderLight, accountLight } from './lib/render-status.js';
import { installPalette } from './lib/palette.js';
import { timeAgo } from './lib/session.js';
import { displayVersion } from './lib/version.js';
import { journey, dockFor, stepOf, isSheet, SHEETS, DEFAULT_TOOL, ringDash } from './lib/stage.js';
import { updateNotice, lowNotice } from './lib/notices.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fileUrl = (m, f) => `/files/${m.id}/${encodeURIComponent(f)}`;
export const MAX_PHOTO = 20 * 1024 * 1024;
export const FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'];

export const state = {
  models: [], // the library, newest first
  accounts: {}, // provider → { hasKey, balance, frozen, rateLimit } or { error }
  settings: null, // non-secret settings + version, paths, which keys are set
  blender: null, // { found, path }
  update: null, // the server's last update check: { current, latest, newer, skipped, notes, downloadUrl, checkedAt, failed, … }
  queue: [], // jobs waiting in Flatform's own upload queue (not sent to a provider yet)
  pending: { photos: [], views: {}, modelId: null }, // photos waiting on the setup screen for Generate
  frames: {}, // composer turntable frame per model, so "Render still" uses the current angle
  lastId: null, // model last opened in a flow screen
  spend: null, // GET /api/spend: totals, daily series, per-model costs, balances and low-balance flags per provider
  workspace: 'car', // 'car' or 'warframe': stamped on models created or imported from a home screen
  recents: [], // the last few scenes worked on, newest first: [{ id, at, frame }] (session.mjs)
  mode: localStorage.getItem('flatform.mode') === 'warframe' ? 'warframe' : 'car', // the Car / Warframe switch in the top bar
  tool: { ...DEFAULT_TOOL }, // the dock tool picked in each step
  humanoid: false, // the model in Scene has a skeleton: the dock shows Pose instead of Car parts
};
state.workspace = state.mode;

export async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
export const send = (path, method, data) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// actions: [{ label, title, run }] buttons after the message (the "render done" toast has Open and Show in folder).
// kind: 'error', 'info' or 'ok' (a green border and a check that draws itself). Toasts stack under the top bar.
export function toast(msg, kind = 'error', actions = []) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast t-${kind}`;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  if (kind === 'ok') t.insertAdjacentHTML('beforeend', '<svg class="tcheck" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l5 5L20 6"/></svg>');
  t.append(Object.assign(document.createElement('span'), { textContent: msg }));
  const kill = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
  for (const a of actions) {
    const b = document.createElement('button');
    Object.assign(b, { type: 'button', className: 'btn sm ghostbtn', textContent: a.label, title: a.title || a.label });
    b.addEventListener('click', () => { kill(); a.run(); });
    t.append(b);
  }
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(kill, kind === 'ok' ? 8000 : actions.length ? 15000 : kind === 'info' ? 4000 : 6000);
}
export const announce = (msg) => { $('#live').textContent = msg; };

// Custom confirm (window.confirm can't be styled and blocks the app).
export function confirmDialog({ title, text, ok = 'Delete' }) {
  const d = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = ok;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

// ---- models ----
export const findModel = (id) => state.models.find((m) => m.id === id);
export function upsert(m) {
  const i = state.models.findIndex((x) => x.id === m.id);
  if (i >= 0) state.models[i] = m;
  else state.models.unshift(m);
  return m;
}
export const isGenerating = (m) => m.versions?.some((v) => v.status === 'generating');
// The turntables a model has been rendered as, in any look: [360, 180], [180] or [].
export const renderedTurns = (m) => [360, 180].filter((t) => ['showroom', 'studio', 'transparent'].some((l) => m.renders?.[`${l}${t}`]));
export const isRendered = (m) => renderedTurns(m).length > 0;
export const thumbOf = (m, v = m) => (v === m && m.renders?.poster ? fileUrl(m, m.renders.poster) : v.thumb ? fileUrl(m, v.thumb) : v.source ? fileUrl(m, v.source) : '');
export const sourceType = (file = '') => (/\.png$/i.test(file) ? 'PNG' : 'JPEG');

// Generation stages, from the provider's job status and progress.
const STAGE_NAMES = {
  tripo: ['Uploaded to Tripo', 'Task started', 'Building geometry', 'Painting textures', 'Saving GLB to library'],
  local: ['Sent to your graphics card', 'Waiting for its turn', 'Building the shape', 'Painting textures', 'Saving GLB to library'],
  '3daistudio': ['Sent to 3D AI Studio', 'Waiting for its turn', 'Building geometry', 'Painting textures', 'Saving GLB to library'],
};
export const providerOf = (v) => (v?.provider === '3daistudio' || v?.provider === 'local' ? v.provider : 'tripo');
export const stagesOf = (v) => STAGE_NAMES[providerOf(v)];
export function stageOf(v) {
  if (v.status === 'ready') return 5;
  const [done, running] = providerOf(v) === 'tripo' ? [v.tripo_status === 'success', v.tripo_status === 'running']
    : providerOf(v) === 'local' ? [v.upstream_status === 'success', v.upstream_status === 'running']
    : [v.upstream_status === 'FINISHED', v.upstream_status === 'IN_PROGRESS'];
  if (done) return 4;
  if (running) return (v.progress || 0) < 50 ? 2 : 3;
  return 1; // queued at the provider
}
export function statusText(m) {
  if (m.status === 'ready') return 'Ready';
  if (m.status === 'spin') return m.spin ? 'Spin set from photos' : 'Photos for a spin set';
  if (m.status === 'failed') return m.error || 'Generation failed';
  if (m.note) return m.note;
  const stage = stageOf(m);
  return stage === 1 ? `Queued at ${PROVIDERS[providerOf(m)].name}` : `${stagesOf(m)[stage]} · ${m.progress || 0}%`;
}
export const statusClass = (m) => ({ ready: 'ready', spin: 'ready', failed: 'fail' })[m.status] || 'gen';
// "Tripo v3.1" or "3D AI Studio · Hitem3D 3.0", for a version (or the model's active one).
export function engineLabel(v) {
  if (providerOf(v) === 'local') return 'Local (free) · TRELLIS';
  if (providerOf(v) === 'tripo') return `Tripo ${String(v.options?.model || state.settings?.model || 'v3.1').split('-')[0]}`;
  return `3D AI Studio · ${ENGINES[v.engine]?.label || ''}`;
}

export const fmt = (n) => Math.floor(n).toLocaleString('en-US');
export const fmtBalance = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const accountOf = (provider) => state.accounts[provider] || null;
// "Balance 1,240 credits · 30 frozen." for a provider, from its own account. Never a guess.
export function creditsText(provider = state.settings?.provider || 'tripo') {
  const a = accountOf(provider);
  if (!a?.hasKey || a.balance == null) return '';
  return `${PROVIDERS[provider].name} balance ${fmtBalance(a.balance)} credits${a.frozen ? ` · ${fmt(a.frozen)} frozen` : ''}.`;
}

// ---- setups: provider, engine and options for the next generation ----
// The one the setup screen opens with, and that the quick queue uses: the last one used with that provider.
export function savedSetup(provider = state.settings?.provider || 'tripo') {
  try { return normalize({ ...state.settings?.setups?.[provider], provider }); } catch { return presetConfig(provider, 'balanced'); }
}
export function setupLabel(setup) {
  const preset = PRESETS[setup.provider].find((p) => p.id === matchPreset(setup));
  return `${PROVIDERS[setup.provider].name} · ${preset ? preset.name : `Custom · ${ENGINES[setup.engine].label}`}`;
}
export const costOf = (setup) => estimate(setup).credits;
export async function rememberSetup(setup) {
  state.settings = await send('/api/settings', 'POST', { provider: setup.provider, setups: { [setup.provider]: setup } });
}

// ---- photos, the setup screen and the upload queue ----
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/heic', 'image/heif'];
function photoType(file) {
  if (PHOTO_TYPES.includes(file.type)) return file.type;
  if (/\.(heic|heif)$/i.test(file.name)) return 'image/heic'; // Windows browsers often leave HEIC types blank
  if (/\.png$/i.test(file.name)) return 'image/png';
  if (/\.jpe?g$/i.test(file.name)) return 'image/jpeg';
  return null;
}
// The photos among picked, dropped or pasted files: [{ id, file, type, name }].
export function takePhotos(files) {
  const photos = [];
  for (const file of files) {
    const type = photoType(file);
    if (!type) { toast(`${file.name}: use a PNG, JPEG or HEIC photo`); continue; }
    if (file.size > MAX_PHOTO) { toast(`${file.name}: too large (max 20 MB)`); continue; }
    photos.push({ id: crypto.randomUUID(), file, type, name: file.name.replace(/\.[^.]+$/, '') || 'Untitled' });
  }
  return photos;
}
// New photos go to the setup screen, where you choose the provider and press Generate. In 4-view mode they fill the
// empty view slots in order. quick: straight into the queue with the last setup used (Generate screen, "drop more").
export function addFiles(files, { quick = false } = {}) {
  const list = [...files];
  const models = list.filter(isModelFile);
  if (models.length) importModels(models);
  const photos = takePhotos(list.filter((f) => !isModelFile(f)));
  if (!photos.length) return;
  if (quick) {
    const setup = normalize({ ...savedSetup(), mode: 'single' });
    for (const p of photos) enqueue({ name: p.name, setup, files: { front: p } });
    return;
  }
  const pending = state.pending;
  if (pending.modelId && route.name !== 'setup') Object.assign(pending, { photos: [], views: {}, modelId: null }); // a new model
  for (const p of photos) {
    const slot = pending.mode === 'views' && VIEWS.find((v) => !pending.views[v]);
    if (slot) pending.views[slot] = p;
    else pending.photos.push(p);
  }
  if (route.name === 'setup') refresh();
  else go('#/setup');
}
// 3D models skip Generate: each is converted to GLB in the page, saved, and the last one opens in Compose.
async function importModels(files) {
  let last;
  for (const file of files) {
    state.importing = file.name;
    announce(`Importing ${file.name}`);
    refresh();
    try { last = upsert(await importModel(file, state.workspace)); } catch (e) { toast(e.message); }
  }
  state.importing = null;
  refresh();
  if (last) { announce(`${last.name} is ready`); go(`#/compose/${last.id}`); }
}

// Regenerate a model: the setup screen with its current photos (fetched back from the library) or new ones.
export async function setupFor(m, files) {
  const v = m.versions.find((x) => x.n === m.activeVersion) || m;
  const pending = { photos: [], views: {}, modelId: m.id, mode: v.mode === 'views' && !files ? 'views' : 'single', setup: v.engine ? v : null };
  if (files) pending.photos = takePhotos(files);
  else {
    for (const [view, file] of Object.entries(v.views || { front: v.source })) {
      const blob = await (await fetch(fileUrl(m, file))).blob();
      const photo = { id: crypto.randomUUID(), file: new File([blob], file, { type: blob.type }), type: blob.type, name: m.name };
      if (pending.mode === 'views') pending.views[view] = photo;
      else pending.photos.push(photo);
    }
  }
  if (!pending.photos.length && !pending.views.front) return;
  state.pending = pending;
  go(`#/setup/${m.id}`);
}
// job: { name, setup, files: { front, left, back, right } of photos, modelId? }. open: show it once it's sent.
export function enqueue(job, open = false) {
  state.queue.push({ qid: crypto.randomUUID(), status: 'waiting', open, ...job });
  refresh();
  pump();
}
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (let item; (item = state.queue.find((q) => q.status === 'waiting'));) {
      item.status = 'uploading';
      announce(`Sending ${item.name} to ${PROVIDERS[item.setup.provider].name}`);
      refresh();
      try {
        const form = new FormData();
        form.append('name', item.name);
        form.append('setup', JSON.stringify(item.setup));
        form.append('workspace', state.workspace);
        for (const [view, p] of Object.entries(item.files)) form.append(view, new File([p.file], p.file.name || `${view}.jpg`, { type: p.type }));
        const m = upsert(await api(item.modelId ? `/api/models/${item.modelId}/versions` : '/api/models', { method: 'POST', body: form }));
        state.queue.splice(state.queue.indexOf(item), 1);
        announce(`${m.name} is generating`);
        if (item.open && (['drop', 'setup'].includes(route.name) || (route.name === 'generate' && !route.id))) go(`#/generate/${m.id}`);
        refreshAccount(item.setup.provider);
      } catch (e) {
        Object.assign(item, { status: 'error', error: e.message });
        toast(`${item.name}: ${e.message}`);
        if (/api key/i.test(e.message)) openKeyDialog(item.setup.provider);
      }
      refresh();
    }
  } finally {
    pumping = false;
  }
}
export function removeQueued(qid) {
  const i = state.queue.findIndex((q) => q.qid === qid && q.status !== 'uploading');
  if (i >= 0) state.queue.splice(i, 1);
  refresh();
}
export function retryQueued(qid) {
  const item = state.queue.find((q) => q.qid === qid);
  if (item) item.status = 'waiting';
  pump();
}
// quick: queue the photos with the last setup instead of opening the setup screen.
export function openPicker({ quick = false } = {}) {
  const picker = $('#filePicker');
  picker.dataset.quick = String(quick);
  picker.click();
}
// Arrow keys move between the options of a radio group, like native radio buttons; focus follows the choice.
export function arrowRadios(e) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const group = e.target.closest?.('[role=radiogroup]');
  const radios = group ? [...group.querySelectorAll('[role=radio]:not([disabled])')] : [];
  const i = radios.indexOf(e.target);
  if (i < 0) return;
  e.preventDefault();
  const next = radios[(i + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) + radios.length) % radios.length];
  next.focus(); // before the click, so a screen that redraws puts focus back on it
  next.click();
}
// Runs a button's action once at a time, so a double click can't start two paid jobs.
export async function busy(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); } finally { button.disabled = false; }
}
export async function retryModel(m) {
  try {
    upsert(await api(`/api/models/${m.id}/retry`, { method: 'POST' }));
    refresh();
  } catch (e) { toast(e.message); }
}

// Paste from clipboard: the button uses the async clipboard API where the browser allows it.
export async function pasteFromClipboard() {
  if (!navigator.clipboard?.read) return toast('Press Ctrl+V (⌘V on a Mac) to paste a photo', 'info');
  try {
    const files = [];
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => ['image/png', 'image/jpeg'].includes(t));
      if (type) files.push(new File([await item.getType(type)], `Pasted photo.${type === 'image/png' ? 'png' : 'jpg'}`, { type }));
    }
    if (files.length) addFiles(files);
    else toast('There is no photo on the clipboard', 'info');
  } catch {
    toast('Press Ctrl+V (⌘V on a Mac) to paste a photo', 'info');
  }
}

// ---- native helpers (Electron preload); in `npm run web` they're missing and screens show text fields ----
export const native = window.flatform;

// ---- accounts and keys ----
let keyProvider = 'tripo';
export function openKeyDialog(provider = state.settings?.provider || 'tripo') {
  keyProvider = provider;
  const p = PROVIDERS[provider];
  $('#keyTitle').textContent = provider === 'tripo' ? 'Connect your Tripo account' : 'Connect 3D AI Studio';
  $('#keyLink').href = p.keyUrl; // "Where do I find this?" opens the page that makes the key
  $('#keyLink').title = `Opens ${provider === 'tripo' ? 'developers.tripo3d.com/en/keys' : 'the 3D AI Studio dashboard'}, where you make and copy your key`;
  $('#keyTo').textContent = p.name;
  $('#keyInput').placeholder = p.keyHint || 'Paste your key';
  $('#keyError').textContent = '';
  if (!$('#keyDialog').open) $('#keyDialog').showModal();
}
// Saves a key after the provider accepted it. The page never gets a key back, only where it comes from.
export async function saveKey(provider, key) {
  const r = await send(`/api/keys/${provider}`, 'PUT', { key });
  state.settings = { ...state.settings, keys: r.keys };
  state.accounts[provider] = { hasKey: true, balance: r.balance, frozen: r.frozen, rateLimit: r.rateLimit, checkedAt: new Date().toISOString() };
  refresh();
  return state.accounts[provider];
}
let askedForKey = false;
// fresh: ask 3D AI Studio now (costs one of its 3 requests a minute) instead of its answer from the last 5 minutes.
export async function refreshAccount(provider = state.settings?.provider || 'tripo', fresh = false) {
  try {
    state.accounts[provider] = await api(`/api/account?provider=${provider}${fresh ? '&fresh' : ''}`);
    // Ask once per session; after that the rail, the setup screen and Settings show that the key is missing.
    if (!state.accounts[provider].hasKey && !askedForKey && provider === state.settings?.provider) { askedForKey = true; openKeyDialog(provider); }
  } catch (e) {
    state.accounts[provider] = { error: e.message };
  }
  refresh();
}

// ---- updates: the server asks GitHub (a few seconds after it starts, then every 6 hours); the page shows the result ----
let toldUpdate; // the version whose toast already showed this session; "Update ready" in the top bar stays until skipped
// check: ask GitHub now (Settings → Check for updates) instead of reading the server's last answer.
export async function refreshUpdate(check = false) {
  try {
    state.update = await api(check ? '/api/update/check' : '/api/update', check ? { method: 'POST' } : {});
  } catch {
    if (check) state.update = { ...state.update, failed: true };
  }
  showUpdate();
  refresh();
}
// A newer Flatform: a toast once (Download, Later, Skip this version) and an "Update" pill in the top bar that shows
// the toast again. Skip this version hides both.
function showUpdate(force = false) {
  const n = updateNotice(state.update, displayVersion);
  $('#updatePill').hidden = !n;
  if (!n) return;
  $('#updatePill .tb-l').textContent = n.pill;
  $('#updatePill').title = `${n.title}. Click to see what is new and download it.`;
  if (toldUpdate === n.version && !force) return;
  toldUpdate = n.version;
  announce(`${n.title} to download`);
  toast(`${n.title}. ${n.note}`, 'info', [
    { label: 'Download', title: 'Open the download page for the new version', run: () => window.open(state.update.downloadUrl, '_blank', 'noopener') },
    { label: 'Later', title: 'Hide this. The Update button in the top bar stays until you install it.', run: () => {} },
    { label: 'Skip this version', title: 'Do not ask about this version again', run: skipUpdate },
  ]);
}
async function skipUpdate() {
  try { state.update = await send('/api/update/skip', 'POST', { version: state.update.latest }); } catch (e) { toast(e.message); }
  showUpdate();
  refresh();
}

// ---- spend: the ledger summary (Settings → Spend) and a banner when a balance is under its alert ----
// Top up opens the provider's billing page: through main.mjs in the app, a plain new tab in `npm run web`.
export const topUp = (service) => (native?.openBilling ? native.openBilling(service).catch((e) => toast(e.message))
  : window.open(PROVIDERS[service].billingUrl, '_blank', 'noopener'));
let toldLow = false; // the low balance toast shows once per session; the account dot stays amber until topped up
export async function refreshSpend() {
  try { state.spend = await api('/api/spend'); } catch { return; }
  showLow();
  refresh();
}
function showLow(force = false) {
  const n = lowNotice(state.spend, PROVIDERS, fmt);
  if (!n || (toldLow && !force)) return n;
  toldLow = true;
  announce(n.title);
  toast(`${n.title}. ${n.note}`, 'info', [
    { label: 'Top up', title: 'Open the page where you buy more credits', run: () => topUp(n.service) },
    { label: 'Later', title: 'Hide this. The amber dot in the top bar stays until you top up.', run: () => {} },
  ]);
  return n;
}

// ---- files opened with Flatform (desktop app: "Open with", a second launch) go to the Drop flow ----
native?.onOpenFiles?.(async (paths) => {
  const files = [];
  for (const p of paths) {
    try { const { name, bytes } = await native.readDroppedFile(p); files.push(new File([bytes], name)); } catch (e) { toast(`${p}: ${e.message}`); }
  }
  if (files.length) addFiles(files); // photos to the setup screen, 3D models straight into Compose
});

// ---- the frame: the top bar, the step trail at the bottom and the tool dock on the left (lib/stage.js) ----
// The trail is drawn once for every screen, so screens no longer draw their own step tabs.
export const stepper = () => '';

export function focusModel() {
  const ready = (m) => m?.status === 'ready' && m;
  return ready(findModel(route.id)) || ready(findModel(state.lastId)) || state.models.find((m) => m.status === 'ready');
}

// Where each step of the trail goes: Photo, the 3D model being made (or set up), and the Scene and Finish of the
// model on screen (or the last ready one).
function stepHrefs() {
  const ready = focusModel();
  const here = findModel(route.id);
  const making = here && here.status !== 'ready' ? here : state.models.find(isGenerating);
  return {
    photo: '#/drop',
    model: making ? `#/generate/${making.id}` : state.pending.photos.length || state.pending.views.front ? '#/setup' : ready ? `#/generate/${ready.id}` : '#/setup',
    scene: ready ? `#/compose/${ready.id}` : '#/library',
    finish: ready ? `#/finish/${ready.id}` : '#/library',
  };
}
function renderFrame() {
  const sheet = isSheet(route.name);
  document.body.dataset.screen = route.name;
  document.body.dataset.step = stepOf(route.name) || '';
  document.body.dataset.mode = state.mode;
  document.body.toggleAttribute('data-sheet', sheet);
  $('#sheetClose').hidden = !sheet;
  if (sheet) $('#sheetClose').title = `Close ${SHEETS[route.name]} and go back (Esc)`;
  // The step trail.
  const trail = journey(route.name, stepHrefs()).map((s, i) => `${i ? '<span class="jbar" aria-hidden="true"></span>' : ''}<a class="jstep ${s.state}" href="${s.href}" title="${esc(s.tip)}"${s.state === 'current' ? ' aria-current="step"' : ''}><b aria-hidden="true">${s.state === 'done' ? icon('check', 14) : s.n}</b><span>${esc(s.label)}</span></a>`).join('');
  if ($('#journey').innerHTML !== trail) $('#journey').innerHTML = trail;
  $('#journey').hidden = route.name === 'preview';
  renderDock();
  // The Car / Warframe switch.
  $$('#modeSeg [data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)));
  // The default provider's connection, and Blender.
  const provider = state.settings?.provider || 'tripo';
  const { name } = PROVIDERS[provider];
  const a = state.accounts[provider];
  for (const [id, l, label] of [['blenderLight', blenderLight(state.blender), 'Blender · GPU'], ['accountStatus', accountLight(name, a), name]]) {
    const el = $(`#${id}`);
    el.title = `${l.text}. ${l.tip}`;
    el.setAttribute('aria-label', `${l.text}. ${l.tip}`);
    if (id === 'blenderLight' && el.dataset.busy === 'true') continue; // blinking while a render runs (setRenderLight)
    const low = id === 'accountStatus' && lowNotice(state.spend, PROVIDERS, fmt);
    if (low) { el.title = low.dot; el.setAttribute('aria-label', low.dot); }
    const html = `<span class="dot ${low ? 'low' : l.ok ? 'ok' : l.ok == null ? 'wait' : ''}"></span><span class="tb-l">${esc(label)}</span>`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  const test = Boolean(state.settings?.testMode); // Flatform Test (mock services, its own data)
  $('#testBtn').hidden = !test;
  if (test) document.title = 'Flatform Test';
  const hm = focusModel();
  $('#historyBtn').href = hm ? `#/history/${hm.id}` : '#/history';
  $('#appVersion').textContent = state.settings ? `${test ? 'Flatform Test · mocks · ' : ''}Version ${displayVersion(state.settings.version)}` : '';
}

// The dock: the tools for the step on screen. A screen with an onDock(id) handles the pick (Scene shows that tool's
// card); the others scroll to the part of the screen the tool names.
const DOCK_TARGETS = { recipe: '#suPresetK', photos: '#suLeft', check: '#health', compare: '#fCompare' };
function renderDock() {
  const step = stepOf(route.name);
  const tools = route.name === 'compose' && findModel(route.id)?.status !== 'ready' ? [] : dockFor(step, { humanoid: state.humanoid });
  const on = state.tool[step];
  const html = tools.map(([id, ic, label, tip]) => `<button class="dk" type="button" data-dock="${id}" aria-pressed="${id === on}" title="${esc(tip)}">${icon(ic, 22)}<span>${esc(label)}</span></button>`).join('');
  const dock = $('#dock');
  if (dock.innerHTML !== html) dock.innerHTML = html;
  dock.hidden = !tools.length;
}
export function pickDock(id) {
  const step = stepOf(route.name);
  if (!step) return;
  if (id === 'share' || id === 'history') { const m = focusModel(); return go(m ? `#/${id}/${m.id}` : `#/${id}`); }
  state.tool[step] = id;
  renderDock();
  if (current?.onDock) return current.onDock(id);
  if (DOCK_TARGETS[id]) $(`#view ${DOCK_TARGETS[id]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
/** Scene tells the frame whether its model has a skeleton (Pose) or not (Car parts). */
export function setHumanoid(on) {
  if (state.humanoid === on) return;
  state.humanoid = on;
  if (on && state.tool.scene === 'carparts') state.tool.scene = 'pose';
  if (!on && state.tool.scene === 'pose') state.tool.scene = 'carparts';
  renderDock();
}

// The top bar's render pill: { light, pct, text, tip } from lib/render-status.js. Click it to open the render queue.
// While a render runs the Blender · GPU dot blinks; when one finishes the window title says so for a moment.
export function setRenderLight(l, modelId) {
  const b = $('#renderLight');
  if (!b) return;
  const was = b.dataset.light;
  b.dataset.light = l.light;
  b.dataset.id = modelId || '';
  b.title = `${l.tip}. Click to see the render queue.`;
  b.setAttribute('aria-label', `${l.text}. ${l.tip}`);
  b.querySelector('.p').setAttribute('stroke-dasharray', ringDash(l.light === 'done' ? 100 : l.pct));
  b.querySelector('.rl-t').textContent = l.text;
  const blender = $('#blenderLight');
  const busy = l.light === 'busy';
  blender.dataset.busy = String(busy);
  if (busy) blender.querySelector('.dot').className = 'dot busy';
  else if (was === 'busy') renderFrame();
  if (l.light === 'done' && was !== 'done') {
    document.title = '✓ Render done · Flatform';
    setTimeout(() => { document.title = state.settings?.testMode ? 'Flatform Test' : 'Flatform'; }, 8000);
    if (globalThis.Notification?.permission === 'granted') new Notification('Flatform: render finished', { body: l.text, silent: true });
  }
}

// ---- routing ----
const SCREENS = ['drop', 'setup', 'generate', 'compose', 'library', 'model', 'settings', 'warframe', 'spin', 'preview', 'finish', 'share', 'history', 'usage', 'test'];
export let route = { name: 'drop', id: null };
let current = null;
let navToken = 0;
let lastStep = '#/drop';
export const go = (hash) => (location.hash === hash ? navigate() : (location.hash = hash));
export const closeSheet = () => go(lastStep);

async function navigate() {
  const [, name = 'drop', id = null, sub = null] = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?(?:\/(\w+))?/) || [];
  if (name === 'review') return go(id ? `#/compose/${id}` : '#/library'); // Review was folded into Compose in v0.5
  if (name === 'render') return go(id ? `#/compose/${id}/render` : '#/library'); // and Render in v0.6: old links land on its render area
  if (name === 'compose' && sub === 'render') { state.renderIntent ||= 'show'; state.tool.scene = 'render'; } // old Render links open the Render tool
  if (!SCREENS.includes(name)) return go('#/drop');
  if (state.presenting && name !== 'preview') return history.replaceState(null, '', `#/preview/${route.id}`); // client preview stays put until it is ended
  const token = ++navToken;
  const mod = await import(`./views/${name}.js`);
  if (token !== navToken) return;
  try { current?.unmount?.(); } catch (e) { console.error(e); }
  route = { name, id };
  if (id && findModel(id)) state.lastId = id;
  if (stepOf(name)) lastStep = location.hash; // a sheet's ✕ and Esc go back here
  // A fresh element per screen, so listeners a screen added can never fire on the next one.
  const el = $('#view').cloneNode(false);
  $('#view').replaceWith(el);
  current = mod;
  renderFrame();
  try { await mod.mount(el, { id }); } catch (e) { console.error(e); toast(e.message); }
}

// Re-renders the frame and lets the open screen update its live parts.
export function refresh() {
  renderFrame();
  try { current?.update?.(); } catch (e) { console.error(e); }
}

// ---- polling: generating models and format conversions ----
async function poll() {
  let errored = false;
  for (const m of state.models.filter(isGenerating)) {
    try { upsert(await api(`/api/models/${m.id}`)); } catch (e) { errored = true; toast(e.message); }
  }
  for (const m of state.models) {
    for (const [f, e] of Object.entries(m.exports || {})) {
      if (e.status !== 'converting' || !e.task_id) continue;
      try { m.exports[f] = await api(`/api/models/${m.id}/exports/${f}`); } catch (err) { errored = true; toast(err.message); }
    }
  }
  refresh();
  setTimeout(poll, errored ? 10000 : 2500);
}

// ---- start ----
$('#keyCancel').addEventListener('click', () => $('#keyDialog').close());
$('#keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#keyError').textContent = 'Checking…';
  try {
    await saveKey(keyProvider, $('#keyInput').value);
    $('#keyInput').value = '';
    $('#keyDialog').close();
  } catch (err) { $('#keyError').textContent = err.message; }
});
$('#keyDialog').addEventListener('close', () => { $('#keyInput').value = ''; });
$('#filePicker').addEventListener('change', (e) => { addFiles(e.target.files, { quick: e.target.dataset.quick === 'true' }); e.target.value = ''; });
// Dropping a file outside a drop zone must not open it in the window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('paste', (e) => {
  if (state.presenting || !['drop', 'setup', 'generate'].includes(route.name) || e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files, { quick: route.name === 'generate' }); }
});
window.addEventListener('hashchange', navigate);

// ---- Workspaces: a pill under the logo (Warframe, Car, + New workspace), Ctrl+1 / Ctrl+2 to switch ----
export async function loadWorkspaces() {
  try { state.workspaces = await api('/api/workspaces'); } catch { state.workspaces = null; }
  drawWorkspaces();
}
export const activeWorkspace = () => state.workspaces?.list.find((w) => w.id === state.workspaces.active) || null;
function drawWorkspaces() {
  const el = $('#wsPill');
  const ws = state.workspaces;
  if (!el) return;
  el.hidden = !ws;
  if (!ws) return;
  const cur = activeWorkspace();
  el.innerHTML = `<button class="wsbtn" type="button" id="wsBtn" aria-haspopup="menu" aria-expanded="false" title="Switch project (Ctrl+1 to Ctrl+9)"><span class="wsico ${esc(cur?.kind)}" aria-hidden="true"></span><span>${esc(cur?.name || 'Workspace')}</span></button>
    <div class="wsmenu glass" id="wsMenu" role="menu" hidden>${ws.list.map((w, i) => `<button type="button" role="menuitemradio" aria-checked="${w.id === ws.active}" data-ws="${esc(w.id)}"><span class="wsico ${esc(w.kind)}" aria-hidden="true"></span>${esc(w.name)}${i < 9 ? `<small>Ctrl+${i + 1}</small>` : ''}</button>`).join('')}
    <button type="button" role="menuitem" data-ws-new>+ New workspace</button></div>`;
}
export async function switchWorkspace(id) {
  if (!state.workspaces || id === state.workspaces.active) return;
  try {
    const r = await send('/api/workspaces/active', 'POST', { id });
    announce('Switching workspace');
    if (r.restarting) { for (let i = 0; i < 50; i++) { await new Promise((ok) => setTimeout(ok, 200)); try { await api('/api/workspaces'); break; } catch { /* restarting */ } } }
    location.hash = '#/library';
    location.reload();
  } catch (e) { toast(e.message); }
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('#wsBtn')) { const m = $('#wsMenu'); m.hidden = !m.hidden; $('#wsBtn').setAttribute('aria-expanded', String(!m.hidden)); return; }
  const pick = e.target.closest('[data-ws]');
  if (pick) return switchWorkspace(pick.dataset.ws);
  if (e.target.closest('[data-ws-new]')) {
    const name = prompt('Name the new workspace');
    if (!name) return;
    const kind = confirm('Is it for Warframe models? OK for Warframe, Cancel for cars.') ? 'warframe' : 'car';
    try { state.workspaces = await send('/api/workspaces', 'POST', { name, kind }); drawWorkspaces(); } catch (err) { toast(err.message); }
    return;
  }
  if (!e.target.closest('#wsPill') && $('#wsMenu')) $('#wsMenu').hidden = true;
});
window.addEventListener('keydown', (e) => {
  if (state.presenting || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key) || !state.workspaces) return;
  const w = state.workspaces.list[Number(e.key) - 1];
  if (w) { e.preventDefault(); switchWorkspace(w.id); }
});

// ---- auto-save session: recents and "Restore last session" after Flatform closed unexpectedly ----
// The recents whose model is still in the library: [{ id, at, frame, model }].
export const recentItems = () => state.recents.map((r) => ({ ...r, model: findModel(r.id) })).filter((r) => r.model?.status === 'ready');
// Reopens a recent exactly as saved: its scene (kept on the model) and the turntable frame it was on.
export function openRecent(r) {
  state.frames[r.id] = r.frame ?? 0;
  go(`#/compose/${r.id}`);
}
// Puts a saved snapshot's scene back on its model and opens it. Returns false when there is nothing to restore.
async function restoreSnapshot(last) {
  const m = last && findModel(last.modelId);
  if (!m) return false;
  try { upsert(await send(`/api/models/${m.id}`, 'PATCH', { scene: last.scene })); } catch (e) { toast(e.message); return true; }
  openRecent({ id: m.id, frame: last.frame });
  toast(`Your last session is back: ${m.name}, saved ${timeAgo(last.at)}.`, 'ok');
  return true;
}
/** Restore last session (the Saved button, Tools, Ctrl+K): the newest auto-save, after a yes. */
export async function restoreLastSession() {
  let s;
  try { s = await api('/api/session?latest'); } catch (e) { return toast(e.message); }
  const m = s.last && findModel(s.last.modelId);
  if (!m) return toast('Everything is saved. There is no earlier session to bring back yet.', 'info');
  const ok = await confirmDialog({ title: 'Restore your last session?', text: `${m.name}, as it was ${timeAgo(s.last.at)}. The scene you have open now is replaced, and Undo brings it back.`, ok: 'Restore last session' });
  if (ok) restoreSnapshot(s.last);
}
async function loadSession() {
  let s;
  try { s = await api('/api/session'); } catch { return; }
  state.recents = s.recents || [];
  const last = s.crashed && s.last;
  const m = last && findModel(last.modelId);
  if (!m) return;
  $('#restoreNote').textContent = `Your last scene, ${m.name}, was saved ${timeAgo(last.at)}. Open it as it was?`;
  $('#restoreBar').hidden = false;
  announce('Flatform closed unexpectedly. You can restore your last session.');
  const done = () => { $('#restoreBar').hidden = true; send('/api/session/dismiss', 'POST', {}).catch(() => {}); };
  $('#restoreNo').onclick = done;
  $('#restoreYes').onclick = async () => { done(); await restoreSnapshot(last); };
}

// ---- the top bar's buttons ----
/** The Car / Warframe switch: same steps, the words and a few tools change. Remembered on this computer. */
export function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = state.workspace = mode;
  localStorage.setItem('flatform.mode', mode);
  announce(mode === 'warframe' ? 'Warframe mode' : 'Car mode');
  if (['drop', 'warframe'].includes(route.name)) go('#/drop'); // the Photo step's words change with the mode
  else refresh();
}
const present = () => { const m = focusModel(); return m ? go(`#/preview/${m.id}`) : toast('Make or open a 3D model first, then show it to a client.', 'info'); };
const shareSheet = () => { const m = focusModel(); go(m ? `#/share/${m.id}` : '#/share'); };
// Reduce motion: the system setting, or this switch (Settings, Look). Stops loops and makes every animation instant.
export const reduceMotion = (on) => {
  if (on != null) localStorage.setItem('flatform.reduceMotion', on ? '1' : '');
  document.body.classList.toggle('rm', Boolean(localStorage.getItem('flatform.reduceMotion')));
  return document.body.classList.contains('rm');
};
const showTray = (open = null) => { const t = $('#queueTray'); if (t.children.length) t.hidden = open == null ? !t.hidden : !open; return !t.hidden; };
function wireTopBar(palette) {
  $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, 18); });
  $('#modeSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#modeSeg').addEventListener('keydown', arrowRadios);
  $('#searchBtn').addEventListener('click', () => palette.open());
  $('#shareBtn').addEventListener('click', shareSheet);
  $('#presentBtn').addEventListener('click', present);
  $('#savedNote').addEventListener('click', restoreLastSession);
  $('#updatePill').addEventListener('click', () => showUpdate(true));
  $('#accountStatus').addEventListener('click', () => {
    if (showLow(true)) return; // low balance: the toast with Top up
    const provider = state.settings?.provider || 'tripo';
    return state.accounts[provider]?.hasKey ? go('#/settings/providers') : openKeyDialog(provider);
  });
  $('#blenderLight').addEventListener('click', () => (showTray(true) || go('#/settings/rendering')));
  $('#renderLight').addEventListener('click', () => { if (!showTray()) toast('Nothing in the render queue yet. Start one from Render in Scene and render.', 'info'); });
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#dock').addEventListener('click', (e) => { const b = e.target.closest('[data-dock]'); if (b) pickDock(b.dataset.dock); });
  // Esc closes a sheet (Library, Settings, Share, Usage) when nothing else is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isSheet(route.name) || $('dialog[open]') || e.target.closest?.('input, textarea, select')) return;
    e.preventDefault();
    closeSheet();
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'reduceMotion') reduceMotion(e.target.checked); });
  reduceMotion();
}

// Ctrl+K: recents first, then the main screens, then every shortcut.
let hotkeys; // { act(id) } once the keys are wired
function paletteCommands() {
  const m = focusModel();
  const recents = recentItems().map((r) => ({ label: r.model.name, hint: `Edited ${timeAgo(r.at)}`, title: `Open ${r.model.name} in Scene and render, as you left it`, thumb: thumbOf(r.model), run: () => openRecent(r) }));
  const href = stepHrefs();
  const screens = [
    ['Go to Photo', 'Step 1 · drop or choose photos', href.photo],
    ['Go to 3D model', 'Step 2 · recipe and Generate', href.model],
    ['Go to Scene and render', m ? `Step 3 · ${m.name}` : 'Step 3 · pick a model first', href.scene],
    ['Go to Finish', 'Step 4 · check, compare and share', href.finish],
    ['Library', 'Everything you have made', '#/library'],
    ['Library: renders', 'Finished pictures and spins', '#/library'],
    ['Usage and spend', 'What you have spent', '#/usage'],
    ['Settings', 'Accounts, look, folders, updates and shortcuts', '#/settings'],
    ['Check for updates', 'Settings · About and updates', '#/settings/about'],
    m && ['Version history', `Older versions of ${m.name}`, `#/model/${m.id}`],
    m && ['Spin set from photos', 'Photo frames for Dud Rents', `#/spin/${m.id}`],
  ].filter(Boolean).map(([label, hint, to]) => ({ label, hint, run: () => go(to) }));
  // The Scene tools, each one click from anywhere.
  const tools = m ? dockFor('scene', { humanoid: state.humanoid }).map(([id, , label, tip]) => ({ label: `Scene: ${label}`, hint: tip, run: () => { state.tool.scene = id; go(`#/compose/${m.id}`); if (route.name === 'compose') pickDock(id); } })) : [];
  const actions = [
    { label: 'Show a client', hint: 'Clean full screen, slow spin', run: present },
    { label: 'Share links', hint: 'Send someone a link', run: shareSheet },
    { label: 'Restore last session', hint: 'Bring back your last auto-save', run: restoreLastSession },
    { label: 'Show render queue', hint: 'Every render waiting or running', run: () => showTray(true) || toast('Nothing in the render queue yet.', 'info') },
    { label: 'Connect Tripo account', hint: 'Paste your key', run: () => openKeyDialog('tripo') },
    { label: state.mode === 'car' ? 'Switch to Warframe mode' : 'Switch to Car mode', hint: 'Top bar · Car / Warframe', run: () => setMode(state.mode === 'car' ? 'warframe' : 'car') },
    { label: reduceMotion() ? 'Turn animations back on' : 'Reduce motion', hint: 'Stops moving effects', run: () => toast(reduceMotion(!reduceMotion()) ? 'Animations are off.' : 'Animations are on.', 'info') },
  ];
  // Every shortcut, with its keys. The Scene ones open Scene first when you are somewhere else.
  const keys = loadKeys().keys;
  const shortcuts = SHORTCUTS.filter((s) => s.id !== 'palette').map((s) => {
    const here = worksOn(s, route.name);
    const k = keyOf(s.id, keys);
    return { label: s.label, hint: here ? k : `${k} · in Scene`, title: here ? `${s.label} (${k})` : `Opens Scene and render. There, press ${k} for this.`,
      run: () => (here ? hotkeys.act(s.id) : m ? go(`#/compose/${m.id}`) : toast('Pick a model first.', 'info')) };
  });
  return [...recents, ...screens, ...tools, ...actions, ...shortcuts];
}

// Not top-level await: the screens import this module, so it has to finish loading before they can.
(async () => {
  const [models, settings, blender] = await Promise.all([api('/api/models'), api('/api/settings'), api('/api/blender')]
    .map((p) => p.catch((e) => { toast(e.message); return null; })));
  state.models = models || [];
  state.settings = settings;
  state.blender = blender;
  applyTheme(settings?.theme);
  await loadWorkspaces();
  await loadSession();
  const palette = installPalette({ commands: paletteCommands });
  hotkeys = installHotkeys({
    screen: () => route.name,
    say: (text) => toast(text, 'info'),
    run: async (id) => {
      if (state.presenting) return;
      if (id === 'palette') return palette.open();
      const m = (route.id && findModel(route.id)) || focusModel();
      if (id === 'shelf') { const on = state.tool.scene === 'world'; pickDock('world'); return (await import('./views/compose.js')).toggleShelf(on ? undefined : 'shelf'); }
      if (id === 'share' || id === 'history') return go(m ? `#/${id}/${m.id}` : `#/${id}`);
      if (!m) return toast('Pick a model first.', 'info');
      if (id === 'still' || id === 'turntable') { pickDock('render'); return (await import('./views/compose-render.js')).showRenderIntent(id); }
      go(`#/${id === 'preview' ? 'preview' : 'finish'}/${m.id}`);
    },
  });
  wireTopBar(palette);
  await navigate();
  refreshAccount();
  setInterval(() => refreshAccount(), 60000);
  refreshUpdate();
  setTimeout(refreshUpdate, 20000); // the server's first check runs a few seconds after it starts
  setInterval(refreshUpdate, 15 * 60000);
  refreshSpend();
  setInterval(refreshSpend, 5 * 60000);
  poll();
})();
