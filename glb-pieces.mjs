// Where each app piece lives in Blender. three.js (paint.js listPieces) makes one mesh per glTF primitive, so a mesh
// with two materials (Paint and Accents) is two pieces, numbered in scene order; Blender's glTF importer makes one
// object per node with one material slot per primitive. This reads the GLB's JSON and lists the pieces in three.js
// order: [{ node, prim, prims, material, mesh }], so piece key '<name>#<i>' is entry i and Blender can find node + slot.
import { blenderMaterial, deserializeMaterial, resolveColors } from './public/lib/tenno.js';
import { glowOf, blenderPulse } from './public/lib/roles.js';

// ponytail: two nodes with the same name both match the first Blender object of that name; unique names are the norm.
export function glbPieces(buf) {
  const b = Buffer.from(buf);
  if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF' || b.readUInt32LE(16) !== 0x4e4f534a) return [];
  let json;
  try { json = JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); } catch { return []; }
  const out = [];
  const walk = (i, seen = new Set()) => {
    const n = json.nodes?.[i];
    if (!n || seen.has(i)) return;
    seen.add(i);
    const prims = json.meshes?.[n.mesh]?.primitives || [];
    prims.forEach((p, j) => out.push({ node: n.name ?? null, prim: j, prims: prims.length, material: json.materials?.[p.material]?.name ?? null, mesh: n.mesh }));
    for (const c of n.children || []) walk(c, seen);
  };
  for (const i of json.scenes?.[json.scene ?? 0]?.nodes || []) walk(i);
  return out;
}

// Adds node, prim, prims and source_material to the Blender spec of every whole-piece key ('<name>#<i>').
export function locatePieces(materials, pieces) {
  return Object.fromEntries(Object.entries(materials).map(([key, spec]) => {
    const m = /#(\d+)$/.exec(key);
    const at = m && pieces[Number(m[1])];
    return [key, at?.node ? { ...spec, node: at.node, prim: at.prim, prims: at.prims, source_material: at.material } : spec];
  }));
}

/**
 * What render/blender_turntable.py --materials reads: { materials: { key: Principled spec }, groups: { meshKey:
 * face groups } } for a scene's paint on this GLB. Every piece with a look of its own gets a spec (its slot's color,
 * Glow and Energy strength from Part colors, and Energy's pulse); every piece and face group gets the node it is on,
 * so Blender finds it by name and not by import order.
 */
export function paintSpec(paint, buf) {
  const specs = paint?.pieces ? Object.fromEntries(Object.entries(paint.pieces).filter(([, p]) => p && (p.material || p.slot || p.colors || p.region || p.hidden))
    .map(([key, p]) => [key, {
      ...blenderMaterial(deserializeMaterial(p.material), resolveColors(paint, p), p.slot, glowOf(paint, p.slot)),
      slot: p.slot, textured: p.material?.textured !== false && !p.material?.color, ...(p.hidden && { hidden: true }),
      ...(blenderPulse(paint, p.slot) && { pulse: blenderPulse(paint, p.slot) }),
    }])) : {};
  const groups = paint?.groups || {};
  let where = [];
  if (Object.keys(specs).length || Object.keys(groups).length) { try { where = glbPieces(buf()); } catch { /* no file: keys only */ } }
  const placed = Object.fromEntries(Object.entries(groups).map(([key, g]) => {
    const m = /#(\d+)$/.exec(key);
    const at = m && where[Number(m[1])];
    return [key, at?.node && at.prims <= 1 ? { ...g, node: at.node } : g];
  }));
  return { materials: locatePieces(specs, where), groups: placed };
}
