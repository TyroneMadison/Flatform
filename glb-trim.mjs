// Remove part, the saving half: takes one loose piece out of a GLB and returns the new file. Only the piece's
// triangle list changes (a new index at the end of the binary); every vertex, texture, material and skin stays as
// it was, so nothing else about the model moves. Pieces are found with the same code as the page (public/lib/pieces.js).
import { glbPieces } from './glb-pieces.mjs';
import { findPieces, removePiece } from './public/lib/pieces.js';

export const pad4 = (n) => (n + 3) & ~3;
export const INDEX_TYPES = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array };

export function readGlb(buf) {
  const b = Buffer.from(buf);
  if (b.length < 20 || b.toString('latin1', 0, 4) !== 'glTF') throw new Error('That is not a GLB file');
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
  const at = 20 + jsonLen;
  const bin = at + 8 <= b.length && b.readUInt32LE(at + 4) === 0x004e4942 ? b.subarray(at + 8, at + 8 + b.readUInt32LE(at)) : Buffer.alloc(0);
  return { json, bin };
}
export function writeGlb(json, bin) {
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc(pad4(j.length) - j.length, 0x20)]);
  const bb = Buffer.concat([bin, Buffer.alloc(pad4(bin.length) - bin.length)]);
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bb.length, 8);
  const ch = (len, type) => { const c = Buffer.alloc(8); c.writeUInt32LE(len, 0); c.writeUInt32LE(type, 4); return c; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bb.length, 0x004e4942), bb]);
}

// An accessor's numbers as a typed array (copied out, so the stride and alignment never matter).
export function accessor(json, bin, i, Type, comps) {
  const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
  if (!bv || (bv.buffer ?? 0) !== 0 || a.sparse) throw new Error('unsupported');
  const size = Type.BYTES_PER_ELEMENT, base = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || size * comps;
  const out = new Type(a.count * comps), dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 1: (o) => dv.getUint8(o), 2: (o) => dv.getUint16(o, true), 4: Type === Float32Array ? (o) => dv.getFloat32(o, true) : (o) => dv.getUint32(o, true) }[size];
  for (let e = 0; e < a.count; e++) for (let c = 0; c < comps; c++) out[e * comps + c] = get(base + e * stride + c * size);
  return out;
}

/**
 * buf: the GLB. piece: the app's piece number (three.js mesh order, glb-pieces.mjs). vertex: a vertex of the piece
 * to remove, in that mesh. expect: the triangle count the page showed (a mismatch means the file is not the one on
 * screen). Returns { glb, removed, left }.
 */
export function trimGlb(buf, { piece, vertex, expect = null }) {
  const { json, bin } = readGlb(buf);
  const where = glbPieces(buf)[piece];
  const prim = where && json.meshes?.[where.mesh]?.primitives?.[where.prim];
  if (!prim) throw new Error('That piece is not in the model file');
  if (prim.extensions?.KHR_draco_mesh_compression || prim.extensions?.EXT_meshopt_compression || (prim.mode ?? 4) !== 4) throw new Error('This model file is packed in a way that cannot be trimmed');
  const pa = json.accessors[prim.attributes.POSITION];
  if (pa?.componentType !== 5126 || pa.type !== 'VEC3') throw new Error('This model file is packed in a way that cannot be trimmed');
  const pos = accessor(json, bin, prim.attributes.POSITION, Float32Array, 3);
  const ia = prim.indices != null ? json.accessors[prim.indices] : null;
  const index = ia ? accessor(json, bin, prim.indices, INDEX_TYPES[ia.componentType], 1) : null;
  const nv = pos.length / 3;
  if (!(vertex >= 0 && vertex < nv)) throw new Error('That spot is not on the model');
  const { vertexPiece, sizes, triangles } = findPieces(pos, index);
  const p = vertexPiece[vertex], removed = sizes[p];
  if (expect != null && expect !== removed) throw new Error('The model changed since the piece was picked. Pick it again.');
  if (removed === triangles) throw new Error('That is the whole part. Hide it in Look instead.');
  const kept = removePiece(index, nv, vertexPiece, p);
  const out = nv <= 65535 ? Uint16Array.from(kept) : kept;
  const offset = pad4(bin.length);
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: out.byteLength, target: 34963 });
  json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: out instanceof Uint16Array ? 5123 : 5125, count: out.length, type: 'SCALAR' });
  prim.indices = json.accessors.length - 1;
  const data = Buffer.concat([bin, Buffer.alloc(offset - bin.length), Buffer.from(out.buffer, out.byteOffset, out.byteLength)]);
  json.buffers[0].byteLength = pad4(data.length);
  // ponytail: the old triangle list stays in the file unused (a few MB at most); repack if file size ever matters.
  return { glb: writeGlb(json, data), removed, left: kept.length / 3 };
}
