// Flatform front end: shared state, API calls, routing, the window frame and the upload queue.
// Each screen is a module in views/ with mount(el, params), and optionally update() and unmount().
import { icon } from './lib/icons.js';
import { PROVIDERS, ENGINES, VIEWS, normalize, presetConfig, matchPreset, PRESETS } from './lib/engines.js';
import { estimate } from './lib/pricing.js';

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
  queue: [], // jobs waiting in Flatform's own upload queue (not sent to a provider yet)
  pending: { photos: [], views: {}, modelId: null }, // photos waiting on the setup screen for Generate
  frames: {}, // composer turntable frame per model, so "Render still" uses the current angle
  lastId: null, // model last opened in a flow screen
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
export const isRendered = (m) => Boolean(m.renders && ['studio360', 'studio180', 'transparent360', 'transparent180'].some((k) => m.renders[k]));
export const thumbOf = (m, v = m) => (v === m && m.renders?.poster ? fileUrl(m, m.renders.poster) : v.thumb ? fileUrl(m, v.thumb) : v.source ? fileUrl(m, v.source) : '');
export const sourceType = (file = '') => (/\.png$/i.test(file) ? 'PNG' : 'JPEG');

// Generation stages, from the provider's job status and progress.
const STAGE_NAMES = {
  tripo: ['Uploaded to Tripo', 'Task started', 'Building geometry', 'Painting textures', 'Saving GLB to library'],
  '3daistudio': ['Sent to 3D AI Studio', 'Waiting for its turn', 'Building geometry', 'Painting textures', 'Saving GLB to library'],
};
export const providerOf = (v) => (v?.provider === '3daistudio' ? '3daistudio' : 'tripo');
export const stagesOf = (v) => STAGE_NAMES[providerOf(v)];
export function stageOf(v) {
  if (v.status === 'ready') return 5;
  const [done, running] = providerOf(v) === 'tripo' ? [v.tripo_status === 'success', v.tripo_status === 'running']
    : [v.upstream_status === 'FINISHED', v.upstream_status === 'IN_PROGRESS'];
  if (done) return 4;
  if (running) return (v.progress || 0) < 50 ? 2 : 3;
  return 1; // queued at the provider
}
export function statusText(m) {
  if (m.status === 'ready') return 'Ready';
  if (m.status === 'failed') return m.error || 'Generation failed';
  if (m.note) return m.note;
  const stage = stageOf(m);
  return stage === 1 ? `Queued at ${PROVIDERS[providerOf(m)].name}` : `${stagesOf(m)[stage]} · ${m.progress || 0}%`;
}
export const statusClass = (m) => ({ ready: 'ready', failed: 'fail' })[m.status] || 'gen';
// "Tripo v3.1" or "3D AI Studio · Hitem3D 3.0", for a version (or the model's active one).
export function engineLabel(v) {
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
  const photos = takePhotos(files);
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

// ---- the frame: rail, title bar status, stepper ----
const FLOW = [['drop', 'Drop'], ['generate', 'Generate'], ['review', 'Review'], ['compose', 'Compose'], ['render', 'Render']];
export function stepper(active, m) {
  const idx = FLOW.findIndex(([key]) => key === active);
  return `<nav class="stepper" aria-label="Steps">${FLOW.map(([key, label], i) => {
    const cls = i < idx ? 'done' : i === idx ? 'on' : '';
    const inner = `<b>${i < idx ? icon('check', 12) : i + 1}</b><span>${label}</span>`;
    const href = i === 0 ? '#/drop' : m && (i === 1 || m.status === 'ready') ? `#/${key}/${m.id}` : null;
    const step = href && i !== idx ? `<a class="step ${cls}" href="${href}">${inner}</a>`
      : `<div class="step ${cls}"${i === idx ? ' aria-current="step"' : ''}>${inner}</div>`;
    return (i ? '<em class="stepline" aria-hidden="true"></em>' : '') + step;
  }).join('')}</nav>`;
}

export function focusModel() {
  const ready = (m) => m?.status === 'ready' && m;
  return ready(findModel(route.id)) || ready(findModel(state.lastId)) || state.models.find((m) => m.status === 'ready');
}

function renderFrame() {
  const target = focusModel();
  const links = [
    ['New', 'plus', '#/drop', ['drop', 'setup', 'generate']],
    ['Library', 'library', '#/library', ['library', 'review']],
    ['Scenes', 'scene', target ? `#/compose/${target.id}` : '#/library', ['compose']],
    ['Renders', 'film', target ? `#/render/${target.id}` : '#/library', ['render']],
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
const VIEWS = ['drop', 'setup', 'generate', 'review', 'compose', 'render', 'library', 'settings'];
export let route = { name: 'drop', id: null };
let current = null;
let navToken = 0;
export const go = (hash) => (location.hash === hash ? navigate() : (location.hash = hash));

async function navigate() {
  const [, name = 'drop', id = null] = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/) || [];
  if (!VIEWS.includes(name)) return go('#/drop');
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
$('#filePicker').addEventListener('change', (e) => { addFiles(e.target.files, { quick: e.target.dataset.quick === 'true' }); e.target.value = ''; });
// Dropping a file outside a drop zone must not open it in the window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('paste', (e) => {
  if (!['drop', 'setup', 'generate'].includes(route.name) || e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files, { quick: route.name === 'generate' }); }
});
window.addEventListener('hashchange', navigate);

// Not top-level await: the screens import this module, so it has to finish loading before they can.
(async () => {
  const [models, settings, blender] = await Promise.all([api('/api/models'), api('/api/settings'), api('/api/blender')]
    .map((p) => p.catch((e) => { toast(e.message); return null; })));
  state.models = models || [];
  state.settings = settings;
  state.blender = blender;
  await navigate();
  refreshAccount();
  setInterval(() => refreshAccount(), 60000);
  poll();
})();
