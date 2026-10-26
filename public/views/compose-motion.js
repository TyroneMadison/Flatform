// Compose, the Pose and motion group: model type (auto or set), car stance or humanoid pose, part tags for wheels,
// doors, hood and trunk, and the animation preview (play, pause, speed, loop, scrub). Saved in scene.motion.
import { $, esc, api, send, toast } from '../app.js';
import { MODEL_TYPES, STANCES, STANCE_DEFAULT, STANCE_LIMITS, applyStance, availableStances, POSES, BONES, clipsFor, TAGS, deserializePose } from '../lib/motion.js';
import { tagsFor, modelInfo } from '../lib/rig.js';
import { listPieces } from '../lib/paint.js';
import { posesFor, detectParts, mixamoBones, carStance } from '../lib/poses.js';

let PRESETS = null; // from /api/poses (public/poses/*.json plus <library>/poses/*.json)
async function loadPresets() {
  if (PRESETS) return;
  try { const r = await fetch('/api/poses'); PRESETS = r.ok ? (await r.json()).poses : []; } catch { PRESETS = []; }
  ctx?.renderInspector?.();
}
function presetChips(kind, model, current) {
  if (!PRESETS) { loadPresets(); return '<p class="fine">Loading poses...</p>'; }
  const found = kind === 'car' && model ? detectParts(listPieces(model).map((p) => ({ name: p.name }))) : {};
  const list = posesFor(PRESETS, kind, found);
  return `<h4 class="fine">${kind === 'car' ? 'Pick a stance' : 'Pick a pose'}</h4><div class="chips big" role="group" aria-label="${kind === 'car' ? 'Stance' : 'Pose'} presets">${list.map((p) => `<button class="chip" type="button" data-mo-preset="${esc(p.id)}" aria-pressed="${current === p.id}" title="${esc(p.description || '')}">${esc(p.icon || '')} ${esc(p.name)}</button>`).join('')}</div>`;
}

let ctx; // same ctx as compose-paint
let playing = false, raf = 0, t0 = 0, clipT = 0, boneSel = 'Spine';
const CLIP_LEN = 4;

export function initMotion(c) { ctx = c; stop(); clipT = 0; }
const motionOf = () => ctx.scene().motion || { type: 'auto', stance: { ...STANCE_DEFAULT }, tags: {}, pose: null, clip: null, speed: 30, loop: true };
const setMotion = (patch, opts) => ctx.change({ motion: { ...motionOf(), ...patch } }, opts);

function stop() { playing = false; cancelAnimationFrame(raf); }
function tick(now) {
  if (!playing) return;
  const mo = motionOf();
  clipT = (now - t0) / 1000;
  if (!mo.loop && clipT >= CLIP_LEN) { clipT = CLIP_LEN; stop(); }
  const studio = ctx.studio();
  studio?.setClipTime(mo.loop ? clipT % CLIP_LEN : clipT);
  ctx.draw();
  const scrub = $('#mo-scrub', ctx.root);
  if (scrub) scrub.value = String(((mo.loop ? clipT % CLIP_LEN : clipT) / CLIP_LEN) * 100);
  if (playing) raf = requestAnimationFrame(tick);
}

const num = (id, label, min, max, step, v, attr) => `<div class="sl"><label for="${id}">${label}</label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-mo="${attr}"><span class="v" id="v-${id}">${v}</span></div>`;

export function renderMotionGroup() {
  const studio = ctx.studio();
  if (!studio?.model) return '';
  const mo = motionOf();
  const kind = ctx.model()?.kind;
  const info = modelInfo(studio, kind || mo.type || 'auto');
  // The model's kind (saved on the model): Auto shows only while it was never set, with what detection found.
  const typeSel = `<label class="row-sel"><span>Model type</span><select class="inp" data-mo-kind>${Object.entries(MODEL_TYPES).filter(([k]) => k !== 'auto' || !kind).map(([k, l]) => `<option value="${k}" ${k === (kind || 'auto') ? 'selected' : ''}>${l}${k === 'auto' ? ` (${info.type === 'car' ? 'Car' : 'Humanoid'})` : ''}</option>`).join('')}</select></label>`;
  const clips = clipsFor(info.type);
  const preview = `<div class="mg-row"><select class="inp" data-mo-clip aria-label="Animation"><option value="">No animation</option>${clips.map((c) => `<option value="${c.id}" ${mo.clip === c.id ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>
      <button class="btn sm sec" type="button" data-mo-act="play" ${mo.clip ? '' : 'disabled'}>${playing ? 'Pause' : 'Play'}</button>
      <label class="tg"><span>Loop</span><input class="sw" type="checkbox" role="switch" data-mo-loop ${mo.loop !== false ? 'checked' : ''}></label></div>
      <div class="sl"><label for="mo-scrub">Time</label><input id="mo-scrub" type="range" min="0" max="100" step="0.1" value="${(clipT % CLIP_LEN) / CLIP_LEN * 100}" data-mo-scrub ${mo.clip ? '' : 'disabled'}></div>
      ${num('mo-speed', info.type === 'car' ? 'Speed km/h' : 'Speed', info.type === 'car' ? 5 : 0.25, info.type === 'car' ? 200 : 3, info.type === 'car' ? 5 : 0.25, mo.speed ?? (info.type === 'car' ? 30 : 1), 'speed')}`;
  let body;
  if (info.type === 'car') {
    const s = { ...STANCE_DEFAULT, ...mo.stance };
    const tags = tagsFor(studio.model, mo.tags);
    const whole = listPieces(studio.model).filter((p) => p.group == null);
    body = `${presetChips('car', studio.model, mo.presetId)}<details><summary>Fine tune</summary><div class="chips" role="group" aria-label="Stance">${availableStances(mo.tags && Object.keys(mo.tags).length ? mo.tags : Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, { tag: v.tag }]))).map((st) => `<button class="chip" type="button" data-mo-stance="${st.id}">${esc(st.label)}</button>`).join('')}</div>
      ${num('mo-ride', 'Ride height m', ...STANCE_LIMITS.rideHeight, 0.01, s.rideHeight, 'stance.rideHeight')}
      ${num('mo-steer', 'Steer angle', ...STANCE_LIMITS.steer, 1, s.steer, 'stance.steer')}
      ${num('mo-fd', 'Front drop m', ...STANCE_LIMITS.frontDrop, 0.01, s.frontDrop, 'stance.frontDrop')}
      ${num('mo-rd', 'Rear drop m', ...STANCE_LIMITS.rearDrop, 0.01, s.rearDrop, 'stance.rearDrop')}
      ${['doors', 'hood', 'trunk'].filter((k) => Object.values(tags).some((v) => v.tag === (k === 'doors' ? 'door' : k))).map((k) => num(`mo-${k}`, `${k[0].toUpperCase() + k.slice(1)} open`, 0, 80, 1, s[k], `stance.${k}`)).join('')}
      <details><summary>Part tags (${Object.keys(tags).length})</summary>${whole.slice(0, 200).map((p) => `<label class="row-sel"><span>${esc(p.name)}</span><select class="inp" data-mo-tag="${esc(p.key)}"><option value="">None</option>${Object.entries(TAGS).map(([k, l]) => `<option value="${k}" ${tags[p.key]?.tag === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`).join('') || '<p class="fine">No separate meshes to tag.</p>'}</details></details>`;
  } else if (!hasSkeleton(studio.model)) {
    body = rigPanel();
  } else {
    const pose = deserializePose(mo.pose || { preset: 'tpose' });
    const v = pose.bones[boneSel] || [0, 0, 0];
    body = `${presetChips('humanoid', studio.model, mo.presetId)}<details><summary>Fine tune</summary><div class="chips" role="group" aria-label="Pose">${Object.entries(POSES).map(([k, p]) => `<button class="chip" type="button" data-mo-pose="${k}" aria-pressed="${pose.preset === k}">${esc(p.label)}</button>`).join('')}</div>
      <label class="row-sel"><span>Bone</span><select class="inp" data-mo-bone>${BONES.map((b) => `<option ${b === boneSel ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
      ${['X', 'Y', 'Z'].map((a, i) => num(`mo-b${a}`, `Rotate ${a}`, -180, 180, 1, v[i], `bone.${i}`)).join('')}</details>`;
  }
  return `<div class="grp" id="grp-motion"><h3>Pose and motion</h3>${typeSel}${body}<h4 class="fine">Animation preview</h4>${preview}</div>`;
}
// A humanoid with no bones: poses would do nothing, so say so and offer the free Blender rig instead.
let rigging = null; // model id being rigged
function rigPanel() {
  const busy = rigging === ctx.model()?.id;
  return `<div class="warnbox" role="alert"><b>No skeleton</b><p>This model has no bones, so poses and humanoid animations can't move it. Rig it first.</p></div>
    <button class="btn pri" type="button" data-mo-act="rig" ${busy ? 'disabled' : ''}>${busy ? 'Rigging in Blender…' : 'Auto-rig (free, in Blender)'}</button>
    <p class="fine">Builds a skeleton with Mixamo bone names, binds it with automatic weights and saves it as a new version. Works best on a model standing upright, facing the camera, arms out or down.</p>`;
}
async function rig() {
  const m = ctx.model();
  try { await send(`/api/models/${m.id}/rig`, 'POST', {}); } catch (e) { toast(e.message); return; }
  rigging = m.id; ctx.renderInspector();
  let job;
  do { await new Promise((ok) => setTimeout(ok, 1000)); job = await api(`/api/models/${m.id}/rig`).catch(() => null); } while (job?.status === 'running');
  rigging = null;
  if (job?.status !== 'done') { toast(`Auto-rig failed: ${job?.error || 'no answer from Flatform'}`); ctx.renderInspector(); return; }
  toast(`Rigged · version ${job.version}`, 'info');
  if (ctx.model()?.id === m.id) await ctx.reload(await api(`/api/models/${m.id}`));
}
const hasSkeleton = (m) => { let b = false; m.traverse((o) => { if (o.isBone) b = true; }); return b; };

export async function onMotionClick(t) {
  if (t.dataset.moPreset) {
    const p = (PRESETS || []).find((x) => x.id === t.dataset.moPreset);
    if (!p) return true;
    stop();
    if (p.kind === 'car') await setMotion({ presetId: p.id, stance: { ...STANCE_DEFAULT, ...carStance(p) } });
    else await setMotion({ presetId: p.id, pose: { preset: 'tpose', bones: mixamoBones(p) } });
    return true;
  }
  if (t.dataset.moStance) { stop(); await setMotion({ stance: applyStance(motionOf().stance, t.dataset.moStance) }); return true; }
  if (t.dataset.moPose) { const p = deserializePose(motionOf().pose || {}); await setMotion({ pose: { preset: t.dataset.moPose, bones: t.dataset.moPose === p.preset ? p.bones : {} } }); return true; }
  if (t.dataset.moAct === 'rig') { await rig(); return true; }
  if (t.dataset.moAct === 'play') {
    if (playing) { stop(); ctx.renderInspector(); return true; }
    playing = true; t0 = performance.now() - clipT * 1000; raf = requestAnimationFrame(tick); ctx.renderInspector(); return true;
  }
  return false;
}
export function onMotionInput(t) {
  if (t.dataset.moScrub !== undefined) { stop(); clipT = (Number(t.value) / 100) * CLIP_LEN; ctx.studio()?.setClipTime(clipT); ctx.draw(); return true; }
  const k = t.dataset.mo;
  if (!k) return false;
  const v = Number(t.value);
  const out = $(`#v-${t.id}`, ctx.root); if (out) out.textContent = String(v);
  const mo = motionOf();
  if (k === 'speed') setMotion({ speed: v }, { inspector: false });
  else if (k.startsWith('stance.')) setMotion({ stance: { ...STANCE_DEFAULT, ...mo.stance, [k.slice(7)]: v } }, { inspector: false });
  else if (k.startsWith('bone.')) {
    const p = deserializePose(mo.pose || { preset: 'tpose' });
    const cur = [...(p.bones[boneSel] || [0, 0, 0])]; cur[Number(k.slice(5))] = v;
    setMotion({ pose: { preset: p.preset, bones: { ...p.bones, [boneSel]: cur } } }, { inspector: false });
  }
  return true;
}
export async function onMotionChange(t) {
  if (t.dataset.moKind !== undefined) {
    stop();
    if (t.value === 'auto') return true;
    try { await ctx.reload(await send(`/api/models/${ctx.model().id}`, 'PATCH', { kind: t.value }), { glb: false }); } catch (e) { toast(e.message); return true; }
    await setMotion({ type: t.value });
    return true;
  }
  if (t.dataset.moClip !== undefined) { stop(); clipT = 0; ctx.studio()?.setClipTime(t.value ? 0 : null); await setMotion({ clip: t.value || null }); return true; }
  if (t.dataset.moLoop !== undefined) { await setMotion({ loop: t.checked }, { inspector: false }); return true; }
  if (t.dataset.moBone !== undefined) { boneSel = t.value; ctx.renderInspector(); return true; }
  if (t.dataset.moTag !== undefined) { const tags = { ...(motionOf().tags || {}) }; tags[t.dataset.moTag] = { tag: t.value || null }; await setMotion({ tags }); return true; }
  return false;
}
export const stopMotion = stop;
