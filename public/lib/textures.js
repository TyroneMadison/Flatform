// The texture library: scanned CC0 surfaces from ambientCG and Poly Haven (synced on demand and cached for offline
// use), plus the user's own imports per workspace. Shared by the server (textures.mjs) and the Compose screen.
// Every item records where it came from and its license. No game assets: only CC0 sources and the user's own files.

const CC0 = { license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/' };
const acg = (id, name, kind, preset) => ({ id: `acg-${id}`, name, kind, preset, source: 'ambientCG', sourceId: id, page: `https://ambientcg.com/view?id=${id}`, ...CC0 });
const ph = (id, name, kind, preset) => ({ id: `ph-${id}`, name, kind, preset, source: 'Poly Haven', sourceId: id, page: `https://polyhaven.com/a/${id}`, ...CC0 });

export const KINDS = { carbon: 'Carbon fiber', metal: 'Metal', leather: 'Leather', fabric: 'Fabric', rubber: 'Rubber', custom: 'Your textures' };

// Small on purpose: 1K JPG colour, normal and roughness maps, about 1 to 3 MB per item once synced.
export const LIBRARY = [
  acg('Fabric004', 'Carbon fiber weave', 'carbon', 'paintedMetal'),
  acg('Metal009', 'Brushed metal', 'metal', 'brushedMetal'),
  acg('Metal049A', 'Polished metal', 'metal', 'metal'),
  ph('metal_plate', 'Metal plate', 'metal', 'metal'),
  acg('Leather025', 'White leather', 'leather', 'leather'),
  ph('brown_leather', 'Brown leather', 'leather', 'leather'),
  ph('leather_red_03', 'Red leather', 'leather', 'leather'),
  ph('denim_fabric', 'Denim', 'fabric', 'cloth'),
  ph('quatrefoil_jacquard_fabric', 'Jacquard fabric', 'fabric', 'cloth'),
  acg('Rubber004', 'Rubber', 'rubber', 'rubber'),
];
export const MAPS = ['color', 'normal', 'roughness'];
export const libraryItem = (id) => LIBRARY.find((t) => t.id === id) || null;
export const isLibraryId = (id) => Boolean(libraryItem(id));
export const isCustomId = (id) => /^my-[a-z0-9-]{1,60}$/.test(String(id));

// Where each map comes from. ambientCG: one zip per item, maps picked out by suffix. Poly Haven: its files API.
export function sourceFiles(item) {
  if (item.source === 'ambientCG') return { zip: `https://ambientcg.com/get?file=${item.sourceId}_1K-JPG.zip`, names: { color: '_Color.jpg', normal: '_NormalGL.jpg', roughness: '_Roughness.jpg' } };
  return { api: `https://api.polyhaven.com/files/${item.sourceId}`, keys: { color: 'Diffuse', normal: 'nor_gl', roughness: 'Rough' } };
}

// A texture on a piece: { id, scale, rotation }. scale = repeats across the piece's UVs, rotation in degrees.
export function normalizeTextureRef(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !(isLibraryId(t.id) || isCustomId(t.id))) return null;
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return { id: t.id, scale: num(t.scale, 4, 0.1, 64), rotation: num(t.rotation, 0, -180, 180) };
}
export const textureUrl = (id, map, workspace) => `/api/textures/${encodeURIComponent(id)}/${map}?workspace=${workspace === 'warframe' ? 'warframe' : 'car'}`;
