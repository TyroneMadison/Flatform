// A small model with holes for Fill small holes: a ball (64 around, 32 up) with UVs, normals and an orange material,
// three small holes (one face, one face, a 2 by 2 patch), the bottom cap cut off (a big opening that must stay
// open), and a crack: the copies of the UV seam are a hair (1.5 ten-thousandths) away from where they should be.
import { writeGlb } from '../../glb-trim.mjs';

export const HOLEY = { holes: 3, cracks: 28 }; // seam rows 4 to 31 are open corners that meet again

export function holeyMesh() {
  const W = 64, H = 32, pos = [], nor = [], uv = [], idx = [];
  const at = (i, j) => i * (W + 1) + j;
  for (let i = 0; i <= H; i++) {
    for (let j = 0; j <= W; j++) {
      const t = (i / H) * Math.PI, f = (j / W) * Math.PI * 2;
      const n = [Math.sin(t) * Math.cos(f), -Math.cos(t), Math.sin(t) * Math.sin(f)];
      const crack = j === W && i > 0 && i < H ? 1 + 1.5e-4 : 1;
      pos.push(n[0] * crack, n[1] * crack, n[2] * crack);
      nor.push(...n);
      uv.push(j / W, i / H);
    }
  }
  const gone = (i, j) => i < 4 || (i === 16 && j === 5) || (i === 20 && j === 40) || ((i === 12 || i === 13) && (j === 30 || j === 31));
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      if (gone(i, j)) continue;
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j + 1), d = at(i + 1, j);
      if (i !== 0) idx.push(a, c, b); // facing out
      if (i !== H - 1) idx.push(a, d, c);
    }
  }
  return { pos: Float32Array.from(pos), nor: Float32Array.from(nor), uv: Float32Array.from(uv), idx: Uint32Array.from(idx) };
}

export function holeyGlb() {
  const { pos, nor, uv, idx } = holeyMesh();
  const parts = [idx, pos, nor, uv];
  let o = 0;
  const views = parts.map((p) => { const v = { buffer: 0, byteOffset: o, byteLength: p.byteLength }; o += p.byteLength; return v; });
  const bin = Buffer.concat(parts.map((p) => Buffer.from(p.buffer)));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Ball', mesh: 0 }],
    materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.75, 0.45, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6 }, doubleSided: false }],
    meshes: [{ name: 'Ball', primitives: [{ attributes: { POSITION: 1, NORMAL: 2, TEXCOORD_0: 3 }, indices: 0, material: 0 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors: [
      { bufferView: 0, componentType: 5125, count: idx.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-1.0002, -1, -1.0002], max: [1.0002, 1, 1.0002] },
      { bufferView: 2, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 3, componentType: 5126, count: uv.length / 2, type: 'VEC2' },
    ],
  };
  return writeGlb(json, bin);
}
