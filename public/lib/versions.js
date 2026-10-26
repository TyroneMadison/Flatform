// Render version compare. Every render pass is kept as a version with the settings that made it, so two versions can
// be flipped, wiped or shown side by side straight from their saved frames, with no re-render.
export const MODES = ['flip', 'wipe', 'side'];

export function addVersion(list, { files, settings, at = new Date().toISOString() }) {
  const n = (list.at(-1)?.n ?? 0) + 1;
  return [...list, { n, at, files: [...files], settings: structuredClone(settings ?? {}) }];
}

/** Which settings changed between two versions: [{ key, a, b }] (dotted keys for nested values). */
export function diffSettings(a = {}, b = {}, prefix = '') {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k], key = prefix + k;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) out.push(...diffSettings(x, y, key + '.'));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ key, a: x, b: y });
  }
  return out;
}

/** Wipe / before-after slider: the clip rectangle of the "after" image at position t (0..1) across width. */
export const wipeClip = (t, width, height) => { const x = Math.round(Math.min(1, Math.max(0, t)) * width); return { x, y: 0, w: width - x, h: height }; };
/** Keyboard on the slider: arrows step 5%, Shift steps 25%, Home/End go to the ends. */
export function sliderKey(t, key, shift = false) {
  const s = shift ? 0.25 : 0.05;
  const n = key === 'ArrowLeft' ? t - s : key === 'ArrowRight' ? t + s : key === 'Home' ? 0 : key === 'End' ? 1 : t;
  return Math.min(1, Math.max(0, n));
}
/** Same frame index in both versions (frame counts may differ), so flipping keeps the angle. */
export const pairFrame = (i, a, b) => [a.files[i % a.files.length], b.files[Math.round((i / a.files.length) * b.files.length) % b.files.length]];

// Plain names for what a render's settings hold (scene keys, the light rig, glass).
const NAMES = {
  preset: 'Place', backdrop: 'Place', paint: 'Colours', decals: 'Stickers', extras: 'Added things', motion: 'Pose',
  camera: 'Camera', lens: 'Camera', view: 'Camera', orbit: 'Camera', path: 'Camera move', bookmarks: 'Camera',
  key: 'Light', fill: 'Light', rim: 'Light', matchLighting: 'Light', lighting: 'Light', look: 'Look', glass: 'Glass',
  x: 'Position', y: 'Position', turn: 'Position', scale: 'Size', sameSize: 'Size', flip: 'Position', snap: 'Position',
  reflection: 'Ground', shadow: 'Ground', mirror: 'Shape',
};
/** "Place and Colours" style list of what changed between two versions' settings, or '' when nothing did. */
export function changedNames(a, b) {
  const flat = (v) => ({ ...(v?.scene || {}), lighting: v?.lighting, glass: v?.glass });
  const names = [...new Set(diffSettings(flat(a), flat(b)).map((d) => NAMES[d.key.split('.')[0]] || 'Other settings'))];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}
