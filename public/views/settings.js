// 07 · Settings: providers and keys, rendering, the output folder, updates and about. Only non-secret values are stored
// in settings.json; keys go to the OS keychain and never come back to this page: it only learns whether one is saved.
import { PRESETS as THEMES, normalizeTheme, resolveTheme, applyTheme, contrast, AAA } from '../lib/theme.js';
import { $, esc, state, api, send, toast, refresh, native, fmt, fmtBalance, saveKey, confirmDialog, arrowRadios, refreshUpdate, refreshSpend, topUp } from '../app.js';
import { PROVIDERS } from '../lib/engines.js';
import { icon } from '../lib/icons.js';
import { displayVersion } from '../lib/version.js';
import { blenderStatus } from '../lib/render-status.js';
import { PRESETS } from '../lib/studio.js';
import { EXTRA, EXTRA_HTML, wireExtra } from './settings-extra.js';
import { applyHelpText } from '../lib/help-text.js';

const SCENES = Object.entries(PRESETS).map(([k, p]) => [k, k === 'white-cyc-studio' ? 'White studio (default)' : k === 'miami' ? 'Miami street at night (your photo)' : p.label]);
// The tabs, in plain words (v3): Accounts, Look, Rendering, Folders, Version history, Usage, Shortcuts, Backup, Plugins, About.
const SECTIONS = [['providers', 'Accounts'], ['appearance', 'Look'], ['rendering', 'Rendering'], ['output', 'Folders'], ['history', 'Version history'], ['spend', 'Usage'], ...EXTRA, ['about', 'About and updates']];
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
  <p class="sub">Your accounts, look and folders. Keys stay locked on this computer.</p>
  <div class="set">
    <nav class="sn" aria-label="Settings sections">${SECTIONS.map(([k, label]) => `<a href="#/settings/${k}" title="${label}"${k === section ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <section class="settings" id="settings"></section>
  </div>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  wireExtra(el);
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
  a.frozen ? `${fmt(a.frozen)} on hold` : '',
  provider === '3daistudio' ? `up to ${a.rateLimit || 3} jobs a minute` : '',
].filter(Boolean).join(' · ');
const testedAt = () => `checked ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

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
    if (!(await confirmDialog({ title: `Remove the ${PROVIDERS[provider].name} key?`, text: 'Flatform deletes the saved key from this computer. If a key is also in the setup file, that one is used.', ok: 'Remove key' }))) return;
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
  if (act === 'blender-find') save({ blenderPath: '' }); // forget the picked one and look in the usual places
  if (act === 'theme') { const theme = { preset: t.dataset.value, custom: {} }; applyTheme(theme); save({ theme }); }
  if (act === 'theme-reset') { applyTheme(undefined); save({ theme: { preset: 'dark', custom: {} } }); }
  if (act === 'git-repo') {
    const dir = native ? await native.pickFolder() : prompt('Paste the full path of your project folder');
    if (dir) { await save({ gitRepo: dir.trim() }); loadGit(); }
  }
  if (act === 'git-load') loadGit();
  if (act === 'rollback') {
    const { sha, mode } = t.dataset;
    const text = mode === 'revert' ? `Add a new save point that undoes every change after ${sha.slice(0, 7)}. Nothing is deleted.` : `Make a new copy from ${sha.slice(0, 7)} and switch to it. Your current work stays as it is.`;
    if (!(await confirmDialog({ title: 'Go back to this version?', text, ok: mode === 'revert' ? 'Undo changes' : 'New copy' }))) return;
    try { await send('/api/history/rollback', 'POST', { sha, mode }); toast(mode === 'revert' ? 'Done. The later changes are undone.' : 'Done. You are on the new copy.', 'info'); } catch (err) { toast(err.message); }
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
  if (t.name === 'showHelp') { applyHelpText({ showHelp: t.checked }); save({ showHelp: t.checked }); }
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
  const pill = { saved: ['ok', 'Saved · locked'], env: ['env', 'From setup file'], none: ['none', 'No key'] }[source];
  // Tripo has two hosts (global and China); the header picks one.
  const sub = id === 'tripo'
    ? `<label class="sr-only" for="region">Tripo server</label><select class="hostsel" id="region" name="region" title="Pick the Tripo server for where you live">${Object.entries(s.regions).map(([k, url]) => `<option value="${k}"${s.region === k ? ' selected' : ''}>${k === 'china' ? 'China server' : 'Worldwide server'} · ${esc(new URL(url).host)}</option>`).join('')}</select>`
    : `<span>${esc(p.host)}</span>`;
  const r = results[id];
  const field = replacing === id
    ? `<form class="kf" data-provider="${id}"><label class="sr-only" for="key-${id}">New ${p.name} key</label>
        <input class="in" id="key-${id}" type="password" autocomplete="off" spellcheck="false" placeholder="${esc(p.keyHint || 'Paste the new key')}" title="Paste your ${esc(p.name)} key here" required>
        <button class="btn sm pri" type="submit" title="Save the key and check it works">Save</button><button class="btn sm ghostbtn" type="button" data-act="cancel" title="Close without saving">Cancel</button></form>`
    : `<div class="kf"><div class="in" aria-label="${source === 'none' ? 'No key saved' : 'Key saved, hidden'}">${source === 'none' ? '<span class="muted">No key yet</span>' : '<span aria-hidden="true">••••••••••••••••••••••••</span>'}<em>${source === 'env' ? 'from setup file' : source === 'saved' ? 'hidden' : ''}</em></div>
        <button class="btn sm ghostbtn" type="button" data-act="test" data-provider="${id}" title="Check the key works and see your credits. Free."${source === 'none' ? ' disabled' : ''}>Check key</button>
        <button class="btn sm ghostbtn" type="button" data-act="replace" data-provider="${id}" title="Paste a new key">${source === 'none' ? 'Add key' : 'Change key'}</button>
        <button class="btn sm ghostbtn" type="button" data-act="remove" data-provider="${id}" title="Delete the saved key from this computer"${source === 'saved' ? '' : ' disabled'}>Remove</button></div>`;
  return `<div class="pc glass" aria-labelledby="pc-${id}">
    <div class="ph2"><div class="av" aria-hidden="true">${id === 'tripo' ? 'T' : '3D'}</div><div><b id="pc-${id}">${p.name}</b><p>${sub}</p></div><span class="pill ${pill[0]}">● ${pill[1]}</span></div>
    ${field}
    <div class="res${r ? (r.ok === false ? ' bad' : r.ok ? ' ok' : '') : ''}" id="pc-res-${id}" role="status">${r ? `${r.ok === false ? '✗' : r.ok ? '✓' : ''} ${esc(r.text)}` : `<span>Get a key at <a href="${p.keyUrl}" target="_blank" rel="noopener">${esc(new URL(p.keyUrl).host)}</a>. Checking a key is free.</span>`}</div>
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
  if (!l) { loadLocal().then(redraw); return '<div class="pc glass"><b>Local (free)</b><p class="fine keep">Checking…</p></div>'; }
  const d = l.download || {};
  const status = l.error ? l.error : d.running ? `Downloading ${esc(d.file || '')} · ${gb(d.done || 0)} of about 3.3 GB`
    : l.ready ? 'Ready. Pick Local (free) when you make a model.' : d.error ? `${d.error}` : 'Not downloaded yet. About 3.3 GB, one time.';
  return `<div class="pc glass" aria-labelledby="pc-local">
    <div class="ph2"><div class="av" aria-hidden="true">PC</div><div><b id="pc-local">Local (free)</b><p><span>TRELLIS on your graphics card · $0 per model</span></p></div>
      <span class="pill ${l.ready ? 'ok' : 'none'}">● ${l.ready ? 'Ready' : 'Not set up'}</span></div>
    <p class="fine keep">Graphics card: ${l.gpu?.ok ? `${esc(l.gpu.name)} · ${l.gpu.memoryGB} GB` : esc(l.gpu?.error || 'unknown')}</p>
    <p class="fine keep">Detail Boost: ${l.upscaler ? 'ready' : 'comes with the download (64 MB)'}</p>
    <p class="fine keep">Saved in <span class="mono">${esc(l.weightsDir || '')}</span></p>
    ${d.running ? `<progress max="${3.3 * 1024 ** 3}" value="${d.done || 0}" style="width:100%"></progress>` : ''}
    <div class="kf"><button class="btn sm pri" type="button" data-act="local-download" title="Download the free maker to this computer, one time"${d.running || (l.ready && l.upscaler) ? ' disabled' : ''}>${d.error ? 'Try again' : 'Download'}</button></div>
    <div class="res${d.error ? ' bad' : l.ready ? ' ok' : ''}" role="status">${esc(status)}</div>
  </div>`;
}

function providersHtml() {
  const s = state.settings;
  return `<div class="def"><h2 class="label" id="defK">Main service</h2>
      <div class="prov" role="radiogroup" aria-labelledby="defK">${Object.entries(PROVIDERS).map(([id, p]) => `<button type="button" role="radio" aria-checked="${s.provider === id}" class="${s.provider === id ? 'on' : ''}" data-act="provider" data-value="${id}" title="Make models with ${esc(p.name)} unless you pick another"><b>${p.name}</b><span>${p.sub}</span></button>`).join('')}</div>
      <p class="fine">You can still pick another one each time you make a model.</p></div>
    ${Object.keys(PROVIDERS).map(card).join('')}
    <p class="fine">Keys stay locked on this computer and only go to their own service. Checking a key is free.</p>`;
}

const pathForm = (id, name, label, value, placeholder) => `
  <form class="field pathform" id="${id}" hidden><label for="${id}In">${label}</label>
    <input class="inp mono" id="${id}In" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" title="Type or paste the full path" spellcheck="false">
    <button class="btn ghostbtn" type="submit" title="Save this path">Save</button></form>`;

function renderingHtml() {
  const s = state.settings;
  const b = state.blender;
  return `<div class="card glass"><h2 class="label">How pictures are made</h2>
    <div class="field"><span class="flabel" id="rendererLabel">Picture maker</span>
      <div class="chips seg" role="radiogroup" aria-labelledby="rendererLabel">
        <button class="chip" type="button" role="radio" aria-checked="${s.renderer !== 'blender' || !b?.found}" data-act="renderer" data-value="three" title="Renders inside Flatform. Quick, and needs nothing else.">In-app</button>
        <button class="chip" type="button" role="radio" aria-checked="${s.renderer === 'blender' && Boolean(b?.found)}" data-act="renderer" data-value="blender" ${b?.found ? '' : 'disabled'} title="${b?.found ? 'Renders in Blender. Slower, more realistic light.' : 'Needs Blender. Click Browse below to show Flatform where it is.'}">Blender (Cycles)</button>
      </div></div>
    <div class="field"><span class="flabel">Where Blender is</span>
      <div class="inp ${b?.found ? '' : 'warn'}" id="blenderStatus" role="status" title="${esc(b?.found ? b.path : 'Flatform looked in the usual places and did not find Blender. Click Browse and pick blender.exe.')}">${esc(blenderStatus(b))}</div>
      <button class="btn sec" type="button" data-act="blender" title="Pick the Blender program (blender.exe) yourself">${icon('folder')}<span>Browse</span></button>
      <button class="btn ghostbtn" type="button" data-act="blender-find" title="Look for Blender again in the usual places">Find again</button></div>
    ${b?.found ? `<p class="fine mono keep" title="Where Flatform runs Blender from">${esc(b.path)}</p>` : ''}
    ${pathForm('blenderField', 'blenderPath', 'Where Blender is', s.blenderPath, s.platform === 'win32' ? 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe' : '/Applications/Blender.app')}
    <div class="field"><label class="flabel" for="defaultScene">Starting scene</label>
      <select class="inp" id="defaultScene" name="defaultScene" title="The scene a new model starts in">${SCENES.map(([k, l]) => `<option value="${k}" ${s.defaultScene === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <label class="tg" title="Each render also saves a copy with no background"><span>Also make a no-background copy</span><input class="sw" type="checkbox" role="switch" name="alsoTransparent" ${s.alsoTransparent ? 'checked' : ''}></label>
  </div>`;
}

function outputHtml() {
  const s = state.settings;
  return `<div class="card glass"><h2 class="label">Where finished cars go</h2>
    <div class="field"><span class="flabel">Send to Dud Rents and pictures save here${s.outputRootIsDefault ? ' (the usual folder)' : ''}</span>
      <div class="inp mono" title="${esc(s.outputRoot)}">${s.outputRoot ? esc(s.outputRoot) : `<span class="muted">Not set · we suggest ${esc(s.suggestedOutputRoot)}</span>`}</div>
      <button class="btn ghostbtn" type="button" data-act="output" title="Pick a different folder">${icon('folder')}<span>Change folder</span></button></div>
    ${pathForm('outputField', 'outputRoot', 'Finished cars folder', s.outputRoot || s.suggestedOutputRoot, s.suggestedOutputRoot)}
    <p class="fine">Each car gets its own folder in here, with its pictures and model files.</p>
  </div>`;
}

// The last check's result. Skipping a version only hides the banner; this still offers it.
function updateStatus() {
  const u = state.update;
  if (checking) return 'Checking…';
  const at = u?.checkedAt ? ` · last checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  if (u?.newer) return `<b>Flatform ${esc(displayVersion(u.latest))} is ready</b><a class="btn sm pri" href="${esc(u.downloadUrl)}" target="_blank" rel="noopener" title="Open the download page in your browser">${icon('download')}<span>Download</span></a>`;
  if (u?.failed) return `Couldn't check right now${at}`;
  return u?.checkedAt ? `✓ You're up to date${at}` : 'Not checked yet';
}

function appearanceHtml() {
  const th = normalizeTheme(state.settings.theme);
  const c = resolveTheme(th);
  const ratio = contrast(c.text, c.bg);
  return `<div class="card glass"><h2 class="label">Theme</h2>
    <p class="fine">Only changes how the app looks. Your models and pictures stay the same.</p>
    <div class="chips" role="radiogroup" aria-label="Theme">${Object.entries(THEMES).map(([k, p]) => `<button class="chip" type="button" role="radio" aria-checked="${th.preset === k}" data-act="theme" data-value="${k}" title="Use the ${esc(p.label)} look"><span class="tswatch" style="background:${p.primary}"></span>${esc(p.label)}</button>`).join('')}</div>
    ${[['primary', 'Main color'], ['secondary', 'Second color'], ['accent', 'Highlight color']].map(([k, l]) => `<div class="field"><span class="flabel">${l}</span><input class="inp" type="color" data-theme-color="${k}" value="${c[k]}" aria-label="${l}" title="Pick the ${l.toLowerCase()}"></div>`).join('')}
    <p class="fine">${ratio >= AAA ? 'Easy to read' : 'Text contrast'} (${ratio.toFixed(1)} to 1)</p>
    <button class="btn ghostbtn" type="button" data-act="theme-reset" title="Go back to the standard dark look">Reset to Flatform Dark</button>
    <label class="tg" title="Shows the small grey lines that explain each setting. Pop-up tips stay on either way."><span>Show help text<small>Small notes under titles and switches</small></span><input class="sw" type="checkbox" role="switch" name="showHelp" ${state.settings.showHelp ? 'checked' : ''}></label>
    <label class="tg" title="Stops moving effects and makes every animation instant. Also on when your computer asks for less motion."><span>Reduce motion<small>No pulsing, spinning or sliding</small></span><input class="sw" type="checkbox" role="switch" id="reduceMotion" ${document.body.classList.contains('rm') ? 'checked' : ''}></label>
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
      <button class="btn ghostbtn" type="button" data-act="git-repo" title="Pick your project folder (a Git folder) to see its save points">${icon('folder')}<span>Choose</span></button></div>
    <p class="fine">Going back is always safe. Nothing is ever deleted. In Compose, Ctrl+Z undoes and Ctrl+Shift+Z redoes.</p>
    ${git?.error ? `<p class="form-error">${esc(git.error)}</p>` : ''}
    ${git?.commits ? `<p class="fine keep">Copy in use: <b>${esc(git.branch)}</b></p><ul class="histlist">${git.commits.map((c, i) => `<li><span class="mono">${esc(c.short)}</span> ${esc(c.subject)} <small class="muted">${esc(new Date(c.date).toLocaleString())}</small>
      ${i ? `<button class="btn sm ghostbtn" type="button" data-act="rollback" data-mode="branch" data-sha="${esc(c.sha)}" title="Start a new copy from this save point. Nothing is lost.">New copy</button><button class="btn sm ghostbtn" type="button" data-act="rollback" data-mode="revert" data-sha="${esc(c.sha)}" title="Undo every change made after this save point">Go back</button>` : '<small>now</small>'}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function aboutHtml() {
  const s = state.settings;
  return `<div class="card glass"><h2 class="label">Updates</h2>
    <div class="field"><span class="flabel">Version</span><div class="inp">Flatform ${esc(displayVersion(s.version))}</div>
      <a class="btn ghostbtn" href="${RELEASES}" target="_blank" rel="noopener" title="See every version on GitHub">${icon('external')}<span>All versions</span></a></div>
    <div class="field"><span class="flabel">Newest</span><span class="ures" role="status">${updateStatus()}</span>
      <button class="btn ghostbtn" type="button" data-act="check-update" title="Ask GitHub if there is a newer version">${icon('retry')}<span>Check now</span></button></div>
    <label class="tg" title="Look for a new version by itself"><span>Check for updates on its own<small>When Flatform opens, then every 6 hours</small></span><input class="sw" type="checkbox" role="switch" id="autoCheck" name="autoCheck" ${s.updates?.autoCheck ? 'checked' : ''}></label>
    <p class="fine">Flatform only asks GitHub for the newest version number. Nothing downloads or installs on its own.</p>
  </div>
  <div class="card glass"><h2 class="label">About</h2>
    <div class="field"><span class="flabel">Where models are kept</span><div class="inp mono" title="${esc(s.libraryDir)}">${esc(s.libraryDir)}</div>
      <button class="btn ghostbtn" type="button" data-act="show-library" title="${native ? 'Open this folder' : 'Only in the desktop app'}" ${native ? '' : 'disabled'}>${icon('folder')}<span>Show</span></button></div>
    <p class="fine">Not made by Tripo or 3D AI Studio. You pay them directly with credits.</p>
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
    <p class="fine keep">${ids.map((id) => `<span style="color:${colors[id]}">■</span> ${PROVIDERS[id].name}`).join(' &nbsp; ')} · ${esc(days[0]?.day)} to ${esc(days.at(-1)?.day)}</p>`;
}

function spendCard(id, s) {
  const p = PROVIDERS[id];
  const left = s.balance == null ? 'Balance unknown · add a key or press Check key' : `${fmtBalance(s.balance)} credits${s.daysLeft != null ? ` · about ${fmt(s.daysLeft)} days left at ${fmt(s.burn)} a day` : ''}`;
  return `<div class="card glass"><h2 class="label">${p.name}</h2>
    <div class="field"><span class="flabel">Balance</span><div class="inp ${s.low ? 'warn' : ''}">${s.low ? 'Low · ' : ''}${esc(left)}</div>
      <button class="btn ghostbtn" type="button" data-act="topup" data-service="${id}" title="Buy more credits on their website">${icon('external')}<span>Top up</span></button></div>
    <div class="field"><span class="flabel">Spent</span><div class="inp">Today ${spent(s.today)} · Week ${spent(s.week)} · Month ${spent(s.month)} · All time ${spent(s.all)}</div></div>
    <div class="field"><label class="flabel" for="thr-${id}">Warn me below</label>
      <input class="inp" id="thr-${id}" type="number" min="0" step="10" name="threshold" data-service="${id}" value="${s.threshold}" title="Warn me when my credits drop below this number"></div>
    ${s.unlogged ? `<p class="fine keep">${fmt(s.unlogged)} more credits were used than Flatform expected.</p>` : ''}
  </div>`;
}

function spendHtml() {
  const sp = state.spend;
  if (!sp) return '<div class="card glass"><h2 class="label">Usage</h2><p class="fine keep">Loading…</p></div>';
  const rows = sp.models.map((m) => `<tr><td>${esc(PROVIDERS[m.service]?.name)}</td><td>${esc(m.model)}</td><td>${fmt(m.calls)}</td><td>${fmt(m.credits)}</td><td>${money(m.usd)}</td></tr>`).join('');
  return `${Object.entries(sp.services).map(([id, s]) => spendCard(id, s)).join('')}
    <div class="card glass"><h2 class="label">Last 30 days</h2>${chart(sp.daily)}</div>
    <div class="card glass"><h2 class="label">Cost per model</h2>
      ${rows ? `<table class="spendt"><thead><tr><th>Service</th><th>Model</th><th>Times</th><th>Credits</th><th>Dollars</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="fine keep">Nothing paid yet.</p>'}</div>
    ${sp.free?.calls ? `<p class="fine keep">Local (free): ${fmt(sp.free.calls)} models made on this PC · $0.00</p>` : ''}
    <p class="fine">Credits come from each service's price list. Dollars are a guess at ${Object.entries(sp.usdPerCredit).map(([id, r]) => `${PROVIDERS[id].name} $${r}`).join(', ')} per credit. Flatform warns you once when credits run low.</p>`;
}

export function update() {
  if (!state.settings || !root?.isConnected) return;
  const html = { providers: providersHtml, spend: spendHtml, rendering: renderingHtml, output: outputHtml, appearance: appearanceHtml, history: historyHtml, about: aboutHtml, ...EXTRA_HTML }[section]();
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
