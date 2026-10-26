// Compose, Remove part (Tools, and Pose before joints): click a stray bit of the model, see it lit up with a small
// card, then Remove or Keep (Esc cancels). Each mesh's loose pieces are found once, in a worker (lib/pieces-worker.js),
// and kept until the model changes, so a big scan never freezes the page. Remove saves a new version on the server
// (glb-trim.mjs) and switches to it as one undo step, so Ctrl+Z brings the piece back.
import * as THREE from 'three';
import { $, esc, send, toast, upsert } from '../app.js';
import { pieceIndex, pieceCard } from '../lib/pieces.js';

let ctx; // { root, model, scene, studio, swapVersion, draw }
let on = false, ready = false, pick = null, overlay = null, saving = false, keys = null;
const cache = new WeakMap(); // mesh → Promise<{ vertexPiece, sizes, triangles }>
let worker = null, jobs = 0;
const waiting = new Map();

export function initTrim(c) { ctx = c; stopTrim(); }
export const isTrimming = () => on;

/** The button that starts it, for the Tools card and the Pose card. */
export function trimButton() {
  return `<button class="btn" type="button" data-trim="start" aria-pressed="${on}" title="Click a stray bit on the model to take it off">${on ? 'Removing pieces…' : 'Remove a loose piece'}</button>`;
}

// The model file's own vertices and triangle order: before Mirror and before face groups reorder the triangles.
function source(mesh) {
  const g = mesh.userData.origGeometry || mesh.geometry, at = g.attributes.position;
  const pos = new Float32Array(at.count * 3);
  for (let i = 0; i < at.count; i++) { pos[i * 3] = at.getX(i); pos[i * 3 + 1] = at.getY(i); pos[i * 3 + 2] = at.getZ(i); }
  const idx = mesh.userData.sourceIndex || g.index?.array;
  return { pos, index: idx ? Uint32Array.from(idx) : null };
}
function pieces(mesh) {
  if (!cache.has(mesh)) cache.set(mesh, new Promise((ok, fail) => {
    if (!worker) {
      worker = new Worker(new URL('../lib/pieces-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => { waiting.get(data.id)?.ok(data); waiting.delete(data.id); };
      worker.onerror = (e) => { for (const w of waiting.values()) w.fail(new Error(e.message || 'Could not look at the model')); waiting.clear(); worker = null; };
    }
    const id = ++jobs, { pos, index } = source(mesh);
    waiting.set(id, { ok, fail });
    worker.postMessage({ id, pos, index }, [pos.buffer, ...(index ? [index.buffer] : [])]);
  }));
  return cache.get(mesh);
}
const meshes = () => { const out = []; ctx.studio()?.model?.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };
const triCount = (o) => (o.userData.sourceIndex?.length ?? (o.userData.origGeometry || o.geometry).index?.count ?? (o.userData.origGeometry || o.geometry).attributes.position.count) / 3;

async function start() {
  if (ctx.scene().mirror?.axis) return toast('Turn off Mirror one half first, then remove pieces.', 'info');
  on = true; ready = false; pick = null;
  keys = new AbortController();
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stopTrim(); } }, { capture: true, signal: keys.signal });
  card();
  const model = ctx.studio()?.model;
  try { await Promise.all(meshes().map(pieces)); } catch (e) { toast(e.message); return stopTrim(); }
  if (on && ctx.studio()?.model === model) { ready = true; card(); }
}
export function stopTrim() {
  on = false; ready = false; pick = null;
  keys?.abort(); keys = null;
  highlight(null);
  if (ctx?.root) { $('#trimCard', ctx.root)?.remove(); $$tb().forEach((b) => { b.setAttribute('aria-pressed', 'false'); b.textContent = 'Remove a loose piece'; }); }
}
const $$tb = () => [...(ctx.root?.querySelectorAll('[data-trim="start"]') || [])];

// The lit-up piece: its triangles in a see-through colour, drawn over everything so its whole shape shows.
function highlight(p) {
  const studio = ctx?.studio();
  if (overlay) { overlay.parent?.remove(overlay); overlay.geometry.dispose(); overlay.material.dispose(); overlay = null; }
  if (p && studio) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', p.mesh.geometry.attributes.position);
    geo.setIndex(new THREE.BufferAttribute(pieceIndex(p.index, p.nv, p.vertexPiece, p.piece), 1));
    overlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff4f45, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide }));
    overlay.renderOrder = 999;
    overlay.matrixAutoUpdate = false; overlay.matrixWorldAutoUpdate = false;
    overlay.onBeforeRender = () => overlay.matrixWorld.copy(p.mesh.matrixWorld); // follows the model as it turns
    overlay.raycast = () => {};
    studio.scene.add(overlay);
  }
  ctx?.draw();
}

function card() {
  const vp = $('#vp', ctx.root);
  if (!vp) return;
  $$tb().forEach((b) => { b.setAttribute('aria-pressed', 'true'); b.textContent = 'Removing pieces…'; });
  let el = $('#trimCard', vp);
  if (!el) { vp.insertAdjacentHTML('beforeend', '<div class="trimcard" id="trimCard" role="dialog" aria-label="Remove a piece"></div>'); el = $('#trimCard', vp); }
  if (!pick) {
    el.innerHTML = `<p class="tc-title" role="status">${ready ? 'Click a loose piece on the model.' : 'Finding the loose pieces…'}</p>
      <div class="tc-row"><button class="btn" type="button" data-trim="done" title="Stop removing pieces (Esc)">Done</button></div>`;
    return;
  }
  const c = pieceCard(pick.tris, pick.total);
  el.innerHTML = `<p class="tc-title" role="status">${esc(c.title)}</p>${c.warn ? `<p class="tc-warn" role="alert">${esc(c.warn)}</p>` : ''}
    <div class="tc-row"><button class="btn pri" type="button" data-trim="remove" title="Take this piece off the model. Ctrl+Z brings it back." ${saving ? 'disabled' : ''}>${saving ? 'Removing…' : 'Remove'}</button>
    <button class="btn" type="button" data-trim="keep" title="Leave this piece on the model (Esc)">Keep</button></div>`;
}

/** Canvas click while removing pieces. Returns true when it used the click. */
export function onTrimCanvasClick(x, y) {
  if (!on) return false;
  if (!ready || saving) return true;
  const studio = ctx.studio();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((x / studio.width) * 2 - 1, -(y / studio.height) * 2 + 1), studio.camera);
  const list = meshes().filter((o) => o.visible);
  const hit = ray.intersectObjects(list, false).find((h) => h.face && [].concat(h.object.material)[h.face.materialIndex ?? 0]?.visible !== false);
  if (!hit) { pick = null; highlight(null); card(); return true; }
  const mesh = hit.object, vertex = hit.face.a;
  pieces(mesh).then((r) => {
    if (!on) return;
    const piece = r.vertexPiece[vertex];
    if (r.sizes[piece] === r.triangles) { toast('That is a whole part, not a loose piece. To hide it, use Hide in Look.', 'info'); return; }
    const index = mesh.userData.sourceIndex || (mesh.userData.origGeometry || mesh.geometry).index?.array || null;
    pick = { mesh, vertex, piece, tris: r.sizes[piece], total: meshes().reduce((s, o) => s + triCount(o), 0), index, nv: mesh.geometry.attributes.position.count, vertexPiece: r.vertexPiece, meshNo: meshes().indexOf(mesh) };
    highlight(pick);
    card();
  }, (e) => toast(e.message));
  return true;
}

async function remove() {
  if (!pick || saving) return;
  const m = ctx.model(), from = m.activeVersion;
  saving = true; card();
  try {
    const r = await send(`/api/models/${m.id}/remove-piece`, 'POST', { piece: pick.meshNo, vertex: pick.vertex, expect: pick.tris });
    upsert(r.model);
    pick = null; highlight(null); ready = false; card();
    await ctx.swapVersion(r.version, 'Remove piece', { from });
    toast(`Piece removed. Saved as version ${r.version}. Press Ctrl+Z to bring it back.`, 'ok');
    if (on) { await Promise.all(meshes().map(pieces)); ready = true; }
  } catch (e) { toast(e.message); }
  saving = false;
  if (on) card();
}

export async function onTrimClick(t) {
  const a = t.dataset.trim;
  if (!a) return false;
  if (a === 'start') { if (on) stopTrim(); else await start(); }
  if (a === 'done') stopTrim();
  if (a === 'keep') { pick = null; highlight(null); card(); }
  if (a === 'remove') await remove();
  return true;
}
