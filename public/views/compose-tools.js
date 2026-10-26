// Compose, the Tools group (Sadie half): line up, mirror, measure, size check, camera spots (bookmarks)
// and the rig check (weight heatmap). Pure logic lives in lib/model-tools.js.
import { $, esc, toast, activeWorkspace, state } from '../app.js';
import { alignPatch, AXES, distance, midpoint, proportionsCheck, addBookmark, setHero, removeBookmark, lerpCamera, weightFlags } from '../lib/model-tools.js';
import { formatLength, dimensions } from '../lib/grid.js';

let ctx; // { root, scene, studio, change, draw, renderInspector }
let measuring = false, pts = [], boneSel = null;
export function initTools(c) { ctx = c; measuring = false; pts = []; boneSel = null; }
const unit = () => state.settings?.gridUnit || 'm';
const kind = () => (activeWorkspace()?.kind === 'warframe' ? 'warframe' : 'car');

export function renderToolsGroup() {
  const s = ctx.scene(), studio = ctx.studio();
  const size = studio?.modelSize();
  const check = proportionsCheck(size, kind());
  const marks = s.bookmarks || [];
  const bones = studio?.bones?.() || [];
  let flags = null;
  if (boneSel != null && studio?.model) studio.model.traverse((o) => { if (!flags && o.isSkinnedMesh) flags = weightFlags(o.geometry.attributes.skinWeight.array); });
  const mi = s.mirror || {};
  return `<div class="grp" id="grp-tools"><h3>Tools</h3>
    <h4 class="fine">Line up</h4>
    <div class="mg-row"><button class="btn big" type="button" data-tool="ground">Put on the floor</button><button class="btn big sec" type="button" data-tool="center">Center it</button></div>
    <h4 class="fine">Mirror one half</h4>
    <div class="chips seg" role="radiogroup" aria-label="Mirror">${[['', 'Off'], ...AXES.map((a) => [a, `${a.toUpperCase()} axis`])].map(([k, l]) => `<button class="chip" type="button" role="radio" data-mirror="${k}" aria-checked="${(mi.axis || '') === k}">${l}</button>`).join('')}</div>
    ${mi.axis ? `<button class="btn sm ghostbtn" type="button" data-tool="mirror-side">Use the other half</button>` : ''}
    <h4 class="fine">Measure</h4>
    <button class="btn big ${measuring ? '' : 'sec'}" type="button" data-tool="measure" aria-pressed="${measuring}">${measuring ? 'Stop measuring' : 'Measure two points'}</button>
    ${measuring ? `<p class="fine">${pts.length === 0 ? 'Click the first point on the model.' : pts.length === 1 ? 'Now click the second point.' : `Distance: <b>${formatLength(distance(pts[0], pts[1]), unit())}</b>. Click again to start over.`}</p>` : ''}
    ${size ? `<p class="fine">Size: ${esc(dimensions(size, unit()).text)}</p>` : ''}
    ${check.ok ? (size ? '<p class="fine ok">Size looks right for this workspace.</p>' : '') : `<div class="warnbox">${check.warnings.map((w) => `<p>${esc(w)}</p>`).join('')}</div>`}
    <h4 class="fine">Camera spots</h4>
    <button class="btn big sec" type="button" data-tool="bookmark">Save this view</button>
    <div class="chips" role="group" aria-label="Camera spots">${marks.map((b, i) => `<span class="chipset"><button class="chip" type="button" data-bm="${esc(b.name)}" title="Key ${i + 1}">${b.hero ? '★ ' : ''}${i + 1}. ${esc(b.name)}</button><button class="chip sm" type="button" data-bm-hero="${esc(b.name)}" title="Make this the hero shot">★</button><button class="chip sm" type="button" data-bm-del="${esc(b.name)}" title="Remove">✕</button></span>`).join('') || '<p class="fine">No saved spots yet. Keys 1 to 9 jump to them.</p>'}</div>
    ${bones.length ? `<h4 class="fine">Check the rig</h4>
    <label class="row-sel"><span>Show weights for</span><select class="inp" data-tool-bone><option value="">Off</option>${bones.map((b) => `<option ${b === boneSel ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
    ${flags ? `<p class="fine">Blue is no pull, red is full pull. ${flags.none.length} points with no weights, ${flags.unnormalized.length} that do not add up, ${flags.over4.length} with more than 4 bones.</p>` : ''}` : ''}
  </div>`;
}

function saveView() {
  const studio = ctx.studio(), s = ctx.scene();
  const name = `Spot ${(s.bookmarks || []).length + 1}`;
  const target = studio.target ? studio.target.toArray() : [0, 1, 0];
  ctx.change({ bookmarks: addBookmark(s.bookmarks, { name, position: studio.camera.position.toArray(), target, lens: s.lens }) });
  toast(`Saved ${name}`, 'info');
}
export function jumpTo(name) {
  const s = ctx.scene(), studio = ctx.studio();
  const b = (s.bookmarks || []).find((x) => x.name === name);
  if (!b || !studio) return;
  const from = { position: studio.camera.position.toArray(), target: studio.target ? studio.target.toArray() : b.target, lens: s.lens };
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / 600);
    const c = lerpCamera(from, b, t);
    studio.state.view = 'free';
    studio.state.orbit = { position: c.position, target: c.target };
    studio.state.lens = c.lens;
    studio.applyCamera();
    ctx.draw();
    if (t < 1) requestAnimationFrame(step);
    else ctx.change({ view: 'free', orbit: { position: b.position, target: b.target }, lens: b.lens });
  };
  requestAnimationFrame(step);
}

export async function onToolsClick(t) {
  const s = ctx.scene();
  if (t.dataset.tool === 'ground') { await ctx.change(alignPatch({ ground: true, center: false })); return true; }
  if (t.dataset.tool === 'center') { await ctx.change(alignPatch({ ground: false, center: true })); return true; }
  if (t.dataset.mirror !== undefined) { await ctx.change({ mirror: t.dataset.mirror ? { axis: t.dataset.mirror, keep: s.mirror?.keep || 1 } : null }); return true; }
  if (t.dataset.tool === 'mirror-side') { await ctx.change({ mirror: { ...s.mirror, keep: -(s.mirror?.keep || 1) } }); return true; }
  if (t.dataset.tool === 'measure') { measuring = !measuring; pts = []; ctx.studio()?.setMeasure(null); label(); ctx.draw(); ctx.renderInspector(); return true; }
  if (t.dataset.tool === 'bookmark') { saveView(); return true; }
  if (t.dataset.bm) { jumpTo(t.dataset.bm); return true; }
  if (t.dataset.bmHero) { await ctx.change({ bookmarks: setHero(s.bookmarks, t.dataset.bmHero) }); return true; }
  if (t.dataset.bmDel) { await ctx.change({ bookmarks: removeBookmark(s.bookmarks, t.dataset.bmDel) }); return true; }
  return false;
}
export function onToolsChange(t) {
  if (t.dataset.toolBone === undefined) return false;
  boneSel = t.value || null;
  ctx.studio()?.showWeights(boneSel);
  ctx.draw();
  ctx.renderInspector();
  return true;
}
// Canvas click while measuring. Returns true when it used the click.
export function onCanvasClick(x, y) {
  if (!measuring) return false;
  const studio = ctx.studio();
  const p = studio?.pickPoint(x, y);
  if (!p) return true;
  pts = pts.length >= 2 ? [p] : [...pts, p];
  studio.setMeasure(pts[0], pts[1]);
  label();
  ctx.draw();
  ctx.renderInspector();
  return true;
}
function label() {
  const el = $('#hudMeasure', ctx.root);
  if (!el) return;
  if (!measuring || pts.length < 2) { el.hidden = true; return; }
  const [x, y] = ctx.studio().toScreen(midpoint(pts[0], pts[1]));
  el.hidden = false;
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  el.textContent = formatLength(distance(pts[0], pts[1]), unit());
}
export const isMeasuring = () => measuring;
// Keys 1 to 9 (no Ctrl, that switches workspaces): jump to a saved spot.
export function onToolsKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key) || e.target.closest('input, textarea, select')) return false;
  const b = (ctx.scene().bookmarks || [])[Number(e.key) - 1];
  if (!b) return false;
  e.preventDefault();
  jumpTo(b.name);
  return true;
}
// Before export: the size warnings for this workspace (empty when fine).
export const exportWarnings = () => proportionsCheck(ctx?.studio()?.modelSize(), kind()).warnings;
