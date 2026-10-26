// A blocky robot for Part colors: one mesh "Body" of loose closed boxes (a big chest, a head, two arms, two legs,
// two small hands and three crumbs stuck to the chest) plus a second mesh "Visor" with a glowing material.
// glTF coords: Y up, metres, x is the robot's own left and right. The chest and head share one paint, the arms
// and legs another; the hands are gold. robotGlb() writes it as a GLB with face colors baked into vertex colors.
import { writeGlb } from '../../glb-trim.mjs';

export const PAINT = { chest: [0.8, 0.8, 0.82], head: [0.8, 0.8, 0.82], arm: [0.15, 0.17, 0.2], leg: [0.15, 0.17, 0.2], hand: [0.95, 0.75, 0.2], crumb: [0.8, 0.8, 0.82] };
// [name, centre, half size]
export const BOXES = [
  ['chest', [0, 1.2, 0], [0.3, 0.35, 0.18]],
  ['head', [0, 1.75, 0], [0.13, 0.15, 0.13]],
  ['armL', [0.45, 1.25, 0], [0.08, 0.3, 0.08]], ['armR', [-0.45, 1.25, 0], [0.08, 0.3, 0.08]],
  ['legL', [0.15, 0.45, 0], [0.1, 0.42, 0.1]], ['legR', [-0.15, 0.45, 0], [0.1, 0.42, 0.1]],
  ['handL', [0.45, 0.88, 0], [0.05, 0.05, 0.05]], ['handR', [-0.45, 0.88, 0], [0.05, 0.05, 0.05]],
  ['crumb', [0.1, 1.2, 0.185], [0.006, 0.006, 0.006]], ['crumb', [-0.12, 1.3, 0.185], [0.005, 0.005, 0.005]], ['crumb', [0.05, 1.0, 0.185], [0.004, 0.004, 0.004]],
];

function box(c, h, pos, idx, col, color) {
  const o = pos.length / 3;
  for (const z of [-1, 1]) for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(c[0] + x * h[0], c[1] + y * h[1], c[2] + z * h[2]); col.push(...color); }
  for (const t of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) idx.push(...t.map((i) => o + i));
}

/** { body: { pos, idx, col (rgb per vertex), faceColors (rgb per face), boxOf (box name per face) }, visor: { pos, idx } } */
export function robotMesh() {
  const pos = [], idx = [], col = [], boxOf = [];
  for (const [name, c, h] of BOXES) { const before = idx.length; box(c, h, pos, idx, col, PAINT[name.replace(/[LR]$/, '')]); for (let i = before; i < idx.length; i += 3) boxOf.push(name); }
  const faceColors = [];
  for (let f = 0; f < idx.length / 3; f++) faceColors.push(...col.slice(idx[f * 3] * 3, idx[f * 3] * 3 + 3));
  const vp = [], vi = [], vc = [];
  box([0, 1.77, 0.135], [0.1, 0.03, 0.01], vp, vi, vc, [1, 1, 1]);
  return {
    body: { pos: Float32Array.from(pos), idx: Uint32Array.from(idx), col: Float32Array.from(col), faceColors: Float32Array.from(faceColors), boxOf },
    visor: { pos: Float32Array.from(vp), idx: Uint32Array.from(vi) },
  };
}

/** The robot as a GLB: node "Body" (vertex colors, white material) and node "Visor" (emissive cyan material). */
export function robotGlb() {
  const { body, visor } = robotMesh();
  const arrays = [body.idx, body.pos, body.col, visor.idx, visor.pos];
  let o = 0;
  const views = arrays.map((a) => { const v = { buffer: 0, byteOffset: o, byteLength: a.byteLength }; o += a.byteLength; return v; });
  const bin = Buffer.concat(arrays.map((a) => Buffer.from(a.buffer)));
  const bounds = (p) => [0, 1, 2].map((k) => Math.min(...p.filter((_, i) => i % 3 === k))).concat([0, 1, 2].map((k) => Math.max(...p.filter((_, i) => i % 3 === k))));
  const bb = bounds([...body.pos]), vb = bounds([...visor.pos]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ name: 'Body', mesh: 0 }, { name: 'Visor', mesh: 1 }],
    materials: [
      { name: 'Shell', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
      { name: 'Visor', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.3 }, emissiveFactor: [0.2, 0.9, 1] },
    ],
    meshes: [
      { name: 'Body', primitives: [{ attributes: { POSITION: 1, COLOR_0: 2 }, indices: 0, material: 0 }] },
      { name: 'Visor', primitives: [{ attributes: { POSITION: 4 }, indices: 3, material: 1 }] },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5125, count: body.idx.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: body.pos.length / 3, type: 'VEC3', min: bb.slice(0, 3), max: bb.slice(3) },
      { bufferView: 2, componentType: 5126, count: body.col.length / 3, type: 'VEC3' },
      { bufferView: 3, componentType: 5125, count: visor.idx.length, type: 'SCALAR' },
      { bufferView: 4, componentType: 5126, count: visor.pos.length / 3, type: 'VEC3', min: vb.slice(0, 3), max: vb.slice(3) },
    ],
  };
  return writeGlb(json, bin);
}
