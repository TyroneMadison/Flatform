// Where each app piece lives in Blender. three.js (paint.js listPieces) makes one mesh per glTF primitive, so a mesh
// with two materials (Paint and Accents) is two pieces, numbered in scene order; Blender's glTF importer makes one
// object per node with one material slot per primitive. This reads the GLB's JSON and lists the pieces in three.js
// order: [{ node, prim, prims, material, mesh }], so piece key '<name>#<i>' is entry i and Blender can find node + slot.
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
