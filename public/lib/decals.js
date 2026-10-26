// Decals: PNG or SVG images projected onto the model (they wrap over curves), saved in the scene as plain data.
// Each decal sits at a surface point (model space) facing along that surface's normal, with its own size, turn,
// nudge and finish. Studio builds the meshes as children of the model, so a GLB export carries them.
export const MAX_DECALS = 32;
export const FINISHES = { matte: 'Matte', gloss: 'Gloss', metallic: 'Metallic', mirror: 'Mirror' };
export const DECAL_FILE = /^[a-f0-9]{40}\.(png|svg)$/;

const num = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : d);
const vec = (v, d) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : d);

export function normalizeDecal(d = {}) {
  if (!d || typeof d !== 'object' || !DECAL_FILE.test(String(d.file))) return null;
  const n = vec(d.normal, [0, 0, 1]);
  const len = Math.hypot(...n) || 1;
  return {
    id: /^[\w-]{1,40}$/.test(String(d.id)) ? String(d.id) : `d${Math.random().toString(36).slice(2, 10)}`,
    file: String(d.file),
    name: String(d.name || 'Decal').slice(0, 60),
    point: vec(d.point, [0, 0, 0]),
    normal: n.map((x) => x / len),
    size: num(d.size, 0.01, 5, 0.3), // metres across
    aspect: num(d.aspect, 0.1, 10, 1), // width / height of the image
    rotation: num(d.rotation, -180, 180, 0), // degrees around the surface normal
    offsetX: num(d.offsetX, -1, 1, 0), // nudge along the surface, metres
    offsetY: num(d.offsetY, -1, 1, 0),
    depth: num(d.depth, 0.01, 2, 0.25), // how far the projection reaches into the surface (wrap)
    gloss: num(d.gloss, 0, 1, 0.3),
    metallic: num(d.metallic, 0, 1, 0),
    reflective: num(d.reflective, 0, 1, 0), // clearcoat on top
    opacity: num(d.opacity, 0, 1, 1),
    visible: d.visible !== false,
  };
}
export const normalizeDecals = (list) => (Array.isArray(list) ? list.map(normalizeDecal).filter(Boolean).slice(0, MAX_DECALS) : []);

// The physical material settings for one decal (three.js MeshPhysicalMaterial fields).
export const decalMaterialParams = (d) => ({
  roughness: 1 - d.gloss, metalness: d.metallic, clearcoat: d.reflective, clearcoatRoughness: (1 - d.gloss) * 0.3,
  opacity: d.opacity, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
});

export function finishOf(d) {
  if (d.metallic > 0.8 && d.gloss > 0.9) return 'mirror';
  if (d.metallic > 0.5) return 'metallic';
  return d.gloss > 0.6 ? 'gloss' : 'matte';
}
export const FINISH_VALUES = {
  matte: { gloss: 0.2, metallic: 0, reflective: 0 }, gloss: { gloss: 0.85, metallic: 0, reflective: 0.6 },
  metallic: { gloss: 0.7, metallic: 0.9, reflective: 0.2 }, mirror: { gloss: 1, metallic: 1, reflective: 1 },
};

export const decalUrl = (file) => `/decals/${file}`;

// Server side check of an uploaded decal: a PNG, or an SVG with no scripts. Returns the extension or null.
export function decalKind(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  const text = buf.subarray(0, 4096).toString('utf8').trimStart().toLowerCase();
  if ((text.startsWith('<svg') || text.startsWith('<?xml')) && text.includes('<svg')) {
    const all = buf.toString('utf8').toLowerCase();
    if (/<script|\son\w+\s*=|javascript:|<foreignobject/.test(all)) return null;
    return 'svg';
  }
  return null;
}
