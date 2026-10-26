// Model tools (pure, no three.js): alignment, mirror, measurements, proportions check, depth range,
// camera bookmarks and rigging weight checks. studio.js and compose-tools.js apply the results.

export const AXES = ['x', 'y', 'z'];
const AI = { x: 0, y: 1, z: 2 };

// Alignment guide: the scene fields that put the model on the floor and/or centre it (undoable via history).
export function alignPatch({ ground = true, center = true } = {}) {
  return { ...(ground && { snap: true, y: 0 }), ...(center && { center: true, x: 0 }) };
}

// Measurements.
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

// Expected sizes in metres by workspace kind. Outside the range warns before export.
export const PROPORTIONS = {
  warframe: { label: 'Warframe', height: [1.6, 3.6], width: [0.4, 3.5], length: [0.2, 3.5] },
  car: { label: 'Car', height: [1.0, 2.3], width: [1.5, 2.6], length: [3.0, 6.5] },
};
export function proportionsCheck(size, kind) {
  const r = PROPORTIONS[kind];
  if (!r || !size) return { ok: true, warnings: [] };
  const dims = kind === 'car' ? { height: size.y, width: Math.min(size.x, size.z), length: Math.max(size.x, size.z) } : { height: size.y, width: size.x, length: size.z };
  const warnings = [];
  for (const [k, [lo, hi]] of Object.entries(r)) {
    if (k === 'label') continue;
    const v = dims[k];
    if (v < lo) warnings.push(`${k[0].toUpperCase() + k.slice(1)} is ${v.toFixed(2)} m, smaller than a usual ${r.label.toLowerCase()} (${lo} m or more).`);
    if (v > hi) warnings.push(`${k[0].toUpperCase() + k.slice(1)} is ${v.toFixed(2)} m, bigger than a usual ${r.label.toLowerCase()} (${hi} m or less).`);
  }
  return { ok: warnings.length === 0, warnings };
}

/**
 * Mirror tool. attrs: { position: { array, itemSize: 3 }, normal?, uv?, ... } NON-indexed triangles.
 * Keeps the triangles on the chosen side of the plane (axis = plane, at `plane`), snaps vertices within `tol` of
 * the plane onto it (the seam weld), then adds the mirrored copy with flipped winding. Returns new attrs.
 */
export function mirrorAttributes(attrs, axis = 'x', { keep = 1, plane = 0, tol = 1e-3 } = {}) {
  const a = AI[axis];
  const pos = attrs.position.array;
  const tris = pos.length / 9;
  const keepTri = [];
  for (let t = 0; t < tris; t++) {
    const c = (pos[t * 9 + a] + pos[t * 9 + 3 + a] + pos[t * 9 + 6 + a]) / 3 - plane;
    if (c * keep >= -tol) keepTri.push(t);
  }
  const out = {};
  for (const [name, { array, itemSize }] of Object.entries(attrs)) {
    const n = keepTri.length * 3 * itemSize;
    const arr = new Float32Array(n * 2);
    let o = 0;
    for (const t of keepTri) for (let v = 0; v < 3; v++) for (let i = 0; i < itemSize; i++) arr[o++] = array[(t * 3 + v) * itemSize + i];
    if (name === 'position') for (let i = a; i < n; i += 3) if (Math.abs(arr[i] - plane) <= tol) arr[i] = plane;
    // Mirrored copy: reverse each triangle's winding (v0, v2, v1) and flip the axis on positions and normals.
    for (let t = 0; t < keepTri.length; t++) for (const v of [0, 2, 1]) for (let i = 0; i < itemSize; i++) {
      let val = arr[(t * 3 + v) * itemSize + i];
      if (i === a && name === 'position') val = 2 * plane - val;
      if (i === a && name === 'normal') val = -val;
      arr[o++] = val;
    }
    out[name] = { array: arr, itemSize };
  }
  return out;
}
// Seam vertices that ended up on the plane (for the live preview count).
export function seamCount(attrs, axis = 'x', plane = 0, tol = 1e-6) {
  const a = AI[axis], p = attrs.position.array;
  let n = 0;
  for (let i = a; i < p.length; i += 3) if (Math.abs(p[i] - plane) <= tol) n++;
  return n;
}

// Depth and occlusion: a near/far pair that keeps depth precision on the model (no z-fighting, no clipping).
export function depthRange(dist, radius) {
  const near = Math.max(0.01, Math.min(0.5, (dist - radius) * 0.25));
  const far = Math.max(near * 10, dist + radius * 6);
  return { near, far };
}

// Camera bookmarks: [{ name, position, target, lens, hero }], up to 9 for the hotkeys.
export function addBookmark(list = [], b) {
  const next = [...list.filter((x) => x.name !== b.name), { name: b.name, position: b.position, target: b.target, lens: b.lens, hero: false }];
  return next.slice(-9);
}
export const setHero = (list = [], name) => list.map((b) => ({ ...b, hero: b.name === name }));
export const removeBookmark = (list = [], name) => list.filter((b) => b.name !== name);
// Smooth transition: eased interpolation between two camera states, t in 0..1.
export function lerpCamera(a, b, t) {
  const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const mix = (p, q) => p.map((v, i) => v + (q[i] - v) * e);
  return { position: mix(a.position, b.position), target: mix(a.target, b.target), lens: a.lens + (b.lens - a.lens) * e };
}
// A bookmark as a camera path keyframe (camera-path.js).
export function bookmarkKey(b, time) {
  const d = [b.position[0] - b.target[0], b.position[1] - b.target[1], b.position[2] - b.target[2]];
  const dist = Math.hypot(...d);
  return { time, orbit: ((Math.atan2(d[0], d[2]) * 180) / Math.PI + 360) % 360, height: b.position[1], distance: dist, lens: b.lens, turn: 0 };
}

// Rigging preview. skinIndex/skinWeight: flat arrays, 4 per vertex. Heat colour (blue 0 to red 1) for a bone.
export function heat(w) {
  const t = Math.max(0, Math.min(1, w));
  return [t, t < 0.5 ? t * 2 : (1 - t) * 2, 1 - t];
}
export function boneWeights(skinIndex, skinWeight, bone) {
  const n = skinIndex.length / 4, out = new Float32Array(n);
  for (let v = 0; v < n; v++) for (let i = 0; i < 4; i++) if (skinIndex[v * 4 + i] === bone) out[v] += skinWeight[v * 4 + i];
  return out;
}
// Flags: no weights, more than 4 influences (from an extra set), weights that do not add up to 1.
export function weightFlags(skinWeight, { extraInfluences = null, tol = 0.01 } = {}) {
  const n = skinWeight.length / 4;
  const flags = { none: [], over4: [], unnormalized: [] };
  for (let v = 0; v < n; v++) {
    let sum = 0, count = 0;
    for (let i = 0; i < 4; i++) { const w = skinWeight[v * 4 + i]; sum += w; if (w > 0) count++; }
    if (extraInfluences?.[v]) count += extraInfluences[v];
    if (sum === 0) flags.none.push(v);
    else if (Math.abs(sum - 1) > tol) flags.unnormalized.push(v);
    if (count > 4) flags.over4.push(v);
  }
  return flags;
}
