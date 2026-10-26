// Tools panel polish and plain words: export file names and the short "Saves to" line, help text hidden by default
// with a saved Settings switch, one button style in the panel, and no jargon in the words on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFileName, savesTo, lastFolder } from '../public/lib/save-place.js';
import { hidesHelp, applyHelpText, HIDE_CLASS } from '../public/lib/help-text.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

test('export file names: normal names, spaces, odd characters and empty', () => {
  assert.equal(safeFileName('Weapon'), 'Weapon');
  assert.equal(safeFileName('Sample car'), 'Sample car');
  assert.equal(safeFileName('  lots   of   space  '), 'lots of space');
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeFileName('..hidden..'), 'hidden');
  assert.equal(safeFileName('Mötley Crüe ★'), 'Mötley Crüe ★', 'letters from other languages stay');
  assert.equal(safeFileName('CON'), 'CON_', 'a name Windows will not use gets a mark');
  assert.equal(safeFileName(''), 'model');
  assert.equal(safeFileName(null), 'model');
  assert.equal(safeFileName('///', 'sample-car'), 'sample-car', 'nothing left: the fallback');
  assert.equal(safeFileName('x'.repeat(200)).length, 80);
});

test('"Saves to": the folder\'s own name, the inside folder and the file, never a long raw path', () => {
  assert.equal(lastFolder('E:\\Claude Stuff\\handoff\\sample-car'), 'sample-car');
  assert.equal(lastFolder('/home/me/renders/'), 'renders');
  assert.equal(savesTo('E:\\Renders\\car', 'models', 'Car.glb'), 'car › models › Car.glb');
  assert.equal(savesTo('/r/Weapon', 'tennogen', ['Weapon_d.png', 'Weapon_e.png', 'Weapon_n.png']), 'Weapon › tennogen › Weapon_d.png and 2 more');
  assert.equal(savesTo('', '', 'x.png'), 'x.png');
  const paint = read('public/views/compose-paint.js');
  assert.doesNotMatch(paint, /_d\/_e\/_n/, 'no made-up file name');
  assert.match(paint, /Saves to: <b>\$\{esc\(savesTo\(/);
  assert.match(paint, /data-act="open-export"/, 'an Open folder button');
  assert.match(paint, /models\/\$\{safeFileName\(m\.name, m\.slug\)\}\.glb/, 'the 3D file is named after the model');
});

test('help text: hidden by default, Settings › Show help text brings it back and is saved', async () => {
  assert.equal(hidesHelp(undefined), true);
  assert.equal(hidesHelp({}), true);
  assert.equal(hidesHelp({ showHelp: false }), true);
  assert.equal(hidesHelp({ showHelp: true }), false);
  const classes = new Set([HIDE_CLASS]);
  const body = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
  applyHelpText({ showHelp: true }, body);
  assert.ok(!classes.has(HIDE_CLASS));
  applyHelpText({}, body);
  assert.ok(classes.has(HIDE_CLASS));
  assert.match(read('public/index.html'), /<body class="hide-descriptions">/, 'on before settings load');
  assert.match(read('public/styles/stage.css'), /body\.hide-descriptions :is\([^)]*p\.fine[^)]*\.tg small[^)]*\):not\(\.keep\) \{ display: none; \}/);
  assert.match(read('public/views/settings.js'), /Show help text[\s\S]{0,200}name="showHelp"/);
  assert.match(read('public/app.js'), /applyHelpText\(settings\)/);
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-help-'));
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  const post = (body) => fetch(`http://127.0.0.1:${app.port}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ showHelp: true }).then((r) => r.json())).showHelp, true);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/settings`).then((r) => r.json())).showHelp, true, 'saved');
    assert.equal((await post({ showHelp: 'yes' })).status, 400);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('Tools panel: Start over is three buttons in a row, one button style, the undo note is a pill', () => {
  const compose = read('public/views/compose.js');
  const start = compose.slice(compose.indexOf('id="startover"'), compose.indexOf('id="turntable"'));
  assert.match(start, /class="mg-row trio"/);
  assert.equal(start.match(/class="btn" type="button"/g)?.length, 3, 'three same buttons, no bare ghost text');
  const tools = read('public/views/compose-tools.js');
  assert.doesNotMatch(tools, /btn big/, 'no oversized buttons');
  const css = read('public/styles/stage.css');
  assert.match(css, /\.tcard \.grp \.btn:not\(\.pri\):not\(\.icon\):not\(\.huge\) \{[^}]*font: 600 13px/);
  assert.match(css, /\.tcard \.mg-row\.trio \{ grid-template-columns: repeat\(3/);
  assert.match(css, /\.tcard :is\(\.warnbox[^)]*\) \{ overflow-wrap: anywhere; \}/, 'warning cards wrap');
});

// Words a sixth grader would not know. Checked in the words people see: text between tags, tooltips, labels and
// any quoted string with a space in it (code and saved-data keys have no spaces).
const JARGON = [
  /\b[Ee]missive/, /\b[Aa]lbedo\b/, /Auto-orient/i, /TennoGen texture set/, /GLB with named materials/, /\d{3,4} ?[×x] ?\d{3,4} maps/,
  /\b[XYZ] axis\b/, /\bSSAO\b/, /\bGTAO\b/, /\bSMAA\b/, /\bFXAA\b/, /\bMSAA\b/, /\bSSR\b/, /[Ss]creen-space/, /[Aa]mbient occlusion/,
  /[Tt]one mapping/, /[Aa]nti-aliasing/, /\bHDRI\b/, /\bPBR\b/, /\bIOR\b/, /\bSSS\b/, /\d EV\b/, /[Mm]etalness/, /[Ss]pecular/,
  /\bUVs?\b/, /[Nn]ormal map/, /[Dd]iffuse/, /\bviewport\b/i, /\bfrustum\b/i, /\bshader\b/i, /\bpolycount\b/i, /\btris\b/,
  // the Recipe (Setup) words
  /[Ff]ace (limit|count)/, /\b[Qq]uads?\b/, /[Ss]mart low poly/, /\b[Ss]eeds?\b/, /\bGLB\b/, /\b[Aa]utofix\b/, /\b[Mm]esh\b/, /[Dd]ecimation/,
  /\b[Pp]olygons?\b/, /\bmultiview\b/i,
];
const UI_FILES = [
  ...readdirSync(path.join(ROOT, 'public/views')).map((f) => `public/views/${f}`),
  'public/app.js', 'public/index.html',
  ...['stage', 'shortcuts', 'look', 'render-types', 'render-ideas', 'tennogen-ui', 'notices', 'render-status', 'templates', 'engines', 'pricing', 'plain-errors', 'sheets', 'checklist', 'import-flow', 'health', 'testrig', 'render-effects', 'environments', 'importer', 'tennogen', 'identify', 'pipeline', 'version', 'palette', 'drawing-tips', 'photo-set'].map((f) => `public/lib/${f}.js`),
];
// Every string literal in a JS file (a template's ${…} becomes •, and strings inside it are read too).
function literals(src) {
  const out = [];
  let i = 0;
  const str = (q) => { // i is just past the opening quote
    let s = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
      if (q === '`' && src[i] === '$' && src[i + 1] === '{') { i += 2; code('}'); s += ' • '; continue; }
      s += src[i++];
    }
    i++;
    return s;
  };
  const code = (end) => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === end && depth === 0) { i++; return; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === '/' && /[(,=:[!&|?{};]\s*$/.test(src.slice(Math.max(0, i - 20), i))) { // a regex literal
        i++; let cls = false;
        while (i < src.length && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; i++; }
        i++; continue;
      }
      if (c === '"' || c === "'" || c === '`') { i++; out.push(str(c)); continue; }
      i++;
    }
  };
  code(null);
  return out;
}
function uiStrings(src, html = false) {
  const out = [];
  for (const s of html ? [src.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')] : literals(src)) {
    if (!/[<>]|="/.test(s)) { if (/ |^[A-Z]/.test(s)) out.push(s); continue; } // words (a lone lowercase word is a code key)
    for (const [, t] of `>${s}<`.matchAll(/>([^<>]*)</g)) out.push(t.replace(/^[^<>]*?"\s*\/?$/, '')); // text between tags
    for (const [, t] of s.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]+)"/g)) out.push(t);
  }
  return out.map((s) => s.trim()).filter((s) => /[a-z]/i.test(s));
}

test('plain words: no jargon in the words on any screen', () => {
  const found = [];
  for (const f of UI_FILES) for (const s of uiStrings(read(f), f.endsWith('.html'))) for (const re of JARGON) if (re.test(s)) found.push(`${f}: ${re} in "${s.slice(0, 90)}"`);
  if (process.env.JARGON) console.log([...new Set(found)].join('\n'));
  assert.deepEqual([...new Set(found)], []);
});

// Every bit of markup in the screens: each string literal of the JS files (a template's ${…} is •), and index.html.
const markup = () => UI_FILES.flatMap((f) => (f.endsWith('.html') ? [[f, read(f).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')]]
  : literals(read(f)).filter((s) => /<(button|a|select|input|textarea|label)\b/.test(s)).map((s) => [f, s])));
// Hidden help and screen-reader-only text don't count.
const words = (s) => s.replace(/<(\w+)[^>]*class="[^"]*\b(help|sr-only)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/•/g, ' ').replace(/&[a-z]+;/g, ' ').split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
export const MAX_BUTTON_WORDS = 6;

test(`short labels: no button says more than ${MAX_BUTTON_WORDS} words`, () => {
  const long = [];
  for (const [f, s] of markup()) {
    for (const [, inner] of s.matchAll(/<(?:button|a)\b[^>]*>([\s\S]*?)<\/(?:button|a)>/g)) {
      if (words(inner).length > MAX_BUTTON_WORDS) long.push(`${f}: "${words(inner).join(' ')}"`);
    }
  }
  if (process.env.JARGON) console.log(long.join('\n'));
  assert.deepEqual([...new Set(long)], []);
});

test('tooltips: every button, link button, menu, box and switch has a hover tip', () => {
  const bare = [];
  for (const [f, s] of markup()) {
    for (const m of s.matchAll(/<(button|select|textarea|input|a)\b([^>]*)>/g)) {
      const [tag, name, attrs] = m;
      if (name === 'a' && !/class="[^"]*\bbtn\b/.test(attrs)) continue; // plain text links read as what they do
      if (name === 'input' && /type="(hidden|file)"|\bhidden\b/.test(attrs)) continue; // never seen
      if (/\b(title|data-tip|aria-label)=/.test(attrs)) continue;
      const before = s.slice(0, m.index);
      const label = before.lastIndexOf('<label'), closed = before.lastIndexOf('</label>');
      if (label > closed && /^<label\b[^>]*\btitle=/.test(before.slice(label))) continue; // its label has the tip
      bare.push(`${f}: ${tag.slice(0, 110)}`);
    }
  }
  if (process.env.JARGON) console.log(bare.length, '\n' + bare.join('\n'));
  assert.deepEqual([...new Set(bare)], []);
});
