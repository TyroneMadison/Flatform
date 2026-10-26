// Tests only: loads a rigged GLB in three.js the way the app does (textures dropped, Node has no images), poses it
// with the app's own pose code (rig.js applyMotion) and measures the damage on the skinned mesh: how many edges
// stretch past three times, the worst piece, and how far any vertex ends up from where its bones carried it.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyMotion } from '../public/lib/rig.js';

/** The GLB with its images, textures and samplers removed (and material texture slots cleared). */
export function stripTextures(buf) {
  const b = Buffer.from(buf);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
  delete json.images; delete json.textures; delete json.samplers;
  for (const m of json.materials || []) {
    for (const k of Object.keys(m)) if (/Texture$/.test(k)) delete m[k];
    const pbr = m.pbrMetallicRoughness || {};
    for (const k of Object.keys(pbr)) if (/Texture$/.test(k)) delete pbr[k];
    delete m.extensions;
  }
  delete json.extensionsUsed; delete json.extensionsRequired;
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4) text += ' ';
  const rest = b.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + Buffer.byteLength(text) + rest.length, 8);
  head.writeUInt32LE(Buffer.byteLength(text), 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, Buffer.from(text), rest]);
}

export async function loadGlb(buf) {
  const s = stripTextures(buf);
  const gltf = await new GLTFLoader().parseAsync(s.buffer.slice(s.byteOffset, s.byteOffset + s.length), '');
  return gltf.scene;
}

/** Poses the model with motion (as Compose does) and measures every skinned mesh. */
export function poseDamage(model, motion) {
  const pivot = new THREE.Group();
  pivot.add(model);
  const box = new THREE.Box3().setFromObject(model);
  const studio = { model, pivot, carSize: box.getSize(new THREE.Vector3()) };
  const H = studio.carSize.y || 1;
  const meshes = [];
  model.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  const rest = meshes.map((m) => positions(m));
  applyMotion(studio, motion);
  model.updateMatrixWorld(true);
  let over = 0, edges = 0, worst = 1, moved = 0;
  meshes.forEach((m, k) => {
    m.skeleton.update();
    const posed = positions(m);
    const idx = m.geometry.index ? m.geometry.index.array : null;
    const n = idx ? idx.length : posed.length / 3;
    const step = Math.max(3, Math.floor(n / 600000) * 3);
    for (let t = 0; t + 2 < n; t += step) {
      const tri = idx ? [idx[t], idx[t + 1], idx[t + 2]] : [t, t + 1, t + 2];
      for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const r0 = dist(rest[k], a, b);
        if (r0 < 0.002 * H) continue;
        const r = dist(posed, a, b) / r0;
        edges++;
        if (r > 3) over++;
        if (r > worst) worst = r;
      }
    }
    for (let i = 0; i < posed.length; i += 3) moved = Math.max(moved, Math.hypot(posed[i] - rest[k][i], posed[i + 1] - rest[k][i + 1], posed[i + 2] - rest[k][i + 2]));
  });
  return { edges, over, share: over / (edges || 1), worst, moved: moved / H, height: H };
}
const dist = (p, a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
function positions(mesh) {
  const n = mesh.geometry.attributes.position.count, out = new Float32Array(n * 3), v = new THREE.Vector3();
  mesh.updateMatrixWorld(true);
  for (let i = 0; i < n; i++) { mesh.getVertexPosition(i, v); v.applyMatrix4(mesh.matrixWorld); out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; }
  return out;
}
