// The drawing kit (public/lib/drawing-kit.js): template photos read back into views, legend colors and part roles.
// Fixtures: test/fixtures/template/*.png, pages of the bundled PDF with a character drawn on and tilted like a phone
// photo (test-app/make-template-fixtures.py). The back view's arms touch the body on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { decode } from '../png.mjs';
import * as K from '../public/lib/drawing-kit.js';

const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
require('js-aruco2/src/dictionaries/aruco_4x4_1000.js');
const jsQR = require('jsqr');
const libs = { AR, jsQR };
const layout = JSON.parse(readFileSync(new URL('../assets/template/layout.json', import.meta.url)));
const photo = (name) => {
  const png = decode(readFileSync(new URL(`fixtures/template/${name}.png`, import.meta.url)));
  const data = new Uint8ClampedArray(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) { for (let k = 0; k < 3; k++) data[i * 4 + k] = png.data[i * png.channels + k]; data[i * 4 + 3] = 255; }
  return { width: png.width, height: png.height, data };
};
const solid = (w, h, rgb) => { const data = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4); return { width: w, height: h, data }; };
const read = {};
const scan = (name) => (read[name] ||= (() => { const r = K.readPage(photo(name), layout, libs); return r.error ? r : { ...r, content: K.readContent(r.page, r.qr, layout) }; })());

test('QR payload: ours is read, anything else is not', () => {
  assert.deepEqual(K.parseQr('{"t":"ft","v":1,"p":"front","s":"nvsash"}'), { page: 'front', sheet: 'NVSASH', guide: true });
  assert.deepEqual(K.parseQr('{"t":"ft","v":1,"p":"cover","s":"AB12","g":0}'), { page: 'cover', sheet: 'AB12', guide: false });
  for (const bad of ['', 'hello', '{"t":"ft","v":2,"p":"front","s":"A"}', '{"t":"ft","v":1,"p":"top","s":"A"}', '{"t":"ft","v":1,"p":"front","s":"../x"}', '{"t":"xx","v":1,"p":"front","s":"A"}', 'null']) {
    assert.equal(K.parseQr(bad), null, bad);
  }
});

test('layout: boxes come from layout.json by page, markers give the page corners', () => {
  assert.deepEqual(K.pageLayout(layout, 'front').regions.front, [33, 46, 150, 200]);
  assert.deepEqual(Object.keys(K.pageLayout(layout, 'detail').regions), ['helmet', 'hands', 'chest', 'feet']);
  assert.equal(K.pageLayout(layout, 'colormap').regions.keys.Energy[0], 177.5);
  assert.throws(() => K.pageLayout(layout, 'nope'), /no nope page/);
  const t = K.markerTargets(layout);
  assert.deepEqual(t[0], [8, 8]);
  assert.ok(Math.abs(t[2][0] - 207.9) < 1e-9 && Math.abs(t[2][1] - 271.4) < 1e-9);
});

test('homography maps the 4 points and what is between them', () => {
  const from = [[0, 0], [10, 0], [10, 20], [0, 20]], to = [[5, 7], [105, 12], [98, 215], [2, 205]];
  const h = K.homography(from, to);
  for (let i = 0; i < 4; i++) { const [x, y] = K.project(h, ...from[i]); assert.ok(Math.hypot(x - to[i][0], y - to[i][1]) < 1e-6); }
  assert.throws(() => K.homography([[0, 0], [1, 1], [2, 2], [3, 3]], to), /in a line/);
});

test('outer corners: the corner farthest from the middle, a missing marker is named', () => {
  const sq = (id, x, y) => ({ id, corners: [{ x, y }, { x: x + 10, y }, { x: x + 10, y: y + 10 }, { x, y: y + 10 }] });
  const r = K.outerCorners([sq(2, 190, 290), sq(0, 0, 0), sq(1, 190, 0), sq(3, 0, 290), sq(7, 50, 50)]);
  assert.deepEqual(r.corners, [[0, 0], [200, 0], [200, 300], [0, 300]]);
  assert.deepEqual(K.outerCorners([sq(0, 0, 0), sq(2, 190, 290)]).missing, [1, 3]);
});

test('guide removal: the sky blue guide and the paper go white, drawing stays', () => {
  const px = (rgb, opts) => [...K.removeGuide(solid(1, 1, rgb), opts).data.slice(0, 3)];
  assert.deepEqual(px([164, 221, 237]), [255, 255, 255]); // the guide line
  assert.deepEqual(px([225, 238, 242]), [255, 255, 255]); // the guide's pale fill
  assert.deepEqual(px([236, 233, 226]), [255, 255, 255]); // warm paper
  assert.deepEqual(px([61, 79, 122]), [61, 79, 122]); // dark blue armor
  assert.deepEqual(px([24, 240, 255]), [24, 240, 255]); // a bright cyan glow is not the guide
  assert.deepEqual(px([164, 221, 237], { guide: false }), [164, 221, 237]); // blank template: no guide to strip
});

test('Lab classification: key colors, pale and far colors are none, a 5 x 5 median', () => {
  const keys = layout.keys;
  const one = (rgb) => K.classifyKeys(solid(5, 5, rgb), keys)[12];
  assert.equal(one([230, 20, 25]), 0); // red marker: Primary
  assert.equal(one([20, 200, 40]), 1); // Secondary
  assert.equal(one([20, 30, 210]), 2); // Tertiary
  assert.equal(one([240, 230, 30]), 3); // Accent
  assert.equal(one([10, 230, 230]), 4); // Glow
  assert.equal(one([220, 0, 210]), 5); // Energy
  assert.equal(one([255, 255, 255]), 255); // white: none
  assert.equal(one([120, 120, 120]), 255); // pencil gray: none
  // A lone off pixel takes its neighbours' label.
  const img = solid(7, 7, [230, 20, 25]);
  img.data.set([20, 30, 210], (3 * 7 + 3) * 4);
  assert.equal(K.classifyKeys(img, keys)[3 * 7 + 3], 0);
  assert.equal(K.coarseMap(Uint8Array.from([0, 0, 255, 255, 0, 0, 255, 255]), 4, 2, 2), '0.');
});

test('grouping: photos by sheet id, slotted by page, a later photo of a page wins', () => {
  const s = (sheet, page, name) => ({ name, qr: { sheet, page, guide: true } });
  const g = K.groupBySheet([s('AAA', 'front', 'a1'), s('BBB', 'front', 'b1'), s('AAA', 'back', 'a2'), s('AAA', 'front', 'a3'), { name: 'x', error: 'qr' }]);
  assert.deepEqual(Object.keys(g), ['AAA', 'BBB']);
  assert.equal(g.AAA.pages.front.name, 'a3');
  assert.deepEqual(g.AAA.dupes, ['front']);
  assert.deepEqual(Object.keys(g.AAA.pages), ['front', 'back']);
});

test('pre-check rules: front required, other sheets left out, drawing problems in plain words', () => {
  const good = { present: true, inBox: true, plainBg: true, armsOut: true, armpitGaps: true, legGap: true };
  const v = (sheet, page, check, name = page) => ({ name, qr: { sheet, page }, content: { view: page, check } });
  assert.match(K.precheck([]).blocker, /Add photos/);
  assert.match(K.precheck([{ name: 'cat.jpg', error: 'markers' }]).blocker, /None of these photos/);
  const noFront = K.precheck([v('AAA', 'back', good)]);
  assert.match(noFront.blocker, /FRONT page \(page 2\)/);
  const r = K.precheck([
    v('AAA', 'front', good), v('AAA', 'back', { ...good, armsOut: false, armpitGaps: false }), v('AAA', 'left', { present: true, inBox: false, plainBg: false }),
    v('AAA', 'right', { present: false }), v('ZZZ', 'front', good, 'other.jpg'), { name: 'blurry.jpg', error: 'qr' },
    { name: 'c', qr: { sheet: 'AAA', page: 'cover' }, content: { colors: { primary: '#3d4f7a' } } },
  ]);
  assert.equal(r.blocker, null);
  assert.equal(r.sheet, 'AAA');
  assert.deepEqual(r.views, ['front', 'back', 'left']);
  assert.deepEqual(r.colors, { primary: '#3d4f7a' });
  const all = r.warnings.join('\n');
  for (const want of [/blurry\.jpg: we could not read the square code/, /1 photo is from another sheet \(ZZZ\)/, /Back: the arms touch the body/,
    /Left side: the drawing goes outside the box/, /Left side: there are marks near the edge/, /Right side box looks empty/]) assert.match(all, want);
  assert.doesNotMatch(all, /hold the arms further out/); // touching says it already
  assert.ok(!all.includes(String.fromCharCode(0x2014))); // no em dashes
  assert.match(K.precheck([v('AAA', 'front', { present: false })]).blocker, /FRONT box looks empty/);
});

test('photos: markers found, QR read, page straightened; front passes, back arms touch', () => {
  const f = scan('front');
  assert.deepEqual(f.qr, { page: 'front', sheet: 'NVSASH', guide: true });
  assert.equal(f.page.width, Math.round(215.9 * K.S));
  assert.deepEqual(f.content.check, { present: true, inBox: true, plainBg: true, armsOut: true, armpitGaps: true, legGap: true });
  // The cleaned box: white corners (no guide, no paper tint), the drawing kept.
  const img = f.content.image, at = (x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.deepEqual(at(10, 10), [255, 255, 255]);
  assert.deepEqual(at(img.width - 10, img.height - 10), [255, 255, 255]);
  const b = scan('back');
  assert.equal(b.qr.page, 'back');
  assert.equal(b.content.check.armpitGaps, false);
  assert.equal(b.content.check.legGap, true);
  // A photo with no page in it.
  assert.equal(K.readPage(solid(400, 500, [90, 80, 70]), layout, libs).error, 'markers');
});

test('cover legend: filled swatches read as colors, empty ones are not set', () => {
  const c = scan('cover');
  assert.equal(c.qr.page, 'cover');
  const { colors } = c.content;
  assert.deepEqual(Object.keys(colors), ['primary', 'secondary', 'tertiary', 'accents']); // Glow and Energy left empty
  const near = (hex, want) => K.hexRgb(hex).every((v, i) => Math.abs(v - K.hexRgb(want)[i]) < 30);
  assert.ok(near(colors.primary, '#3d4f7a'), colors.primary);
  assert.ok(near(colors.secondary, '#d9b35c'), colors.secondary);
});

test('color map page: regions classified, then projected onto model parts as roles', () => {
  const m = scan('colormap').content.map;
  assert.deepEqual(m.roles, ['primary', 'secondary', 'tertiary', 'accents', 'emissive', 'energy']);
  assert.equal(m.front.split('\n').length, m.rows);
  // A model standing like the guide: 1.8 tall, feet at 0, facing +z. Head, body, arms, legs as boxes.
  const box = { min: [-0.6, 0, -0.15], max: [0.6, 1.8, 0.15] };
  const part = (key, min, max, z = 0) => ({ key, min, max, c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, z] });
  const parts = [
    part('head', [-0.1, 1.55, -0.1], [0.1, 1.8, 0.1]),
    part('chest', [-0.13, 0.95, 0.0], [0.13, 1.45, 0.15], 0.12),
    part('back', [-0.13, 0.95, -0.15], [0.13, 1.45, 0], -0.12),
    part('armL', [0.2, 1.0, -0.05], [0.5, 1.35, 0.05]),
    part('legR', [-0.17, 0.1, -0.06], [-0.05, 0.85, 0.06]),
  ];
  const roles = K.rolesFromColorMap(parts, box, m);
  assert.deepEqual(roles, { head: 'accents', chest: 'primary', back: 'energy', armL: 'tertiary', legR: 'secondary' });
});

test('server: the template PDF downloads, layout and the two readers are served', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-kit-'));
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  try {
    const get = (p) => fetch(`http://127.0.0.1:${app.port}${p}`);
    const pdf = await get('/template/Flatform-Drawing-Template.pdf');
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /attachment; filename="Flatform-Drawing-Template\.pdf"/);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual((await (await get('/template/layout.json')).json()).keys, layout.keys);
    for (const p of ['/vendor/js-aruco2/src/cv.js', '/vendor/js-aruco2/src/aruco.js', '/vendor/js-aruco2/src/dictionaries/aruco_4x4_1000.js', '/vendor/jsqr/src/jsQR.js']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /javascript/);
    }
    assert.equal((await get('/template/../package.json')).status, 404);
    assert.equal((await get('/template/other.pdf')).status, 404);
  } finally { await app.close(); await rm(data, { recursive: true, force: true }); }
});

test('the card and its wiring: tips, 44px, plain words, packaged files', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const ui = read('public/views/drawing.js');
  for (const tag of ui.match(/<(button|a|input)\b[^>]*>/g)) if (!/hidden>?$/.test(tag) && !/type="file"/.test(tag)) assert.match(tag, /title="/, `a tip: ${tag.slice(0, 70)}`);
  assert.match(ui, /data-dk="make"[^>]*>Make my 3D model</);
  assert.match(ui, /data-dk="pick"[^>]*>Fix photos</);
  assert.match(ui, /download="Flatform-Drawing-Template\.pdf"[^>]*>\$\{icon\('download', 16\)\}<span>Download template</);
  assert.match(ui, /setup\.mode === 'views' \? files : \{ front: files\.front \}/, 'one job: the front plus the other views');
  const css = read('public/styles/screens.css');
  assert.match(css, /\.drawdlg \.btn \{ min-height: 44px; \}/);
  assert.match(read('public/views/drop.js'), /data-act="kit" title="[^"]+">Drawing kit</);
  assert.match(read('public/app.js'), /kit\.hasDrawingPage\(photos\)\) \? kit\.openDrawing\(photos\) : placePhotos\(photos\)/);
  assert.match(read('public/app.js'), /PATCH', \{ scene: \{ \.\.\.m\.scene, drawing: item\.drawing \} \}/);
  assert.match(read('public/views/compose-roles.js'), /rolesFromColorMap\(parts, box, drawing\.map\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('assets/template/*'));
  assert.ok(pkg.dependencies['js-aruco2'] && pkg.dependencies.jsqr);
  for (const f of ['public/views/drawing.js', 'public/lib/drawing-kit.js', 'test/drawing-kit.test.mjs', 'test-app/make-template-fixtures.py']) {
    assert.doesNotMatch(read(f), new RegExp(String.fromCharCode(0x2014)), `${f}: no em dashes`);
  }
});
