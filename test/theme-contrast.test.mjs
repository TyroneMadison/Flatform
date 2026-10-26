// Light mode and contrast: every preset, plus awkward custom accents, keeps all text at WCAG AA (4.5:1) or better on
// every surface it can sit on, light themes get light surfaces, and the chrome CSS has no hard-coded dark surfaces left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, themeVars, contrast, luminance, readable, textOn, AA } from '../public/lib/theme.js';

const SURF = ['--bg', '--surface-0', '--surface-rail', '--surface-1', '--surface-1h', '--surface-2', '--glass-a', '--glass-b', '--surface-pop', '--stage-a', '--stage-b', '--tint-strong'];
const TEXT = ['--text', '--muted', '--soft', '--dim', '--accent-hi', '--ok', '--bad', '--warn'];
const themes = [
  ...Object.keys(PRESETS).map((preset) => ({ preset })),
  ...['#ffff00', '#ffffff', '#000000', '#123456', '#7f7f7f'].flatMap((p) => [{ preset: 'dark', custom: { primary: p, secondary: p, accent: p } }, { preset: 'light', custom: { primary: p, secondary: p, accent: p } }]),
];

test('contrast: every text color clears AA on every surface, in every theme', () => {
  for (const t of themes) {
    const v = themeVars(t);
    for (const fg of TEXT) for (const bg of SURF) {
      const r = contrast(v[fg], v[bg]);
      assert.ok(r >= AA, `${JSON.stringify(t)} ${fg} ${v[fg]} on ${bg} ${v[bg]} is ${r.toFixed(2)}`);
    }
    for (const bg of [v['--accent'], v['--accent-lo']]) assert.ok(contrast(v['--on-accent'], bg) >= AA, `${JSON.stringify(t)} button label on ${bg}`);
  }
});

test('light mode: light surfaces with dark text, never white on white', () => {
  const v = themeVars({ preset: 'light' });
  for (const bg of SURF) assert.ok(luminance(v[bg]) > 0.5, `${bg} ${v[bg]} is light`);
  assert.ok(luminance(v['--text']) < 0.05, 'text is dark');
  assert.equal(v['--scheme'], 'light');
  assert.equal(themeVars({ preset: 'dark' })['--scheme'], 'dark');
  assert.ok(contrast(readable('#ffffff', '#ffffff'), '#ffffff') >= AA, 'white text on white turns dark enough to read');
  assert.equal(textOn('#ffffff'), '#000000');
  assert.equal(textOn('#000000'), '#ffffff');
});

test('chrome CSS uses theme variables, not hard-coded dark surfaces or light text', () => {
  const banned = ['#050404', '#090807', '#12100d', '#0d0c0a', '#14110f', '#080706', '#1f1513', '#f7ede9', 'rgba(239, 231, 227, .6)'];
  const art = /^\s*(--|\.(s-|sg-|sm-|sc-|sl-x|up\b|fr\b|vtool|hud))/; // scene drawings and photo overlays stay as drawn
  for (const f of ['public/styles/base.css', 'public/styles/screens.css']) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (art.test(line)) return;
      for (const b of banned) assert.ok(!line.includes(b), `${f}:${i + 1} still has ${b}`);
    });
  }
  // The green "Send" button keeps white text at AA.
  assert.ok(contrast('#ffffff', '#1e7d47') >= AA);
});
