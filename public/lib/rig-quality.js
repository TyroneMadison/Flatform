// Test Rig picture quality, as pure rules (no DOM, no three.js): the Fast / High setting, which post.js effects it
// turns on, which materials get subsurface (skin and cloth), the sky picture that lights a place, how the picture
// size follows the frame rate so High stays smooth, and the words shown while a ray-traced photo builds up.

export const QUALITY = {
  fast: { label: 'Fast', tip: 'Smooth on any computer: simpler shadows and no shading in corners', pixelRatio: 1, shadowMap: 1024, shadowRadius: 1, ao: false, aa: 'fxaa' },
  high: { label: 'High', tip: 'The best picture: soft shadows, shading in corners and creases, smooth edges', pixelRatio: 1.5, shadowMap: 2048, shadowRadius: 4, ao: true, aa: 'smaa' },
};
export const DEFAULT_QUALITY = 'high';
// A computer setting, not part of the scene: kept on this machine, never an undo step.
const KEY = 'flatform.testrig.quality';
export const qualityOf = (storage) => { try { const q = storage?.getItem(KEY); return Object.hasOwn(QUALITY, q) ? q : DEFAULT_QUALITY; } catch { return DEFAULT_QUALITY; } };
export const saveQuality = (storage, q) => { try { if (Object.hasOwn(QUALITY, q)) storage?.setItem(KEY, q); } catch { /* private mode: High next time */ } };

/** The post.js Post.configure effects for a look (look.js) at a quality. No composer at all when nothing needs one. */
export function rigEffects(look, quality) {
  const q = QUALITY[quality] || QUALITY[DEFAULT_QUALITY];
  const ao = q.ao;
  const bloom = Boolean(look.bloom?.on);
  const composer = ao || bloom;
  return { composer, ao, aoPass: 'gtao', bloom, ssr: false, aa: composer ? q.aa : 'msaa' };
}

// Subsurface (paint.js withSSS): light that soaks into skin and cloth and comes out a little warmer and softer.
export const SSS = {
  skin: { amount: 0.35, radius: 1, color: '#ff7755' },
  fabric: { amount: 0.15, radius: 1.5, color: '#fff1e6' },
};
const HARD = /metal|steel|iron|chrome|gold|silver|armou?r|gun|blade|sword|glass|visor|lens|eye|teeth|tooth|nail|plastic|rubber|weapon/i;
const SKIN = /skin|face|head|body|flesh|hand|arm|leg|neck|ear|lip|torso|character/i;
const FABRIC = /cloth|fabric|shirt|pant|trouser|jean|jacket|coat|dress|skirt|hood|cape|scarf|sock|glove|sleeve|cotton|wool|leather|suit|uniform|robe|hair/i;
const GENERIC = /^(material|mat|default|lambert|phong|standard|blinn|initialshadinggroup)?[\s_.\-#]*\d*$/i;
/**
 * Which subsurface a character material gets: 'skin', 'fabric' or null (metal, glass and hard parts get none).
 * names: the material's and the mesh's names. A plain unnamed material on a character is mostly skin and cloth, so
 * it gets the gentle fabric one. ponytail: names only; read the texture's colours if a named part is guessed wrong.
 */
export function materialKind(mat = {}, ...names) {
  if ((mat.metalness ?? 0) >= 0.5 || (mat.transmission ?? 0) > 0 || mat.opacity < 0.5) return null;
  const all = [mat.name, ...names].filter(Boolean).join(' ');
  if (HARD.test(all)) return null;
  if (SKIN.test(all)) return 'skin';
  if (FABRIC.test(all)) return 'fabric';
  return GENERIC.test(mat.name || '') ? 'fabric' : null;
}

// The sky picture (public/img/hdri) that lights and reflects in a place: the scene's own when it has one, then the
// place's sky or reflection, then a soft studio.
export const FALLBACK_HDRI = 'studio_small_03';
export function lightingHdri(look, env) {
  const f = look?.hdri?.file;
  if (f?.startsWith('builtin:')) return { name: f.slice(8), rotation: look.hdri.rotation || 0, intensity: look.hdri.intensity ?? 1 };
  return { name: env?.sky?.hdri || env?.reflect || FALLBACK_HDRI, rotation: null, intensity: 1 };
}

// High stays smooth: once a second the picture shrinks a step after two slow seconds in a row (one hitch, like a
// place loading, is not enough), and grows back when it is fast again, but not to a size that was already too slow
// (ceiling) until it has been smooth for a while (RETRY seconds), so it does not see-saw.
export const SLOW = 50, FAST = 58, STEP = 0.25, MIN_SCALE = 0.75, RETRY = 30;
/** state { scale, ceiling, slow, good }; returns the next state. max: the quality's pixel ratio on this screen. */
export function adaptScale(state, fps, max) {
  let { scale, ceiling = Infinity, slow = 0, good = 0 } = state;
  scale = Math.min(scale, max);
  if (fps < SLOW) {
    if (++slow >= 2 && scale > MIN_SCALE) return { scale: Math.max(MIN_SCALE, scale - STEP), ceiling: scale, slow: 0, good: 0 };
    return { scale, ceiling, slow, good: 0 };
  }
  if (fps < FAST) return { scale, ceiling, slow: 0, good: 0 };
  if (++good >= RETRY) { ceiling = Infinity; good = 0; }
  const up = Math.min(max, scale + STEP);
  if (up > scale && up < ceiling) return { scale: up, ceiling, slow: 0, good };
  return { scale, ceiling, slow: 0, good };
}

/** Frames per second over a run of frame times (ms, oldest first). */
export const fpsOf = (times) => (times.length < 2 ? 0 : ((times.length - 1) * 1000) / (times.at(-1) - times[0]));

/** What the photo banner says while the ray-traced picture builds up (the first one waits on the graphics card). */
export function photoLabel(samples, max, ready = true) {
  if (!ready || samples < 1) return 'Getting the photo ready… The first one takes a few seconds.';
  const pct = Math.min(100, Math.floor((samples / max) * 100));
  return pct >= 100 ? 'Photo finished. Press any key to play on.' : `Making a photo… ${pct}%. Press any key to play on.`;
}
