// Flatform front end: shared state, API calls, routing, the window frame and the upload queue.
// Each screen is a module in views/ with mount(el, params), and optionally update() and unmount().
import { icon } from './lib/icons.js';

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fileUrl = (m, f) => `/files/${m.id}/${encodeURIComponent(f)}`;
export const MAX_PHOTO = 20 * 1024 * 1024;
export const FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'];

export const state = {
  models: [], // the library, newest first
  account: null, // { hasKey, balance, frozen } or { error }
  settings: null, // non-secret settings + version, paths
  blender: null, // { found, path }
  queue: [], // photos waiting in Flatform's own upload queue (not sent to Tripo yet)
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

// Generation stages, from Tripo's task status and progress.
export const STAGES = ['Uploaded to Tripo', 'Task started', 'Building geometry', 'Painting textures (PBR)', 'Saving GLB to library'];
export function stageOf(v) {
  if (v.status === 'ready') return STAGES.length;
  if (v.tripo_status === 'success') return 4;
  if (v.tripo_status === 'running') return (v.progress || 0) < 50 ? 2 : 3;
  return 1; // queued at Tripo
}
export function statusText(m) {
  if (m.status === 'ready') return 'Ready';
  if (m.status === 'failed') return m.error || 'Generation failed';
  const stage = stageOf(m);
  return stage === 1 ? 'Queued at Tripo' : `${STAGES[stage]} · ${m.progress || 0}%`;
}
export const statusClass = (m) => ({ ready: 'ready', failed: 'fail' })[m.status] || 'gen';

// Credits: only numbers Tripo gave us. Tripo has no price estimate, so the last real charge is shown instead.
export function credits() {
  const a = state.account?.hasKey ? state.account : null;
  const last = state.models.flatMap((m) => m.versions || []).filter((v) => v.credits != null)
    .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))[0];
  return { balance: a?.balance, frozen: a?.frozen, last: last?.credits };
}
export const fmt = (n) => Math.floor(n).toLocaleString('en-US');
export function creditsText() {
  const c = credits();
  return [
    c.balance != null && `Balance ${fmt(c.balance)} credits · ${fmt(c.frozen || 0)} frozen.`,
    c.last != null && `Last generation used ${fmt(c.last)} credits.`,
  ].filter(Boolean).join(' ');
}
export const modelLabel = (s = state.settings) => `Tripo ${String(s?.model || 'v3.1').split('-')[0]} · ${s?.texture === false ? 'untextured' : s?.pbr === false ? 'textured' : 'textured PBR'}`;

// ---- upload queue: photos wait here until Flatform hands them to Tripo, one at a time ----
const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/heic', 'image/heif'];
function photoType(file) {
  if (PHOTO_TYPES.includes(file.type)) return file.type;
  if (/\.(heic|heif)$/i.test(file.name)) return 'image/heic'; // Windows browsers often leave HEIC types blank
  if (/\.png$/i.test(file.name)) return 'image/png';
  if (/\.jpe?g$/i.test(file.name)) return 'image/jpeg';
  return null;
}
export function addFiles(files, { open = true } = {}) {
  let first = true;
  for (const file of files) {
    const type = photoType(file);
    if (!type) { toast(`${file.name}: use a PNG, JPEG or HEIC photo`); continue; }
    if (file.size > MAX_PHOTO) { toast(`${file.name}: too large (max 20 MB)`); continue; }
    state.queue.push({ qid: crypto.randomUUID(), file, type, fileName: file.name, name: file.name.replace(/\.[^.]+$/, '') || 'Untitled', status: 'waiting', open: open && first });
    first = false;
  }
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
      announce(`Sending ${item.fileName} to Tripo`);
      refresh();
      try {
        const m = upsert(await api(`/api/models?name=${encodeURIComponent(item.name)}`, { method: 'POST', headers: { 'Content-Type': item.type }, body: item.file }));
        state.queue.splice(state.queue.indexOf(item), 1);
        announce(`${m.name} is generating`);
        if (item.open && route.name === 'drop') go(`#/generate/${m.id}`);
      } catch (e) {
        Object.assign(item, { status: 'error', error: e.message });
        toast(`${item.fileName}: ${e.message}`);
        if (/api key/i.test(e.message)) openKeyDialog();
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
// open: go to the Generate screen when the first photo is in.
export function openPicker(open = true) {
  const picker = $('#filePicker');
  picker.dataset.open = String(open);
  picker.click();
}
// Runs a button's action once at a time, so a double click can't start two paid Tripo tasks.
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

// ---- account and key ----
export function openKeyDialog() {
  $('#keyError').textContent = '';
  if (!$('#keyDialog').open) $('#keyDialog').showModal();
}
let askedForKey = false;
export async function refreshAccount() {
  try {
    state.account = await api('/api/account');
    // Ask once per session; after that the rail and Settings show that the key is missing.
    if (!state.account.hasKey && !askedForKey) { askedForKey = true; openKeyDialog(); }
  } catch (e) {
    state.account = { error: e.message };
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
    ['New', 'plus', '#/drop', ['drop', 'generate']],
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
  const a = state.account;
  const text = !a ? 'Connecting to Tripo' : a.error ? 'Tripo unreachable' : a.hasKey ? 'Tripo connected' : 'No Tripo API key';
  $('#tripoStatus').textContent = `${text}${state.settings ? ` · v${state.settings.version}` : ''}`;
  $('#railTripo .dot').className = `dot ${!a ? 'wait' : a.hasKey && !a.error ? 'ok' : ''}`;
  $('#railTripo').title = text;
  $('#railTripo').setAttribute('aria-label', `${text}. Open settings`);
}

// ---- routing ----
const VIEWS = ['drop', 'generate', 'review', 'compose', 'render', 'library', 'settings'];
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
    state.account = await send('/api/settings', 'POST', { apiKey: $('#keyInput').value });
    $('#keyInput').value = '';
    $('#keyDialog').close();
    refresh();
  } catch (err) { $('#keyError').textContent = err.message; }
});
$('#filePicker').addEventListener('change', (e) => { addFiles(e.target.files, { open: e.target.dataset.open !== 'false' }); e.target.value = ''; });
// Dropping a file outside a drop zone must not open it in the window.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
window.addEventListener('paste', (e) => {
  if (!['drop', 'generate'].includes(route.name) || e.target.closest?.('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files, { open: route.name === 'drop' }); }
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
  setInterval(refreshAccount, 60000);
  poll();
})();
