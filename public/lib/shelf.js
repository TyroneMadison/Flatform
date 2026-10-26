// The asset shelf in Compose: people and cars from the Library plus the bundled props (the CC0 models the places
// use), searched and filtered, and dropped into the scene as scene.extras. Positions are real-world metres on the
// floor; studio.js sizes a person to 1.8 m tall and a car to 4.6 m long, props keep their own size.
import { ENVIRONMENTS } from './environments.js';

export const FILTERS = { all: 'Everything', characters: 'People', cars: 'Cars', props: 'Props' };
export const MAX_EXTRAS = 12;

// "painted_wooden_bench.glb" → "Painted wooden bench"
export const propLabel = (file) => {
  const s = file.replace(/\.glb$/i, '').replace(/_\d+$/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const PROPS = [...new Set([...JSON.stringify(ENVIRONMENTS).matchAll(/"glb":"([^"]+\.glb)"/g)].map((x) => x[1]))]
  .sort().map((file) => ({ id: `prop:${file}`, group: 'props', label: propLabel(file), src: `/env/${encodeURIComponent(file)}` }));

/** Shelf items: every ready Library model with a 3D file (not the one being composed), then the props. */
export function shelfItems(models = [], { exclude, fileUrl, thumbOf = () => '' } = {}) {
  const lib = models.filter((m) => m.id !== exclude && m.status === 'ready' && m.glb)
    .map((m) => ({ id: `model:${m.id}`, group: m.kind === 'humanoid' ? 'characters' : 'cars', label: m.name, src: fileUrl(m, m.glb), thumb: thumbOf(m) }));
  return [...lib, ...PROPS];
}

export function filterItems(items, { q = '', group = 'all' } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => (group === 'all' || i.group === group) && words.every((w) => i.label.toLowerCase().includes(w)));
}

/** A new scene.extras list with the item placed at [x, z] metres on the floor. */
export function placeExtra(list = [], item, at, id = `x${Date.now().toString(36)}`) {
  if (list.length >= MAX_EXTRAS) throw new Error(`That is the most for one scene (${MAX_EXTRAS}). Take something out first.`);
  const [x, z] = at.map((v) => Math.round(Math.max(-30, Math.min(30, Number(v) || 0)) * 100) / 100);
  return [...list, { id, src: item.src, label: item.label, group: item.group, at: [x, z], turn: 0 }];
}

/** Where a click (not a drag) puts the next item: beside the model, alternating sides, a step further each time. */
export const besideSpot = (n) => [(n % 2 ? -1 : 1) * (3 + Math.floor(n / 2) * 1.5), 0.5];
