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
export function themeVars(t) {
  const c = resolveTheme(t);
  return { '--bg': c.bg, '--text': c.text, '--muted': c.muted, '--accent': c.primary, '--accent-lo': c.secondary, '--accent-hi': c.accent, '--on-accent': c.onAccent, '--ring': c.primary, '--accent-grad': `linear-gradient(160deg, ${c.accent}, ${c.primary} 55%, ${c.secondary})` };
}
export function applyTheme(t, el = globalThis.document?.documentElement) {
  if (!el) return;
  for (const [k, v] of Object.entries(themeVars(t))) el.style.setProperty(k, v);
  el.dataset.theme = normalizeTheme(t).preset;
}
// WCAG relative luminance and contrast ratio.
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
export const luminance = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
export const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const AAA = 7;
