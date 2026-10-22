// 3D models dropped on the Drop step: GLB as is; GLTF, FBX, OBJ and USDZ read with three.js loaders and written
// out as GLB (GLTFExporter), so everything after (Compose, renders, Blender, downloads) only ever sees GLB.
// A GLTF must be self-contained (embedded buffers and images); one that points at separate files can't be read
// from a single dropped file.
import * as THREE from 'three';

export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.usdz'];
export const MAX_MODEL = 300 * 1024 * 1024;
export const extOf = (name = '') => (/\.[^.]+$/.exec(name.toLowerCase()) || [''])[0];
export const isModelFile = (file) => MODEL_EXTS.includes(extOf(file.name));

const LOADERS = {
  '.gltf': async () => new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader(),
  '.fbx': async () => new (await import('three/addons/loaders/FBXLoader.js')).FBXLoader(),
  '.obj': async () => new (await import('three/addons/loaders/OBJLoader.js')).OBJLoader(),
  '.usdz': async () => new (await import('three/addons/loaders/USDZLoader.js')).USDZLoader(),
};

// The file as GLB bytes (a Blob).
export async function toGlb(file) {
  const ext = extOf(file.name);
  if (ext === '.glb') return file;
  const make = LOADERS[ext];
  if (!make) throw new Error(`${file.name}: use a GLB, GLTF, FBX, OBJ or USDZ file`);
  const url = URL.createObjectURL(file);
  let loaded;
  try { loaded = await (await make()).loadAsync(url); } catch (e) {
    throw new Error(`${file.name}: could not read it (${e.message || 'unknown error'})${ext === '.gltf' ? '. Use a GLB or a GLTF with everything embedded' : ''}`);
  } finally { URL.revokeObjectURL(url); }
  const root = loaded.scene || loaded; // GLTFLoader gives { scene }, the others a Group
  if (ext === '.obj') root.traverse((o) => { if (o.isMesh && !o.material?.isMeshStandardMaterial) o.material = new THREE.MeshStandardMaterial({ color: 0xbfc3c8, roughness: 0.5 }); });
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
  return new Blob([glb], { type: 'model/gltf-binary' });
}

// A small PNG of the model on the transparent look, for the library card. Best effort: null without WebGL.
export async function previewOf(glb) {
  const { Studio } = await import('./studio.js');
  const canvas = document.createElement('canvas');
  let studio;
  const url = URL.createObjectURL(glb);
  try {
    studio = new Studio(canvas, { preserveDrawingBuffer: true });
    studio.resize(512, 512, 1);
    await studio.setState({ preset: 'transparent' });
    await studio.load(url);
    studio.render();
    return await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
  } catch { return null; } finally {
    URL.revokeObjectURL(url);
    studio?.dispose();
  }
}

// Converts, previews and saves a dropped model; returns the new library entry.
export async function importModel(file) {
  if (file.size > MAX_MODEL) throw new Error(`${file.name}: too large (max 300 MB)`);
  const glb = await toGlb(file);
  const form = new FormData();
  form.append('name', file.name.replace(/\.[^.]+$/, '') || 'Untitled');
  form.append('glb', new File([glb], 'model.glb', { type: 'model/gltf-binary' }));
  form.append('fileName', file.name);
  if (extOf(file.name) !== '.glb') form.append('original', file, file.name); // a GLB is already the 'glb' part
  const preview = await previewOf(glb);
  if (preview) form.append('preview', new File([preview], 'preview.png', { type: 'image/png' }));
  const res = await fetch('/api/models/import', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
