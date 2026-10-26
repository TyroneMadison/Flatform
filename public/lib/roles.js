// Part colors (Look): split the model into parts, then give every part one of six color roles, the TennoGen
// slots in tenno.js (Primary, Secondary, Tertiary, Accent, Glow, Energy). Pure: no three.js, so the node tests,
// the page (compose-roles.js, through roles-worker.js) and the server all agree.
//
// Parts: faces joined by a shared corner (copies of the same spot welded, as pieces.js) and of the same paint
// (the face colors are put in a few color groups first), so a one-shell scan still splits where its paint does.
// Material groups are their own meshes in three.js, so they are parts already. Bits smaller than MIN_SHARE of
// the model join the neighbour they touch most (else the nearest), and no model gets more than MAX_PARTS.
// A part's role is saved as its piece's slot (paint.pieces[key].slot); paint.roles holds the rest (see applyRoles).
import { weld, weldTol } from './pieces.js';
import { kmeans } from './infer.js';

export const ROLES = [
  { id: 'primary', label: 'Primary', tip: 'The main color, on the biggest parts' },
  { id: 'secondary', label: 'Secondary', tip: 'The second color, on the next biggest parts' },
  { id: 'tertiary', label: 'Tertiary', tip: 'A third color for the parts in between' },
  { id: 'accents', label: 'Accent', tip: 'Small trim and details that stand out' },
  { id: 'emissive', label: 'Glow', tip: 'Parts that light up' },
  { id: 'energy', label: 'Energy', tip: 'Parts that light up and slowly pulse' },
];
export const ROLE_IDS = ROLES.map((r) => r.id);
export const roleLabel = (id) => ROLES.find((r) => r.id === id)?.label || 'None';
// Bright, easy to tell apart: shown once after the first guess so you can see which part got which role.
export const TEST_COLORS = { primary: '#ff3030', secondary: '#2f6bff', tertiary: '#ffd400', accents: '#22e05a', emissive: '#ff38f0', energy: '#18f0ff' };
export const DEFAULT_ROLES = { strength: { emissive: 3, energy: 4 }, pulse: 0.5 };
export const MIN_SHARE = 0.004; // a part smaller than this share of the model's surface joins a neighbour
export const MAX_PARTS = 24;
const COLOR_GROUPS = 5; // color groups per mesh before the faces are joined into parts
const SAME_COLOR = 0.12; // two color groups closer than this (0..1 RGB distance) are one paint

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const colorDist = (a, b) => (a && b ? dist(a, b) / Math.sqrt(3) : 0);
const at3 = (arr, i) => [arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]];

/** Surface area of an indexed triangle list. pos: flat xyz, index: triangle corners (null = every 3 vertices). */
export function surfaceArea(pos, index = null) {
  const n = index ? index.length : pos.length / 3;
  let total = 0;
  for (let i = 0; i < n; i += 3) {
    const a = at3(pos, index ? index[i] : i), b = at3(pos, index ? index[i + 1] : i + 1), c = at3(pos, index ? index[i + 2] : i + 2);
    const x = cross(sub(b, a), sub(c, a));
    total += Math.hypot(x[0], x[1], x[2]) / 2;
  }
  return total;
}

/**
 * Splits one mesh into parts. pos: flat xyz (model space), index: triangle corners, colors: optional flat rgb per
 * face (0..1). totalArea: the whole model's surface (for MIN_SHARE), else this mesh's.
 * Returns { labels: Uint8Array (part of every face, in the file's own face order), parts: [{ faces, area, c, min,
 * max, color }] } with part 0 the biggest. A mesh with no part over MIN_SHARE stays one part.
 */
export function segmentFaces(pos, index, { colors = null, totalArea = null, minShare = MIN_SHARE, maxParts = MAX_PARTS } = {}) {
  const nf = index.length / 3, nv = pos.length / 3;
  const root = weld(pos, weldTol(pos));
  // Face area and centre.
  const area = new Float64Array(nf), cen = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const a = at3(pos, index[f * 3]), b = at3(pos, index[f * 3 + 1]), c = at3(pos, index[f * 3 + 2]);
    const x = cross(sub(b, a), sub(c, a));
    area[f] = Math.hypot(x[0], x[1], x[2]) / 2;
    for (let k = 0; k < 3; k++) cen[f * 3 + k] = (a[k] + b[k] + c[k]) / 3;
  }
  // Color groups: k-means on a sample of the face colors, close groups merged, every face to its nearest.
  const lab = new Uint8Array(nf);
  let K = 1;
  if (colors) {
    const step = Math.max(1, Math.floor(nf / 20000)), sample = [];
    for (let f = 0; f < nf; f += step) sample.push(colors[f * 3] * 255, colors[f * 3 + 1] * 255, colors[f * 3 + 2] * 255);
    const k = Math.min(COLOR_GROUPS, sample.length / 3);
    const centres = [];
    for (const c of kmeans(Float32Array.from(sample), null, k, 8, 3).centres.map((c) => c.map((v) => v / 255))) {
      if (!centres.some((d) => colorDist(c, d) < SAME_COLOR)) centres.push(c);
    }
    K = centres.length;
    for (let f = 0; f < nf; f++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) { const d = colorDist(at3(colors, f), centres[c]); if (d < bd) { bd = d; best = c; } }
      lab[f] = best;
    }
  }
  // Faces of the same color group that share a (welded) corner are one region.
  const parent = new Int32Array(nf);
  for (let f = 0; f < nf; f++) parent[f] = f;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const first = new Int32Array(nv * K).fill(-1);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const slot = root[index[f * 3 + k]] * K + lab[f];
      if (first[slot] < 0) first[slot] = f;
      else { const a = find(f), b = find(first[slot]); if (a !== b) parent[a] = b; }
    }
  }
  const regionOf = new Int32Array(nf);
  const ids = new Map();
  for (let f = 0; f < nf; f++) { const r = find(f); if (!ids.has(r)) ids.set(r, ids.size); regionOf[f] = ids.get(r); }
  const R = ids.size;
  const reg = Array.from({ length: R }, () => ({ faces: 0, area: 0, c: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], color: [0, 0, 0] }));
  for (let f = 0; f < nf; f++) {
    const r = reg[regionOf[f]], w = area[f] || 1e-12;
    r.faces++; r.area += area[f];
    for (let k = 0; k < 3; k++) {
      r.c[k] += cen[f * 3 + k] * w;
      if (colors) r.color[k] += colors[f * 3 + k] * w;
      r.min[k] = Math.min(r.min[k], cen[f * 3 + k]); r.max[k] = Math.max(r.max[k], cen[f * 3 + k]);
    }
    r.w = (r.w || 0) + w;
  }
  // Which regions touch: a corner shared by two regions (counted per corner, which is enough to pick a neighbour).
  // ponytail: each corner only remembers the first region seen there; fine for picking the best neighbour.
  const cornerRegion = new Int32Array(nv).fill(-1);
  const touch = Array.from({ length: R }, () => new Map());
  for (let f = 0; f < nf; f++) {
    const r = regionOf[f];
    for (let k = 0; k < 3; k++) {
      const v = root[index[f * 3 + k]], o = cornerRegion[v];
      if (o < 0) cornerRegion[v] = r;
      else if (o !== r) { touch[r].set(o, (touch[r].get(o) || 0) + 1); touch[o].set(r, (touch[o].get(r) || 0) + 1); }
    }
  }
  // Merge the small regions (smallest first) into their best neighbour, then the smallest until maxParts are left.
  const up = Int32Array.from({ length: R }, (_, i) => i);
  const top = (x) => { while (up[x] !== x) { up[x] = up[up[x]]; x = up[x]; } return x; };
  const size = Float64Array.from(reg, (r) => r.area);
  const limit = (totalArea ?? reg.reduce((t, r) => t + r.area, 0)) * minShare;
  const boxGap = (p, r) => Math.hypot(...[0, 1, 2].map((k) => Math.max(r.min[k] - p[k], 0, p[k] - r.max[k])));
  const bigs = [...Array(R).keys()].filter((r) => size[r] >= limit);
  const biggest = [...Array(R).keys()].reduce((a, b) => (size[a] >= size[b] ? a : b), 0);
  const into = (s) => {
    const rs = top(s);
    let best = -1, bc = -1;
    for (const [o, n] of touch[s]) { const ro = top(o); if (ro !== rs && (n > bc || (n === bc && size[ro] > size[best]))) { best = ro; bc = n; } }
    if (best < 0) { // touches nothing (a loose bit): the nearest big region, else any other live region
      const p = reg[s].c.map((v) => v / reg[s].w);
      let bd = Infinity;
      for (const o of bigs) { const ro = top(o); const d = boxGap(p, reg[o]); if (ro !== rs && d < bd) { bd = d; best = ro; } }
      if (best < 0 && top(biggest) !== rs) best = top(biggest);
      if (best < 0) for (let o = 0; o < R && best < 0; o++) if (top(o) !== rs) best = top(o);
    }
    if (best >= 0) { up[rs] = best; size[best] += size[rs]; }
  };
  for (const s of [...Array(R).keys()].sort((a, b) => size[a] - size[b])) if (top(s) === s && size[s] < limit) into(s);
  let live = [...Array(R).keys()].filter((r) => top(r) === r);
  while (live.length > Math.max(1, maxParts)) { into(live.reduce((a, b) => (size[a] <= size[b] ? a : b))); live = live.filter((r) => top(r) === r); }
  // The parts, biggest first.
  live.sort((a, b) => size[b] - size[a]);
  const partOf = new Map(live.map((r, i) => [r, i]));
  const parts = live.map(() => ({ faces: 0, area: 0, c: [0, 0, 0], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], color: colors ? [0, 0, 0] : null, w: 0 }));
  for (let r = 0; r < R; r++) {
    const p = parts[partOf.get(top(r))], g = reg[r];
    p.faces += g.faces; p.area += g.area; p.w += g.w;
    for (let k = 0; k < 3; k++) { p.c[k] += g.c[k]; if (colors) p.color[k] += g.color[k]; p.min[k] = Math.min(p.min[k], g.min[k]); p.max[k] = Math.max(p.max[k], g.max[k]); }
  }
  for (const p of parts) { p.c = p.c.map((v) => v / p.w); if (colors) p.color = p.color.map((v) => v / p.w); delete p.w; }
  const labels = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) labels[f] = partOf.get(top(regionOf[f]));
  return { labels, parts };
}

/** The order infer.js groupFaces gives the labels: most faces first, ties in order of first use. */
export function groupOrder(labels) {
  const count = new Map();
  for (const l of labels) count.set(l, (count.get(l) || 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}

// ---- body map (from the joints, when the model has them) ----
const REGION_OF = [[/head|neck|chin|eye|jaw/i, 'head'], [/hand|wrist|finger|thumb|index|middle|ring|pinky/i, 'hand'], [/foot|toe|ankle/i, 'foot'],
  [/arm|shoulder|elbow|clavicle/i, 'arm'], [/leg|knee|thigh|calf|shin/i, 'leg']];
export const regionOfJoint = (name) => REGION_OF.find(([re]) => re.test(name))?.[1] || 'core';
/** Which part of the body a point is on: the region of the nearest joint ({ name, p }), or null with no joints. */
export function bodyRegion(p, joints) {
  if (!joints?.length) return null;
  let best = null, bd = Infinity;
  for (const j of joints) { const d = dist(p, j.p); if (d < bd) { bd = d; best = j; } }
  return regionOfJoint(best.name);
}
/** The body's middle: x of the hips (or the spine) when there are joints, else the middle of the box. */
export function middleX(joints, box) {
  const mid = joints?.find((j) => /hips|pelvis|groin/i.test(j.name)) || joints?.find((j) => /spine|chest/i.test(j.name));
  return mid ? mid.p[0] : (box.min[0] + box.max[0]) / 2;
}

/**
 * Left and right twins: parts whose centre, mirrored across the plane x = center, lands on another part of about
 * the same size. parts: [{ c, area }]. size: the model's size (the box diagonal). Returns [[i, j], ...].
 * ponytail: the middle plane is always x (the model's own left and right); a model lying on its side pairs nothing.
 */
export function mirrorPairs(parts, center, size) {
  const cand = [];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i];
    if (Math.abs(a.c[0] - center) < size * 0.02) continue; // on the middle line: it is its own twin
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j], r = a.area / b.area;
      if (r < 0.6 || r > 1 / 0.6 || Math.sign(a.c[0] - center) === Math.sign(b.c[0] - center)) continue;
      const d = dist([2 * center - a.c[0], a.c[1], a.c[2]], b.c);
      if (d < size * 0.06) cand.push([d + Math.abs(Math.log(r)) * size * 0.01, i, j]);
    }
  }
  const used = new Set(), out = [];
  for (const [, i, j] of cand.sort((x, y) => x[0] - y[0])) if (!used.has(i) && !used.has(j)) { used.add(i); used.add(j); out.push([i, j]); }
  return out;
}

const sat = (c) => { const mx = Math.max(...c); return mx ? (mx - Math.min(...c)) / mx : 0; };
const avg = (items, f) => { const w = items.reduce((t, x) => t + x.area, 0) || 1; return [0, 1, 2].map((k) => items.reduce((t, x) => t + f(x)[k] * x.area, 0) / w); };

/**
 * The role of every part. parts: [{ key, area (share of the model, 0..1), c: [x, y, z], color: [r, g, b] 0..1 or
 * null, emissive: 0..1 (how much it already glows) }]. opts: { center (middle x), size (box diagonal), joints,
 * locked: { key: role } (kept as they are) }. Returns { key: role }. The rules, in order:
 * - Twins (mirrorPairs) are one unit and always share a role.
 * - Glow: a unit that already glows (emissive 0.3 or more), or a small neon one (bright and strong color).
 *   Energy: a small unit (under 5%) that glows hard (0.6 or more).
 * - The rest are put in paints (units of nearly the same color). The biggest paint is Primary (parts on the
 *   body's core count a quarter more when there are joints). A small paint (under 4%) that stands out from Primary
 *   is Accent. The next paints are Secondary, then Tertiary; any more take the role of the closest color.
 * - With one paint only (a plain or one-texture model), size decides: the biggest unit is Primary, the next
 *   Secondary, the next Tertiary; small parts (under 2% each, or a hand or foot under 3%) are Accent, and the rest
 *   are Secondary when at least half as big as Secondary, else Tertiary.
 */
export function labelRoles(parts, { center = 0, size = 1, joints = null, locked = {} } = {}) {
  const out = {};
  const pairOf = new Map();
  for (const [i, j] of mirrorPairs(parts, center, size)) { pairOf.set(i, j); pairOf.set(j, i); }
  const units = [];
  for (let i = 0; i < parts.length; i++) {
    if (pairOf.has(i) && pairOf.get(i) < i) continue;
    const members = [parts[i], ...(pairOf.has(i) ? [parts[pairOf.get(i)]] : [])];
    const area = members.reduce((t, p) => t + p.area, 0);
    const c = avg(members, (p) => [center + Math.abs(p.c[0] - center), p.c[1], p.c[2]]);
    const color = members.every((p) => p.color) ? avg(members, (p) => p.color) : null;
    const region = bodyRegion(c, joints);
    units.push({ keys: members.map((p) => p.key), area, c, color, region, emissive: Math.max(...members.map((p) => p.emissive || 0)), weight: area * (region === 'core' ? 1.25 : 1) });
  }
  const set = (u, role) => { for (const k of u.keys) out[k] = role; u.role = role; };
  // A locked part keeps its role, and so does its twin.
  for (const u of units) { const k = u.keys.find((x) => locked[x]); if (k) set(u, locked[k]); }
  const free = units.filter((u) => !u.role);
  for (const u of free) {
    const neon = u.color && Math.max(...u.color) > 0.9 && sat(u.color) > 0.6 && u.area < 0.02;
    if (u.emissive >= 0.6 && u.area < 0.05) set(u, 'energy');
    else if (u.emissive >= 0.3 || neon) set(u, 'emissive');
  }
  const rest = free.filter((u) => !u.role);
  if (!rest.length) return out;
  // Paints: units of about the same color.
  const paints = [];
  const colored = rest.every((u) => u.color);
  for (const u of [...rest].sort((a, b) => b.weight - a.weight)) {
    const p = !colored ? paints[0] : paints.find((q) => colorDist(q.color, u.color) < SAME_COLOR * 1.5);
    if (p) { p.units.push(u); p.weight += u.weight; p.area += u.area; } else paints.push({ color: u.color, units: [u], weight: u.weight, area: u.area });
  }
  paints.sort((a, b) => b.weight - a.weight);
  if (paints.length > 1) {
    const [main, ...others] = paints;
    for (const u of main.units) set(u, 'primary');
    const named = [main];
    for (const p of others) {
      const role = p.area < 0.04 && colorDist(p.color, main.color) > 0.3 ? 'accents' : named.length === 1 ? 'secondary' : named.length === 2 ? 'tertiary' : null;
      if (role === 'secondary' || role === 'tertiary') named.push(p);
      const final = role || named.reduce((a, b) => (colorDist(a.color, p.color) <= colorDist(b.color, p.color) ? a : b)).units[0].role;
      for (const u of p.units) set(u, final);
    }
    return out;
  }
  const bySize = [...rest].sort((a, b) => b.weight - a.weight);
  set(bySize[0], 'primary');
  let second = null;
  for (const u of bySize.slice(1)) {
    const each = u.area / u.keys.length; // a twin's own size
    const tiny = each < 0.02 || ((u.region === 'hand' || u.region === 'foot') && each < 0.03);
    if (tiny) set(u, 'accents');
    else if (!second) { second = u; set(u, 'secondary'); } else if (!bySize.some((x) => x.role === 'tertiary')) set(u, 'tertiary');
    else set(u, u.area >= second.area / 2 ? 'secondary' : 'tertiary');
  }
  return out;
}

// ---- keeping roles when the model changes (made again, joints added, a piece removed) ----
/** A part's centre as a share of the model's box (0..1 on the longest side), so a new size or place still matches. */
export function normPoint(c, box) {
  const s = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) || 1;
  return [0, 1, 2].map((k) => Number(((c[k] - box.min[k]) / s).toFixed(4)));
}
/**
 * The old part each new part is, by where it sits and how big it is. old: { key: { c (normPoint), a (share), role,
 * locked } }, fresh: [{ key, c, a }]. A new part takes the closest old part within a tenth of the model and with
 * a size between a third and three times; else it has no match (it gets a fresh guess). Returns { key: { role, locked } }.
 */
export function rematch(old, fresh) {
  const prev = Object.values(old || {}).filter((p) => p?.c && p.role);
  const out = {};
  for (const n of fresh) {
    let best = null, bs = Infinity;
    for (const o of prev) {
      const r = n.a / (o.a || 1e-9);
      if (r < 1 / 3 || r > 3) continue;
      const s = dist(n.c, o.c) + Math.abs(Math.log(r)) * 0.02;
      if (dist(n.c, o.c) <= 0.1 && s < bs) { bs = s; best = o; }
    }
    if (best) out[n.key] = { role: best.role, locked: Boolean(best.locked) };
  }
  return out;
}

// ---- the paint ----
/** Every role's current color (paint.colors.global, as tenno.js resolveColors) and the roles settings. */
export const rolesOf = (paint) => ({ ...DEFAULT_ROLES, ...paint?.roles, strength: { ...DEFAULT_ROLES.strength, ...paint?.roles?.strength } });
/** How bright a Glow or Energy piece is (null: not one, or the model has no Part colors yet). Same in the app and Blender. */
export const glowOf = (paint, slot) => (paint?.roles && (slot === 'emissive' || slot === 'energy') ? rolesOf(paint).strength[slot] : null);
/** Energy's slow pulse: full strength at t = 0, down to 30% at the low point. speed: pulses a second (0 = steady). */
export const pulseAt = (strength, speed, t) => (speed > 0 ? strength * (0.65 + 0.35 * Math.cos(2 * Math.PI * speed * t)) : strength);

/**
 * The paint with new parts and roles. found: { parts: [{ key, name, c, a, role, locked }], groups: { meshKey:
 * { labels, names } } (face groups this made), meshes: [meshKeys it split], sig, colors: { role: hex } to seed
 * (first guess only) }. Part records this made before for parts that are gone are dropped; the rest is kept.
 */
export function applyRoles(paint, { parts, groups = {}, meshes = [], sig = '', colors = null }) {
  const old = paint.roles || {};
  const pieces = { ...paint.pieces };
  const now = new Set(parts.map((p) => p.key));
  for (const k of Object.keys(old.parts || {})) if (!now.has(k) && pieces[k]?.made === 'roles') delete pieces[k]; // parts that are gone
  const keepGroups = Object.fromEntries(Object.entries(paint.groups || {}).filter(([k]) => !(old.meshes || []).includes(k)));
  const rolesParts = {};
  for (const p of parts) {
    const rec = pieces[p.key];
    pieces[p.key] = { ...(rec || { name: p.name, made: 'roles' }), slot: p.role, autoSlot: false };
    rolesParts[p.key] = { c: p.c, a: Number(p.a.toFixed(5)), ...(p.locked && { locked: true }) };
  }
  const global = { ...paint.colors?.global, ...(colors || {}) };
  return {
    ...paint, pieces, groups: { ...keepGroups, ...groups },
    colors: { ...paint.colors, global },
    roles: { strength: rolesOf(paint).strength, pulse: rolesOf(paint).pulse, parts: rolesParts, meshes, sig, guessed: true },
  };
}
/** One part's role, picked by hand (it is then locked, so Guess again leaves it). */
export function setRole(paint, key, role) {
  if (!ROLE_IDS.includes(role)) throw new Error(`Unknown role ${role}`);
  const parts = { ...paint.roles?.parts };
  if (parts[key]) parts[key] = { ...parts[key], locked: true };
  return { ...paint, pieces: { ...paint.pieces, [key]: { ...(paint.pieces?.[key] || { name: key }), slot: role, autoSlot: false } }, roles: { ...paint.roles, parts } };
}
export function setLocked(paint, key, locked) {
  const parts = { ...paint.roles?.parts };
  if (!parts[key]) return paint;
  parts[key] = { ...parts[key] };
  if (locked) parts[key].locked = true; else delete parts[key].locked;
  return { ...paint, roles: { ...paint.roles, parts } };
}
/** The saved parts with their roles, for rematch and Guess again: { key: { c, a, role, locked } }. */
export const savedParts = (paint) => Object.fromEntries(Object.entries(paint?.roles?.parts || {}).map(([k, p]) => [k, { ...p, role: paint.pieces?.[k]?.slot || null }]));
/** How many parts have each role. */
export function roleCounts(paint) {
  const out = Object.fromEntries(ROLE_IDS.map((r) => [r, 0]));
  for (const k of Object.keys(paint?.roles?.parts || {})) { const s = paint.pieces?.[k]?.slot; if (s in out) out[s]++; }
  return out;
}
/** The paint as the test-color preview shows it: every role in its bright test color, flat (no texture under it). */
export function withTestColors(paint) {
  const pieces = {};
  for (const [k, p] of Object.entries(paint.pieces || {})) pieces[k] = p.slot ? { ...p, colors: null, material: { ...p.material, color: null, textured: false } } : p;
  return { ...paint, pieces, colors: { ...paint.colors, global: { ...paint.colors?.global, ...TEST_COLORS }, sections: {} } };
}

/** The two numbers Blender needs to pulse an Energy piece frame by frame (render/blender_turntable.py pulse_at). */
export const blenderPulse = (paint, slot) => (slot === 'energy' && rolesOf(paint).pulse > 0 ? { strength: rolesOf(paint).strength.energy, speed: rolesOf(paint).pulse } : null);
