// LOD levels for website thumbnails and previews. The full-res model is never touched: each level is a simplified
// clone. simplify(geometry, removeCount) (sync or async) is injected (three's SimplifyModifier in the app) so this stays testable.
export const LEVELS = [{ name: 'LOD1', ratio: 0.5 }, { name: 'LOD2', ratio: 0.25 }, { name: 'LOD3', ratio: 0.1 }];

export const triangles = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

/** Target triangle counts per level, never below minTris. */
export const plan = (tris, { levels = LEVELS, minTris = 64 } = {}) => levels.map((l) => ({ ...l, target: Math.max(minTris, Math.round(tris * l.ratio)) }));

/** [{ name, ratio, target, tris, geometry }] for one geometry. The source geometry is left as it was. */
export async function buildLods(geometry, simplify, opts) {
  const full = triangles(geometry);
  const out = [];
  for (const l of plan(full, opts)) {
    const verts = geometry.attributes.position.count;
    const g = await simplify(geometry.clone(), Math.max(0, Math.floor(verts * (1 - l.ratio))));
    out.push({ ...l, tris: triangles(g), geometry: g });
  }
  return out;
}

/** Side-by-side table rows: full first. */
export const table = (full, lods) => [{ name: 'Full (export)', tris: full }, ...lods.map((l) => ({ name: l.name, tris: l.tris }))];
