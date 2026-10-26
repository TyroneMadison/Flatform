// The drawing tips card on the Drop screen (public/lib/drawing-tips.js): tips, Download template, Template detected
// from the drawing kit's check, and closed remembered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../public/lib/drawing-tips.js';
import { precheck } from '../public/lib/drawing-kit.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('the tips: front a must, 4 views, plain background, clean lines, arms out, one character, use the template', () => {
  const all = T.TIPS.map((t) => t.text).join(' | ');
  for (const want of [/front view is a must/i, /4 views: front, back, left and right/, /[Pp]lain .*background/, /[Dd]ark, clean lines/, /[Aa]rms out a little/, /One character per sheet/]) assert.match(all, want);
  const html = T.tipsCard();
  assert.match(html, /Best results: use our template/);
  assert.match(html, /href="\/template\/Flatform-Drawing-Template\.pdf" download="Flatform-Drawing-Template\.pdf" title="[^"]+">Download template</);
  assert.equal(T.TEMPLATE_URL, '/template/Flatform-Drawing-Template.pdf');
  assert.doesNotMatch(html, /Template detected/);
});

test('closed is remembered; a broken store never throws', () => {
  const s = memory();
  assert.equal(T.isClosed(s), false);
  assert.match(T.tipsCard({ closed: T.isClosed(s) }), /<details class="dtips glass" id="dtips" open>/);
  T.remember(s, true);
  assert.equal(T.isClosed(s), true);
  assert.match(T.tipsCard({ closed: true }), /<details class="dtips glass" id="dtips">/);
  T.remember(s, false);
  assert.equal(T.isClosed(s), false);
  const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); }, removeItem() { throw new Error('no'); } };
  assert.equal(T.isClosed(bad), false);
  T.remember(bad, true);
  assert.equal(T.isClosed(undefined), false);
});

test('Template detected: green check, sheet id and the views found, from the kit check', () => {
  const check = (present = true) => ({ present, inBox: true, plainBg: true, armpitGaps: true, armsOut: true, legGap: true });
  const scan = (page, c) => ({ name: page, qr: { page, sheet: 'K7Q2M', guide: true }, content: { check: c } });
  const found = T.foundOf(precheck([scan('front', check()), scan('back', check()), scan('left', check(false))]));
  assert.deepEqual(found, { sheet: 'K7Q2M', views: ['front', 'back'] });
  const html = T.tipsCard({ found, esc: (s) => String(s).replace(/</g, '&lt;') });
  assert.match(html, /class="dt-ok"[^>]*>✓</);
  assert.match(html, /<b>Template detected<\/b><span>Sheet <span class="mono">K7Q2M<\/span> · Front and Back found</);
  assert.match(html, /data-act="kit" title="[^"]+">See check</);
  assert.equal(T.foundOf(precheck([])), null, 'no sheet read: no detected state');
  assert.equal(T.foundOf(null), null);
  assert.equal(T.viewsText(['front']), 'Front found');
  assert.equal(T.viewsText(['front', 'back', 'left', 'right']), 'Front, Back, Left side and Right side found');
  assert.match(T.viewsText([]), /FRONT page/);
  assert.match(T.tipsCard({ found: { sheet: '<b>', views: [] }, esc: (s) => String(s).replace(/</g, '&lt;') }), /&lt;b>/, 'the sheet id is escaped');
});

test('the wiring: Drop shows it in Warframe mode, the kit sets and clears the found state, 44px, tips, no em dashes', () => {
  const drop = read('public/views/drop.js'), kit = read('public/views/drawing.js'), css = read('public/styles/screens.css');
  assert.match(drop, /\$\{wf \? '<div id="tipsSlot"><\/div>' : ''\}/);
  assert.match(drop, /remember\(localStorage, !e\.target\.open\)/);
  assert.match(drop, /tipsCard\(\{ found: state\.drawingFound, closed: isClosed\(localStorage\), esc \}\)/);
  assert.match(kit, /state\.drawingFound = foundOf\(K\.precheck\(scans\)\)/);
  assert.match(kit, /forget\(\);/);
  for (const sel of ['.dtips summary', '.dt-open', '.dt-dl .btn']) assert.match(css, new RegExp(`${sel.replace(/\./g, '\.')} \{[^}]*min-height: 44px`), sel);
  const html = T.tipsCard({ found: { sheet: 'A1', views: ['front'] } });
  for (const tag of html.match(/<(button|a|summary)\b[^>]*>/g)) assert.match(tag, /title="/, tag);
  for (const f of ['public/lib/drawing-tips.js', 'public/views/drop.js', 'public/views/drawing.js', 'test/drawing-tips.test.mjs']) {
    assert.doesNotMatch(read(f), new RegExp(String.fromCharCode(0x2014)), `${f}: no em dashes`);
  }
});
