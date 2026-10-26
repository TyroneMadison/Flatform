// Free auto-rig, the thinking half (render/blender_autorig.py does the Blender half). Works out a standing humanoid's
// skeleton from the mesh itself and how every vertex is bound to it. Pure: node tests run it on made-up bodies.
//
//   1. Which way it faces: the legs and shoulders spread sideways, the toes point forward (bodyFrame).
//   2. A solid voxel copy of the body (voxelize), how deep each voxel is inside it (depthField).
//   3. Shortest paths through the middle of the body from the chest reach the feet, the hands and the top of the head
//      (geodesic extremities); where the two leg paths meet is the pelvis.
//   4. Joints on those centre lines: the neck at the narrowest cross-section slice under the head, shoulders where an
//      arm path leaves the thick torso, elbows and knees at the bend (else the narrowest point mid-limb), wrists and
//      ankles at the narrowest point near the end.
//   5. Binding: each voxel belongs to the bone that reaches it first through the body. A separate armour piece is
//      bound whole (rigid) to the one bone most of it sits on; a one-piece body gets smooth weights blended across
//      each joint with the bone next to it (never a bone from another limb).
//   6. validateRig: every vertex bound, every joint inside the body, limbs the right length, no piece tied to a far
//      limb, and a test pose that must not tear anything.
// Coordinates are glTF (Y up, metres) unless named local: local is [left, up, forward] in the body's own frame.
import { BONES } from './motion.js';

// bone: [head joint, tail joint, parent]
export const LAYOUT = {
  Hips: ['Hips', 'Spine', null], Spine: ['Spine', 'Spine1', 'Hips'], Spine1: ['Spine1', 'Spine2', 'Spine'],
  Spine2: ['Spine2', 'Neck', 'Spine1'], Neck: ['Neck', 'Head', 'Spine2'], Head: ['Head', 'HeadTop', 'Neck'],
};
for (const s of ['Left', 'Right']) {
  Object.assign(LAYOUT, {
    [`${s}Shoulder`]: [`${s}Shoulder`, `${s}Arm`, 'Spine2'], [`${s}Arm`]: [`${s}Arm`, `${s}ForeArm`, `${s}Shoulder`],
    [`${s}ForeArm`]: [`${s}ForeArm`, `${s}Hand`, `${s}Arm`], [`${s}Hand`]: [`${s}Hand`, `${s}HandTip`, `${s}ForeArm`],
    [`${s}UpLeg`]: [`${s}UpLeg`, `${s}Leg`, 'Hips'], [`${s}Leg`]: [`${s}Leg`, `${s}Foot`, `${s}UpLeg`],
    [`${s}Foot`]: [`${s}Foot`, `${s}ToeBase`, `${s}Leg`], [`${s}ToeBase`]: [`${s}ToeBase`, `${s}ToeEnd`, `${s}Foot`],
  });
}
/** Which limb a bone is on: core, leftArm, rightArm, leftLeg, rightLeg. */
export const chainOf = (bone) => (/^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/.test(bone) ? `${bone.startsWith('Left') ? 'left' : 'right'}Arm`
  : /^(Left|Right)(UpLeg|Leg|Foot|ToeBase)$/.test(bone) ? `${bone.startsWith('Left') ? 'left' : 'right'}Leg` : 'core');
// The landmarks the user clicks when detection fails (in this order).
export const MARKERS = ['chin', 'groin', 'leftElbow', 'leftWrist', 'rightElbow', 'rightWrist', 'leftKnee', 'leftAnkle', 'rightKnee', 'rightAnkle'];
export const MARKER_LABELS = { chin: 'the chin', groin: 'the groin (where the legs meet)', leftElbow: 'the left elbow', leftWrist: 'the left wrist', rightElbow: 'the right elbow', rightWrist: 'the right wrist', leftKnee: 'the left knee', leftAnkle: 'the left ankle', rightKnee: 'the right knee', rightAnkle: 'the right ankle' };

// --- small vector helpers ([x, y, z] arrays) ---
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Distance from p to the segment a-b, and how far along it (0..1) the closest point is. */
export function segDist(p, a, b) {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1e-12), 0, 1);
  return { d: len(sub(add(a, mul(ab, t)), p)), t };
}

/** Loose pieces: island id per vertex (vertices joined by triangles), with the count and each island's size. */
export function islandsOf(nVerts, tris) {
  const parent = new Int32Array(nVerts);
  for (let i = 0; i < nVerts; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a < b ? b : a] = a < b ? a : b; };
  for (let t = 0; t < tris.length; t += 3) { join(tris[t], tris[t + 1]); join(tris[t], tris[t + 2]); }
  const id = new Int32Array(nVerts).fill(-1);
  const sizes = [];
  for (let i = 0; i < nVerts; i++) {
    const r = find(i);
    if (id[r] < 0) { id[r] = sizes.length; sizes.push(0); }
    id[i] = id[r];
    sizes[id[i]]++;
  }
  return { id, count: sizes.length, sizes };
}

const stride = (n, max = 200000) => Math.max(1, Math.floor(n / max));

/**
 * Which way the body faces. Up is glTF +Y. The sideways axis is the way the legs and shoulders spread most; forward
 * is the way the toes stick out past the ankles (else glTF +Z, the way a model normally faces).
 * Returns { up, left, forward } unit vectors with left = up × forward.
 */
export function bodyFrame(pos) {
  const n = pos.length / 3, k = stride(n);
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i += k) { const y = pos[i * 3 + 1]; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
  const H = ymax - ymin || 1;
  const band = (lo, hi) => {
    let c = 0, mx = 0, mz = 0;
    const pts = [];
    for (let i = 0; i < n; i += k) { const y = (pos[i * 3 + 1] - ymin) / H; if (y >= lo && y <= hi) { pts.push(i); mx += pos[i * 3]; mz += pos[i * 3 + 2]; c++; } }
    return { pts, mx: mx / (c || 1), mz: mz / (c || 1), c };
  };
  let sxx = 0, szz = 0, sxz = 0;
  for (const [lo, hi] of [[0.05, 0.35], [0.7, 0.82]]) {
    const b = band(lo, hi);
    for (const i of b.pts) { const dx = pos[i * 3] - b.mx, dz = pos[i * 3 + 2] - b.mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  }
  const tr = sxx + szz, det = sxx * szz - sxz * sxz;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det)), l2 = tr - l1;
  let fwd = [0, 0, 1];
  if (l2 <= 0 || l1 / l2 > 1.15) { // a clear sideways spread
    const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const side = [Math.cos(th), 0, Math.sin(th)];
    fwd = norm([-side[2], 0, side[0]]);
    if (fwd[2] < -1e-9 || (Math.abs(fwd[2]) <= 1e-9 && fwd[0] < 0)) fwd = mul(fwd, -1); // the candidate nearer +Z
  }
  // Toes stick out forward past the ankles.
  const toes = band(0, 0.04), ankles = band(0.08, 0.16);
  if (toes.c && ankles.c) {
    const d = dot([toes.mx - ankles.mx, 0, toes.mz - ankles.mz], fwd);
    if (d < -0.005 * H) fwd = mul(fwd, -1);
  }
  const up = [0, 1, 0];
  return { up, forward: fwd, left: norm(cross(up, fwd)) };
}

/**
 * A solid voxel copy of the body in its own frame: cell size H / res, every vertex and triangle marked, one cell of
 * padding to close hairline gaps between pieces, then the inside filled (whatever the outside can't reach).
 * Returns the grid with vcell (each vertex's cell) and helpers to go between cells and coordinates.
 */
export function voxelize(pos, tris, frame, res = 128) {
  const n = pos.length / 3;
  const L = new Float32Array(n * 3);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const axes = [frame.left, frame.up, frame.forward];
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    for (let a = 0; a < 3; a++) {
      const v = x * axes[a][0] + y * axes[a][1] + z * axes[a][2];
      L[i * 3 + a] = v;
      if (v < mn[a]) mn[a] = v;
      if (v > mx[a]) mx[a] = v;
    }
  }
  const H = mx[1] - mn[1] || 1;
  const h = H / res, PAD = 3;
  const o = mn.map((v) => v - PAD * h);
  const [nx, ny, nz] = [0, 1, 2].map((a) => Math.ceil((mx[a] - mn[a]) / h) + 2 * PAD + 1);
  const N = nx * ny * nz;
  const at = (u, v, w) => (Math.floor((v - o[1]) / h) * nz + Math.floor((w - o[2]) / h)) * nx + Math.floor((u - o[0]) / h);
  const surf = new Uint8Array(N);
  const vcell = new Int32Array(n);
  for (let i = 0; i < n; i++) { const c = at(L[i * 3], L[i * 3 + 1], L[i * 3 + 2]); vcell[i] = c; surf[c] = 1; }
  for (let t = 0; t < tris.length; t += 3) { // big triangles: sample their surface too
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const e = Math.max(Math.hypot(L[a] - L[b], L[a + 1] - L[b + 1], L[a + 2] - L[b + 2]), Math.hypot(L[a] - L[c], L[a + 1] - L[c + 1], L[a + 2] - L[c + 2]), Math.hypot(L[b] - L[c], L[b + 1] - L[c + 1], L[b + 2] - L[c + 2]));
    if (e < h) continue;
    const s = Math.ceil((e / h) * 2);
    for (let i = 0; i <= s; i++) for (let j = 0; j <= s - i; j++) {
      const wa = i / s, wb = j / s, wc = 1 - wa - wb;
      surf[at(L[a] * wa + L[b] * wb + L[c] * wc, L[a + 1] * wa + L[b + 1] * wb + L[c + 1] * wc, L[a + 2] * wa + L[b + 2] * wb + L[c + 2] * wc)] = 1;
    }
  }
  const sx = 1, sz = nx, sy = nx * nz;
  const solid = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (!surf[c]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) solid[c + dy * sy + dz * sz + dx * sx] = 1;
  }
  // The outside, flooded in from the edge; anything it can't reach is inside the body.
  const out = new Uint8Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  q[tail++] = 0; out[0] = 1;
  const six = [sx, -sx, sz, -sz, sy, -sy];
  while (head < tail) {
    const c = q[head++];
    const i = c % nx, k = Math.floor(c / nx) % nz, j = Math.floor(c / sy);
    for (let d = 0; d < 6; d++) {
      if ((d === 0 && i === nx - 1) || (d === 1 && i === 0) || (d === 2 && k === nz - 1) || (d === 3 && k === 0) || (d === 4 && j === ny - 1) || (d === 5 && j === 0)) continue;
      const nb = c + six[d];
      if (!out[nb] && !solid[nb]) { out[nb] = 1; q[tail++] = nb; }
    }
  }
  for (let c = 0; c < N; c++) if (!out[c]) solid[c] = 1;
  const center = (c) => [o[0] + ((c % nx) + 0.5) * h, o[1] + (Math.floor(c / sy) + 0.5) * h, o[2] + ((Math.floor(c / nx) % nz) + 0.5) * h];
  const toWorld = (p) => add(add(mul(frame.left, p[0]), mul(frame.up, p[1])), mul(frame.forward, p[2]));
  const toLocal = (p) => [dot(p, frame.left), dot(p, frame.up), dot(p, frame.forward)];
  const cellOf = (p) => { const c = at(p[0], p[1], p[2]); return c >= 0 && c < N ? c : -1; };
  return { nx, ny, nz, N, h, H, o, floor: mn[1], solid, vcell, local: L, sx, sy, sz, frame, center, toWorld, toLocal, cellOf };
}

/** How many cells deep inside the body each solid cell is (1 on the skin). */
export function depthField(g) {
  const { N, solid, sy, sz } = g;
  const depth = new Uint16Array(N);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  const six = [1, -1, sz, -sz, sy, -sy];
  for (let c = 0; c < N; c++) {
    if (!solid[c]) continue;
    if (six.some((d) => !solid[c + d])) { depth[c] = 1; q[tail++] = c; }
  }
  while (head < tail) {
    const c = q[head++];
    for (const d of six) { const nb = c + d; if (solid[nb] && !depth[nb]) { depth[nb] = depth[c] + 1; q[tail++] = nb; } }
  }
  return depth;
}

// A binary heap of (key, cell) for Dijkstra.
function heap() {
  let k = new Float64Array(1024), v = new Int32Array(1024), n = 0;
  return {
    get size() { return n; },
    push(key, val) {
      if (n === k.length) { const k2 = new Float64Array(n * 2); k2.set(k); k = k2; const v2 = new Int32Array(n * 2); v2.set(v); v = v2; }
      let i = n++;
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    },
    pop() {
      const top = v[0], key = k[--n], val = v[n];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= key) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = key; v[i] = val;
      return top;
    },
  };
}
function neighbours(g) {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (dx || dy || dz) out.push([dy * g.sy + dz * g.sz + dx, Math.hypot(dx, dy, dz) * g.h]);
  }
  return out;
}
/**
 * Shortest paths through the solid from the seed cells. centred: paths keep to the middle of each limb (a step costs
 * more near the skin), so they trace the limbs' centre lines. labels (one per seed) spread with the paths.
 */
export function geodesic(g, seeds, { depth = null, labels = null, mask = g.solid } = {}) {
  const dist = new Float64Array(g.N).fill(Infinity);
  const prev = new Int32Array(g.N).fill(-1);
  const label = labels ? new Int16Array(g.N).fill(-1) : null;
  const H = heap();
  seeds.forEach((c, i) => { if (c >= 0 && mask[c] && dist[c] > 0) { dist[c] = 0; H.push(0, c); if (label) label[c] = labels[i]; } });
  const nb = neighbours(g);
  while (H.size) {
    const c = H.pop();
    const dc = dist[c];
    for (const [d, l] of nb) {
      const x = c + d;
      if (!mask[x]) continue;
      const step = depth ? l * (1 + 8 / (depth[x] * depth[x])) : l;
      if (dc + step < dist[x]) { dist[x] = dc + step; prev[x] = c; if (label) label[x] = label[c]; H.push(dist[x], x); }
    }
  }
  return { dist, prev, label };
}
const pathTo = (prev, c) => { const p = []; for (let x = c; x >= 0; x = prev[x]) p.push(x); return p; };

/** A path of cells → smoothed points (local coords) with the depth at each and the length along it. */
function line(g, depth, cells) {
  const raw = cells.map((c) => g.center(c));
  const pts = raw.map((_, i) => {
    let s = [0, 0, 0], k = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) { s = add(s, raw[j]); k++; }
    return mul(s, 1 / k);
  });
  pts[0] = raw[0]; pts[pts.length - 1] = raw.at(-1);
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + len(sub(pts[i], pts[i - 1])));
  return { pts, d: cells.map((c) => depth[c]), s, cells, L: s.at(-1) };
}
const indexAt = (ln, s) => { let i = 0; while (i < ln.s.length - 1 && ln.s[i] < s) i++; return i; };
const pointAt = (ln, s) => ln.pts[indexAt(ln, s)];
// The thinnest point (least depth) between two lengths along a line; ties go to the middle of the run.
function narrowest(ln, s0, s1) {
  let best = -1;
  for (let i = indexAt(ln, s0); i <= indexAt(ln, s1); i++) if (best < 0 || ln.d[i] < ln.d[best]) best = i;
  let end = best;
  while (end + 1 <= indexAt(ln, s1) && ln.d[end + 1] === ln.d[best]) end++;
  return Math.round((best + end) / 2);
}
// The sharpest bend between two lengths along a line: [index, degrees].
function bend(ln, s0, s1, k) {
  let best = [-1, 0];
  for (let i = indexAt(ln, s0); i <= indexAt(ln, s1); i++) {
    const a = pointAt(ln, ln.s[i] - k), b = ln.pts[i], c = pointAt(ln, ln.s[i] + k);
    const u = sub(b, a), v = sub(c, b);
    if (len(u) < 1e-9 || len(v) < 1e-9) continue;
    const deg = (Math.acos(clamp(dot(u, v) / len(u) / len(v), -1, 1)) * 180) / Math.PI;
    if (deg > best[1]) best = [i, deg];
  }
  return best;
}
// How wide the body is sideways at a cell: the run of solid cells along the left-right axis through it.
function rowRun(g, c) {
  let n = 1;
  for (let x = c + 1; g.solid[x]; x++) n++;
  for (let x = c - 1; g.solid[x]; x--) n++;
  return n;
}

/**
 * Finds the skeleton. Returns { joints (local), problems: [plain sentences], found: { ... } }.
 */
export function findJoints(g, depth) {
  const { H, floor } = g;
  const rel = (p) => (p[1] - floor) / H;
  const problems = [];
  // The middle of the body, sideways: the median of the chest band.
  const us = [];
  for (let c = 0; c < g.N; c++) if (g.solid[c]) { const p = g.center(c); const r = rel(p); if (r > 0.55 && r < 0.8) us.push(p[0]); }
  if (!us.length) return { joints: null, problems: ['This does not look like a standing person'] };
  us.sort((a, b) => a - b);
  const uc = us[us.length >> 1];
  let chest = -1;
  for (let c = 0; c < g.N; c++) {
    if (!g.solid[c]) continue;
    const p = g.center(c), r = rel(p);
    if (r < 0.62 || r > 0.78 || Math.abs(p[0] - uc) > 0.12 * H) continue;
    if (chest < 0 || depth[c] > depth[chest] || (depth[c] === depth[chest] && Math.abs(p[0] - uc) < Math.abs(g.center(chest)[0] - uc))) chest = c;
  }
  if (chest < 0) return { joints: null, problems: ['Could not find the chest'] };
  // Plain distances pick the far ends (hands, feet, head); the centred paths give the limbs' centre lines.
  const D1 = geodesic(g, [chest], { depth }), F1 = geodesic(g, [chest]);
  const argmax = (score, ok) => {
    let best = -1, bs = -Infinity;
    for (let c = 0; c < g.N; c++) {
      if (!g.solid[c] || !Number.isFinite(F1.dist[c])) continue;
      const p = g.center(c);
      if (!ok(p, c)) continue;
      const s = score(p, c);
      if (s > bs) { bs = s; best = c; }
    }
    return best;
  };
  const foot = (side) => argmax((p, c) => F1.dist[c], (p) => rel(p) < 0.15 && side * (p[0] - uc) > 0);
  const footL = foot(1), footR = foot(-1);
  if (footL < 0 || footR < 0) return { joints: null, problems: ['Could not find two legs. Stand the model up on both feet.'] };
  // The groin, by slicing up from the feet: the first height where the body is solid (more than skin deep) all the
  // way from one leg's centre line to the other's. The hips joint sits a little above it.
  const rows = (foot) => { const m = new Map(); for (const c of pathTo(D1.prev, foot)) { const j = Math.floor(c / g.sy); if (!m.has(j)) m.set(j, c); } return m; };
  const rl = rows(footL), rr = rows(footR);
  let pelvis = -1;
  for (let j = Math.floor((floor + 0.1 * H - g.o[1]) / g.h); j < g.ny && pelvis < 0; j++) {
    if (!rl.has(j) || !rr.has(j)) continue;
    const a = g.center(rl.get(j)), b = g.center(rr.get(j));
    if (rel(a) > 0.75) break;
    const k = Math.ceil(len(sub(b, a)) / (g.h / 2));
    let joined = true;
    for (let t = 0; t <= k && joined; t++) joined = depth[g.cellOf(lerp(a, b, t / k))] >= 3; // not just two thighs touching
    if (joined) { const c = g.cellOf(add(lerp(a, b, 0.5), [0, 0.04 * H, 0])); pelvis = g.solid[c] ? c : g.cellOf(lerp(a, b, 0.5)); }
  }
  if (pelvis >= 0 && rel(g.center(pelvis)) < 0.42) { // thighs pressed together join early: the hips go where they usually are
    const j = Math.floor((floor + 0.5 * H - g.o[1]) / g.h);
    const a = rl.get(j), b = rr.get(j);
    if (a !== undefined && b !== undefined) pelvis = g.cellOf(lerp(g.center(a), g.center(b), 0.5));
  }
  if (pelvis < 0 || !g.solid[pelvis] || rel(g.center(pelvis)) < 0.3 || rel(g.center(pelvis)) > 0.72) problems.push('Could not find where the legs meet');
  if (pelvis < 0 || !g.solid[pelvis]) return { joints: null, problems };
  const D2 = geodesic(g, [pelvis], { depth });
  // Arms and head: cells whose centre-line path from the chest does not come up through the hips (a hand resting
  // on a thigh still hangs from its shoulder).
  const P0 = g.center(pelvis);
  const order = [];
  for (let c = 0; c < g.N; c++) if (g.solid[c] && Number.isFinite(D1.dist[c])) order.push(c);
  order.sort((a, b) => D1.dist[a] - D1.dist[b]);
  const via = new Uint8Array(g.N);
  for (const c of order) via[c] = (D1.prev[c] >= 0 && via[D1.prev[c]]) || len(sub(g.center(c), P0)) < 0.07 * H ? 1 : 0;
  const upper = (c) => !via[c];
  const top = argmax((p, c) => p[1] + F1.dist[c] * 1e-3, (p, c) => upper(c) && Math.abs(p[0] - uc) < 0.1 * H && p[1] > g.center(chest)[1]);
  if (top < 0) problems.push('Could not find the head');
  if (top < 0) return { joints: null, problems };

  const J = {};
  // The core: pelvis → chest → top of the head.
  const core = line(g, depth, [...pathTo(D1.prev, pelvis), ...pathTo(D1.prev, top).reverse().slice(1)]);
  let neckI = -1;
  for (let i = 0; i < core.pts.length; i++) {
    const r = rel(core.pts[i]);
    if (r < 0.72 || r > 0.93) continue;
    const w = rowRun(g, core.cells[i]);
    if (neckI < 0 || w < rowRun(g, core.cells[neckI])) neckI = i;
  }
  if (neckI < 0) neckI = indexAt(core, core.L * 0.75);
  J.Neck = core.pts[neckI];
  J.HeadTop = core.pts.at(-1);
  const headV = J.Neck[1] + 0.28 * (J.HeadTop[1] - J.Neck[1]);
  let hi = neckI;
  while (hi < core.pts.length - 1 && core.pts[hi][1] < headV) hi++;
  J.Head = core.pts[hi];
  J.Hips = core.pts[0];
  const sNeck = core.s[neckI];
  J.Spine = pointAt(core, sNeck * 0.2);
  J.Spine1 = pointAt(core, sNeck * 0.43);
  J.Spine2 = pointAt(core, sNeck * 0.67);
  const clav = pointAt(core, sNeck * 0.85);

  const legLines = [];
  for (const [side, tip] of [['Left', footL], ['Right', footR]]) {
    const leg = line(g, depth, pathTo(D2.prev, tip).reverse()); // pelvis → toe tip
    legLines.push(leg);
    let hipI = 0;
    while (hipI < leg.pts.length - 1 && rel(leg.pts[hipI]) > rel(J.Hips) - 0.05) hipI++;
    let an = -1;
    for (let i = hipI; i < leg.pts.length; i++) { const r = rel(leg.pts[i]); if (r >= 0.03 && r <= 0.14 && (an < 0 || leg.d[i] < leg.d[an])) an = i; }
    if (an < 0) { an = hipI; while (an < leg.pts.length - 1 && rel(leg.pts[an]) > 0.06) an++; }
    const sh = leg.s[hipI], sa = leg.s[an];
    const [bi, deg] = bend(leg, sh + 0.3 * (sa - sh), sh + 0.7 * (sa - sh), 0.1 * (sa - sh));
    const kn = deg >= 15 ? bi : narrowest(leg, sh + 0.42 * (sa - sh), sh + 0.6 * (sa - sh));
    J[`${side}UpLeg`] = leg.pts[hipI];
    J[`${side}Leg`] = leg.pts[kn];
    J[`${side}Foot`] = leg.pts[an];
    const toe = leg.pts.at(-1);
    J[`${side}ToeEnd`] = toe;
    J[`${side}ToeBase`] = pointAt(leg, sa + 0.6 * (leg.L - sa));
  }
  // Arms. In each height slice from the hips to the neck the torso is the thick run of cells (front to back) round
  // the spine; it ends at the side where the slice gets thin (an arm, even one pressed against the body). What is
  // left above mid-thigh, minus the legs, is arms: each arm joins the torso at its shoulder and its far end is the hand.
  const row = (p) => Math.floor((p[1] - g.o[1]) / g.h);
  const coreAt = new Map();
  core.cells.forEach((c) => { const j = Math.floor(c / g.sy); if (!coreAt.has(j)) coreAt.set(j, c); });
  const run = (c) => { let a = c, b = c; while (g.solid[a - g.sz]) a -= g.sz; while (g.solid[b + g.sz]) b += g.sz; return [a, b]; };
  const torso = new Uint8Array(g.N);
  const jHip = row(J.Hips), jNeck = row(J.Neck);
  for (let j = jHip, last = -1; j <= jNeck; j++) {
    const c0 = coreAt.get(j) ?? last;
    if (c0 < 0 || c0 === undefined) continue;
    const at0 = c0 + (j - Math.floor(c0 / g.sy)) * g.sy;
    last = c0;
    if (!g.solid[at0]) continue;
    const thick = 1.25 * Math.max(2, depth[at0]); // the torso is about twice its centre depth thick, an arm much less
    for (const dir of [1, -1]) {
      for (let x = at0; ; x += dir) {
        if (x !== at0 && !g.solid[x]) break;
        const [a, b] = run(x);
        if (x !== at0 && (b - a) / g.sz + 1 < thick) break;
        for (let y = a; y <= b; y += g.sz) torso[y] = 1;
      }
    }
  }
  // Grow the torso three cells round its edge in each slice, so its rounded sides are not left over as a strip.
  for (let k = 0; k < 3; k++) {
    const grow = [];
    for (let c = 0; c < g.N; c++) if (torso[c]) for (const d of [1, -1, g.sz, -g.sz]) if (g.solid[c + d] && !torso[c + d]) grow.push(c + d);
    for (const c of grow) torso[c] = 1;
  }
  // The legs below the hips: in each slice, the piece round a leg's centre line, out to a little past its skin (so
  // armour on the thigh is leg, a hand hanging beside it is not).
  const leg = new Uint8Array(g.N);
  for (const ln of legLines) for (const c of ln.cells) {
    if (Math.floor(c / g.sy) >= jHip) continue;
    const p0 = g.center(c), r = 1.2 * depth[c] * g.h + g.h;
    const st = [c]; leg[c] = 1;
    while (st.length) {
      const x = st.pop();
      for (const d of [1, -1, g.sz, -g.sz, g.sz + 1, g.sz - 1, -g.sz + 1, -g.sz - 1]) {
        const y = x + d;
        if (!g.solid[y] || leg[y] || torso[y]) continue;
        const p = g.center(y);
        if (Math.hypot(p[0] - p0[0], p[2] - p0[2]) <= r) { leg[y] = 1; st.push(y); }
      }
    }
  }
  const jLow = row([0, J.Hips[1] - 0.35 * H, 0]);
  // How far the torso reaches each side in each slice (below the hips: as at the hips). Arms are out past most of it,
  // so a belt buckle or a plate on the belly is never taken for a hand.
  const reach = [new Float64Array(g.ny), new Float64Array(g.ny)];
  for (let c = 0; c < g.N; c++) if (torso[c]) { const j = Math.floor(c / g.sy), d = g.center(c)[0] - J.Spine1[0]; if (d > reach[0][j]) reach[0][j] = d; if (-d > reach[1][j]) reach[1][j] = -d; }
  for (let j = jHip - 1; j >= 0; j--) { reach[0][j] = reach[0][jHip]; reach[1][j] = reach[1][jHip]; }
  const rest = new Uint8Array(g.N);
  for (let c = 0; c < g.N; c++) {
    const j = Math.floor(c / g.sy);
    if (!g.solid[c] || torso[c] || leg[c] || j < jLow || j > jNeck) continue;
    const d = g.center(c)[0] - J.Spine1[0];
    if (d > 0.85 * reach[0][j] || -d > 0.85 * reach[1][j]) rest[c] = 1;
  }
  const comp = new Int32Array(g.N).fill(-1), comps = [];
  const nb26 = neighbours(g).map(([d]) => d);
  for (let c = 0; c < g.N; c++) {
    if (!rest[c] || comp[c] >= 0) continue;
    const id = comps.length, cells = [c];
    comp[c] = id;
    for (let i = 0; i < cells.length; i++) for (const d of nb26) { const y = cells[i] + d; if (rest[y] && comp[y] < 0) { comp[y] = id; cells.push(y); } }
    comps.push(cells);
  }
  const coreU = J.Spine1[0];
  for (const [side, s] of [['Left', 1], ['Right', -1]]) {
    // The arm: the biggest piece on this side that joins the torso up at chest height (a shoulder pad is smaller, a
    // thigh plate joins lower down).
    const joins = (cells) => cells.filter((c) => [1, -1, g.sz, -g.sz, g.sy, -g.sy].some((d) => torso[c + d]));
    const chestV = (J.Hips[1] + J.Neck[1]) / 2;
    let best = null, attach = [];
    for (const cells of comps) {
      if (cells.length < 20 || (best && cells.length <= best.length)) continue;
      const u = cells.reduce((t, c) => t + g.center(c)[0], 0) / cells.length;
      if (s * (u - coreU) <= 0) continue;
      const at = joins(cells);
      if (at.length && Math.max(...at.map((c) => g.center(c)[1])) >= chestV) { best = cells; attach = at; }
    }
    if (!best || best.length < 20 || !attach.length) { problems.push('Could not find both arms'); return { joints: null, problems }; }
    const mask = new Uint8Array(g.N);
    for (const c of best) mask[c] = 1;
    // A hand cut off where the arm crosses the hips (or rests on them): pieces on this side within a few cells of
    // the arm join it, with the cells between.
    const R = 3;
    for (const cells of comps) {
      if (cells === best || cells.length < 20) continue;
      if (s * (cells.reduce((t, c) => t + g.center(c)[0], 0) / cells.length - coreU) <= 0) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const c of cells) { const p = g.center(c); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); } }
      if (len(sub(hi, lo)) > 0.15 * H) continue; // hand-sized only: a long thigh plate is not a hand
      let pair = null;
      for (let n = 0; n < cells.length && !pair; n += 2) {
        const c = cells[n];
        for (let dy = -R; dy <= R && !pair; dy++) for (let dz = -R; dz <= R && !pair; dz++) for (let dx = -R; dx <= R; dx++) {
          const y = c + dy * g.sy + dz * g.sz + dx;
          if (mask[y] && best.includes(y)) { pair = [c, y]; break; }
        }
      }
      if (!pair) continue;
      for (const c of cells) mask[c] = 1;
      const [p, q] = pair.map((c) => g.center(c));
      for (let t = 0; t <= 8; t++) mask[g.cellOf(lerp(p, q, t / 8))] = 1;
    }
    // The shoulder: where the arm meets the torso's side, at shoulder height (just under the neck).
    let W = 0;
    for (let c = 0; c < g.N; c++) if (torso[c]) { const p = g.center(c); if (p[1] > J.Spine1[1] && p[1] < J.Spine2[1]) W = Math.max(W, s * (p[0] - coreU)); }
    const Sa = [coreU + s * W, J.Neck[1] - 0.05 * H, J.Spine2[2]];
    let seed = attach[0];
    for (const c of attach) if (len(sub(g.center(c), Sa)) < len(sub(g.center(seed), Sa))) seed = c;
    const far = geodesic(g, [seed], { mask });
    let tip = seed;
    for (let c = 0; c < g.N; c++) if (mask[c] && Number.isFinite(far.dist[c]) && far.dist[c] > far.dist[tip]) tip = c;
    const arm = line(g, depth, pathTo(geodesic(g, [seed], { mask, depth }).prev, tip).reverse()); // shoulder → hand tip
    const shoulder = arm.pts[0];
    const La = arm.L;
    const wr = narrowest(arm, 0.6 * La, 0.88 * La);
    const sw = arm.s[wr];
    const [bi, deg] = bend(arm, 0.3 * sw, 0.75 * sw, 0.12 * La);
    const el = deg >= 25 ? bi : narrowest(arm, 0.3 * sw, 0.7 * sw);
    J[`${side}Shoulder`] = [clav[0] + s * 0.02 * H, clav[1], clav[2]];
    J[`${side}Arm`] = shoulder;
    J[`${side}ForeArm`] = arm.pts[el];
    J[`${side}Hand`] = arm.pts[wr];
    // A hand is shorter than the forearm: a longer "hand" ran on into something else.
    const fore = len(sub(arm.pts[wr], arm.pts[el])), handDir = sub(arm.pts.at(-1), arm.pts[wr]);
    J[`${side}HandTip`] = len(handDir) > 0.7 * fore ? add(arm.pts[wr], mul(norm(handDir), 0.5 * fore)) : arm.pts.at(-1);
  }
  return { joints: J, problems, found: { chest: g.center(chest), pelvis: g.center(pelvis) } };
}

/**
 * Joints from the landmarks the user clicked (glTF coords on the skin). Each click is pushed to the middle of the
 * limb under it, the rest follows body proportions. markers: { chin, groin, leftElbow, ... } as [x, y, z].
 */
export function jointsFromMarkers(g, markers) {
  const missing = MARKERS.filter((k) => !Array.isArray(markers?.[k]) || markers[k].length !== 3 || !markers[k].every(Number.isFinite));
  if (missing.length) return { joints: null, problems: [`Click ${missing.map((k) => MARKER_LABELS[k]).join(', ')}`] };
  const L = Object.fromEntries(MARKERS.map((k) => [k, g.toLocal(markers[k])]));
  // Into the middle of the limb under the click: the centre of the body within a small ball round it (a click is on
  // the skin, a joint sits inside), whichever way the limb runs.
  const inside = (p) => {
    const R = Math.max(2, Math.round((0.035 * g.H) / g.h)), c0 = g.cellOf(p);
    if (c0 < 0) return p;
    const sum = [0, 0, 0];
    let k = 0;
    for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy + dz * dz > R * R) continue;
      const c = c0 + dy * g.sy + dz * g.sz + dx;
      if (c >= 0 && c < g.N && g.solid[c]) { const q = g.center(c); sum[0] += q[0]; sum[1] += q[1]; sum[2] += q[2]; k++; }
    }
    return k ? mul(sum, 1 / k) : p;
  };
  // The chin and groin are on the front of the body: the joint is halfway through it, front to back.
  const midDepth = (p) => {
    let a = g.cellOf(p);
    if (a < 0) return p;
    for (let k = 0; k < 8 && !g.solid[a]; k++) a -= g.sz; // a click a hair in front of the skin
    let b = a;
    while (g.solid[a - g.sz]) a -= g.sz;
    while (g.solid[b + g.sz]) b += g.sz;
    return [p[0], p[1], (g.center(a)[2] + g.center(b)[2]) / 2];
  };
  const M = Object.fromEntries(Object.entries(L).map(([k, p]) => [k, k === 'chin' || k === 'groin' ? midDepth(p) : inside(p)]));
  const problems = [];
  if (!(M.chin[1] > M.groin[1])) problems.push('The chin must be above the groin');
  if (!(M.leftKnee[1] < M.groin[1] && M.rightKnee[1] < M.groin[1])) problems.push('The knees must be below the groin');
  if (!(M.leftWrist[0] > M.rightWrist[0])) problems.push('The left wrist must be on the model\'s left');
  if (problems.length) return { joints: null, problems };
  const ankle = (M.leftAnkle[1] + M.rightAnkle[1]) / 2;
  const H = (M.chin[1] - ankle) / 0.83;
  const J = {};
  J.Hips = [M.groin[0], M.groin[1] + 0.04 * H, M.groin[2]];
  J.Neck = [M.groin[0], M.chin[1] - 0.05 * H, M.groin[2]];
  J.Head = [M.groin[0], M.chin[1], M.groin[2]];
  J.HeadTop = [M.groin[0], M.chin[1] + 0.13 * H, M.groin[2]];
  J.Spine = lerp(J.Hips, J.Neck, 0.2);
  J.Spine1 = lerp(J.Hips, J.Neck, 0.43);
  J.Spine2 = lerp(J.Hips, J.Neck, 0.67);
  const clav = lerp(J.Hips, J.Neck, 0.85);
  // From p along dir for up to max metres, stopping at the last cell inside the body.
  const toEnd = (p, dir, max) => {
    const d = norm(dir);
    let last = p;
    for (let t = 0; t <= max; t += g.h / 2) { const q = add(p, mul(d, t)); if (!g.solid[g.cellOf(q)]) break; last = q; }
    return last;
  };
  for (const [side, s, el, wr, kn, an] of [['Left', 1, M.leftElbow, M.leftWrist, M.leftKnee, M.leftAnkle], ['Right', -1, M.rightElbow, M.rightWrist, M.rightKnee, M.rightAnkle]]) {
    J[`${side}Shoulder`] = [clav[0] + s * 0.02 * H, clav[1], clav[2]];
    J[`${side}Arm`] = [J.Neck[0] + s * Math.min(0.12 * H, Math.max(0.06 * H, 0.85 * Math.abs(el[0] - J.Neck[0]))), J.Neck[1] - 0.04 * H, J.Neck[2]];
    J[`${side}ForeArm`] = el;
    J[`${side}Hand`] = wr;
    J[`${side}HandTip`] = toEnd(wr, sub(wr, el), 0.45 * len(sub(wr, el)));
    J[`${side}UpLeg`] = [M.groin[0] + s * Math.max(0.05 * H, 0.5 * Math.abs(kn[0] - M.groin[0])), M.groin[1], M.groin[2]];
    J[`${side}Leg`] = kn;
    J[`${side}Foot`] = an;
    const toe = [an[0], Math.max(g.floor + 0.02 * H, an[1] - 0.04 * H), an[2]];
    J[`${side}ToeEnd`] = toEnd(toe, [0, 0, 1], 0.14 * H);
    J[`${side}ToeBase`] = lerp(toe, J[`${side}ToeEnd`], 0.55);
  }
  return { joints: J, problems: [] };
}

/** The 22 bones from joints (local coords): { name, head, tail, parent } with no bone shorter than a hair. */
export function bonesFrom(J, H) {
  return BONES.map((name) => {
    const [a, b, parent] = LAYOUT[name];
    const head = J[a];
    let tail = J[b];
    if (len(sub(tail, head)) < 0.004 * H) tail = add(head, [0, 0.01 * H, 0]);
    return { name, head, tail, parent };
  });
}

/**
 * How every vertex is bound. bones in local coords. Returns per vertex b0, b1 (bone indexes) and q (b0's weight,
 * 0-255; b1 gets the rest), and per island whether it is bound whole (rigid) and to which bone.
 */
export function bindVertices(g, depth, bones, islands) {
  const nb = bones.length, n = g.vcell.length;
  // Each body cell belongs to the bone that reaches it first through the body. A collarbone only claims from its inner
  // half, so the top of the shoulder goes with the upper arm.
  const seeds = [], labels = [];
  bones.forEach((b, i) => {
    const l = len(sub(b.tail, b.head)), k = Math.max(2, Math.ceil(l / (g.h / 2)));
    const end = /Shoulder$/.test(b.name) ? Math.floor(k / 2) : k;
    for (let j = 0; j <= end; j++) { const c = g.cellOf(lerp(b.head, b.tail, j / k)); if (c >= 0 && g.solid[c]) { seeds.push(c); labels.push(i); } }
  });
  const { label } = geodesic(g, seeds, { labels });
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const L = g.local;
  const P = (i) => [L[i * 3], L[i * 3 + 1], L[i * 3 + 2]];
  const nearestBone = (p) => { let best = 0, bd = Infinity; bones.forEach((b, i) => { const { d } = segDist(p, b.head, b.tail); if (d < bd) { bd = d; best = i; } }); return best; };
  const primary = new Int16Array(n);
  for (let i = 0; i < n; i++) { const l = label[g.vcell[i]]; primary[i] = l >= 0 ? l : nearestBone(P(i)); }
  // Each separate piece (island): bound whole (rigid) to its main bone when it is small or nearly all on that bone. A
  // bigger piece across a joint (a sleeve over the elbow) bends, but only with the bones of its own limb (and the
  // bone that limb hangs from): a thigh plate a fist touches never follows the hand. A piece spread over most of the
  // body (a one-piece model) may use every bone.
  const votes = new Int32Array(islands.count * nb);
  for (let i = 0; i < n; i++) votes[islands.id[i] * nb + primary[i]]++;
  const rigid = new Int16Array(islands.count).fill(-1);
  const allowed = new Array(islands.count).fill(null); // per piece: Uint8Array over bones, or null for all
  const CHAINS = ['core', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
  const cent = new Float64Array(islands.count * 3);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) cent[islands.id[i] * 3 + a] += L[i * 3 + a];
  const hangsFrom = { leftArm: 'Spine2', rightArm: 'Spine2', leftLeg: 'Hips', rightLeg: 'Hips', core: null };
  for (let s = 0; s < islands.count; s++) {
    let best = 0;
    for (let b = 1; b < nb; b++) if (votes[s * nb + b] > votes[s * nb + best]) best = b;
    const size = islands.sizes[s];
    if (votes[s * nb + best] < 0.5 * size) { // no clear winner: the bone nearest the middle of the piece
      const mid = [cent[s * 3] / size, cent[s * 3 + 1] / size, cent[s * 3 + 2] / size];
      let bd = Infinity;
      for (let b = 0; b < nb; b++) { const { d } = segDist(mid, bones[b].head, bones[b].tail); if (d < bd) { bd = d; best = b; } }
    }
    if (size < Math.max(64, 0.002 * n)) { rigid[s] = best; continue; }
    const share = Object.fromEntries(CHAINS.map((c) => [c, 0]));
    for (let b = 0; b < nb; b++) share[chainOf(bones[b].name)] += votes[s * nb + b] / size;
    if (CHAINS.filter((c) => share[c] >= 0.15).length >= 3) continue; // the whole body in one piece
    // Its own limb, plus a second one it really covers (a sleeve fused to the ribs keeps its rib part on the ribs).
    const own = new Set([chainOf(bones[best].name), ...CHAINS.filter((c) => share[c] >= 0.2)]);
    allowed[s] = Uint8Array.from(bones, (b) => (own.has(chainOf(b.name)) || [...own].some((c) => hangsFrom[c] === b.name) ? 1 : 0));
  }
  for (let i = 0; i < n; i++) { // a vertex labelled with another limb's bone goes to the nearest bone of its own
    const ok = allowed[islands.id[i]];
    if (!ok || ok[primary[i]] || rigid[islands.id[i]] >= 0) continue;
    let bestB = -1, bd = Infinity;
    bones.forEach((b, k) => { if (ok[k]) { const { d } = segDist(P(i), b.head, b.tail); if (d < bd) { bd = d; bestB = k; } } });
    primary[i] = bestB;
  }
  // Joints next to each bone: its own head (shared with the parent) and its children's heads.
  // How thick each bone's limb is: the deepest point along it (a joint can sit near the skin, its limb can't).
  const thick = bones.map((b) => { let d = 1; for (let t = 0; t <= 10; t++) { const c = g.cellOf(lerp(b.head, b.tail, t / 10)); if (c >= 0) d = Math.max(d, depth[c]); } return d * g.h; });
  const radius = (p, ...bs) => { const c = g.cellOf(p); return Math.max((c >= 0 ? depth[c] : 1) * g.h, ...bs.map((k) => thick[k])); };
  const near = bones.map((b, i) => {
    const out = [];
    const dir = norm(sub(b.tail, b.head));
    if (b.parent) { const o = byName[b.parent]; const r = radius(b.head, i, o); out.push({ o, J: b.head, dir, r, R: clamp(Math.max(0.4 * Math.min(len(sub(b.tail, b.head)), len(sub(bones[o].tail, bones[o].head))), 0.8 * r), 2 * g.h, 0.12 * g.H) }); }
    bones.forEach((c, j) => {
      if (c.parent !== b.name) return;
      const cd = norm(sub(c.tail, c.head));
      const r = radius(c.head, i, j); out.push({ o: j, J: c.head, dir: mul(cd, -1), r, R: clamp(Math.max(0.4 * Math.min(len(sub(b.tail, b.head)), len(sub(c.tail, c.head))), 0.8 * r), 2 * g.h, 0.12 * g.H) });
    });
    return out;
  });
  const b0 = new Uint8Array(n), b1 = new Uint8Array(n), q = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rigid[islands.id[i]];
    if (r >= 0) { b0[i] = b1[i] = r; q[i] = 255; continue; }
    const b = primary[i], p = P(i), ok = allowed[islands.id[i]];
    let best = null, bs = Infinity;
    for (const a of near[b]) {
      if (ok && !ok[a.o]) continue;
      const v = sub(p, a.J), s = dot(v, a.dir); // how far past the joint, into bone b (negative: on the other bone's side)
      if (len(sub(v, mul(a.dir, s))) > 2.5 * a.r + g.h) continue; // only round this joint, never the other side of the body
      if (s < bs) { bs = s; best = a; }
    }
    b0[i] = b;
    if (!best) { b1[i] = b; q[i] = 255; continue; }
    // By where the vertex is against the joint, not which bone reached it first: both sides of a joint blend the same.
    const f = clamp(0.5 + bs / (2 * best.R), 0, 1);
    q[i] = Math.round(f * 255);
    b1[i] = q[i] === 255 ? b : best.o;
  }
  return { b0, b1, q, rigid, primary, allowed };
}

/**
 * Faces that weld two limbs together (a fist modelled into the thigh, an arm fused to the ribs): their corners are
 * held by bones on different limbs that are not next to each other, so any pose stretches them into a smear. They
 * are cut (deleted) instead; in the rest pose they sit where the two touch, so nothing shows. Returns the
 * triangle numbers (in tris order).
 */
export function cutWelds(bones, bind, tris) {
  const main = (i) => (bind.q[i] >= 128 ? bind.b0[i] : bind.b1[i]);
  const ok = (a, b) => a === b || chainOf(bones[a].name) === chainOf(bones[b].name) || bones[a].parent === bones[b].name || bones[b].parent === bones[a].name;
  const cut = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = main(tris[t]), b = main(tris[t + 1]), c = main(tris[t + 2]);
    if (!ok(a, b) || !ok(b, c) || !ok(a, c)) cut.push(t / 3);
  }
  return Uint32Array.from(cut);
}

/**
 * Checks the binding, returning plain problems. Also poses the skeleton (thigh up, knees bent, spine forward, arms
 * swung: a hero landing done by hand) and measures how far pieces stretch.
 */
export function validateRig(g, depth, bones, joints, bind, islands, tris, cut = new Uint32Array(0)) {
  const problems = [];
  const n = g.vcell.length, H = g.H;
  const L = g.local;
  const P = (i) => [L[i * 3], L[i * 3 + 1], L[i * 3 + 2]];
  let unweighted = 0;
  for (let i = 0; i < n; i++) if (bind.b0[i] >= bones.length || (bind.q[i] === 0 && bind.b1[i] >= bones.length)) unweighted++;
  if (unweighted) problems.push(`${unweighted} points are not tied to any joint`);
  // Every joint inside the body (or touching it).
  const outside = Object.entries(joints).filter(([, p]) => {
    const c = g.cellOf(p);
    return c < 0 || ![0, 1, -1, g.sz, -g.sz, g.sy, -g.sy].some((d) => g.solid[c + d]);
  }).map(([k]) => k);
  if (outside.length) problems.push(`Some joints landed outside the body (${outside.join(', ')})`);
  const lenOf = (a, b) => len(sub(joints[b], joints[a]));
  const limbs = {};
  for (const s of ['Left', 'Right']) {
    const arm = limbs[`${s}arm`] = lenOf(`${s}Arm`, `${s}ForeArm`) + lenOf(`${s}ForeArm`, `${s}Hand`) + lenOf(`${s}Hand`, `${s}HandTip`);
    const leg = limbs[`${s}leg`] = lenOf(`${s}UpLeg`, `${s}Leg`) + lenOf(`${s}Leg`, `${s}Foot`);
    if (arm < 0.15 * H || arm > 0.65 * H) problems.push(`The ${s.toLowerCase()} arm came out the wrong length`);
    if (leg < 0.25 * H || leg > 0.65 * H) problems.push(`The ${s.toLowerCase()} leg came out the wrong length`);
  }
  // Both sides of a body match: one arm far shorter than the other means part of it was missed.
  if (Math.max(limbs.Leftarm, limbs.Rightarm) > 1.3 * Math.min(limbs.Leftarm, limbs.Rightarm)) problems.push('The two arms came out different lengths');
  if (Math.max(limbs.Leftleg, limbs.Rightleg) > 1.25 * Math.min(limbs.Leftleg, limbs.Rightleg)) problems.push('The two legs came out different lengths');
  if (!(joints.Hips[1] < joints.Spine2[1] && joints.Spine2[1] < joints.Neck[1] && joints.Neck[1] < joints.HeadTop[1])) problems.push('The back came out upside down');
  // A piece tied to a limb it does not sit on (a leg plate bound to an arm).
  const cross = [];
  const cent = new Float64Array(islands.count * 3);
  for (let i = 0; i < n; i++) { const s = islands.id[i]; cent[s * 3] += L[i * 3]; cent[s * 3 + 1] += L[i * 3 + 1]; cent[s * 3 + 2] += L[i * 3 + 2]; }
  const adjacent = (a, b) => a === b || bones[a].parent === bones[b].name || bones[b].parent === bones[a].name;
  for (let s = 0; s < islands.count; s++) {
    const r = bind.rigid[s];
    if (r < 0) continue;
    const c = [cent[s * 3] / islands.sizes[s], cent[s * 3 + 1] / islands.sizes[s], cent[s * 3 + 2] / islands.sizes[s]];
    const own = segDist(c, bones[r].head, bones[r].tail).d;
    let other = Infinity;
    bones.forEach((b, j) => { if (chainOf(b.name) !== chainOf(bones[r].name) && !adjacent(j, r)) other = Math.min(other, segDist(c, b.head, b.tail).d); });
    if (own > 0.06 * H && own > 2 * other) cross.push(s);
  }
  if (cross.length) problems.push(`${cross.length} pieces were tied to the wrong limb`);
  // A piece split between two limbs that don't touch (half a thigh plate on the arm): it would be torn in two.
  const CH = ['core', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'];
  const per = new Float64Array(islands.count * 5);
  for (let i = 0; i < n; i++) per[islands.id[i] * 5 + CH.indexOf(chainOf(bones[bind.q[i] >= 128 ? bind.b0[i] : bind.b1[i]].name))]++;
  let split = 0;
  for (let s = 0; s < islands.count; s++) {
    const on = CH.filter((c, k) => per[s * 5 + k] >= 0.1 * islands.sizes[s]);
    if (on.length < 3 && on.filter((c) => c !== 'core').length === 2) split++;
  }
  if (split) problems.push(`${split} pieces were split between two limbs`);
  const stretch = poseStretch(bones, bind, P, n, tris, islands, H, TEST_POSE, cut);
  if (stretch.torn) problems.push('A test pose tore the model apart');
  return { ok: !problems.length, problems, unweighted, outside, crossBound: cross.length, stretch };
}

// --- the test pose: world-space turns about each bone's head, down the hierarchy ---
// Turns are about the body's own axes: X sideways (left), Y up, Z forward, in degrees.
export const TEST_POSE = {
  Spine: [20, 0, 0], LeftUpLeg: [-80, 0, 0], LeftLeg: [100, 0, 0], RightUpLeg: [15, 0, 0], RightLeg: [90, 0, 0],
  LeftArm: [0, 0, -50], LeftForeArm: [-60, 0, 0], RightArm: [-40, 0, 40], RightForeArm: [0, 30, 0], Head: [-15, 20, 0],
};
const rotM = ([x, y, z]) => { // degrees, applied X then Y then Z
  const r = Math.PI / 180, [cx, sx, cy, sy, cz, sz] = [Math.cos(x * r), Math.sin(x * r), Math.cos(y * r), Math.sin(y * r), Math.cos(z * r), Math.sin(z * r)];
  const X = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Y = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Z = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const m = (a, b) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
  return m(Z, m(Y, X));
};
const apply3 = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]];
const mul3 = (a, b) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
/** Each bone's posed transform: x → R·(x − rest head) + posed head. */
export function posedBones(bones, pose = TEST_POSE) {
  const by = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const out = [];
  const get = (i) => {
    if (out[i]) return out[i];
    const b = bones[i];
    const p = b.parent ? get(by[b.parent]) : { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
    const head = add(apply3(p.R, b.head), p.t); // where the parent carried this bone's head
    const R = mul3(p.R, rotM(pose[b.name] || [0, 0, 0]));
    out[i] = { R, t: sub(head, apply3(R, b.head)) };
    return out[i];
  };
  bones.forEach((_, i) => get(i));
  return out;
}
/** Linear blend skinning of every vertex with the 2-bone weights. */
export function skin(bones, bind, P, n, pose = TEST_POSE) {
  const T = posedBones(bones, pose);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = P(i), w = bind.q[i] / 255;
    const a = T[bind.b0[i]], b = T[bind.b1[i]];
    const pa = add(apply3(a.R, p), a.t), pb = add(apply3(b.R, p), b.t);
    const x = lerp(pb, pa, w);
    out[i * 3] = x[0]; out[i * 3 + 1] = x[1]; out[i * 3 + 2] = x[2];
  }
  return out;
}
/**
 * Poses the rig and measures the damage: how much edges stretch (worst and 99.9th percentile ratio) and how far any
 * piece's middle moves away from the bone it is tied to. torn: a piece tore or flew off.
 */
export function poseStretch(bones, bind, P, n, tris, islands, H, pose = TEST_POSE, cut = new Uint32Array(0)) {
  const gone = new Set(cut);
  const X = skin(bones, bind, P, n, pose);
  const T = posedBones(bones, pose);
  const ratios = [];
  const k = Math.max(1, Math.floor(tris.length / 3 / 300000));
  for (let t = 0; t < tris.length; t += 3 * k) {
    if (gone.has(t / 3)) continue;
    for (const [a, b] of [[tris[t], tris[t + 1]], [tris[t + 1], tris[t + 2]], [tris[t + 2], tris[t]]]) {
      const r0 = len(sub(P(a), P(b)));
      if (r0 < 0.002 * H) continue;
      ratios.push(Math.hypot(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2]) / r0);
    }
  }
  ratios.sort((a, b) => a - b);
  const worst = ratios.at(-1) || 1, p999 = ratios[Math.floor(ratios.length * 0.999)] || 1;
  // Torn: more than a few edges in a hundred stretched past three times, or skin pulled far off its bone. (Where a
  // hand is modelled into a thigh a short seam always pulls; a split plate or a limb on the wrong bone is far worse.)
  let over = 0;
  for (let i = ratios.length - 1; i >= 0 && ratios[i] > 3; i--) over++;
  // Every vertex stays as far from its own bone as it was (a little give near the joints).
  let drift = 0;
  const kv = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += kv) {
    const b = bind.b0[i], bone = bones[b], t = T[b];
    const d0 = segDist(P(i), bone.head, bone.tail).d;
    const d1 = segDist([X[i * 3], X[i * 3 + 1], X[i * 3 + 2]], add(apply3(t.R, bone.head), t.t), add(apply3(t.R, bone.tail), t.t)).d;
    drift = Math.max(drift, Math.abs(d1 - d0));
  }
  return { worst, p999, stretched: over / (ratios.length || 1), drift: drift / H, torn: over > Math.max(3, 0.008 * ratios.length) || drift > 0.2 * H };
}

/**
 * The whole job. pos: Float32Array glTF xyz per vertex, tris: Uint32Array. markers: the user's clicks, or null to
 * find the joints by itself. Returns { ok, problems, frame, joints (glTF), bones (glTF), weights { b0, b1, q }, report }.
 */
export function autoRig(pos, tris, { markers = null, res = 128 } = {}) {
  const t0 = Date.now();
  const frame = bodyFrame(pos);
  const g = voxelize(pos, tris, frame, res);
  const depth = depthField(g);
  const islands = islandsOf(pos.length / 3, tris);
  const found = markers ? jointsFromMarkers(g, markers) : findJoints(g, depth);
  const base = { frame, islands: islands.count, ms: 0 };
  if (!found.joints) return { ok: false, problems: found.problems, frame, report: { ...base, ms: Date.now() - t0, problems: found.problems } };
  const bones = bonesFrom(found.joints, g.H);
  const bind = bindVertices(g, depth, bones, islands);
  const cut = cutWelds(bones, bind, tris);
  const check = validateRig(g, depth, bones, found.joints, bind, islands, tris, cut);
  const problems = [...found.problems, ...check.problems];
  const W = (p) => g.toWorld(p);
  const rigidCount = [...bind.rigid].filter((r) => r >= 0).length;
  return {
    ok: !problems.length, problems, frame,
    joints: Object.fromEntries(Object.entries(found.joints).map(([k, p]) => [k, W(p)])),
    bones: bones.map((b) => ({ ...b, head: W(b.head), tail: W(b.tail) })),
    weights: { b0: bind.b0, b1: bind.b1, q: bind.q }, cut,
    report: { ...base, height: g.H, rigid: rigidCount, smooth: islands.count - rigidCount, unweighted: check.unweighted, outside: check.outside, crossBound: check.crossBound, cut: cut.length, stretch: check.stretch, problems, ms: Date.now() - t0, markers: Boolean(markers) },
  };
}

/** The next landmark to click (MARKERS order), or null when all are in. */
export const nextMarker = (points = {}) => MARKERS.find((k) => !points[k]) || null;

/**
 * The model version from before any joints were added: a rigged version points back at the one it was made from
 * (from; older ones only say so in their note). Returns the version number, or the active one when it has no rig.
 */
export function unriggedVersion(model) {
  const byN = (n) => model.versions?.find((v) => v.n === n);
  let v = byN(model.activeVersion) || model.versions?.at(-1);
  for (let hops = 0; v?.rigged && hops < 20; hops++) v = byN(v.from ?? Number(/from version (\d+)/.exec(v.note || '')?.[1])) || null;
  return v && !v.rigged ? v.n : model.activeVersion;
}

/** The one plain sentence for a failed rig, and that clicking the spots (the placement screen) may help. */
export function rigFailure(problems = []) {
  const why = (problems[0] || 'the shape was not clear').split('. ')[0].replace(/\.$/, '');
  return { error: `Flatform could not find the joints by itself (${why[0].toLowerCase()}${why.slice(1)}), so click the 10 spots on the model.`, fallback: 'markers' };
}
