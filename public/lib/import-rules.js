// What the home screens accept when pictures (or 3D files) are dropped or picked. Pure: names, types and sizes only,
// so the server and the tests share it. The page then hands accepted files to app.js addFiles().
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/heic', 'image/heif'];
export const PHOTO_EXTS = ['.png', '.jpg', '.jpeg', '.heic', '.heif'];
export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.usdz'];
export const MAX_PHOTO = 20 * 1024 * 1024;
export const MAX_MODEL = 300 * 1024 * 1024;
export const WORKSPACES = { warframe: 'Warframe', car: 'Cars' };

const extOf = (name = '') => (/\.[^.]+$/.exec(String(name).toLowerCase()) || [''])[0];

// files: [{ name, type?, size? }] → { photos, models, rejected: [{ file, reason }] } (the same objects back).
export function classifyFiles(files) {
  const out = { photos: [], models: [], rejected: [] };
  for (const f of files) {
    const ext = extOf(f.name);
    const type = String(f.type || '').toLowerCase();
    if (MODEL_EXTS.includes(ext)) {
      if (f.size > MAX_MODEL) out.rejected.push({ file: f, reason: 'too large (max 300 MB)' });
      else out.models.push(f);
    } else if (PHOTO_TYPES.includes(type) || PHOTO_EXTS.includes(ext)) {
      if (f.size > MAX_PHOTO) out.rejected.push({ file: f, reason: 'too large (max 20 MB)' });
      else out.photos.push(f);
    } else out.rejected.push({ file: f, reason: 'use a PNG, JPEG or HEIC picture, or a GLB, GLTF, FBX, OBJ or USDZ model' });
  }
  return out;
}

// Is any item in a drag a file? (A dragged link or text must not light the overlay.)
export const dragHasFiles = (dt) => Boolean(dt && [...(dt.types || [])].includes('Files'));
