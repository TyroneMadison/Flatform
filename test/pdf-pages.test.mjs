// Template PDFs in the drawing kit (public/lib/pdf-pages.js): each page of the PDF is rendered with pdf.js and read
// like a photo, so a filled-in or scanned template PDF finds its pages, groups by sheet id and drives the same
// humanoid multi-view job as photos. The bundled template and the photo fixtures share sheet id NVSASH.
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
import { isPdf, pdfPages } from '../public/lib/pdf-pages.js';

const require = createRequire(import.meta.url);
const { AR } = require('js-aruco2');
require('js-aruco2/src/dictionaries/aruco_4x4_1000.js');
const jsQR = require('jsqr');
const { createCanvas } = require('@napi-rs/canvas');
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); // the page loads build/pdf.mjs; legacy is the Node build
const libs = { AR, jsQR };
const layout = JSON.parse(readFileSync(new URL('../assets/template/layout.json', import.meta.url)));
const PDF = new URL('../assets/template/Flatform-Drawing-Template.pdf', import.meta.url);
const canvas = (w, h) => createCanvas(w, h);
const scanOf = (name, img) => { const r = K.readPage(img, layout, libs); return r.error ? { name, error: r.error } : { name, qr: r.qr, content: K.readContent(r.page, r.qr, layout) }; };
const photo = (name) => {
  const png = decode(readFileSync(new URL(`fixtures/template/${name}.png`, import.meta.url)));
  const data = new Uint8ClampedArray(png.width * png.height * 4);
  for (let i = 0; i < png.width * png.height; i++) { for (let k = 0; k < 3; k++) data[i * 4 + k] = png.data[i * png.channels + k]; data[i * 4 + 3] = 255; }
  return { width: png.width, height: png.height, data };
};
const cache = {};
async function readPdf(file = PDF) {
  if (!cache[file]) {
    cache[file] = [];
    for await (const { n, total, image } of pdfPages(new Uint8Array(readFileSync(file)), pdfjs, canvas)) {
      assert.equal(total, 7);
      assert.deepEqual([image.width, image.height], [1700, 2200], 'US Letter at 200 dpi');
      cache[file].push(scanOf(`page ${n}`, image));
    }
  }
  return cache[file];
}

test('isPdf: by type or by name', () => {
  assert.ok(isPdf({ type: 'application/pdf', name: 'x' }));
  assert.ok(isPdf({ type: '', name: 'My Drawing.PDF' }));
  assert.ok(!isPdf({ type: 'image/png', name: 'front.png' }));
  assert.ok(!isPdf({ type: '', name: 'pdf.png' }));
});

test('PDF page detect: all 7 template pages are found, read and in order', async () => {
  const scans = await readPdf();
  assert.equal(scans.length, 7);
  assert.deepEqual(scans.map((s) => s.error), new Array(7).fill(undefined));
  assert.deepEqual(scans.map((s) => s.qr.page), K.PAGES);
  assert.ok(scans.every((s) => s.qr.sheet === 'NVSASH' && s.qr.guide));
  for (const s of scans.filter((x) => K.VIEW_PAGES.includes(x.qr.page))) assert.equal(s.content.check.present, false, `${s.qr.page} box is blank`);
});

test('PDF parse grouping: one sheet with every page; a blank FRONT blocks Generate', async () => {
  const scans = await readPdf();
  const groups = K.groupBySheet(scans);
  assert.deepEqual(Object.keys(groups), ['NVSASH']);
  assert.deepEqual(Object.keys(groups.NVSASH.pages).sort(), [...K.PAGES].sort());
  assert.deepEqual(groups.NVSASH.dupes, []);
  const r = K.precheck(scans);
  assert.equal(r.sheet, 'NVSASH');
  assert.deepEqual(r.views, []);
  assert.match(r.blocker, /FRONT box looks empty/);
});

test('PDF pages and photos of the same sheet group together; the later read of a page wins', async () => {
  const scans = [...(await readPdf()), scanOf('front photo', photo('front')), scanOf('back photo', photo('back'))];
  const r = K.precheck(scans);
  assert.equal(r.sheet, 'NVSASH');
  assert.equal(r.blocker, null);
  assert.deepEqual(r.views, ['front', 'back']);
  assert.equal(r.pages.front.name, 'front photo');
  assert.ok(r.warnings.includes('Two photos of the Front page. We used the last one.'));
  assert.ok(r.warnings.some((w) => /Left side box looks empty/.test(w)));
});

test('a filled-in PDF (drawn into the page, and as tablet ink annotations) is ready for one multi-view job', async () => {
  // test-app/make-template-pdf-fixture.py: FRONT drawn into the page, BACK as ink annotations, legend and color map filled.
  const r = K.precheck(await readPdf(new URL('fixtures/template/filled.pdf', import.meta.url)));
  assert.equal(r.blocker, null);
  assert.deepEqual(r.views, ['front', 'back']);
  for (const v of r.views) assert.deepEqual(r.pages[v].content.check, { present: true, inBox: true, plainBg: true, armsOut: true, armpitGaps: true, legGap: true }, v);
  assert.deepEqual(r.colors, { primary: '#3d4f7a', secondary: '#d9b35c', tertiary: '#2c2c34', accents: '#c0392b' });
  assert.ok(r.map && r.map.front.includes('1') && r.map.back.includes('5'), 'color map: body Primary on the front, Energy on the back');
  assert.deepEqual(r.warnings, ['The Left side box looks empty, so we skip it.', 'The Right side box looks empty, so we skip it.']);
});

test('a file that is not a PDF is refused', async () => {
  await assert.rejects(async () => { for await (const _ of pdfPages(new TextEncoder().encode('not a pdf'), pdfjs, canvas)) { /* none */ } });
});

test('server serves pdf.js and its worker as modules', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-pdf-'));
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  try {
    for (const p of ['/vendor/pdfjs-dist/src/pdf.mjs', '/vendor/pdfjs-dist/src/pdf.worker.mjs']) {
      const r = await fetch(`http://127.0.0.1:${app.port}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /javascript/);
      assert.ok((await r.arrayBuffer()).byteLength > 1000);
    }
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/vendor/pdfjs-dist/src/../package.json`)).status, 404);
  } finally { await app.close(); await rm(data, { recursive: true, force: true }); }
});

test('wiring: dropped or picked PDFs open the drawing kit in Warframe mode', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const app = read('public/app.js');
  assert.match(app, /if \(list\.some\(isPdf\)\) \{\s*setMode\('warframe'\);\s*import\('\.\/views\/drawing\.js'\)\.then\(\(kit\) => kit\.openDrawing\(kit\.pickedFiles\(/);
  assert.match(read('public/index.html'), /id="filePicker"[^>]*accept="[^"]*application\/pdf/);
  const ui = read('public/views/drawing.js');
  assert.match(ui, /id="drawPick" accept="[^"]*application\/pdf/);
  assert.match(ui, /pdfPages\(new Uint8Array\(await p\.file\.arrayBuffer\(\)\), await loadPdf\(\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['pdfjs-dist']);
  assert.ok(pkg.build.files.includes('!node_modules/@napi-rs/**'), 'the Node canvas is for tests only');
  for (const f of ['public/lib/pdf-pages.js', 'test/pdf-pages.test.mjs']) assert.doesNotMatch(read(f), new RegExp(String.fromCharCode(0x2014)), `${f}: no em dashes`);
});
