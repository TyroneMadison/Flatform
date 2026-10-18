// 07 · Settings: Tripo account, generation defaults, rendering, app. Only non-secret values are stored here;
// the API key stays in the OS keychain (desktop app) and is never sent to this page.
import { $, esc, state, api, send, toast, refresh, refreshAccount, openKeyDialog, native, fmt } from '../app.js';
import { icon } from '../lib/icons.js';

const SCENES = [['gold', 'Escalade gold-ring studio'], ['transparent', 'Transparent'], ['cyclorama', 'White cyclorama'], ['miami', 'Miami street at night (your HDRI)'], ['custom', 'Your backdrop or HDRI']];
const RELEASES = 'https://github.com/TyroneMadison/Flatform/releases';
let root;

export function mount(el) {
  root = el;
  el.innerHTML = `<h1 class="ph">Settings</h1><section class="settings" id="settings"></section>`;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('submit', onSubmit);
  update();
}

const save = async (data) => {
  try { state.settings = await send('/api/settings', 'POST', data); state.blender = await api('/api/blender'); } catch (e) { toast(e.message); }
  refresh();
};

async function onClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const s = state.settings;
  const act = t.dataset.act;
  if (act === 'key') openKeyDialog();
  if (act === 'refresh') { await refreshAccount(); toast(state.account?.error || 'Balance updated', state.account?.error ? 'error' : 'info'); }
  if (act === 'region') save({ region: t.dataset.value });
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
  if (act === 'show-library') native?.showItemInFolder(s.libraryDir).catch((err) => toast(err.message));
}

function showField(id) {
  const f = $(`#${id}`, root);
  f.hidden = false;
  f.querySelector('input').focus();
}

function onChange(e) {
  const t = e.target;
  if (t.name === 'texture' || t.name === 'pbr' || t.name === 'alsoTransparent') save({ [t.name]: t.checked });
  if (t.name === 'defaultScene') save({ defaultScene: t.value });
  if (t.name === 'model') save({ model: t.value.trim() });
}

function onSubmit(e) {
  e.preventDefault();
  const input = e.target.querySelector('input');
  save({ [input.name]: input.value.trim() });
}

export function update() {
  const s = state.settings;
  const a = state.account;
  const b = state.blender;
  if (!s) return;
  const pathForm = (id, name, label, value, placeholder) => `
    <form class="field pathform" id="${id}" hidden><label for="${id}In">${label}</label>
      <input class="inp mono" id="${id}In" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">
      <button class="btn ghostbtn" type="submit">Save</button></form>`;
  const html = `
  <div class="setcol">
    <div class="card glass"><h2 class="label">Tripo account</h2>
      <div class="field"><span class="flabel">API key</span><div class="inp mono">${a?.hasKey ? 'tsk_••••••••••••••••' : 'No key yet'}</div><button class="btn ghostbtn" type="button" data-act="key">${a?.hasKey ? 'Change key' : 'Add key'}</button></div>
      <p class="fine">Encrypted by Windows (DPAPI) or the macOS Keychain. Only ever sent to Tripo. Get a key at developers.tripo3d.com/en/keys.</p>
      <div class="field"><span class="flabel" id="regionLabel">Region</span>
        <div class="chips seg" role="radiogroup" aria-labelledby="regionLabel">
          ${Object.entries(s.regions).map(([k, url]) => `<button class="chip" type="button" role="radio" aria-checked="${s.region === k}" data-act="region" data-value="${k}">${k === 'global' ? 'Global' : 'China'} · ${esc(new URL(url).host)}</button>`).join('')}
        </div></div>
      <div class="field"><span class="flabel">Credit balance</span>
        <div class="inp" role="status">${a?.hasKey ? `${fmt(a.balance)} credits · ${fmt(a.frozen || 0)} frozen` : a?.error ? esc(a.error) : 'Shown from your Tripo account'}</div>
        <button class="btn ghostbtn" type="button" data-act="refresh">${icon('retry')}<span>Refresh</span></button></div>
    </div>
    <div class="card glass"><h2 class="label">Generation defaults</h2>
      <div class="field"><label class="flabel" for="model">Tripo model</label><input class="inp mono" id="model" name="model" value="${esc(s.model)}" spellcheck="false"></div>
      <label class="tg"><span>Textures</span><input class="sw" type="checkbox" role="switch" name="texture" ${s.texture ? 'checked' : ''}></label>
      <label class="tg"><span>PBR materials<small>Metal and roughness maps for realistic paint</small></span><input class="sw" type="checkbox" role="switch" name="pbr" ${s.pbr ? 'checked' : ''} ${s.texture ? '' : 'disabled'}></label>
    </div>
  </div>
  <div class="setcol">
    <div class="card glass"><h2 class="label">Rendering</h2>
      <div class="field"><span class="flabel" id="rendererLabel">Renderer</span>
        <div class="chips seg" role="radiogroup" aria-labelledby="rendererLabel">
          <button class="chip" type="button" role="radio" aria-checked="${s.renderer !== 'blender' || !b?.found}" data-act="renderer" data-value="three">In-app</button>
          <button class="chip" type="button" role="radio" aria-checked="${s.renderer === 'blender' && Boolean(b?.found)}" data-act="renderer" data-value="blender" ${b?.found ? '' : 'disabled'}>Blender (Cycles)</button>
        </div></div>
      <div class="field"><span class="flabel">Blender</span>
        <div class="inp ${b?.found ? 'mono' : 'warn'}" title="${esc(b?.path || '')}">${b?.found ? esc(b.path) : 'Not found · install Blender 4.x to render'}</div>
        <button class="btn sec" type="button" data-act="blender">${icon('folder')}<span>Locate Blender</span></button></div>
      ${pathForm('blenderField', 'blenderPath', 'Blender path', s.blenderPath, s.platform === 'win32' ? 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe' : '/Applications/Blender.app')}
      <div class="field"><span class="flabel">Default output folder</span>
        <div class="inp mono" title="${esc(s.outputRoot)}">${s.outputRoot ? esc(s.outputRoot) : `<span class="muted">Not set · suggested ${esc(s.suggestedOutputRoot)}</span>`}</div>
        <button class="btn ghostbtn" type="button" data-act="output">${icon('folder')}<span>Change</span></button></div>
      ${pathForm('outputField', 'outputRoot', 'Output folder', s.outputRoot || s.suggestedOutputRoot, s.suggestedOutputRoot)}
      <div class="field"><label class="flabel" for="defaultScene">Default scene</label>
        <select class="inp" id="defaultScene" name="defaultScene">${SCENES.map(([k, l]) => `<option value="${k}" ${s.defaultScene === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="tg"><span>Always also render the transparent look</span><input class="sw" type="checkbox" role="switch" name="alsoTransparent" ${s.alsoTransparent ? 'checked' : ''}></label>
    </div>
    <div class="card glass"><h2 class="label">App</h2>
      <div class="field"><span class="flabel">Library location</span><div class="inp mono" title="${esc(s.libraryDir)}">${esc(s.libraryDir)}</div>
        <button class="btn ghostbtn" type="button" data-act="show-library" ${native ? '' : 'disabled title="Available in the desktop app"'}>${icon('folder')}<span>Show</span></button></div>
      <div class="field"><span class="flabel">Version</span><div class="inp">Flatform ${esc(s.version)}</div>
        <a class="btn ghostbtn" href="${RELEASES}" target="_blank" rel="noopener">${icon('external')}<span>Releases</span></a></div>
    </div>
  </div>`;
  const box = $('#settings', root);
  // Keep the page as it is while someone is typing in it.
  if (box.dataset.html !== html && !box.contains(document.activeElement?.matches('input:not([type=checkbox])') ? document.activeElement : null)) {
    box.dataset.html = html;
    box.innerHTML = html;
  }
}
