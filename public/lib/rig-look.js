// The Look panel of the Test Rig and the Look row of the Pose panel, as pure data and rules (no DOM, no three.js).
// Every setting lives in the Compose scene itself (scene.preset and scene.look), so what you pick while playing is
// what the scene shows, saves and renders, and each pick is one undo step (lookChange returns that one change).
import { ENVIRONMENTS, ROOMS } from './environments.js';
import { mergeLook, lightsFromPreset } from './look.js';

/** The places to play in: every 3D world (White studio first, the default). */
export const RIG_ENVS = Object.fromEntries(ROOMS.map((r) => [r.slug, r.label])); // the shared room list
export const DEFAULT_ENV = 'white-cyc-studio';

// A light preset sets the light rig (look.js LIGHT_PRESETS) plus the time of day, brightness, rim colour, haze and
// glow that go with it. Rain stays as you set it.
export const RIG_LIGHTS = {
  studio: { label: 'Studio', tip: 'Bright, clean light, like a photo studio', lights: 'studio', time: 13, brightness: 1, rim: '#ffffff', fog: false, fogColor: '#cfd3da', glow: false },
  sunset: { label: 'Sunset', tip: 'Warm, low sun and a soft haze', lights: 'dusk', time: 19, brightness: 1.05, rim: '#ffb070', fog: true, fogColor: '#d9a07a', glow: true },
  night: { label: 'Night', tip: 'Cool moonlight, dark sky, lit signs glow', lights: 'night', time: 20, brightness: 0.85, rim: '#7fa0ff', fog: true, fogColor: '#1a2033', glow: true },
  neon: { label: 'Neon', tip: 'Pink and blue city light with a strong glow', lights: 'neon', time: 20, brightness: 1, rim: '#2fe0ff', fog: true, fogColor: '#2a1640', glow: true },
};
// Glow only on what is lit brighter than white (signs, lamps, glowing parts): bloom runs before tone mapping, so a
// lower threshold washes a white studio and the model out (the Night city template's numbers).
export const GLOW = { strength: 0.2, threshold: 1.6 };
const PRESET_OF = Object.fromEntries(Object.entries(RIG_LIGHTS).map(([k, p]) => [p.lights, k]));

// Time of day (6 am to 8 pm) is where the sun is: it crosses from one side at sunrise to the other at dusk, highest
// at noon. Stored as the key light's place, so the time is read back from its turn.
export const TIME = { min: 6, max: 20 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function sunAt(hour) {
  const h = clamp(hour, TIME.min, TIME.max);
  return { azimuth: (h - 12) * 15, elevation: Math.round(clamp(75 * Math.sin((Math.PI * (h - 6)) / 12), 4, 75)) };
}
export const timeOf = (azimuth) => clamp(12 + azimuth / 15, TIME.min, TIME.max);
/** "1 pm" for 13. */
export const timeLabel = (hour) => { const h = Math.round(hour); return h === 12 ? 'Noon' : `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`; };

/** What the Look panel shows, read from the scene. light is null while the scene keeps its own light (Match photo). */
export function rigLookOf(scene = {}) {
  const look = mergeLook(scene.look);
  const own = look.lights.preset === 'match';
  return {
    env: ENVIRONMENTS[scene.preset] ? scene.preset : DEFAULT_ENV,
    light: PRESET_OF[look.lights.preset] || null,
    time: own ? 13 : timeOf(look.lights.key.azimuth),
    brightness: look.exposure,
    rim: look.lights.rim.color,
    fog: look.fog.on, rain: look.rain, glow: look.bloom.on,
  };
}

/**
 * The one scene change a Look control makes: key is env | light | time | brightness | rim | fog | rain | glow.
 * Anything that moves a light first swaps the scene's own light (Match photo) for the Studio rig.
 */
export function lookChange(scene, key, value) {
  if (key === 'env') {
    if (!ENVIRONMENTS[value]) throw new Error(`Unknown place ${value}`);
    return { preset: value };
  }
  const look = mergeLook(structuredClone(scene.look || {}));
  const rig = () => { if (look.lights.preset === 'match') look.lights = lightsFromPreset('studio'); return look.lights; };
  if (key === 'light') {
    const p = RIG_LIGHTS[value];
    if (!p) throw new Error(`Unknown light ${value}`);
    look.lights = lightsFromPreset(p.lights);
    Object.assign(look.lights.key, sunAt(p.time));
    look.lights.rim = { ...look.lights.rim, on: true, color: p.rim };
    look.exposure = p.brightness;
    look.fog = { ...look.fog, on: p.fog, color: p.fogColor };
    look.bloom = { ...look.bloom, ...GLOW, on: p.glow };
  } else if (key === 'time') Object.assign(rig().key, sunAt(Number(value)));
  else if (key === 'brightness') look.exposure = clamp(Number(value) || 1, 0.3, 2);
  else if (key === 'rim') { const l = rig(); l.rim = { ...l.rim, on: true, color: String(value) }; }
  else if (key === 'fog') look.fog = { ...look.fog, on: Boolean(value) };
  else if (key === 'rain') look.rain = Boolean(value);
  else if (key === 'glow') look.bloom = { ...look.bloom, ...(value && GLOW), on: Boolean(value) };
  else throw new Error(`Unknown look setting ${key}`);
  return { look };
}
