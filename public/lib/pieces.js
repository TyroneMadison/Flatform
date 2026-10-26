// Remove part (pure, no three.js): split a mesh into its loose pieces and take one out. Vertices at the same spot
// (within a small weld distance) count as joined, so a seam split for UVs or normals stays one piece. Runs in
// pieces-worker.js on the page and in glb-trim.mjs on the server, so both agree on what a piece is.

// Weld distance: a hundred-thousandth of the model's size.
export function weldTol(pos) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { const v = pos[i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-5 || 1e-6;
}

/**
 * pos: flat xyz floats. index: triangle vertex list (null = every 3 vertices are a triangle).
 * Returns { vertexPiece: Int32Array (piece of every vertex), sizes: Int32Array (triangles per piece), triangles }.
 */
// ponytail: welds by rounding to a grid of `tol`, so two points a hair apart across a grid line stay apart; fine
// for seams (their copies are bit-for-bit equal), add a neighbour-cell check if near misses ever matter.
export function findPieces(pos, index = null, tol = weldTol(pos)) {
  const nv = pos.length / 3;
  const parent = weld(pos, tol);
  const find = (v) => { while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; } return v; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a < b ? b : a] = a < b ? a : b; };
  const triangles = (index ? index.length : nv) / 3;
  const at = index ? (i) => index[i] : (i) => i;
  for (let t = 0; t < triangles; t++) { const a = at(t * 3); join(a, at(t * 3 + 1)); join(a, at(t * 3 + 2)); }
  const vertexPiece = new Int32Array(nv).fill(-1);
  let n = 0;
  for (let v = 0; v < nv; v++) { const r = find(v); if (vertexPiece[r] < 0) vertexPiece[r] = n++; vertexPiece[v] = vertexPiece[r]; }
  const sizes = new Int32Array(n);
  for (let t = 0; t < triangles; t++) sizes[vertexPiece[at(t * 3)]]++;
  return { vertexPiece, sizes, triangles };
}

/** Weld: every vertex's first vertex in the same `tol` grid cell (itself when it is first). Int32Array. */
export function weld(pos, tol) {
  const nv = pos.length / 3;
  const parent = new Int32Array(nv);
  const q = new Int32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) q[i] = Math.round(pos[i] / tol);
  // An open hash table of grid cells; the first vertex in a cell is the parent of the rest.
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const table = new Int32Array(size).fill(-1);
  for (let v = 0; v < nv; v++) {
    const x = q[v * 3], y = q[v * 3 + 1], z = q[v * 3 + 2];
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
    for (;;) {
      const u = table[h];
      if (u < 0) { table[h] = v; parent[v] = v; break; }
      if (q[u * 3] === x && q[u * 3 + 1] === y && q[u * 3 + 2] === z) { parent[v] = u; break; }
      h = (h + 1) & (size - 1);
    }
  }
  return parent;
}

/** The triangle list without one piece: a new index (Uint32Array). */
export function removePiece(index, nv, vertexPiece, piece) {
  const n = index ? index.length : nv;
  const out = new Uint32Array(n);
  let o = 0;
  for (let i = 0; i < n; i += 3) {
    const a = index ? index[i] : i;
    if (vertexPiece[a] === piece) continue;
    out[o++] = a; out[o++] = index ? index[i + 1] : i + 1; out[o++] = index ? index[i + 2] : i + 2;
  }
  return out.slice(0, o);
}

/** Just one piece's triangles, for the highlight. */
export function pieceIndex(index, nv, vertexPiece, piece) {
  const n = index ? index.length : nv, out = [];
  for (let i = 0; i < n; i += 3) {
    const a = index ? index[i] : i;
    if (vertexPiece[a] === piece) out.push(a, index ? index[i + 1] : i + 1, index ? index[i + 2] : i + 2);
  }
  return Uint32Array.from(out);
}

// A piece over a fifth of the whole model gets a one-sentence warning on the card.
export const BIG = 0.2;
export const isBig = (tris, total) => total > 0 && tris / total > BIG;
export function pieceCard(tris, total) {
  return {
    title: `Remove this piece? (${tris.toLocaleString('en-US')} triangles)`,
    warn: isBig(tris, total) ? `This piece is big, ${Math.round((tris / total) * 100)}% of your model, so make sure it is not a part you want.` : '',
  };
}
