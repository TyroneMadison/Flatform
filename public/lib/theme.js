// App themes: UI chrome only (CSS variables on <html>). Nothing here touches the 3D scene, materials or renders.
export const PRESETS = {
  dark: { label: 'Flatform Dark', bg: '#070605', text: '#efe7e3', muted: '#ab9d96', primary: '#ff7a66', secondary: '#e2523e', accent: '#ff9a88', onAccent: '#2a0c06' },
  light: { label: 'Light', bg: '#f6f3f1', text: '#1b1614', muted: '#5c514c', primary: '#c43d2a', secondary: '#9e2f20', accent: '#d9503c', onAccent: '#ffffff' },
  contrast: { label: 'High Contrast', bg: '#000000', text: '#ffffff', muted: '#e0e0e0', primary: '#ffd60a', secondary: '#ffe766', accent: '#ffffff', onAccent: '#000000' },
  warm: { label: 'Warm', bg: '#0c0806', text: '#f3e9e3', muted: '#b8a69c', primary: '#FA614B', secondary: '#d94a35', accent: '#ff8a76', onAccent: '#2a0a04' },
  cool: { label: 'Cool', bg: '#060a0f', text: '#e4ecf3', muted: '#9aabbb', primary: '#5b8db8', secondary: '#3f6f99', accent: '#8fb7da', onAccent: '#061220' },
  orokin: { label: 'Warframe Orokin', bg: '#050505', text: '#f2ead8', muted: '#b5a98c', primary: '#c9a35a', secondary: '#a8843f', accent: '#e8c77f', onAccent: '#1a1206' },
};
export const DEFAULT_THEME = { preset: 'dark', custom: {} };
const HEX = /^#[0-9a-f]{6}$/i;
export function normalizeTheme(t) {
  const preset = Object.hasOwn(PRESETS, t?.preset) ? t.preset : 'dark';
  const custom = {};
  for (const k of ['primary', 'secondary', 'accent']) if (HEX.test(t?.custom?.[k] || '')) custom[k] = t.custom[k].toLowerCase();
  return { preset, custom };
}
export const resolveTheme = (t) => { const n = normalizeTheme(t); return { ...PRESETS[n.preset], ...n.custom }; };
// Colors are mixed and checked here so every preset (and any custom accent) stays readable: surfaces come from
// the background, and every text color is nudged toward black or white until it clears WCAG AA (4.5:1) on every
// surface it can sit on. Light themes get light surfaces automatically, so text is never white on white.
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
export const mix = (a, b, t) => { const [x, y] = [rgb(a), rgb(b)]; return '#' + x.map((v, i) => hex2(v + (y[i] - v) * t)).join(''); };
export const isLight = (bg) => luminance(bg) > 0.4;
/** fg moved toward black or white (whichever reads better) until it reaches min contrast on all of bgs. */
export function readable(fg, bgs, min = AA) {
  const list = [].concat(bgs);
  const worst = (c) => Math.min(...list.map((b) => contrast(c, b)));
  if (worst(fg) >= min) return fg;
  const target = worst('#000000') >= worst('#ffffff') ? '#000000' : '#ffffff';
  for (let t = 0.05; t <= 1.0001; t += 0.05) { const c = mix(fg, target, t); if (worst(c) >= min) return c; }
  return target;
}
/** Black or white, whichever is easier to read on bg (button labels on accent fills). */
export const textOn = (bg) => (contrast('#000000', bg) >= contrast('#ffffff', bg) ? '#000000' : '#ffffff');
export function surfaces(c) {
  const light = isLight(c.bg);
  const m = (t) => mix(c.bg, c.text, t);
  return {
    light,
    s0: light ? m(0.06) : mix(c.bg, '#000000', 0.3), // title bar
    rail: light ? m(0.04) : m(0.01),
    s1: light ? '#ffffff' : m(0.05), // cards, chips, chosen tabs
    s1h: light ? m(0.03) : m(0.07),
    s2: light ? '#ffffff' : m(0.005), // inputs, path boxes
    glassA: light ? '#ffffff' : m(0.045), glassB: light ? m(0.02) : m(0.025),
    pop: light ? '#ffffff' : mix(m(0.06), c.primary, 0.06), // tooltips, toasts
    stageA: light ? m(0.05) : mix(c.bg, c.primary, 0.08), stageB: light ? m(0.1) : m(0.01),
    tint: mix(light ? '#ffffff' : c.bg, c.primary, light ? 0.12 : 0.16),
    lines: [0.12, 0.1, 0.14, 0.2, 0.28].map((t) => m(light ? t * 1.2 : t)),
  };
}
export function themeVars(t) {
  const c = resolveTheme(t);
  const S = surfaces(c);
  const all = [c.bg, S.s0, S.rail, S.s1, S.s1h, S.s2, S.glassA, S.glassB, S.pop, S.stageA, S.stageB, S.tint];
  const text = readable(c.text, all);
  const muted = readable(c.muted, all);
  const accentText = readable(c.accent, all);
  const status = (dark, light) => readable(S.light ? light : dark, all);
  const onAccent = c.onAccent && contrast(c.onAccent, c.primary) >= AA ? c.onAccent : textOn(c.primary);
  // Button fills bend toward whatever keeps their label readable (a light end of a gradient gets darker, and so on).
  const fill = (x) => readable(x, [onAccent]);
  const primary = fill(c.primary), secondary = fill(c.secondary), accentFill = fill(c.accent);
  return {
    '--bg': c.bg, '--text': text, '--muted': muted, '--soft': readable(mix(muted, text, 0.4), all), '--dim': muted,
    '--accent': primary, '--accent-lo': secondary, '--accent-hi': accentText, '--on-accent': onAccent, '--ring': c.primary,
    '--accent-grad': `linear-gradient(160deg, ${accentFill}, ${primary} 55%, ${secondary})`,
    '--surface-0': S.s0, '--surface-rail': S.rail, '--surface-1': S.s1, '--surface-1h': S.s1h, '--surface-2': S.s2,
    '--glass-a': S.glassA, '--glass-b': S.glassB, '--surface-pop': S.pop, '--stage-a': S.stageA, '--stage-b': S.stageB,
    '--tint-strong': S.tint, '--line': S.lines[0], '--line-2': S.lines[1], '--line-3': S.lines[2], '--line-4': S.lines[3], '--line-5': S.lines[4],
    '--ok': status('#b9d98a', '#2f6b12'), '--bad': status('#ff5d73', '#b3122c'), '--warn': status('#ffb366', '#8a4b00'),
    '--ok-bg': mix(S.s1, '#4caf50', 0.14), '--warn-bg': mix(S.s1, '#ff9800', 0.14), '--bad-bg': mix(S.s1, '#ff3355', 0.14),
    '--scheme': S.light ? 'light' : 'dark',
  };
}
export function applyTheme(t, el = globalThis.document?.documentElement) {
  if (!el) return;
  for (const [k, v] of Object.entries(themeVars(t))) el.style.setProperty(k, v);
  el.dataset.theme = normalizeTheme(t).preset;
  el.style.colorScheme = themeVars(t)['--scheme']; // native scrollbars, pickers and selects follow the theme
}
// WCAG relative luminance and contrast ratio.
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const AAA = 7;
export const AA = 4.5;
