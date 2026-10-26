// Fill small holes (pure, no three.js): after a model is made, close the small gaps in each part. Two kinds:
// cracks, where two open edges almost touch (they are moved onto each other), and small holes, a short ring of open
// edges (it is closed with new triangles made from the ring's own corners, so UVs, normals and skin come along).
// Big openings are left alone: a ring with too many edges, one wider than a share of the part, or one that is the
// whole edge of a flat sheet (a card, a leaf) is not a hole. Used by glb-fill.mjs on the server; Blender does the
// same job in render/blender_fillholes.py with the same limits.
import { weld, weldTol, findPieces } from './pieces.js';

export const HOLE_EDGES = 32; // a ring of up to this many edges can be a hole
export const HOLE_SIZE = 0.1; // ... and no wider than a tenth of the part
export const CRACK = 10; // open edges closer than 10 weld distances (a ten-thousandth of the part) are a crack

const sub = (p, a, b) => [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
const cross = (p, a, b, c) => {
  const u = sub(p, a, b), v = sub(p, a, c);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};
const area = (p, a, b, c) => Math.hypot(...cross(p, a, b, c)) / 2;

// The fan that closes a ring, turned to face out like the part (the ring runs the other way round the hole). It
// starts from the corner whose thinnest triangle is the fattest, so corners in a straight line make no slivers.
function fan(p, ring) {
  const n = ring.length, tris = (k) => {
    const out = [];
    for (let i = 1; i < n - 1; i++) out.push(ring[k], ring[(k + i + 1) % n], ring[(k + i) % n]);
    return out;
  };
  const whole = [0, 0, 0]; // the hole's facing, the same from any corner
  const first = tris(0);
  for (let i = 0; i < first.length; i += 3) cross(p, first[i], first[i + 1], first[i + 2]).forEach((x, a) => { whole[a] += x; });
  let best = first, score = -Infinity;
  for (let k = 0; k < n; k++) {
    const t = tris(k);
    let worst = Infinity;
    for (let i = 0; i < t.length; i += 3) { const c = cross(p, t[i], t[i + 1], t[i + 2]); worst = Math.min(worst, c[0] * whole[0] + c[1] * whole[1] + c[2] * whole[2]); }
    if (worst > score) { score = worst; best = t; }
  }
  return best;
}

// Like pieces.js weld, but a point joins any earlier point within `tol` in its own or a neighbouring grid cell, so
// two corners a hair apart across a cell line still meet. For the few open corners only.
function nearWeld(p, tol) {
  const n = p.length / 3, out = new Int32Array(n), cells = new Map();
  const cell = (x, y, z) => `${x},${y},${z}`;
  for (let v = 0; v < n; v++) {
    const c = [0, 1, 2].map((a) => Math.round(p[v * 3 + a] / tol));
    out[v] = v;
    search: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const u of cells.get(cell(c[0] + dx, c[1] + dy, c[2] + dz)) || []) {
        if (Math.hypot(p[u * 3] - p[v * 3], p[u * 3 + 1] - p[v * 3 + 1], p[u * 3 + 2] - p[v * 3 + 2]) <= tol) { out[v] = u; break search; }
      }
    }
    if (out[v] === v) { const k = cell(...c); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(v); }
  }
  return out;
}

// Open (boundary) edges: { out: Map(rep -> [[toRep, realFrom], ...]), count }. rep: welded vertex of each vertex.
function openEdges(index, rep, nv) {
  const uses = new Map();
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = rep[index[i + k]], b = rep[index[i + (k + 1) % 3]];
      if (a !== b) uses.set(key(a, b), (uses.get(key(a, b)) || 0) + 1);
    }
  }
  const out = new Map();
  let count = 0;
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const from = index[i + k], a = rep[from], b = rep[index[i + (k + 1) % 3]];
      if (a === b || uses.get(key(a, b)) !== 1) continue;
      if (!out.has(a)) out.set(a, []);
      out.get(a).push([b, from]);
      count++;
    }
  }
  return { out, count };
}

/**
 * pos: flat xyz floats (one part). index: triangle list (null = every 3 vertices). Returns
 * { index: Uint32Array with the new triangles at the end, pos: Float32Array when cracks moved vertices else null,
 *   holes, cracks }.
 */
// ponytail: a hole is closed as a fan from its best corner, fine for the small, nearly flat rings this takes;
// switch to ear clipping if very bent holes ever show folds.
export function fillHoles(pos, index = null, { maxEdges = HOLE_EDGES, maxSize = HOLE_SIZE, crack = CRACK } = {}) {
  const nv = pos.length / 3;
  const idx = index ? Uint32Array.from(index) : Uint32Array.from({ length: nv }, (_, i) => i);
  const tol = weldTol(pos);
  const size = tol * 1e5; // the part's diagonal
  const rep = weld(pos, tol);
  let open = openEdges(idx, rep, nv);
  if (!open.count) return { index: idx, pos: null, holes: 0, cracks: 0 };

  // Cracks: weld just the open corners again, a little wider. Each group that joins two corners is one crack.
  let moved = null, cracks = 0;
  const corners = [...new Set([...open.out.values()].flatMap((list) => list.map(([b]) => b)).concat([...open.out.keys()]))];
  const cp = new Float32Array(corners.length * 3);
  corners.forEach((v, i) => { for (let a = 0; a < 3; a++) cp[i * 3 + a] = pos[v * 3 + a]; });
  const cw = nearWeld(cp, tol * crack);
  const to = new Map(); // a corner's rep -> the rep it joins
  corners.forEach((v, i) => { if (cw[i] !== i) to.set(v, corners[cw[i]]); });
  if (to.size) {
    moved = Float32Array.from(pos);
    const groups = new Set();
    for (let v = 0; v < nv; v++) {
      const t = to.get(rep[v]);
      if (t === undefined) continue;
      groups.add(t);
      for (let a = 0; a < 3; a++) moved[v * 3 + a] = pos[t * 3 + a];
      rep[v] = t;
    }
    cracks = groups.size;
    open = openEdges(idx, rep, nv);
  }
  const p = moved || pos;

  // Holes: walk each ring of open edges.
  const pieces = findPieces(p, idx); // a ring that is the whole edge of a flat sheet is not a hole
  const pieceArea = new Float64Array(pieces.sizes.length);
  for (let i = 0; i < idx.length; i += 3) pieceArea[pieces.vertexPiece[idx[i]]] += area(p, idx[i], idx[i + 1], idx[i + 2]);
  const added = [];
  let holes = 0;
  for (const start of open.out.keys()) {
    while (open.out.get(start)?.length) {
      const ring = []; // real vertices, one per corner
      let at = start, ok = true;
      do {
        const list = open.out.get(at);
        if (!list?.length || ring.length > maxEdges) { ok = false; break; }
        const [b, from] = list.pop();
        ring.push(from);
        at = b;
      } while (at !== start);
      if (!ok || ring.length < 3) continue;
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of ring) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[v * 3 + a]); hi[a] = Math.max(hi[a], p[v * 3 + a]); }
      if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) > maxSize * size) continue;
      const tris = fan(p, ring);
      let fill = 0;
      for (let i = 0; i < tris.length; i += 3) fill += area(p, tris[i], tris[i + 1], tris[i + 2]);
      if (fill >= 0.5 * pieceArea[pieces.vertexPiece[ring[0]]]) continue;
      added.push(...tris);
      holes++;
    }
  }
  const out = new Uint32Array(idx.length + added.length);
  out.set(idx);
  out.set(added, idx.length);
  return { index: out, pos: moved, holes, cracks };
}

/** The plain-words line for the log and the Generate screen, or '' when nothing was done. */
export function fillNote({ holes = 0, cracks = 0 } = {}) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const parts = [holes && `Filled ${n(holes, 'small hole', 'small holes')}`, cracks && `closed ${n(cracks, 'tiny crack', 'tiny cracks')}`].filter(Boolean);
  if (!parts.length) return 'No small holes to fill';
  const s = parts.join(' and ');
  return s[0].toUpperCase() + s.slice(1);
}
