// TennoGen compare: checks an exported texture set against the official template set before submitting.
import { MAPS, textureSet, checkTextureName, ALBEDO } from './tenno.js';

const SUFFIX_CHANNELS = { _d: 3, _e: 3, _n: 3, _r: 3, _s: 3, _t: 4 };
// files: [{ name, width, height, channels, luma: { min, max, mean } (albedo only) }]
export function compareSet(files, { part = 'Body', altHelmet = false } = {}) {
  const want = textureSet(part, { altHelmet });
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const checks = [];
  for (const t of want) {
    const f = byName.get(t.name.toLowerCase());
    checks.push({ id: `${t.map}-present`, label: `${t.name} is in the set`, pass: Boolean(f) });
    if (!f) continue;
    checks.push({ id: `${t.map}-size`, label: `${t.name} is ${t.width} x ${t.height}`, pass: f.width === t.width && f.height === t.height, got: `${f.width} x ${f.height}` });
    const sfx = (f.name.match(/(_[a-z])\.[a-z]+$/i)?.[1] || '').toLowerCase();
    const ch = SUFFIX_CHANNELS[sfx];
    if (ch && f.channels != null) checks.push({ id: `${t.map}-channels`, label: `${t.name} has ${ch === 4 ? 'RGBA' : 'RGB'} channels`, pass: f.channels >= ch, got: f.channels });
    if (sfx === '_d' && f.luma) {
      const ok = f.luma.max <= 255 - 15 && f.luma.min >= 15 && Math.abs(f.luma.mean - ALBEDO.nonMetal) <= ALBEDO.tolerance * 2;
      checks.push({ id: `${t.map}-luma`, label: 'Albedo brightness is in the PBR range', pass: ok, got: `${f.luma.min} to ${f.luma.max}, mean ${Math.round(f.luma.mean)}` });
    }
  }
  for (const f of files) {
    const r = checkTextureName(f.name);
    if (!r.ok) checks.push({ id: `name-${f.name}`, label: `${f.name} uses a TennoGen name`, pass: false, got: r.reason || 'unexpected name' });
  }
  return { pass: checks.every((c) => c.pass), checks, maps: Object.keys(MAPS) };
}
// Luminance of RGBA pixel data (Rec. 709), as used for the albedo check.
export function lumaStats(data) {
  let min = 255, max = 0, sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (y < min) min = y; if (y > max) max = y; sum += y; n++;
  }
  return n ? { min: Math.round(min), max: Math.round(max), mean: sum / n } : { min: 0, max: 0, mean: 0 };
}
