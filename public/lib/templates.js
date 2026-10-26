// Scene templates: a starting scene (backdrop, lighting, camera and background) in one click. Built-in ones per
// workspace kind, plus "Save current scene as template" (kept per workspace on the server, templates.json).
import { mergeLook, lightsFromPreset } from './look.js';

// The scene fields a template sets. Everything else (the model, paint, decals, motion) stays as it is.
// (Old saved templates may still carry 'modeled', the retired "Modeled room" switch: it is not a key, so it is dropped on load.)
export const TEMPLATE_KEYS = ['preset', 'camera', 'turn', 'lens', 'view', 'orbit', 'fit', 'look', 'matchLighting', 'reflection', 'shadow'];
const lit = (preset, tweak = {}) => {
  const l = lightsFromPreset(preset);
  for (const [k, v] of Object.entries(tweak)) l[k] = { ...l[k], ...v };
  return l;
};

export const BUILTIN_TEMPLATES = [
  // Warframe
  { id: 'wf-orokin-hall', kind: 'warframe', name: 'Orokin hall', note: 'Ivory and gold, warm glow',
    scene: { preset: 'cyclorama', camera: 'front34', turn: 25, lens: 50, view: 'car', fit: 'all', reflection: 0.6, shadow: 0.5,
      look: { background: { kind: 'gradient', color: '#f3ead6', color2: '#b8893a' }, hdri: { file: 'builtin:brown_photostudio_02', intensity: 1.1, rotation: 40 },
        lights: lit('studio', { key: { color: '#ffe2b0', intensity: 1.5 }, rim: { color: '#ffd27a', intensity: 1.6 } }), bloom: { on: true, strength: 0.6, threshold: 0.85 }, tone: 'agx', ao: { on: true, strength: 1 } } } },
  { id: 'wf-void-black', kind: 'warframe', name: 'Void black', note: 'Pure black, hard rim light',
    scene: { preset: 'cyclorama', camera: 'front34', turn: 20, lens: 50, view: 'car', fit: 'all', reflection: 0, shadow: 0,
      look: { background: { kind: 'solid', color: '#000000' }, hdri: { file: null }, lights: lit('rim', { rim: { intensity: 2.6, color: '#e8f0ff' } }), bloom: { on: true, strength: 0.8, threshold: 0.8 }, tone: 'agx', exposure: 0.9 } } },
  { id: 'wf-relay-plaza', kind: 'warframe', name: 'Relay plaza', note: 'Cool daylight, open sky',
    scene: { preset: 'cyclorama', camera: 'front34', turn: 35, lens: 35, view: 'car', fit: 'all', reflection: 0.3, shadow: 0.6,
      look: { background: { kind: 'gradient', color: '#cfe0f2', color2: '#5d6f86' }, hdri: { file: 'builtin:kloofendal_48d_partly_cloudy_puresky', intensity: 1, rotation: 120 }, lights: lit('softbox'), tone: 'neutral' } } },
  { id: 'wf-turnaround', kind: 'warframe', name: 'Studio turnaround', note: 'Neutral studio for a full spin',
    scene: { preset: 'cyclorama', camera: 'side', turn: 0, lens: 50, view: 'car', fit: 'all', reflection: 0.2, shadow: 0.5,
      look: { background: { kind: 'solid', color: '#2a2b30' }, hdri: { file: 'builtin:studio_small_03', intensity: 1 }, lights: lit('studio'), ao: { on: true, strength: 1 }, tone: 'neutral' } } },
  { id: 'wf-tennogen-shot', kind: 'warframe', name: 'TennoGen shot', note: 'Workshop-style front shot',
    scene: { preset: 'cyclorama', camera: 'front34', turn: 15, lens: 50, view: 'car', fit: 'all', reflection: 0, shadow: 0.4,
      look: { background: { kind: 'solid', color: '#15161a' }, hdri: { file: 'builtin:studio_small_03', intensity: 1.2, rotation: 30 }, lights: lightsFromPreset('studio'), ao: { on: true, strength: 1 }, tone: 'agx', bloom: { on: true, strength: 0.5 }, aa: 'smaa', quality: 'high' } } },
  // Car
  { id: 'car-dudrents-showroom', kind: 'car', name: 'Dud Rents showroom', note: 'Gold ring, dark showroom',
    scene: { preset: 'showroom', camera: 'front34', turn: 30, lens: 50, view: 'car', fit: 'footprint', matchLighting: true, look: {} } },
  { id: 'car-garage', kind: 'car', name: 'Garage', note: 'Polished concrete, warm LED strips',
    scene: { preset: 'luxury-garage', camera: 'front34', turn: 35, lens: 50, view: 'car', fit: 'footprint', matchLighting: true, look: {} } },
  { id: 'car-desert-dusk', kind: 'car', name: 'Desert dusk', note: 'Low sun, open road',
    scene: { preset: 'desert-highway-dusk', camera: 'low', turn: 30, lens: 35, view: 'car', fit: 'footprint', matchLighting: true, look: {} } },
  { id: 'car-white-cyc', kind: 'car', name: 'White cyclorama', note: 'Clean white, soft even light',
    scene: { preset: 'white-cyc-studio', camera: 'side', turn: 90, lens: 50, view: 'car', fit: 'footprint', matchLighting: true, look: {} } },
  { id: 'car-night-city', kind: 'car', name: 'Night city', note: 'Wet street, neon reflections',
    scene: { preset: 'night-city-rain', camera: 'low', turn: 25, lens: 35, view: 'car', fit: 'footprint', matchLighting: true, look: { bloom: { on: true, strength: 0.2, threshold: 1.6 } } } }, // bloom runs before tone mapping: keep it to the signs, not the sky
];

export const templatesFor = (kind) => BUILTIN_TEMPLATES.filter((t) => t.kind === (kind === 'warframe' ? 'warframe' : 'car'));

// Only the template keys, with sane values. Used for saved templates on both sides.
export function templateScene(scene = {}) {
  const out = {};
  for (const k of TEMPLATE_KEYS) if (scene?.[k] !== undefined) out[k] = scene[k];
  if (typeof out.preset !== 'string' || !/^[\w-]{1,40}$/.test(out.preset)) delete out.preset;
  if (typeof out.camera !== 'string' || !/^\w{1,20}$/.test(out.camera)) delete out.camera;
  for (const [k, lo, hi] of [['turn', -360, 360], ['lens', 10, 200], ['reflection', 0, 1], ['shadow', 0, 1]]) {
    if (out[k] === undefined) continue;
    if (!Number.isFinite(Number(out[k]))) delete out[k]; else out[k] = Math.min(hi, Math.max(lo, Number(out[k])));
  }
  if (out.view !== undefined && !['car', 'free'].includes(out.view)) delete out.view;
  if (out.fit !== undefined && !['all', 'footprint'].includes(out.fit)) delete out.fit;
  if (out.matchLighting !== undefined) out.matchLighting = Boolean(out.matchLighting);
  const o = out.orbit;
  if (o !== undefined && !(o === null || (o && [o.position, o.target].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite))))) delete out.orbit;
  if (out.look !== undefined) out.look = out.look && typeof out.look === 'object' && !Array.isArray(out.look) ? mergeLook(out.look) : mergeLook({});
  return out;
}

export function normalizeTemplate(t) {
  const name = String(t?.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  if (!name) return null;
  const id = /^my-[\w-]{1,60}$/.test(String(t.id)) ? String(t.id) : `my-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { id, name, note: 'Saved by you', scene: templateScene(t.scene), savedAt: typeof t.savedAt === 'string' ? t.savedAt.slice(0, 40) : new Date().toISOString() };
}
