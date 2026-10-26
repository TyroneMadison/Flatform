// Warframe home (redesign mock-up screen 02): drag pictures anywhere, "Add new picture", New Warframe from a
// picture, Open my model, the template tiles and the TennoGen-ready note. Everything created from here is stamped
// workspace: 'warframe', so Compose and Render show the Warframe tools and the TennoGen check.
import { $, esc, state, openPicker, thumbOf, statusText, statusClass } from '../app.js';
import { icon } from '../lib/icons.js';
import { attachImportFlow } from '../lib/import-flow.js';

let root;
let off;
// Start from a template: the TennoGen content type the texture check will expect (the picture still comes from you).
const TEMPLATES = [['warframe', 'Full skin', '#3c2f55'], ['helmet', 'Helmet only', '#553c2f'], ['syandana', 'Syandana', '#2f4555'], ['weapon', 'Weapon', '#2f553c']];

export function mount(el) {
  root = el;
  state.workspace = 'warframe';
  el.innerHTML = `<section class="gt" aria-label="Warframe home">
    <h1 class="ph"><span aria-hidden="true">${icon('cube', 40)}</span>Warframe</h1>
    <p class="sub">Start a new skin or open one you already have.</p>
    <div class="dz2" data-import="zone" role="group" aria-label="Drop pictures here">
      ${icon('upload', 56)}
      <div class="big">Drag pictures here</div>
      <p class="muted">or</p>
      <button class="bigbtn" type="button" data-import="pick" title="Pick a picture from this computer">${icon('plus', 22)}Add new picture</button>
    </div>
    <div class="grid g2">
      <button class="bigbtn tall" type="button" data-import="pick" title="Make a 3D Warframe from a picture">${icon('plus', 26)}New from a picture</button>
      <button class="pick tall" type="button" data-act="open-model" title="Open a 3D file you already have">${icon('folder', 26)}Open my model</button>
    </div>
    <h3>Start from a template</h3>
    <div class="grid g4" role="group" aria-label="Templates">${TEMPLATES.map(([type, label, color]) => `<button class="tile" type="button" data-template="${type}" aria-pressed="${state.tennogenType === type}" title="Start a ${label.toLowerCase()}, then pick a picture"><div class="th" style="background:${color}"></div>${label}</button>`).join('')}</div>
    <div class="card"><div class="row"><span class="pill2 ok">✓ TennoGen ready</span><span class="muted">Sizes, names and paint pictures are checked for you when you save.</span></div></div>
    <h3>Your Warframes</h3>
    <div class="grid g4" id="wfRecent"></div>
  </section>`;
  off = attachImportFlow(el, { workspace: 'warframe', text: 'Drop pictures here' });
  el.addEventListener('click', onClick);
  update();
}

export function unmount() { off?.(); }

function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.act === 'open-model') { // the same picker; 3D files skip Generate and open in Compose
    const p = $('#filePicker');
    const was = p.accept;
    p.accept = '.glb,.gltf,.fbx,.obj,.usdz';
    p.addEventListener('change', () => { p.accept = was; }, { once: true });
    openPicker();
  }
  if (t.dataset.template) {
    state.tennogenType = t.dataset.template; // the TennoGen check on Render starts with this content type
    $$('[data-template]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
    openPicker();
  }
}
const $$ = (s) => [...root.querySelectorAll(s)];

export function update() {
  if (!root?.isConnected) return;
  const mine = state.models.filter((m) => m.workspace === 'warframe').slice(0, 8);
  const html = mine.map((m) => `<a class="tile" href="#/model/${m.id}"><div class="th">${thumbOf(m) ? `<img src="${thumbOf(m)}" alt="">` : ''}</div>${esc(m.name)}<small class="st ${statusClass(m)}">${esc(statusText(m))}</small></a>`).join('')
    || '<p class="muted">Your Warframes will show up here.</p>';
  const box = $('#wfRecent', root);
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}
