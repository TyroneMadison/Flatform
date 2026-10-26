// Project health check: runs on a loaded model (a three.js object tree) before export and on demand. Pure: it only
// reads the tree, so it is testable with plain objects. Fixes are applied by applyFix and only where they are safe
// (rebuilding normals, giving an unassigned mesh a plain material). Nothing here changes the original model file.
export const BUDGET = { tris: 100000, maxTex: 4096 };
export const TENNO_BUDGET = { tris: 40000, maxTex: 2048 };
const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'];
const pow2 = (n) => n > 0 && (n & (n - 1)) === 0;

export const triCount = (g) => Math.floor((g?.index ? g.index.count : g?.attributes?.position?.count || 0) / 3);

/** Edges not shared by exactly two triangles (holes, fins, T-junctions). Skipped above maxTris to stay quick. */
export function openEdges(g, maxTris = 300000) {
  const tris = triCount(g);
  if (!tris || tris > maxTris) return 0;
  const idx = g.index ? g.index.array : null;
  const v = (i) => (idx ? idx[i] : i);
  const seen = new Map();
  for (let t = 0; t < tris; t++) {
    const a = v(t * 3), b = v(t * 3 + 1), c = v(t * 3 + 2);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) { const k = x < y ? `${x}_${y}` : `${y}_${x}`; seen.set(k, (seen.get(k) || 0) + 1); }
  }
  let n = 0; for (const c of seen.values()) if (c !== 2) n++;
  return n;
}

const texName = (t) => String(t?.name || t?.image?.src || t?.source?.data?.src || '');

/** { pass, tris, checks: [{ id, level: 'error' | 'warn', label, count, names, fix }] } */
export function checkScene(root, { tennogen = false, budget = tennogen ? TENNO_BUDGET : BUDGET } = {}) {
  const found = {};
  const note = (id, name) => { (found[id] ??= []).push(name || '(no name)'); };
  let tris = 0; let tint = false; let meshes = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    const mats = [].concat(o.material).filter((m) => m && m.isMaterial !== false);
    if (!mats.length) note('material', o.name);
    if (!g?.attributes?.normal) note('normals', o.name);
    if (!g?.attributes?.uv) note('uvs', o.name);
    tris += triCount(g);
    if (openEdges(g)) note('manifold', o.name);
    for (const m of mats) for (const k of MAP_KEYS) {
      const t = m[k]; if (!t) continue;
      const img = t.image; const n = texName(t);
      if (/(_t\b|tint)/i.test(n)) tint = true;
      if (!img || !img.width) note('texture-missing', `${m.name || o.name} ${k}`);
      else if (!pow2(img.width) || !pow2(img.height) || img.width > budget.maxTex || img.height > budget.maxTex) note('texture-size', `${n || k} ${img.width}x${img.height}`);
    }
    if (/decal/i.test(o.name || '') && !mats.some((m) => m.map)) note('decal', o.name);
  });
  const LABELS = {
    'texture-missing': ['error', 'Paint pictures that did not load', null],
    material: ['error', 'Parts with no paint at all', 'material'],
    normals: ['warn', 'Parts that may look flat or black', 'normals'],
    uvs: ['warn', 'Parts the paint cannot wrap onto', null],
    'texture-size': ['warn', `Paint pictures with an odd size or over ${budget.maxTex}px`, null],
    manifold: ['warn', 'Parts with holes or loose edges', null],
    decal: ['warn', 'Stickers with no picture', null],
  };
  const checks = Object.entries(found).map(([id, names]) => ({ id, level: LABELS[id][0], label: LABELS[id][1], count: names.length, names: names.slice(0, 8), fix: LABELS[id][2] }));
  if (tris > budget.tris) checks.push({ id: 'tris', level: 'warn', label: `Too many pieces: ${tris.toLocaleString('en-US')} (limit ${budget.tris.toLocaleString('en-US')})`, count: 1, names: [], fix: null });
  if (tennogen && meshes && !tint) checks.push({ id: 'tint', level: 'warn', label: 'No color mask picture (_t) found', count: 1, names: [], fix: null });
  if (!meshes) checks.push({ id: 'empty', level: 'error', label: 'The model has no visible parts', count: 1, names: [], fix: null });
  return { pass: !checks.some((c) => c.level === 'error'), clean: !checks.length, tris, meshes, checks };
}

/** Safe one-click fixes. makeMaterial() returns a plain material (injected so this stays three-free). */
export function applyFix(root, id, { makeMaterial } = {}) {
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (id === 'normals' && !o.geometry?.attributes?.normal) { o.geometry.computeVertexNormals(); n++; }
    if (id === 'material' && ![].concat(o.material).some(Boolean) && makeMaterial) { o.material = makeMaterial(); n++; }
  });
  return n;
}
