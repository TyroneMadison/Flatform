// Fill small holes, the in-app way (no Blender): every triangle part of a GLB goes through public/lib/holes.js and
// gets a new triangle list (and new corner positions where a crack was closed) added to the end of the file. Every
// texture, material, UV and skin stays as it was. Blender does the same in render/blender_fillholes.py.
import { readGlb, writeGlb, accessor, pad4, INDEX_TYPES } from './glb-trim.mjs';
import { fillHoles } from './public/lib/holes.js';

/** Returns { glb, holes, cracks }; glb is the same buffer when nothing changed. Parts packed in other ways are skipped. */
export function fillGlb(buf, opts = {}) {
  const { json, bin } = readGlb(buf);
  const chunks = [bin];
  let length = bin.length, holes = 0, cracks = 0;
  const add = (data, target, extra) => {
    const offset = pad4(length);
    chunks.push(Buffer.alloc(offset - length), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    length = offset + data.byteLength;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    json.accessors.push({ bufferView: json.bufferViews.length - 1, ...extra });
    return json.accessors.length - 1;
  };
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      if (prim.extensions?.KHR_draco_mesh_compression || prim.extensions?.EXT_meshopt_compression || (prim.mode ?? 4) !== 4) continue;
      const pa = json.accessors?.[prim.attributes?.POSITION];
      if (pa?.componentType !== 5126 || pa.type !== 'VEC3' || pa.sparse) continue;
      let pos, index = null;
      try {
        pos = accessor(json, bin, prim.attributes.POSITION, Float32Array, 3);
        if (prim.indices != null) index = accessor(json, bin, prim.indices, INDEX_TYPES[json.accessors[prim.indices].componentType], 1);
      } catch { continue; } // in another buffer: leave it
      const r = fillHoles(pos, index, opts);
      if (!r.holes && !r.cracks) continue;
      holes += r.holes;
      cracks += r.cracks;
      if (r.pos) {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < r.pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], r.pos[i]); hi[i % 3] = Math.max(hi[i % 3], r.pos[i]); }
        prim.attributes.POSITION = add(r.pos, 34962, { componentType: 5126, count: pa.count, type: 'VEC3', min: lo, max: hi });
      }
      const out = pos.length / 3 <= 65535 ? Uint16Array.from(r.index) : r.index;
      prim.indices = add(out, 34963, { componentType: out instanceof Uint16Array ? 5123 : 5125, count: out.length, type: 'SCALAR' });
    }
  }
  if (!holes && !cracks) return { glb: Buffer.from(buf), holes, cracks };
  const data = Buffer.concat(chunks);
  json.buffers[0].byteLength = pad4(data.length);
  // ponytail: old triangle lists stay in the file unused, as in glb-trim.mjs; repack if file size ever matters.
  return { glb: writeGlb(json, data), holes, cracks };
}
