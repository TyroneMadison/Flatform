// 07 · Settings: providers and keys, rendering, the output folder, updates and about. Only non-secret values are stored
// in settings.json; keys go to the OS keychain and never come back to this page: it only learns whether one is saved.
import { PRESETS as THEMES, normalizeTheme, resolveTheme, applyTheme, contrast, AAA } from '../lib/theme.js';
import { $, esc, state, api, send, toast, refresh, native, fmt, fmtBalance, saveKey, confirmDialog, arrowRadios, refreshUpdate, refreshSpend, topUp } from '../app.js';
import { PROVIDERS } from '../lib/engines.js';
import { icon } from '../lib/icons.js';
import { PRESETS } from '../lib/studio.js';

const SCENES = Object.entries(PRESETS).map(([k, p]) => [k, k === 'showroom' ? 'Showroom (default)' : k === 'miami' ? 'Miami street at night (your HDRI)' : p.label]);
const SECTIONS = [['providers', 'Providers'], ['spend', 'Spend'], ['rendering', 'Rendering'], ['output', 'Output folder'], ['appearance', 'Appearance'], ['history', 'History'], ['about', 'About']];
const RELEASES = 'https://github.com/TyroneMadison/Flatform/releases';
const results = {}; // provider → { ok, text } from the last Test or key change
let root;
let section;
let replacing = null; // provider whose key field is open for a new key
let checking = false; // "Check for updates" is waiting for GitHub

export function mount(el, { id }) {
  root = el;
  section = SECTIONS.some(([k]) => k === id) ? id : 'providers';
  replacing = null;
  el.innerHTML = `<h1 class="ph">Settings</h1>
  <p class="sub">Providers and keys. Paste a key once; Flatform encrypts it on this computer.</p>
  <div class="set">
    <nav class="sn" aria-label="Settings sections">${SECTIONS.map(([k, label]) => `<a href="#/settings/${k}"${k === section ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <section class="settings" id="settings"></section>
  </div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('submit', onSubmit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && replacing) { replacing = null; redraw(); }
    arrowRadios(e);
  });
  update();
  if (section === 'spend') refreshSpend();
}

const save = async (data) => {
  try {
    state.settings = await send('/api/settings', 'POST', data);
    state.blender = await api('/api/blender');
  } catch (e) {
    toast(e.message);
  }
  redraw();
  refresh();
};
let forced = false;
const redraw = () => { forced = true; update(); }; // after an action of ours, even if a field has focus

async function test(provider) {
  results[provider] = { text: 'Checking…' };
  redraw();
  try {
    const a = await api(`/api/account?provider=${provider}&fresh`);
    state.accounts[provider] = a;
    results[provider] = a.hasKey ? { ok: true, text: `${worksText(provider, a)} · ${testedAt()}` } : { ok: false, text: 'No key to test' };
  } catch (e) {
    results[provider] = { ok: false, text: e.message };
  }
  redraw();
  refresh();
}
const worksText = (provider, a) => [
  `Key works · ${fmtBalance(a.balance)} credits`,
  a.frozen ? `${fmt(a.frozen)} frozen` : '',
  provider === '3daistudio' ? `${a.rateLimit || 3} requests a minute` : '',
].filter(Boolean).join(' · ');
const testedAt = () => `tested ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

async function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const s = state.settings;
  const { act, provider } = t.dataset;
  if (act === 'provider') save({ provider: t.dataset.value });
  if (act === 'local-download') { try { localInfo = await send('/api/local/download', 'POST'); } catch (err) { toast(err.message); } redraw(); loadLocal().then(redraw); }
  if (act === 'test') await test(provider);
  if (act === 'replace') { replacing = provider; redraw(); $(`#key-${provider}`, root)?.focus(); }
  if (act === 'cancel') { replacing = null; redraw(); }
  if (act === 'remove') {
    const env = PROVIDERS[provider].env;
    if (!(await confirmDialog({ title: `Remove the ${PROVIDERS[provider].name} key?`, text: `Flatform deletes the encrypted key from this computer. If ${env} is set in .env, that key is used instead.`, ok: 'Remove key' }))) return;
    try {
      const r = await send(`/api/keys/${provider}`, 'DELETE');
      state.settings = { ...state.settings, keys: r.keys };
      delete state.accounts[provider];
      results[provider] = { ok: true, text: 'Key removed' };
    } catch (err) { toast(err.message); }
    redraw();
    refresh();
  }
  if (act === 'topup') topUp(t.dataset.service);
  if (act === 'renderer') save({ renderer: t.dataset.value });
  if (act === 'output') {
    if (native) { const dir = await native.pickFolder(); if (dir) save({ outputRoot: dir }); } else showField('outputField');
  }
  if (act === 'blender') {
    if (native) {
      const filters = s.platform === 'win32' ? [{ name: 'Blender', extensions: ['exe'] }] : s.platform === 'darwin' ? [{ name: 'Blender', extensions: ['app'] }] : [{ name: 'Blender', extensions: ['*'] }];
      const file = await native.pickFile(filters);
      if (file) save({ blenderPath: file });
    } else showField('blenderField');
  }
  if (act === 'theme') { const theme = { preset: t.dataset.value, custom: {} }; applyTheme(theme); save({ theme }); }
  if (act === 'theme-reset') { applyTheme(undefined); save({ theme: { preset: 'dark', custom: {} } }); }
  if (act === 'git-repo') {
    const dir = native ? await native.pickFolder() : prompt('Project folder (a git repository), full path');
    if (dir) { await save({ gitRepo: dir.trim() }); loadGit(); }
  }
  if (act === 'git-load') loadGit();
  if (act === 'rollback') {
    const { sha, mode } = t.dataset;
    const text = mode === 'revert' ? `Add a new commit that undoes every change after ${sha.slice(0, 7)}. Nothing is deleted.` : `Make a new branch at ${sha.slice(0, 7)} and switch to it. The current branch stays as it is.`;
    if (!(await confirmDialog({ title: 'Roll back to this version', text, ok: mode === 'revert' ? 'Revert' : 'New branch' }))) return;
    try { const r = await send('/api/history/rollback', 'POST', { sha, mode }); toast(`Done: ${r.ran.join('; ')}`, 'info'); } catch (err) { toast(err.message); }
    loadGit();
  }
  if (act === 'show-library') native?.showItemInFolder(s.libraryDir).catch((err) => toast(err.message));
  if (act === 'check-update' && !checking) {
    checking = true;
    redraw();
    await refreshUpdate(true);
    checking = false;
    redraw();
  }
}

function showField(id) {
  const f = $(`#${id}`, root);
  f.hidden = false;
  f.querySelector('input').focus();
}

async function onChange(e) {
  const t = e.target;
  if (t.dataset.themeColor) {
    const cur = normalizeTheme(state.settings.theme);
    const theme = { ...cur, custom: { ...cur.custom, [t.dataset.themeColor]: t.value } };
    applyTheme(theme);
    save({ theme });
  }
  if (t.name === 'alsoTransparent') save({ alsoTransparent: t.checked });
  if (t.name === 'defaultScene') save({ defaultScene: t.value });
  if (t.name === 'autoCheck') save({ updates: { autoCheck: t.checked } });
  if (t.name === 'threshold' && t.value !== '') { await save({ spend: { thresholds: { [t.dataset.service]: Number(t.value) } } }); refreshSpend(); }
  if (t.name === 'region') { await save({ region: t.value }); if (state.settings.keys?.tripo !== 'none') test('tripo'); } // the balance comes from the new region
}

async function onSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const provider = form.dataset.provider;
  if (!provider) {
    const input = form.querySelector('input');
    return save({ [input.name]: input.value.trim() });
  }
  const input = form.querySelector('input');
  results[provider] = { text: 'Checking the key…' };
  $(`#pc-res-${provider}`, root).textContent = 'Checking the key…';
  try {
    const a = await saveKey(provider, input.value);
    input.value = '';
    replacing = null;
    results[provider] = { ok: true, text: `${worksText(provider, a)} · saved · ${testedAt()}` };
  } catch (err) {
    results[provider] = { ok: false, text: err.message };
  }
  redraw();
}

// One card per provider, both built the same way.
function card(id) {
  if (PROVIDERS[id].local) return localCard();
  const p = PROVIDERS[id];
  const s = state.settings;
  const source = s.keys?.[id] || 'none';
  const pill = { saved: ['ok', 'Saved · encrypted'], env: ['env', 'From .env'], none: ['none', 'Not set'] }[source];
  // Tripo has two hosts (global and China); the header picks one.
  const sub = id === 'tripo'
    ? `<label class="sr-only" for="region">Tripo region</label><select class="hostsel" id="region" name="region">${Object.entries(s.regions).map(([k, url]) => `<option value="${k}"${s.region === k ? ' selected' : ''}>${esc(new URL(url).host)} · v3${k === 'china' ? ' · China' : ''}</option>`).join('')}</select>`
    : `<span>${esc(p.host)}</span>`;
  const r = results[id];
  const field = replacing === id
    ? `<form class="kf" data-provider="${id}"><label class="sr-only" for="key-${id}">New ${p.name} API key</label>
        <input class="in" id="key-${id}" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(p.keyHint || 'Paste the new key')}" required>
        <button class="btn sm pri" type="submit">Save</button><button class="btn sm ghostbtn" type="button" data-act="cancel">Cancel</button></form>`
    : `<div class="kf"><div class="in" aria-label="${source === 'none' ? 'No key saved' : 'Key saved, hidden'}">${source === 'none' ? '<span class="muted">No key yet</span>' : '<span aria-hidden="true">••••••••••••••••••••••••</span>'}<em>${source === 'env' ? 'from .env' : source === 'saved' ? 'hidden' : ''}</em></div>
        <button class="btn sm ghostbtn" type="button" data-act="test" data-provider="${id}"${source === 'none' ? ' disabled' : ''}>Test</button>
        <button class="btn sm ghostbtn" type="button" data-act="replace" data-provider="${id}">${source === 'none' ? 'Add key' : 'Replace'}</button>
        <button class="btn sm ghostbtn" type="button" data-act="remove" data-provider="${id}"${source === 'saved' ? '' : ' disabled'}>Remove</button></div>`;
  return `<div class="pc glass" aria-labelledby="pc-${id}">
    <div class="ph2"><div class="av" aria-hidden="true">${id === 'tripo' ? 'T' : '3D'}</div><div><b id="pc-${id}">${p.name}</b><p>${sub}</p></div><span class="pill ${pill[0]}">● ${pill[1]}</span></div>
    ${field}
    <div class="res${r ? (r.ok === false ? ' bad' : r.ok ? ' ok' : '') : ''}" id="pc-res-${id}" role="status">${r ? `${r.ok === false ? '✗' : r.ok ? '✓' : ''} ${esc(r.text)}` : `<span>Get a key at <a href="${p.keyUrl}" target="_blank" rel="noopener">${esc(new URL(p.keyUrl).host)}</a>. Test runs the free balance check.</span>`}</div>
  </div>`;
}

// The free local engine: no key, just a one-time download and a graphics card.
let localInfo = null;
let localTimer = null;
async function loadLocal() {
  try { localInfo = await api('/api/local'); } catch (err) { localInfo = { error: err.message }; }
  clearTimeout(localTimer);
  if (localInfo?.download?.running) localTimer = setTimeout(() => loadLocal().then(redraw), 1000);
}
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
function localCard() {
  const l = localInfo;
  if (!l) { loadLocal().then(redraw); return '<div class="pc glass"><b>Local (free)</b><p class="fine">Checking…</p></div>'; }
  const d = l.download || {};
  const status = l.error ? l.error : d.running ? `Downloading ${esc(d.file || '')} · ${gb(d.done || 0)} of about 3.3 GB`
    : l.ready ? 'Ready. Generate with Local (free) to use it.' : d.error ? `${d.error}` : 'Not downloaded yet. About 3.3 GB, one time.';
  return `<div class="pc glass" aria-labelledby="pc-local">
    <div class="ph2"><div class="av" aria-hidden="true">PC</div><div><b id="pc-local">Local (free)</b><p><span>TRELLIS on your graphics card · $0 per model</span></p></div>
      <span class="pill ${l.ready ? 'ok' : 'none'}">● ${l.ready ? 'Ready' : 'Not set up'}</span></div>
    <p class="fine">Graphics card: ${l.gpu?.ok ? `${esc(l.gpu.name)} · ${l.gpu.memoryGB} GB` : esc(l.gpu?.error || 'unknown')}</p>
    <p class="fine">Detail Boost upscaler: ${l.upscaler ? 'ready' : 'downloads with the engine (64 MB)'}</p>
    <p class="fine">Saved in <span class="mono">${esc(l.weightsDir || '')}</span></p>
    ${d.running ? `<progress max="${3.3 * 1024 ** 3}" value="${d.done || 0}" style="width:100%"></progress>` : ''}
    <div class="kf"><button class="btn sm pri" type="button" data-act="local-download"${d.running || (l.ready && l.upscaler) ? ' disabled' : ''}>${d.error ? 'Try again' : 'Download local engine'}</button></div>
    <div class="res${d.error ? ' bad' : l.ready ? ' ok' : ''}" role="status">${esc(status)}</div>
  </div>`;
}

function providersHtml() {
  const s = state.settings;
  return `<div class="def"><h2 class="label" id="defK">Default provider</h2>
      <div class="prov" role="radiogroup" aria-labelledby="defK">${Object.entries(PROVIDERS).map(([id, p]) => `<button type="button" role="radio" aria-checked="${s.provider === id}" class="${s.provider === id ? 'on' : ''}" data-act="provider" data-value="${id}"><b>${p.name}</b><span>${p.sub}</span></button>`).join('')}</div>
      <p class="fine">You can still switch per model on the Generate screen.</p></div>
    ${Object.keys(PROVIDERS).map(card).join('')}
    <p class="fine">Keys are stored with the operating system's encryption (Windows DPAPI, macOS Keychain), never in settings.json, and are only sent to that provider's own API. Test runs the free balance check and spends no credits. In <span class="mono">npm run web</span>, keys come from .env (TRIPO_API_KEY, THREE_D_AI_STUDIO_KEY) and pasted ones last until it stops.</p>`;
}

const pathForm = (id, name, label, value, placeholder) => `
  <form class="field pathform" id="${id}" hidden><label for="${id}In">${label}</label>
    <input class="inp mono" id="${id}In" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">
    <button class="btn ghostbtn" type="submit">Save</button></form>`;

function renderingHtml() {
  const s = state.settings;
  const b = state.blender;
  return `<div class="card glass"><h2 class="label">Rendering</h2>
    <div class="field"><span class="flabel" id="rendererLabel">Renderer</span>
      <div class="chips seg" role="radiogroup" aria-labelledby="rendererLabel">
        <button class="chip" type="button" role="radio" aria-checked="${s.renderer !== 'blender' || !b?.found}" data-act="renderer" data-value="three">In-app</button>
        <button class="chip" type="button" role="radio" aria-checked="${s.renderer === 'blender' && Boolean(b?.found)}" data-act="renderer" data-value="blender" ${b?.found ? '' : 'disabled'}>Blender (Cycles)</button>
      </div></div>
    <div class="field"><span class="flabel">Blender</span>
      <div class="inp ${b?.found ? 'mono' : 'warn'}" title="${esc(b?.path || '')}">${b?.found ? esc(b.path) : 'Not found · install Blender 4.x to render'}</div>
      <button class="btn sec" type="button" data-act="blender">${icon('folder')}<span>Locate Blender</span></button></div>
    ${pathForm('blenderField', 'blenderPath', 'Blender path', s.blenderPath, s.platform === 'win32' ? 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe' : '/Applications/Blender.app')}
    <div class="field"><label class="flabel" for="defaultScene">Default scene</label>
      <select class="inp" id="defaultScene" name="defaultScene">${SCENES.map(([k, l]) => `<option value="${k}" ${s.defaultScene === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <label class="tg"><span>Always also render the transparent look</span><input class="sw" type="checkbox" role="switch" name="alsoTransparent" ${s.alsoTransparent ? 'checked' : ''}></label>
  </div>`;
}

function outputHtml() {
  const s = state.settings;
  return `<div class="card glass"><h2 class="label">Output folder</h2>
    <div class="field"><span class="flabel">Default output folder</span>
      <div class="inp mono" title="${esc(s.outputRoot)}">${s.outputRoot ? esc(s.outputRoot) : `<span class="muted">Not set · suggested ${esc(s.suggestedOutputRoot)}</span>`}</div>
      <button class="btn ghostbtn" type="button" data-act="output">${icon('folder')}<span>Change</span></button></div>
    ${pathForm('outputField', 'outputRoot', 'Output folder', s.outputRoot || s.suggestedOutputRoot, s.suggestedOutputRoot)}
    <p class="fine">Each car gets its own folder inside it: frames, web sprite sheets, stills, model files and HANDOFF.md.</p>
  </div>`;
}

// The last check's result. Skipping a version only hides the banner; this still offers it.
function updateStatus() {
  const u = state.update;
  if (checking) return 'Checking…';
  const at = u?.checkedAt ? ` · last checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  if (u?.newer) return `<b>Flatform ${esc(u.latest)} is ready</b><a class="btn sm pri" href="${esc(u.downloadUrl)}" target="_blank" rel="noopener">${icon('download')}<span>Download</span></a>`;
  if (u?.failed) return `Couldn't check right now${at}`;
  return u?.checkedAt ? `✓ You're up to date${at}` : 'Not checked yet';
}

function appearanceHtml() {
  const th = normalizeTheme(state.settings.theme);
  const c = resolveTheme(th);
  const ratio = contrast(c.text, c.bg);
  return `<div class="card glass"><h2 class="label">Theme</h2>
    <p class="fine">Changes the app's look only. Models, scenes, materials and renders never change.</p>
    <div class="chips" role="radiogroup" aria-label="Theme">${Object.entries(THEMES).map(([k, p]) => `<button class="chip" type="button" role="radio" aria-checked="${th.preset === k}" data-act="theme" data-value="${k}"><span class="swatch" style="background:${p.primary}"></span>${esc(p.label)}</button>`).join('')}</div>
    ${['primary', 'secondary', 'accent'].map((k) => `<div class="field"><span class="flabel">${k[0].toUpperCase() + k.slice(1)}</span><input class="inp" type="color" data-theme-color="${k}" value="${c[k]}" aria-label="${k} color"></div>`).join('')}
    <p class="fine">Text contrast ${ratio.toFixed(1)}:1${ratio >= AAA ? ' (meets WCAG AAA)' : ''}</p>
    <button class="btn ghostbtn" type="button" data-act="theme-reset">Reset to Flatform Dark</button>
  </div>`;
}

let git = null;
async function loadGit() {
  try { git = await api('/api/history/git'); } catch (e) { git = { error: e.message }; }
  redraw();
}
function historyHtml() {
  const s = state.settings;
  if (s.gitRepo && !git) setTimeout(loadGit);
  return `<div class="card glass"><h2 class="label">Version history</h2>
    <div class="field"><span class="flabel">Project folder</span><div class="inp mono">${s.gitRepo ? esc(s.gitRepo) : '<span class="muted">Not set</span>'}</div>
      <button class="btn ghostbtn" type="button" data-act="git-repo">${icon('folder')}<span>Choose</span></button></div>
    <p class="fine">Roll back is always safe: a revert commit or a new branch. Nothing is reset, force pushed or deleted. In Compose, Ctrl+Z and Ctrl+Shift+Z undo and redo scene edits.</p>
    ${git?.error ? `<p class="form-error">${esc(git.error)}</p>` : ''}
    ${git?.commits ? `<p class="fine">Branch <b>${esc(git.branch)}</b></p><ul class="histlist">${git.commits.map((c, i) => `<li><span class="mono">${esc(c.short)}</span> ${esc(c.subject)} <small class="muted">${esc(new Date(c.date).toLocaleString())}</small>
      ${i ? `<button class="btn sm ghostbtn" type="button" data-act="rollback" data-mode="branch" data-sha="${esc(c.sha)}">New branch here</button><button class="btn sm ghostbtn" type="button" data-act="rollback" data-mode="revert" data-sha="${esc(c.sha)}">Revert to this</button>` : '<small>current</small>'}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function aboutHtml() {
  const s = state.settings;
  return `<div class="card glass"><h2 class="label">Updates</h2>
    <div class="field"><span class="flabel">Version</span><div class="inp">Flatform ${esc(s.version)}</div>
      <a class="btn ghostbtn" href="${RELEASES}" target="_blank" rel="noopener">${icon('external')}<span>Releases</span></a></div>
    <div class="field"><span class="flabel">Latest</span><span class="ures" role="status">${updateStatus()}</span>
      <button class="btn ghostbtn" type="button" data-act="check-update">${icon('retry')}<span>Check for updates</span></button></div>
    <label class="tg"><span>Check for updates automatically<small>A few seconds after Flatform starts, then every 6 hours</small></span><input class="sw" type="checkbox" role="switch" id="autoCheck" name="autoCheck" ${s.updates?.autoCheck ? 'checked' : ''}></label>
    <p class="fine">Flatform only asks GitHub which version is the newest. Download opens the installer on GitHub in your browser; nothing is downloaded or installed on its own.</p>
  </div>
  <div class="card glass"><h2 class="label">About</h2>
    <div class="field"><span class="flabel">Library location</span><div class="inp mono" title="${esc(s.libraryDir)}">${esc(s.libraryDir)}</div>
      <button class="btn ghostbtn" type="button" data-act="show-library" ${native ? '' : 'disabled title="Available in the desktop app"'}>${icon('folder')}<span>Show</span></button></div>
    <p class="fine">Unofficial app for the Tripo and 3D AI Studio APIs; not affiliated with either. You pay them directly in credits.</p>
  </div>`;
}

// ---- Spend: what each paid call cost, from the ledger (ledger.mjs), and the low-balance alert ----
const money = (usd) => (usd == null ? '' : `$${Number(usd).toFixed(2)}`);
const spent = (x) => `${fmt(x.credits)} <span class="muted">${money(x.usd)}</span>`;

// Last 30 days as stacked bars, Tripo under 3D AI Studio. Plain SVG; each bar has its day and credits as a tooltip.
function chart(days) {
  const ids = Object.keys(PROVIDERS).filter((id) => !PROVIDERS[id].local); // free runs add nothing to the bars
  const colors = { tripo: 'var(--accent)', '3daistudio': 'var(--soft)' };
  const max = Math.max(1, ...days.map((d) => ids.reduce((s, id) => s + d[id], 0)));
  const w = 10;
  const h = 90;
  const bars = days.map((d, i) => {
    let y = h;
    return ids.map((id) => {
      const bh = (d[id] / max) * h;
      y -= bh;
      return bh ? `<rect x="${i * (w + 4)}" y="${y.toFixed(1)}" width="${w}" height="${bh.toFixed(1)}" rx="2" style="fill:${colors[id]}"><title>${d.day} · ${PROVIDERS[id].name} ${fmt(d[id])} credits</title></rect>` : '';
    }).join('');
  }).join('');
  const total = days.reduce((s, d) => s + ids.reduce((t, id) => t + d[id], 0), 0);
  return `<svg viewBox="0 0 ${days.length * (w + 4)} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${fmt(total)} credits over the last 30 days">${bars}</svg>
    <p class="fine">${ids.map((id) => `<span style="color:${colors[id]}">■</span> ${PROVIDERS[id].name}`).join(' &nbsp; ')} · ${esc(days[0]?.day)} to ${esc(days.at(-1)?.day)}</p>`;
}

function spendCard(id, s) {
  const p = PROVIDERS[id];
  const left = s.balance == null ? 'Balance unknown · add a key or press Test' : `${fmtBalance(s.balance)} credits${s.daysLeft != null ? ` · about ${fmt(s.daysLeft)} days left at ${fmt(s.burn)} a day` : ''}`;
  return `<div class="card glass"><h2 class="label">${p.name}</h2>
    <div class="field"><span class="flabel">Balance</span><div class="inp ${s.low ? 'warn' : ''}">${s.low ? 'Low · ' : ''}${esc(left)}</div>
      <button class="btn ghostbtn" type="button" data-act="topup" data-service="${id}">${icon('external')}<span>Top up</span></button></div>
    <div class="field"><span class="flabel">Spent</span><div class="inp">Today ${spent(s.today)} · Week ${spent(s.week)} · Month ${spent(s.month)} · All time ${spent(s.all)}</div></div>
    <div class="field"><label class="flabel" for="thr-${id}">Alert under</label>
      <input class="inp" id="thr-${id}" type="number" min="0" step="10" name="threshold" data-service="${id}" value="${s.threshold}"></div>
    ${s.unlogged ? `<p class="fine">${fmt(s.unlogged)} credits left the balance beyond what Flatform expected (balance checks before and after each call).</p>` : ''}
  </div>`;
}

function spendHtml() {
  const sp = state.spend;
  if (!sp) return '<div class="card glass"><h2 class="label">Spend</h2><p class="fine">Loading…</p></div>';
  const rows = sp.models.map((m) => `<tr><td>${esc(PROVIDERS[m.service]?.name)}</td><td>${esc(m.model)}</td><td>${fmt(m.calls)}</td><td>${fmt(m.credits)}</td><td>${money(m.usd)}</td></tr>`).join('');
  return `${Object.entries(sp.services).map(([id, s]) => spendCard(id, s)).join('')}
    <div class="card glass"><h2 class="label">Last 30 days</h2>${chart(sp.daily)}</div>
    <div class="card glass"><h2 class="label">Cost per model</h2>
      ${rows ? `<table class="spendt"><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Credits</th><th>USD</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="fine">No paid calls yet.</p>'}</div>
    ${sp.free?.calls ? `<p class="fine">Local (free): ${fmt(sp.free.calls)} models made on this PC · $0.00</p>` : ''}
    <p class="fine">Credits are what each call costs on the providers' price lists. US dollars are an estimate at ${Object.entries(sp.usdPerCredit).map(([id, r]) => `${PROVIDERS[id].name} $${r}`).join(', ')} per credit. Flatform warns once a session when a balance drops under its alert.</p>`;
}

export function update() {
  if (!state.settings || !root?.isConnected) return;
  const html = { providers: providersHtml, spend: spendHtml, rendering: renderingHtml, output: outputHtml, appearance: appearanceHtml, history: historyHtml, about: aboutHtml }[section]();
  const box = $('#settings', root);
  // Keep the page as it is while someone is typing in it.
  const focused = box.contains(document.activeElement) ? document.activeElement : null;
  const typing = !forced && focused?.matches('input:not([type=checkbox])');
  forced = false;
  if (box.dataset.html === html || typing) return;
  box.dataset.html = html;
  box.innerHTML = html;
  // Put keyboard focus back on the same control.
  const d = focused?.dataset || {};
  const same = focused?.id ? `#${CSS.escape(focused.id)}` : d.act ? `[data-act="${d.act}"]${d.value ? `[data-value="${d.value}"]` : ''}${d.provider ? `[data-provider="${d.provider}"]` : ''}` : null;
  if (same) box.querySelector(same)?.focus();
}
