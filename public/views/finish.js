// Finish: check a model before export and fix what can be fixed. The original file is
// never changed: fixes are saved as a copy in the render folder (fixed/<name>-fixed.glb).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { esc, findModel, focusModel, fileUrl, toast, announce, activeWorkspace } from '../app.js';
import { checkScene, applyFix } from '../lib/health.js';
import { mountTools, unmountTools } from './finish-tools.js';

let root, m, tree = null, report = null, fixed = [];
const tenno = () => activeWorkspace()?.kind === 'warframe';
export const slug = s => String(s || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';

export async function mount(el, { id }) {
  root = el; m = findModel(id) || focusModel(); tree = null; report = null; fixed = [];
  el.innerHTML = `<div class="libhead"><div><h1 class="ph">Check and finish</h1>
    <p class="sub keep">${m ? esc(m.name) + ' · make sure it is right before you save it' : 'Pick a model in the Library first.'}</p></div></div>
    <section class="finish"><div class="card glass" id="health" aria-live="polite"></div><div id="finish-more"></div></section>`;
  el.addEventListener('click', onClick);
  draw();
  if (m) mountTools(el.querySelector('#finish-more'), m, () => tree);
  if (m?.glb) runCheck();
}

async function loadTree() {
  const draco = new DRACOLoader().setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/');
  try { return (await new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).loadAsync(fileUrl(m, m.glb))).scene; }
  finally { draco.dispose(); }
}

async function runCheck() {
  report = { running: true }; draw();
  try { tree ||= await loadTree(); report = checkScene(tree, { tennogen: tenno() }); }
  catch (e) { report = { error: e.message }; }
  draw();
  if (report.checks) announce(report.pass ? 'Check finished. Ready to save.' : `Check finished. ${report.checks.filter(c => c.level === 'error').length} things need fixing.`);
}

const LEVEL = { error: 'Needs fixing', warn: 'Worth a look' };
function draw() {
  const h = root.querySelector('#health'); if (!h) return;
  if (!m?.glb) { h.innerHTML = `<p class="sub keep">There is no 3D model to check yet.</p>`; return; }
  const head = `<h2 class="label">Check before saving</h2>`;
  if (!report || report.running) { h.innerHTML = `${head}<p class="hc-status">Checking the model…</p>`; return; }
  if (report.error) { h.innerHTML = `${head}<p class="hc-status bad">Could not open the model: ${esc(report.error)}</p><button class="btn pri" data-f="check" title="Load the model and check it again">Try again</button>`; return; }
  h.innerHTML = `${head}
    <p class="hc-status ${report.pass ? 'ok' : 'bad'}">${report.pass ? (report.clean ? 'All good. Ready to save.' : 'Ready to save, with a few things worth a look.') : 'Not ready yet. Fix the items below.'}</p>
    <p class="fine keep">${report.tris.toLocaleString()} pieces in ${report.meshes} parts${tenno() ? ' · checked against TennoGen limits' : ''}.</p>
    <ul class="hc-list">${report.checks.map(c => `<li class="hc ${c.level === 'error' ? 'bad' : 'warn'}">
      <span class="hc-tag">${LEVEL[c.level]}</span><span class="hc-label">${esc(c.label)}${c.names?.length ? `<span class="fine keep"> ${esc(c.names.slice(0, 4).join(', '))}${c.names.length > 4 ? '…' : ''}</span>` : ''}</span>
      ${c.fix ? `<button class="btn sec sm" data-f="fix" data-id="${c.id}" title="Fix this here. Your original file stays the same.">Fix it</button>` : ''}</li>`).join('')}</ul>
    <div class="row"><button class="btn sec" data-f="check" title="Run the check one more time">Check again</button>
    ${fixed.length ? `<button class="btn pri" data-f="save" title="Save a fixed copy in the render folder">Save fixed copy</button>` : ''}</div>
    ${fixed.length ? `<p class="fine keep">Fixes are only here until you save. Your original file is never changed.</p>` : ''}`;
}

async function saveFixed() {
  if (!m.renders?.outDir) return toast('Render this model once first, so it has a folder to save the fixed copy in.', 'warn');
  try {
    const glb = await new GLTFExporter().parseAsync(tree, { binary: true });
    const rel = `fixed/${slug(m.name)}-fixed.glb`;
    const r = await fetch(`/api/renders/${encodeURIComponent(m.id)}/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: glb });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    toast(`Saved ${rel} in the render folder.`, 'ok'); fixed = []; draw();
  } catch (e) { toast(`Could not save the fixed copy: ${e.message}`, 'bad'); }
}

function onClick(e) {
  const b = e.target.closest('[data-f]'); if (!b) return;
  const a = b.dataset.f;
  if (a === 'check') runCheck();
  else if (a === 'fix' && tree) {
    const n = applyFix(tree, b.dataset.id, { makeMaterial: () => new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: .6 }) });
    if (n) { fixed.push(b.dataset.id); report = checkScene(tree, { tennogen: tenno() }); draw(); announce('Fixed.'); }
    else toast('That one has to be fixed in a 3D app like Blender, not here.', 'warn');
  } else if (a === 'save') saveFixed();
}

export function update() {}
export function unmount() { root?.removeEventListener('click', onClick); unmountTools(); tree = null; }

