// Compose, Part colors (Look): Find the parts splits the model (lib/roles.js, in roles-worker.js), guesses a color
// role for each part and shows them once in bright test colors with a one-line card. One color wheel per role
// (Glow adds a strength, Energy a strength and a pulse speed). Clicking a part opens the inspector card, where its
// role can be changed or locked. When the model changes (made again, joints added, a piece removed) the parts are
// found again and each one takes the role of the old part in the same place (rematch).
import * as THREE from 'three';
import { $, esc, toast } from '../app.js';
import { icon } from '../lib/icons.js';
import { ColorPicker } from '../lib/color-picker.js';
import { pieceKey, listPieces } from '../lib/paint.js';
import { DEFAULT_COLORS, setColor, recentColor } from '../lib/tenno.js';
import {
  ROLES, TEST_COLORS, labelRoles, rematch, normPoint, applyRoles, setRole, setLocked, savedParts, roleCounts, rolesOf,
  groupOrder, middleX, surfaceArea,
} from '../lib/roles.js';

let ctx; // { root, scene, studio, change, draw, renderInspector, selected: () => piece key }
let busy = false, testing = false, open = null, picker = null, checked = null;
export function initRoles(c) { ctx = c; busy = false; testing = false; open = null; picker = null; checked = null; }
const paintOf = () => ctx.scene().paint || {};
const hasRoles = () => Boolean(paintOf().roles?.guessed);
const colorOf = (id) => ({ ...DEFAULT_COLORS, ...paintOf().colors?.global })[id];

// ---- the model's meshes, in model space, the way paint.js numbers them ----
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbOf = (c) => [toSrgb(c.r), toSrgb(c.g), toSrgb(c.b)];
// Face colors from the texture (a small copy of it) or the vertex colors, times the material color. Null: one flat color.
function faceColors(o, g, index) {
  const mat = [].concat(o.userData.material || o.material)[0];
  const tint = mat?.color ? [mat.color.r, mat.color.g, mat.color.b] : [1, 1, 1];
  const img = mat?.map?.image, uv = g.attributes.uv, vc = g.attributes.color;
  if (!(img && uv) && !vc) return null;
  let px = null, S = 128;
  if (img && uv) {
    try {
      const c = Object.assign(document.createElement('canvas'), { width: S, height: S });
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, S, S);
      px = x.getImageData(0, 0, S, S).data;
    } catch { px = null; }
  }
  const nf = index.length / 3, out = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const a = index[f * 3], b = index[f * 3 + 1], d = index[f * 3 + 2];
    let col;
    if (px) {
      const u = (uv.getX(a) + uv.getX(b) + uv.getX(d)) / 3, v = (uv.getY(a) + uv.getY(b) + uv.getY(d)) / 3;
      const X = Math.min(S - 1, Math.max(0, Math.floor((u - Math.floor(u)) * S))), Y = Math.min(S - 1, Math.max(0, Math.floor((v - Math.floor(v)) * S))); // glTF: v down
      const i = (Y * S + X) * 4;
      col = [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255].map((c, k) => c * toSrgb(tint[k]));
    } else col = [0, 1, 2].map((k) => toSrgb(((vc.getComponent(a, k) + vc.getComponent(b, k) + vc.getComponent(d, k)) / 3) * tint[k]));
    out.set(col, f * 3);
  }
  return out;
}
function meshesOf(model) {
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const out = [];
  let i = 0;
  const v = new THREE.Vector3();
  model.traverse((o) => {
    if (!o.isMesh) return;
    const key = pieceKey(i++, o.name);
    const g = o.userData.origGeometry || o.geometry, at = g.attributes.position;
    const M = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const pos = new Float32Array(at.count * 3);
    for (let k = 0; k < at.count; k++) { v.fromBufferAttribute(at, k).applyMatrix4(M); pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z; }
    const src = o.userData.sourceIndex || g.index?.array;
    const index = src ? Uint32Array.from(src) : Uint32Array.from({ length: at.count }, (_, k) => k);
    const mat = [].concat(o.userData.material || o.material)[0];
    const em = mat?.emissive ? Math.min(1, Math.max(...srgbOf(mat.emissive)) * (mat.emissiveIntensity ?? 1)) : 0;
    out.push({ o, key, pos, index, indexed: Boolean(src), textured: Boolean(mat?.map), color: mat?.color ? srgbOf(mat.color) : [1, 1, 1], emissive: em, emissiveHex: mat?.emissive && em > 0.3 ? `#${mat.emissive.getHexString()}` : null });
  });
  return out;
}
// The model's fingerprint: every mesh's key, face count and first face. A new one means the parts must be found again.
const sigOf = (list) => list.map((m) => `${m.key}:${m.index.length / 3}:${[0, 1, 2].map((k) => m.pos[m.index[0] * 3 + k]?.toFixed(3)).join(',')}`).join('|');
export function modelSig() { const model = ctx.studio()?.model; return model ? sigOf(meshesOf(model)) : ''; }

let worker = null, jobs = 0;
const waiting = new Map();
function segment(pos, index, opts) {
  if (!worker) {
    worker = new Worker(new URL('../lib/roles-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); if (data.error) w?.fail(new Error(data.error)); else w?.ok(data); };
    worker.onerror = (e) => { for (const w of waiting.values()) w.fail(new Error(e.message || 'Could not look at the model')); waiting.clear(); worker = null; };
  }
  return new Promise((ok, fail) => {
    const id = ++jobs;
    waiting.set(id, { ok, fail });
    const p = pos.slice(), i = index.slice();
    worker.postMessage({ id, pos: p, index: i, opts }, [p.buffer, i.buffer]);
  });
}
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s); };
// Back to the file's own triangles, no face groups (paint.js regroup only ever adds them).
function ungroup(o) {
  o.geometry.setIndex(new THREE.BufferAttribute(o.userData.sourceIndex, 1));
  o.geometry.clearGroups();
  delete o.userData.groupNames; delete o.userData.grouped;
  o.material = o.userData.material;
}
// Area, centre and box of some faces of a mesh (a piece we do not split).
function statsOf(pos, index, start = 0, count = index.length) {
  const sub = index.subarray(start, start + count);
  const area = surfaceArea(pos, sub);
  const c = [0, 0, 0], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < sub.length; i++) for (let k = 0; k < 3; k++) { const x = pos[sub[i] * 3 + k]; c[k] += x / sub.length; min[k] = Math.min(min[k], x); max[k] = Math.max(max[k], x); }
  return { area, c, min, max };
}

/**
 * Finds the parts and their roles. keep: { key: { role, locked } } from rematch (they keep their role).
 * Returns what roles.js applyRoles takes.
 */
async function findParts(keep = null) {
  const model = ctx.studio().model, paint = paintOf();
  const list = meshesOf(model);
  const own = paint.roles?.meshes || [];
  const total = list.reduce((t, m) => t + surfaceArea(m.pos, m.index), 0) || 1;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const m of list) for (let i = 0; i < m.pos.length; i++) { const k = i % 3; box.min[k] = Math.min(box.min[k], m.pos[i]); box.max[k] = Math.max(box.max[k], m.pos[i]); }
  const parts = [], groups = {}, meshes = [];
  const pieces = listPieces(model);
  let n = 0;
  for (const m of list) {
    // A mesh is split unless it is one of several materials on one node (Blender keeps those in one object) or it
    // already has face groups the photo guess made.
    const splittable = m.indexed && !m.o.userData.partName && (!paint.groups?.[m.key] || own.includes(m.key));
    const seg = splittable ? await segment(m.pos, m.index, { colors: faceColors(m.o, m.o.userData.origGeometry || m.o.geometry, m.index), totalArea: total }) : null;
    if (seg && seg.parts.length <= 1 && m.o.userData.sourceIndex) ungroup(m.o); // split before, one part now
    if (seg && seg.parts.length > 1) {
      const names = seg.parts.map(() => `Part ${++n}`);
      groups[m.key] = { labels: b64(seg.labels), names };
      meshes.push(m.key);
      groupOrder(seg.labels).forEach((p, gi) => { const s = seg.parts[p]; parts.push({ key: `${m.key}@${gi}`, name: names[p], area: s.area / total, c: s.c, color: s.color || m.color, seed: m.textured ? m.color : s.color || m.color, emissive: m.emissive, emissiveHex: m.emissiveHex }); });
    } else {
      for (const p of (seg ? [{ key: m.key, name: m.o.name, group: null }] : pieces.filter((x) => x.mesh === m.o))) {
        const grp = p.group != null && m.o.geometry.groups[p.group];
        const s = grp ? statsOf(m.pos, m.o.geometry.index.array, grp.start, grp.count) : statsOf(m.pos, m.index);
        parts.push({ key: p.key, name: paint.pieces?.[p.key]?.name || p.name, area: s.area / total, c: s.c, color: m.color, seed: m.color, emissive: m.emissive, emissiveHex: m.emissiveHex });
      }
    }
  }
  const joints = [];
  const v = new THREE.Vector3(), inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  model.traverse((o) => { if (o.isBone) { o.getWorldPosition(v).applyMatrix4(inv); joints.push({ name: o.name, p: [v.x, v.y, v.z] }); } });
  const size = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
  const fresh = parts.map((p) => ({ key: p.key, c: normPoint(p.c, box), a: p.area }));
  const kept = keep ? rematch(keep, fresh) : {};
  const locked = Object.fromEntries(Object.entries(kept).map(([k, x]) => [k, x.role]));
  const roles = labelRoles(parts, { center: middleX(joints, box), size, joints: joints.length ? joints : null, locked });
  const out = parts.map((p, i) => ({ key: p.key, name: p.name, c: fresh[i].c, a: p.area, role: roles[p.key] || 'primary', locked: Boolean(kept[p.key]?.locked) }));
  // The first guess starts every role at the colors its parts have now, so the model looks the same afterwards.
  let colors = null;
  if (!paint.roles) {
    colors = {};
    for (const r of ['primary', 'secondary', 'tertiary', 'accents']) {
      const mine = parts.filter((p) => roles[p.key] === r), w = mine.reduce((t, p) => t + p.area, 0);
      if (w) colors[r] = `#${[0, 1, 2].map((k) => Math.round(Math.min(1, mine.reduce((t, p) => t + p.seed[k] * p.area, 0) / w) * 255).toString(16).padStart(2, '0')).join('')}`;
    }
    for (const r of ['emissive', 'energy']) { const p = parts.find((x) => roles[x.key] === r && x.emissiveHex); if (p) colors[r] = p.emissiveHex; }
  }
  return { parts: out, groups, meshes, sig: sigOf(list), colors };
}

async function guess() {
  if (busy || !ctx.studio()?.model) return;
  if (ctx.scene().mirror?.axis) return toast('Turn off Mirror one half first, then find the parts.', 'info');
  const first = !hasRoles();
  busy = true; ctx.renderInspector();
  try {
    const saved = savedParts(paintOf());
    const keepLocked = Object.fromEntries(Object.entries(saved).filter(([, p]) => p.locked));
    const found = await findParts(keepLocked);
    await ctx.change({ paint: applyRoles(paintOf(), found) });
    checked = found.sig;
    if (first) setTesting(true);
  } catch (e) { toast(`Could not find the parts: ${e.message}`); }
  busy = false; ctx.renderInspector();
}
/** After a model loads: if it changed since its parts were found, find them again and keep each role in its place. */
export async function checkRoles() {
  const model = ctx?.studio()?.model;
  if (!model || !hasRoles() || busy) return;
  const sig = modelSig();
  if (sig === checked || sig === paintOf().roles.sig) { checked = sig; return; }
  busy = true;
  try {
    const found = await findParts(savedParts(paintOf()));
    if (ctx.studio()?.model !== model) return;
    await ctx.change({ paint: applyRoles(paintOf(), found) }, { record: false });
    checked = found.sig;
  } catch (e) { toast(`Could not find the parts again: ${e.message}`); } finally { busy = false; ctx.renderInspector(); }
}
function setTesting(on) {
  testing = Boolean(on);
  ctx.studio()?.setTestColors(testing);
  const card = $('#roleCard', ctx.root);
  if (card) card.hidden = !testing;
  ctx.renderInspector();
  ctx.draw();
}
export function stopRoles() { if (testing) { testing = false; ctx?.studio()?.setTestColors(false); } }

// ---- drawing ----
const pulseWords = (v) => (v <= 0 ? 'Off' : v < 0.4 ? 'Slow' : v < 1 ? 'Medium' : 'Fast');
const slider = (attr, key, label, min, max, step, value, text, tip) => `<div class="sl"><label for="role-${attr}-${key}">${label}</label><input class="range" type="range" id="role-${attr}-${key}" data-${attr}="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${((value - min) / (max - min)) * 100}%" title="${tip}"><span class="v" id="v-role-${attr}-${key}">${text}</span></div>`;
const swatch = (id) => `<i class="rolesw" style="background:${testing ? TEST_COLORS[id] : colorOf(id)}" aria-hidden="true"></i>`;

/** The Part colors group (Look) and the clicked part's Color role group (moved into the inspector card). */
export function renderRolesGroup() {
  const studio = ctx.studio(), paint = paintOf();
  if (!hasRoles()) {
    return `<div class="grp" id="grp-roles"><h3>${icon('scene', 14)} Part colors</h3>
      <p class="fine keep">Split the model into parts and give each part one of six colors.</p>
      <button class="btn pri" type="button" data-roles="guess" title="Find the parts of the model and guess a color for each one" ${studio?.model && !busy ? '' : 'disabled'}>${busy ? 'Finding the parts…' : 'Find the parts'}</button></div>`;
  }
  const counts = roleCounts(paint), r = rolesOf(paint);
  const extra = (id) => (id === 'emissive' ? slider('role-strength', 'emissive', 'Glow strength', 0, 10, 0.1, r.strength.emissive, r.strength.emissive.toFixed(1), 'How bright the Glow parts shine')
    : id === 'energy' ? `${slider('role-strength', 'energy', 'Energy strength', 0, 10, 0.1, r.strength.energy, r.strength.energy.toFixed(1), 'How bright the Energy parts shine')}${slider('role-pulse', 'speed', 'Pulse speed', 0, 2, 0.05, r.pulse, pulseWords(r.pulse), 'How fast the Energy parts pulse. All the way left stops the pulse')}` : '');
  const rows = ROLES.map((x) => `<button class="rolerow" type="button" data-role-open="${x.id}" aria-expanded="${open === x.id}" title="${x.tip}. Click to pick its color.">${swatch(x.id)}<b>${x.label}</b><small>${counts[x.id]} part${counts[x.id] === 1 ? '' : 's'}</small></button>
    ${open === x.id ? `<div class="rolebox">${testing ? '<p class="fine keep">Test colors are on. Picking a color turns them off.</p>' : ''}<div id="rolePicker"></div>${extra(x.id)}</div>` : ''}`).join('');
  return `<div class="grp" id="grp-roles"><h3>${icon('scene', 14)} Part colors</h3>
    <div class="roles">${rows}</div>
    <div class="mg-row">
      <button class="btn sm sec" type="button" data-roles="test" aria-pressed="${testing}" title="Show each role in a bright test color, so you can see which part has which">${testing ? 'Hide test colors' : 'Show test colors'}</button>
      <button class="btn sm ghostbtn" type="button" data-roles="guess" title="Find the parts and guess again. Parts you locked keep their role" ${busy ? 'disabled' : ''}>${busy ? 'Finding…' : 'Guess again'}</button></div>
    <p class="fine keep">Click a part in the view to change its role.</p></div>${roleGroup()}`;
}
function roleGroup() {
  const key = ctx.selected(), paint = paintOf();
  if (!key || !hasRoles()) return '';
  const slot = paint.pieces?.[key]?.slot, locked = Boolean(paint.roles.parts?.[key]?.locked);
  return `<div class="grp" id="grp-role"><h3>Color role</h3>
    <div class="chips rolechips" role="radiogroup" aria-label="Color role">${ROLES.map((x) => `<button class="chip" type="button" role="radio" data-role-set="${x.id}" aria-checked="${slot === x.id}" title="Give this part the ${x.label} color. ${x.tip}">${swatch(x.id)}${x.label}</button>`).join('')}</div>
    ${paint.roles.parts?.[key] ? `<label class="tg" title="Guess again leaves this part's role as it is"><span>Lock this role<small>Guess again will not change it</small></span><input class="sw" type="checkbox" role="switch" title="Guess again leaves this part's role as it is" data-role-lock ${locked ? 'checked' : ''}></label>` : ''}</div>`;
}
/** The test-color card over the view (compose.js puts #roleCard in the viewport). */
export function roleCardHtml() {
  return `<p class="tc-title">We guessed the parts. Click one to change it.</p>
    <div class="rolelegend">${ROLES.map((x) => `<span title="${x.tip}"><i class="rolesw" style="background:${TEST_COLORS[x.id]}" aria-hidden="true"></i>${x.label}</span>`).join('')}</div>
    <button class="btn pri" type="button" data-roles="done" title="Keep these parts and show your own colors again">Looks good</button>`;
}
/** After the inspector HTML is in place: the open role's color wheel. */
export function afterRolesRender() {
  const box = $('#rolePicker', ctx.root);
  const card = $('#roleCard', ctx.root);
  if (card) card.hidden = !testing;
  if (!box || !open) { picker = null; return; }
  const role = open;
  const pick = (hex) => setColor(paintOf(), 'global', role, hex);
  picker = new ColorPicker(box, {
    value: colorOf(role), recent: paintOf().recent || [],
    onPreview: (hex) => { if (testing) { testing = false; ctx.studio()?.setTestColors(false); } ctx.studio()?.previewPaint(pick(hex)); ctx.draw(); liveSwatch(role, hex); },
    onPick: (hex) => { if (testing) setTesting(false); ctx.change({ paint: recentColor(pick(hex), hex) }, { inspector: false }); picker?.setRecent(paintOf().recent); liveSwatch(role, hex); },
  });
}
const liveSwatch = (role, hex) => { const i = $(`[data-role-open="${role}"] .rolesw`, ctx.root); if (i) i.style.background = hex; };

// ---- events (compose.js) ----
export async function onRolesClick(t) {
  const act = t.dataset.roles;
  if (act === 'guess') { await guess(); return true; }
  if (act === 'test') { setTesting(!testing); return true; }
  if (act === 'done') { setTesting(false); return true; }
  if (t.dataset.roleOpen) { open = open === t.dataset.roleOpen ? null : t.dataset.roleOpen; ctx.renderInspector(); return true; }
  if (t.dataset.roleSet) {
    const key = ctx.selected();
    if (key) await ctx.change({ paint: setRole(paintOf(), key, t.dataset.roleSet) });
    return true;
  }
  return false;
}
export function onRolesInput(t) {
  if (t.dataset.roleStrength || t.dataset.rolePulse) {
    const v = Number(t.value), r = rolesOf(paintOf());
    t.style.setProperty('--p', `${((v - t.min) / (t.max - t.min)) * 100}%`);
    $(`#v-${t.id}`, ctx.root).textContent = t.dataset.rolePulse ? pulseWords(v) : v.toFixed(1);
    const roles = t.dataset.rolePulse ? { ...paintOf().roles, pulse: v } : { ...paintOf().roles, strength: { ...r.strength, [t.dataset.roleStrength]: v } };
    ctx.change({ paint: { ...paintOf(), roles } }, { inspector: false });
    return true;
  }
  return false;
}
export function onRolesChange(t) {
  if (t.dataset.roleLock === undefined) return false;
  const key = ctx.selected();
  if (key) ctx.change({ paint: setLocked(paintOf(), key, t.checked) });
  return true;
}
