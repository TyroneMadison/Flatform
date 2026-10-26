// The scene "look": background, HDRI environment, light rig, ambient occlusion, reflections, tone mapping and
// render quality. Pure data and rules; studio.js applies them, render/blender_turntable.py reads blenderLook().
// Every default is today's behaviour, so an old scene (no `look`) renders exactly as before.

export const TONE_MAPPINGS = { neutral: 'Neutral (default)', aces: 'ACES Filmic', agx: 'AgX' };
export const QUALITIES = { low: 'Low', medium: 'Medium', high: 'High', pathTraced: 'Path traced' };
export const BACKGROUND_KINDS = { scene: 'Scene', solid: 'Solid colour', gradient: 'Gradient', image: 'Image' };
export const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp']; // custom background images
export const HDRI_TYPES = ['.hdr', '.exr'];
// Built-in studio HDRIs: Poly Haven, CC0 (THIRD_PARTY_NOTICES.md). 1k versions, served from public/img/hdri/.
// ground: [camera height, radius] in metres: shown as a place, the HDRI is projected onto a dome with a flat floor
// that far below the lens it was shot with, so its ground meets the car at real scale (studio.js showDome).
export const HDRIS = {
  studio_small_03: { label: 'Studio small 03', note: 'Soft three-light studio', ground: [1.6, 8] },
  studio_small_08: { label: 'Studio small 08', note: 'Bright softbox studio', ground: [1.6, 8] },
  brown_photostudio_02: { label: 'Brown photo studio', note: 'Warm photo studio', ground: [1.6, 9] },
  kloofendal_48d_partly_cloudy_puresky: { label: 'Kloofendal sky', note: 'Partly cloudy outdoor sky', ground: [1.7, 120] },
  garage: { label: 'Garage', note: 'Concrete garage, daylight from the door', ground: [1.6, 12] },
  goegap_road: { label: 'Desert dusk', note: 'Desert road at sunset', ground: [1.7, 80] },
  white_studio_02: { label: 'White cyclorama', note: 'Clean white studio, soft light', ground: [1.6, 10] },
};
// Your own HDRIs: a tripod at eye height, a mid-size place. ponytail: one guess for every upload; add a per-file
// setting if people import very small rooms or wide landscapes.
export const hdriGround = (file) => (file?.startsWith('builtin:') && HDRIS[file.slice(8)]?.ground) || [1.7, 40];
export const hdriUrl = (file) => (file.startsWith('builtin:') ? `/img/hdri/${file.slice(8)}.hdr` : `/backdrops/${encodeURIComponent(file)}`);
export const isHdri = (name) => HDRI_TYPES.includes(String(name).slice(String(name).lastIndexOf('.')).toLowerCase());
export const isBackgroundImage = (name) => IMAGE_TYPES.includes(String(name).slice(String(name).lastIndexOf('.')).toLowerCase());
// Accepts a built-in HDRI name or an imported .hdr/.exr file; anything else is refused.
export function checkHdri(file) {
  if (file == null) return { ok: true, file: null };
  if (typeof file !== 'string') return { ok: false, reason: 'Pick an HDRI' };
  if (file.startsWith('builtin:')) return Object.hasOwn(HDRIS, file.slice(8)) ? { ok: true, file } : { ok: false, reason: 'Unknown built-in HDRI' };
  return isHdri(file) ? { ok: true, file } : { ok: false, reason: 'Use a .hdr or .exr file' };
}

const light = (on, intensity, color, azimuth, elevation) => ({ on, intensity, color, azimuth, elevation });
// Light presets. 'match' = today's "Match lighting to scene" rig (the scene's own key/fill/rim), untouched.
export const LIGHT_PRESETS = {
  match: { label: 'Match photo', note: 'Key, fill and rim follow the scene (default)' },
  studio: { label: 'Studio 3-point', key: light(true, 1.4, '#fff3e2', -35, 40), fill: light(true, 0.5, '#dfe8ff', 50, 15), rim: light(true, 1.2, '#ffffff', 160, 35) },
  softbox: { label: 'Soft box', key: light(true, 1.0, '#ffffff', -10, 65), fill: light(true, 0.8, '#ffffff', 30, 30), rim: light(false, 0.4, '#ffffff', 180, 40) },
  rim: { label: 'Dramatic rim', key: light(true, 0.5, '#ffe9d6', -60, 25), fill: light(false, 0.2, '#dfe8ff', 60, 10), rim: light(true, 2.2, '#ffffff', 150, 30) },
  dusk: { label: 'Outdoor dusk', key: light(true, 1.6, '#ffb070', -80, 8), fill: light(true, 0.35, '#8fa8ff', 70, 30), rim: light(true, 0.8, '#ffd0a0', 170, 12) },
};
export const DEFAULT_LIGHTS = { preset: 'match', ...Object.fromEntries(['key', 'fill', 'rim'].map((k) => [k, LIGHT_PRESETS.studio[k]])), shadows: true, softness: 0.5 };
export const lightsFromPreset = (id) => {
  if (!Object.hasOwn(LIGHT_PRESETS, id)) throw new Error(`Unknown lighting preset ${id}`);
  const p = LIGHT_PRESETS[id];
  return { ...DEFAULT_LIGHTS, preset: id, ...(p.key && { key: { ...p.key }, fill: { ...p.fill }, rim: { ...p.rim } }) };
};

export const DEFAULT_LOOK = {
  background: { kind: 'scene', color: '#0b0a09', color2: '#2a2422', image: null },
  hdri: { file: null, rotation: 0, intensity: 1, background: false, blur: 0 },
  lights: DEFAULT_LIGHTS,
  ao: { on: false, strength: 1 },
  tone: 'neutral', exposure: 1,
  bloom: { on: false, strength: 0.6, threshold: 0.9 },
  aa: 'msaa', // the renderer's own MSAA; 'fxaa' or 'smaa' add a pass
  ssr: { on: false, strength: 0.5 },
  pathTraced: false,
  quality: 'medium',
  finalEngine: 'cycles', // Blender final renders: Cycles (path traced) or Eevee (fast)
};
// Merges a saved (partial, possibly old) look over the defaults.
export function mergeLook(saved = {}) {
  const out = { ...DEFAULT_LOOK, ...saved };
  for (const k of ['background', 'hdri', 'lights', 'ao', 'bloom', 'ssr']) out[k] = { ...DEFAULT_LOOK[k], ...saved?.[k] };
  for (const k of ['key', 'fill', 'rim']) out.lights[k] = { ...DEFAULT_LIGHTS[k], ...saved?.lights?.[k] };
  if (!Object.hasOwn(TONE_MAPPINGS, out.tone)) out.tone = 'neutral';
  if (!Object.hasOwn(QUALITIES, out.quality)) out.quality = 'medium';
  if (!checkHdri(out.hdri.file).ok) out.hdri.file = null;
  return out;
}
// Which realtime effects a quality level allows (lower-end GPUs keep the plain renderer).
export function effectsFor(look) {
  const q = look.quality;
  const allow = { low: 0, medium: 1, high: 2, pathTraced: 2 }[q] ?? 1;
  return {
    composer: allow >= 1 && (look.ao.on || look.bloom.on || look.ssr.on || ['fxaa', 'smaa'].includes(look.aa)),
    ao: allow >= 1 && look.ao.on, aoPass: allow >= 2 ? 'gtao' : 'ssao',
    bloom: allow >= 1 && look.bloom.on, aa: allow >= 1 ? look.aa : 'msaa', ssr: allow >= 2 && look.ssr.on,
    pathTraced: q === 'pathTraced' && look.pathTraced,
  };
}

// Studio presets: a whole look under a name. Car Default is today's look exactly; the others are shipped too.
export const STUDIO_PRESETS = {
  'Car Default': DEFAULT_LOOK,
  'Warframe Studio': mergeLook({
    background: { kind: 'solid', color: '#15161a' }, hdri: { file: 'builtin:studio_small_03', intensity: 1.2, rotation: 30 },
    lights: lightsFromPreset('studio'), ao: { on: true, strength: 1 }, tone: 'agx', bloom: { on: true, strength: 0.5 }, aa: 'smaa', quality: 'high',
  }),
  'Showcase Dark': mergeLook({
    background: { kind: 'gradient', color: '#000000', color2: '#1d1a1a' }, hdri: { file: 'builtin:studio_small_08', intensity: 0.8, rotation: 0 },
    lights: lightsFromPreset('rim'), ao: { on: true, strength: 1.2 }, tone: 'aces', exposure: 1.1, ssr: { on: true, strength: 0.6 }, aa: 'smaa', quality: 'high',
  }),
};
// Lighting studio: one-click environments. Each sets the HDRI (file, turn, strength, shown as the place around
// the car or not) and the tone. A studio with a 3D set (preset, environments.js) also switches the scene to it;
// the others keep the scene and, when shown, put the HDRI on a ground-projected dome at real scale.
export const LIGHTING_PRESETS = {
  garage: { label: 'Garage', hdri: { file: 'builtin:garage', rotation: 90, intensity: 1, background: true, blur: 0.15 }, tone: 'agx' },
  desertDusk: { label: 'Desert dusk', hdri: { file: 'builtin:goegap_road', rotation: 200, intensity: 1.1, background: true, blur: 0 }, tone: 'aces' },
  whiteCyc: { label: 'White cyclorama', hdri: { file: 'builtin:white_studio_02', rotation: 0, intensity: 1, background: false, blur: 0 }, tone: 'neutral', preset: 'white-cyc-studio' },
  studioSoft: { label: 'Soft studio', hdri: { file: 'builtin:studio_small_03', rotation: 30, intensity: 1.2, background: false, blur: 0 }, tone: 'agx', preset: 'soft-studio' },
  studioBright: { label: 'Bright studio', hdri: { file: 'builtin:studio_small_08', rotation: 0, intensity: 1, background: false, blur: 0 }, tone: 'neutral' },
  photoWarm: { label: 'Warm photo studio', hdri: { file: 'builtin:brown_photostudio_02', rotation: 0, intensity: 1, background: false, blur: 0 }, tone: 'neutral' },
  outdoorSky: { label: 'Open sky', hdri: { file: 'builtin:kloofendal_48d_partly_cloudy_puresky', rotation: 0, intensity: 1, background: true, blur: 0 }, tone: 'aces' },
};
export const applyLightingPreset = (look, id) => {
  const p = LIGHTING_PRESETS[id];
  if (!p) return mergeLook(look);
  const base = mergeLook(look);
  return mergeLook({ ...base, hdri: { ...p.hdri }, tone: p.tone });
};
export const lightingPresetOf = (look) => {
  const l = mergeLook(look);
  return Object.keys(LIGHTING_PRESETS).find((k) => { const h = LIGHTING_PRESETS[k].hdri; return l.hdri.file === h.file && l.hdri.background === h.background && l.hdri.rotation === h.rotation; }) || null;
};
// Whether a look change needs the stage rebuilt. Swapping one HDRI for another (same background setting) does
// not: the environment and background are replaced in place.
export const lookNeedsRebuild = (a, b) => {
  a = mergeLook(a); b = mergeLook(b);
  const hdriSwap = a.hdri.file && b.hdri.file && a.hdri.background === b.hdri.background;
  return a.background.kind !== b.background.kind || a.background.image !== b.background.image || (!hdriSwap && a.hdri.file !== b.hdri.file) || a.hdri.background !== b.hdri.background;
};
// Validates a saved preset collection (settings.studioPresets): { name: look } with sane names.
export function cleanStudioPresets(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [name, look] of Object.entries(obj)) {
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || !look || typeof look !== 'object') return null;
    out[name.trim()] = mergeLook(look);
  }
  return out;
}

// What render/blender_turntable.py reads from the scene JSON: materials with SSS, HDRI, lights and tone mapping.
export function blenderLook(look, { hdriPath = null } = {}) {
  const l = mergeLook(look);
  return {
    engine: l.pathTraced || l.finalEngine === 'cycles' ? 'CYCLES' : 'BLENDER_EEVEE_NEXT',
    tone: { neutral: 'Khronos PBR Neutral', aces: 'Filmic', agx: 'AgX' }[l.tone], exposure: l.exposure,
    background: l.background,
    hdri: l.hdri.file ? { path: hdriPath, rotation: l.hdri.rotation, intensity: l.hdri.intensity, background: l.hdri.background, blur: l.hdri.blur, ground: hdriGround(l.hdri.file) } : null,
    lights: l.lights.preset === 'match' ? null : l.lights,
    ao: l.ao, bloom: l.bloom,
  };
}
