// Flatform front end: shared state, API calls, routing, the window frame and the upload queue.
// Each screen is a module in views/ with mount(el, params), and optionally update() and unmount().
import { icon } from './lib/icons.js';
import { applyTheme } from './lib/theme.js';
import { PROVIDERS, ENGINES, VIEWS, normalize, presetConfig, matchPreset, PRESETS } from './lib/engines.js';
import { estimate } from './lib/pricing.js';
import { isModelFile, importModel } from './lib/importer.js';
import { installHotkeys } from './lib/hotkeys.js';

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
};

export async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
export const send = (path, method, data) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export function toast(msg, kind = 'error') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 6000);
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
  $('#keyLink').href = p.keyUrl;
  $('#keyLink').textContent = provider === 'tripo' ? 'developers.tripo3d.com/en/keys' : 'the 3D AI Studio API dashboard';
  $('#keyTo').textContent = p.name;
  $('#keyInput').placeholder = p.keyHint || 'Paste your API key';
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
let laterAt; // "Later" hides the banner until GitHub answers again, or the app starts again
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
function showUpdate() {
  const u = state.update;
  const bar = $('#update');
  const show = Boolean(u?.newer && !u.skipped && u.checkedAt !== laterAt);
  if (show) {
    $('#updateTitle').textContent = `Flatform ${u.latest} is ready`;
    $('#updateNote').textContent = u.notes;
    $('#updateDownload').href = u.downloadUrl; // checked by the server: only github.com/TyroneMadison/Flatform/ links
    if (bar.hidden) announce(`Flatform ${u.latest} is ready to download`);
  } else if (bar.contains(document.activeElement)) $('#view').focus();
  bar.hidden = !show;
}
function updateLater() {
  laterAt = state.update?.checkedAt;
  showUpdate();
}

// ---- spend: the ledger summary (Settings → Spend) and a banner when a balance is under its alert ----
// Top up opens the provider's billing page: through main.mjs in the app, a plain new tab in `npm run web`.
export const topUp = (service) => (native?.openBilling ? native.openBilling(service).catch((e) => toast(e.message))
  : window.open(PROVIDERS[service].billingUrl, '_blank', 'noopener'));
let lowLater = false; // "Later" hides the banner until Flatform starts again
export async function refreshSpend() {
  try { state.spend = await api('/api/spend'); } catch { return; }
  showLow();
  refresh();
}
function showLow() {
  const low = Object.entries(state.spend?.services || {}).filter(([, s]) => s.low);
  const bar = $('#lowBalance');
  if (low.length && !lowLater) {
    const [service, s] = low[0];
    $('#lowTitle').textContent = `${PROVIDERS[service].name} balance is low`;
    $('#lowNote').textContent = [`${fmt(s.balance)} credits left, under your alert of ${fmt(s.threshold)}`,
      s.daysLeft != null && `about ${s.daysLeft} days at this pace`, low.length > 1 && `${PROVIDERS[low[1][0]].name} is low too`].filter(Boolean).join(' · ');
    $('#lowTopUp').dataset.service = service;
    if (bar.hidden) announce($('#lowTitle').textContent);
  }
  bar.hidden = !low.length || lowLater;
}
$('#lowTopUp').addEventListener('click', (e) => topUp(e.target.dataset.service));
$('#lowLater').addEventListener('click', () => { lowLater = true; showLow(); });

// ---- files opened with Flatform (desktop app: "Open with", a second launch) go to the Drop flow ----
native?.onOpenFiles?.(async (paths) => {
  const files = [];
  for (const p of paths) {
    try { const { name, bytes } = await native.readDroppedFile(p); files.push(new File([bytes], name)); } catch (e) { toast(`${p}: ${e.message}`); }
  }
  if (files.length) addFiles(files); // photos to the setup screen, 3D models straight into Compose
});

// ---- the frame: rail, title bar status, flow tabs ----
// Plain tabs, every one clickable at any time: Generate opens this car's progress (or the queue), Compose and
// Render this car or the last ready one.
const FLOW = [['drop', 'Drop'], ['generate', 'Generate'], ['compose', 'Compose'], ['render', 'Render']];
export function stepper(active, m) {
  const ready = m?.status === 'ready' ? m : focusModel();
  const hrefOf = (key) => (key === 'drop' ? '#/drop' : key === 'generate' ? (m ? `#/generate/${m.id}` : '#/generate')
    : ready ? `#/${key}/${ready.id}` : '#/library');
  return `<nav class="flowtabs" aria-label="Steps">${FLOW.map(([key, label]) => (key === active
    ? `<a class="ftab on" href="${hrefOf(key)}" aria-current="page">${label}</a>`
    : `<a class="ftab" href="${hrefOf(key)}">${label}</a>`)).join('')}</nav>`;
}

export function focusModel() {
  const ready = (m) => m?.status === 'ready' && m;
  return ready(findModel(route.id)) || ready(findModel(state.lastId)) || state.models.find((m) => m.status === 'ready');
}

function renderFrame() {
  const target = focusModel();
  const links = [
    ['New', 'plus', '#/drop', ['drop', 'setup', 'generate']],
    ['Warframe', 'cube', '#/warframe', ['warframe']],
    ['Library', 'library', '#/library', ['library', 'model']],
    ['Scenes', 'scene', target ? `#/compose/${target.id}` : '#/library', ['compose']],
    ['Renders', 'film', target ? `#/render/${target.id}` : '#/library', ['render']],
    ['Spin set', 'retry', target ? `#/spin/${target.id}` : '#/spin', ['spin']],
    ['Finish', 'check', target ? `#/finish/${target.id}` : '#/library', ['finish']],
    ['Share', 'external', target ? `#/share/${target.id}` : '#/share', ['share']],
    ['Usage', 'eye', '#/usage', ['usage']],
    ['Settings', 'settings', '#/settings', ['settings']],
  ];
  const html = links.map(([label, ic, href, names]) => {
    const on = names.includes(route.name);
    return `<a class="ri ${on ? 'on' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}>${icon(ic, 20)}<span>${label}</span></a>`;
  }).join('');
  if ($('#railLinks').innerHTML !== html) $('#railLinks').innerHTML = html;
  // The default provider's connection.
  const provider = state.settings?.provider || 'tripo';
  const { name } = PROVIDERS[provider];
  const a = state.accounts[provider];
  const text = !a ? `Connecting to ${name}` : a.error ? `${name} unreachable` : a.hasKey ? `${name} connected` : `No ${name} API key`;
  $('#accountStatus').textContent = `${text}${state.settings ? ` · v${state.settings.version}` : ''}`;
  $('#railAccount .dot').className = `dot ${!a ? 'wait' : a.hasKey && !a.error ? 'ok' : ''}`;
  $('#railAccount .acctname').textContent = provider === 'tripo' ? 'Tripo' : '3D AI';
  $('#railAccount').title = text;
  $('#railAccount').setAttribute('aria-label', `${text}. Open settings`);
}

// ---- routing ----
const SCREENS = ['drop', 'setup', 'generate', 'compose', 'render', 'library', 'model', 'settings', 'warframe', 'spin', 'preview', 'finish', 'share', 'usage'];
export let route = { name: 'drop', id: null };
let current = null;
let navToken = 0;
export const go = (hash) => (location.hash === hash ? navigate() : (location.hash = hash));

async function navigate() {
  const [, name = 'drop', id = null] = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
  if (name === 'review') return go(id ? `#/compose/${id}` : '#/library'); // Review was folded into Compose in v0.5
  if (!SCREENS.includes(name)) return go('#/drop');
  if (state.presenting && name !== 'preview') return history.replaceState(null, '', `#/preview/${route.id}`); // client preview stays put until it is ended
  const token = ++navToken;
  const mod = await import(`./views/${name}.js`);
  if (token !== navToken) return;
  try { current?.unmount?.(); } catch (e) { console.error(e); }
  route = { name, id };
  if (id && findModel(id)) state.lastId = id;
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
// The Download link opens in the browser (the desktop app hands https links to it); the bar's job is then done.
$('#updateDownload').addEventListener('click', updateLater);
$('#updateLater').addEventListener('click', updateLater);
$('#updateSkip').addEventListener('click', async () => {
  try { state.update = await send('/api/update/skip', 'POST', { version: state.update.latest }); } catch (e) { toast(e.message); }
  showUpdate();
  refresh();
});
$('#update').addEventListener('keydown', (e) => { if (e.key === 'Escape') updateLater(); });
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
  el.innerHTML = `<button class="wsbtn" type="button" id="wsBtn" aria-haspopup="menu" aria-expanded="false" title="Workspace (Ctrl+1, Ctrl+2)"><span class="wsico ${esc(cur?.kind)}" aria-hidden="true"></span><span>${esc(cur?.name || 'Workspace')}</span></button>
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

// Not top-level await: the screens import this module, so it has to finish loading before they can.
(async () => {
  const [models, settings, blender] = await Promise.all([api('/api/models'), api('/api/settings'), api('/api/blender')]
    .map((p) => p.catch((e) => { toast(e.message); return null; })));
  state.models = models || [];
  state.settings = settings;
  state.blender = blender;
  applyTheme(settings?.theme);
  await loadWorkspaces();
  installHotkeys({
    screen: () => route.name,
    run: (action) => {
      if (state.presenting) return;
      const m = (route.id && findModel(route.id)) || focusModel();
      if (!m) return toast('Pick a model first.');
      go(`#/${action === 'preview' ? 'preview' : 'finish'}/${m.id}`);
    },
  });
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
