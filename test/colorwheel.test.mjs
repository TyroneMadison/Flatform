// Free look and Reset view in the viewport toolbar, and the Color panel's colour wheel: a picked colour really
// tints the piece (or the whole model), live while dragging with one undo step per drag, saved with the scene and
// handed to Blender.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { toggleView, FREE_TIP, VIEWS } from '../public/lib/studio.js';
import { SHORTCUTS, byId, clashes, shortcutFor } from '../public/lib/shortcuts.js';
import { ColorPicker, rgbToHsv, hsvToRgb, hsvFromHex, wheelPick, wheelZone } from '../public/lib/color-picker.js';
import { pickColor, defaultPaint, setColor, rgbHex, hexRgb } from '../public/lib/tenno.js';
import { keyRoute } from '../public/lib/testrig-ui.js';
import { applyPaint, previewColors, listPieces, pieceKey } from '../public/lib/paint.js';
import { createHistory } from '../public/lib/history.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const compose = read('public/views/compose.js');
const toolbar = compose.slice(compose.indexOf('<div class="vtool"'), compose.indexOf('<aside class="tcard'));

// ---- Free look and Reset view ----
test('Free look flips scene.view between car and free, and stays in sync however the view changes', () => {
  assert.equal(toggleView('car'), 'free');
  assert.equal(toggleView('free'), 'car');
  assert.equal(toggleView(undefined), 'free', 'a new scene is in car view');
  assert.equal(VIEWS.free, 'Free look');
  assert.match(compose, /t\.dataset\.vt === 'free'\) await change\(\{ view: toggleView\(scene\.view\) \}\)/);
  assert.match(compose, /\[data-vt="free"\]', root\)\?\.setAttribute\('aria-pressed', String\(scene\.view === 'free'\)\)/, 'renderHud (every draw) sets the pressed state');
  assert.equal(FREE_TIP, 'Drag to spin · Scroll to zoom · Right-drag to move · F to reset');
  assert.ok(FREE_TIP.split('·').length === 4 && !FREE_TIP.includes('\n'), 'one tiny line');
});

test('toolbar: Move, Turn, Free look, Reset view, Camera and Light, all 44px with a clear 20px icon and a tip', () => {
  const buttons = toolbar.match(/<button[^>]*>/g);
  assert.equal(buttons.length, 6);
  for (const b of buttons) {
    assert.match(b, /class="vt"/);
    assert.match(b, /title="[^"]+"/, b);
    assert.match(b, /aria-label="[^"]+"/, b);
  }
  assert.equal((toolbar.match(/icon\('\w+', 20\)/g) || []).length, 6, 'one icon size');
  for (const name of ['move', 'turn', 'freeLook', 'frame', 'camera', 'light']) assert.ok(toolbar.includes(`icon('${name}', 20)`), name);
  assert.ok(toolbar.includes('data-vt="free" aria-pressed="false" title="${FREE_TIP}" data-tip-one'), 'the tip stays on one line');
  assert.match(read('public/styles/stage.css'), /\.tip\.one \{ max-width: none; white-space: nowrap; \}/);
  assert.ok(toolbar.includes('data-act="frame"') && toolbar.includes("Reset view: show the whole model (${keyOf('frame')})"));
  const icons = read('public/lib/icons.js');
  for (const name of ['turn', 'freeLook', 'frame']) assert.match(icons, new RegExp(`\\b${name}: '<`), name);
  const css = read('public/styles/screens.css');
  assert.match(css, /\.vt \{ width: 44px; height: 44px;/);
  assert.match(css, /\.vt \.ic \{ width: 20px; height: 20px; \}/);
  assert.match(css, /\.vt\[aria-pressed='true'\] \{ opacity: 1; background: var\(--accent\); color: var\(--on-accent\); \}/, 'one active look');
  assert.match(compose, /\[data-pick-tool\]', root\)\.forEach\(\(b\) => b\.setAttribute\('aria-pressed'/, 'Camera and Light show when their settings are open');
});

test('F is Reset view: in the one shortcut list, presses the toolbar button, clashes with nothing, off in Test moves', () => {
  const f = byId('frame');
  assert.equal(f.keys, 'F');
  assert.equal(f.click, '[data-act="frame"]');
  assert.match(f.label, /Reset view/);
  assert.equal(SHORTCUTS.filter((s) => s.keys === 'F' || s.also?.includes('F')).length, 1);
  assert.deepEqual(clashes(), []);
  assert.equal(shortcutFor({ key: 'f' }, 'compose')?.id, 'frame');
  assert.equal(shortcutFor({ key: 'f' }, 'library'), null, 'Compose only');
  const tr = read('public/views/compose-testrig.js');
  assert.match(tr, /window\.addEventListener\('keydown', onKey, true\)/, 'Test moves takes the keys first');
  assert.match(tr, /e\.preventDefault\(\); e\.stopPropagation\(\);/);
  assert.match(tr, /keyRoute\(e\.key/, 'the keys go through testrig-ui.js keyRoute');
  assert.equal(keyRoute('f'), 'game', 'only F1-F12 get through, not the F key');
  assert.equal(keyRoute('F5'), 'pass');
});

// ---- the colour wheel ----
test('HSV <-> hex round trip: every colour comes back exactly, greys keep their hue', () => {
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 51) {
    const hex = rgbHex(r, g, b);
    assert.equal(rgbHex(...hsvToRgb(...rgbToHsv(r, g, b))), hex);
    assert.equal(rgbHex(...hsvToRgb(...hsvFromHex(hex, [200, 0.5, 0.5]))), hex);
  }
  assert.equal(rgbHex(...hsvToRgb(...hsvFromHex('#896185'))), '#896185');
  assert.deepEqual(hsvFromHex('#808080', [210, 0.6, 0.9]).slice(0, 2), [210, 0], 'a grey keeps the hue: the ring marker does not jump');
  assert.deepEqual(hsvFromHex('#000000', [210, 0.6, 0.9]), [210, 0.6, 0], 'black keeps hue and strength');
});

test('the wheel clamps: past the square edge or out of the ring it stays on the edge, corners do nothing', () => {
  const sq = { x0: 40, y0: 40, side: 84 };
  assert.deepEqual(wheelPick('sv', -500, -500, [10, 0.5, 0.5], sq), [10, 0, 1]);
  assert.deepEqual(wheelPick('sv', 999, 999, [10, 0.5, 0.5], sq), [10, 1, 0]);
  assert.deepEqual(wheelPick('sv', 82, 82, [10, 0.5, 0.5], sq), [10, 0.5, 0.5]);
  const far = wheelPick('hue', 82 + 900, 82, [10, 0.4, 0.6], sq);
  assert.ok(Math.abs(far[0]) < 1e-9 && far[1] === 0.4 && far[2] === 0.6, 'hue only, from the angle, however far out');
  assert.equal(Math.round(wheelPick('hue', 82, 82 + 50, [0, 1, 1], sq)[0]), 90);
  assert.deepEqual(wheelPick('hue', 82, 82, [33, 1, 1], sq), [33, 1, 1], 'the exact centre keeps the hue');
  assert.equal(wheelZone(82, 2), 'hue');
  assert.equal(wheelZone(82, 82), 'sv');
  assert.equal(wheelZone(1, 1), null, 'a press in a corner outside the wheel');
});

// A just-enough DOM for one ColorPicker: elements by class, a canvas with a no-op 2D context, and rAF by hand.
function fakePicker(opts) {
  const nodes = new Map();
  const node = (cls) => {
    if (!nodes.has(cls)) {
      const on = {};
      nodes.set(cls, {
        value: '', style: { setProperty() {} }, classList: { contains: (c) => c === cls }, className: `inp mono ${cls}`, innerHTML: '', on,
        addEventListener: (t, f) => { (on[t] ||= []).push(f); },
        getContext: () => new Proxy({}, { get: (_, k) => (k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}) }),
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 164, height: 164 }),
        setPointerCapture() { this.captured = true; }, hasPointerCapture() { return this.captured; }, releasePointerCapture() { this.captured = false; },
      });
    }
    return nodes.get(cls);
  };
  const el = node('root');
  el.querySelector = (sel) => node(sel.slice(1));
  const frames = [];
  globalThis.requestAnimationFrame = (f) => frames.push(f);
  globalThis.cancelAnimationFrame = () => {};
  const picker = new ColorPicker(el, opts);
  const cv = node('cp-wheel');
  const fire = (t, e) => cv.on[t]?.forEach((f) => f({ button: 0, pointerId: 1, preventDefault() {}, type: t, ...e }));
  const flush = () => { while (frames.length) frames.shift()(); };
  return { picker, fire, flush, hex: () => node('cp-hex').value, el, node };
}

test('a wheel drag: live preview at most once a frame, exactly one pick (one undo step) when it ends', () => {
  const previews = [], picks = [];
  const hist = createHistory({ burst: 0 });
  let scene = { paint: { colors: { global: { primary: '#808080' } } } };
  const w = fakePicker({
    value: '#808080', onPreview: (h) => previews.push(h),
    onPick: (h) => { picks.push(h); hist.record(scene); scene = { paint: { colors: { global: { primary: h } } } }; },
  });
  w.fire('pointerdown', { clientX: 82, clientY: 82 });
  for (let i = 0; i < 30; i++) {
    w.fire('pointermove', { clientX: 60 + i * 3, clientY: 50 + i });
    if (i % 3 === 2) w.flush(); // ten frames for thirty moves
  }
  assert.equal(picks.length, 0, 'nothing saved while dragging');
  assert.ok(previews.length >= 2 && previews.length <= 11, `previews: ${previews.length}`);
  w.fire('pointerup', { clientX: 150, clientY: 70 });
  w.fire('lostpointercapture', {});
  assert.equal(picks.length, 1, 'one pick at the end');
  assert.equal(hist.list().length, 1, 'one undo step');
  assert.equal(picks[0], w.hex(), 'the hex field shows the picked colour');
  assert.equal(picks[0], w.picker.hex);
  assert.equal(w.node('cp-wheel').captured, false, 'pointer capture released');
  w.fire('pointermove', { clientX: 10, clientY: 10 }); w.flush();
  assert.equal(picks.length, 1, 'moves after the drag do nothing');
});

test('the hex field, RGB fields and swatches drive the wheel, and the wheel drives them back', () => {
  const picks = [];
  const w = fakePicker({ value: '#808080', onPick: (h) => picks.push(h) });
  const hexIn = w.node('cp-hex');
  hexIn.value = '#896185';
  w.el.on.input.forEach((f) => f({ target: hexIn }));
  assert.equal(w.picker.hex, '#896185');
  assert.deepEqual(picks, ['#896185']);
  assert.equal(w.node('cp-r').value, 137); assert.equal(w.node('cp-g').value, 97); assert.equal(w.node('cp-b').value, 133);
  hexIn.value = '#89'; w.el.on.input.forEach((f) => f({ target: hexIn }));
  assert.equal(picks.length, 1, 'half a code waits');
  w.el.on.change.forEach((f) => f({ target: hexIn }));
  assert.equal(hexIn.value, '#896185', 'a bad code goes back to the current colour');
  w.node('cp-r').value = 255; w.el.on.change.forEach((f) => f({ target: w.node('cp-r') }));
  assert.equal(w.picker.hex, '#ff6185');
  w.el.on.click.forEach((f) => f({ target: { closest: () => ({ dataset: { hex: '#123456' }, classList: { contains: () => false } }) } }));
  assert.equal(w.picker.hex, '#123456');
  assert.equal(hexIn.value, '#123456');
  w.fire('pointerdown', { clientX: 82, clientY: 160 }); // bottom of the ring: hue 90
  w.fire('pointerup', { clientX: 82, clientY: 160 });
  assert.equal(Math.round(w.picker.hsv[0]), 90);
  assert.equal(hexIn.value, w.picker.hex, 'the wheel writes the field back');
  assert.equal(picks.at(-1), w.picker.hex);
});

// ---- the colour really reaches the mesh ----
const accentsModel = () => {
  const g = new THREE.Group();
  for (const [name, color] of [['Body', '#ffffff'], ['Accents', '#ffffff']]) {
    const geo = new THREE.BoxGeometry();
    geo.clearGroups(); // one piece per mesh, as a GLB part
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, name }));
    m.name = name;
    m.userData.material = m.material;
    g.add(m);
  }
  return g;
};
const hexOf = (mesh) => `#${[].concat(mesh.material)[0].color.getHexString()}`;

test('root cause: a colour saved without a slot never reached the mesh; pickColor puts the piece on the slot', () => {
  const model = accentsModel();
  const accents = model.children[1], key = pieceKey(1, 'Accents');
  assert.ok(listPieces(model).some((p) => p.key === key));
  // Before: the Color panel stored Accents = #896185 on the piece but the piece had no slot, so it stayed white.
  const old = setColor({ ...defaultPaint(), pieces: { [key]: { key, name: 'Accents', slot: null } } }, key, 'accents', '#896185');
  applyPaint(model, old, new Map());
  assert.equal(hexOf(accents), '#ffffff');
  // Now: the piece wears the Accents slot and shows the colour; the other piece is untouched.
  const paint = pickColor(defaultPaint(), { level: key, key: 'accents', hex: '#896185', targets: [key], names: { [key]: 'Accents' } });
  assert.equal(paint.pieces[key].slot, 'accents');
  assert.equal(paint.pieces[key].colors.accents, '#896185');
  applyPaint(model, paint, new Map());
  assert.equal(hexOf(accents), '#896185');
  assert.ok(accents.material.isMeshPhysicalMaterial && accents.material !== accents.userData.material, 'its own material, the shared original untouched');
  assert.equal(accents.userData.material.color.getHexString(), 'ffffff');
  assert.equal(hexOf(model.children[0]), '#ffffff', 'the body keeps its own material');
});

test('nothing selected: the colour tints the whole model; slots set by hand stay; a texture is tinted, not replaced', () => {
  const model = accentsModel();
  const tex = new THREE.Texture();
  model.children[0].material.map = tex;
  const keys = listPieces(model).map((p) => p.key);
  let paint = pickColor(defaultPaint(), { level: 'global', key: 'accents', hex: '#896185', targets: keys });
  applyPaint(model, paint, new Map());
  for (const m of model.children) assert.equal(hexOf(m), '#896185');
  assert.equal(model.children[0].material.map, tex, 'the colour multiplies the texture');
  paint = pickColor(paint, { level: 'global', key: 'primary', hex: '#1e64c8', targets: keys });
  assert.ok(keys.every((k) => paint.pieces[k].slot === 'primary'), 'the last whole-model colour shows');
  paint = pickColor(paint, { level: keys[1], key: 'tertiary', hex: '#00ff00', targets: [keys[1]] });
  paint = pickColor(paint, { level: 'global', key: 'secondary', hex: '#222222', targets: keys });
  assert.equal(paint.pieces[keys[1]].slot, 'tertiary', 'a piece coloured on its own keeps its colour');
  assert.equal(paint.pieces[keys[0]].slot, 'secondary');
  const glow = pickColor(paint, { level: 'global', key: 'emissive', hex: '#ff0000', targets: keys });
  assert.ok(keys.every((k) => glow.pieces[k].slot !== 'emissive'), 'a whole-model Glow colour does not make everything glow');
});

test('live preview changes the existing materials only (no new material, no rebuild) and reports pieces still to build', () => {
  const model = accentsModel();
  const key = pieceKey(1, 'Accents');
  const cache = new Map();
  const pick = (hex) => pickColor(defaultPaint(), { level: key, key: 'accents', hex, targets: [key] });
  assert.deepEqual(previewColors(model, pick('#896185'), cache), { changed: 0, missing: 1 }, 'first colour: build it once');
  applyPaint(model, pick('#896185'), cache);
  const mat = model.children[1].material, version = mat.version;
  assert.deepEqual(previewColors(model, pick('#ff0000'), cache), { changed: 1, missing: 0 });
  assert.equal(model.children[1].material, mat, 'same material');
  assert.equal(mat.version, version, 'no shader rebuild');
  assert.equal(hexOf(model.children[1]), '#ff0000');
});

test('studio: applyGlass keeps the cached piece materials (no shader throw-away per colour change)', () => {
  const s = read('public/lib/studio.js');
  assert.match(s, /if \(!m\.userData\.made \|\| \[\.\.\.this\.pieceMats\.values\(\)\]\.includes\(m\)\) continue;/);
  assert.match(s, /previewPaint\(paint\) \{[\s\S]*?previewColors\(this\.model, paint, this\.pieceMats\)/);
  const p = read('public/views/compose-paint.js');
  assert.match(p, /onPick: applyColor, onPreview: previewColor/);
  assert.match(p, /function previewColor\(hex\) \{[\s\S]*?ctx\.studio\(\)\?\.previewPaint\(paint\);[\s\S]*?\n\}/);
  assert.doesNotMatch(p.slice(p.indexOf('function previewColor'), p.indexOf('function applyColor')), /ctx\.change/, 'no saved step while dragging');
  assert.match(p, /if \(!selected\) colorLevel = 'global';/, 'nothing selected: the whole model');
});

// ---- saved with the scene, and in Blender ----
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
test('the colour is saved with the scene and Blender gets it on the Accents piece', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'ff-color-'));
  const out = await mkdtemp(path.join(tmpdir(), 'ff-color-out-'));
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  const base = `http://127.0.0.1:${app.port}`;
  const j = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    await j('/api/settings', 'POST', { outputRoot: out, blenderPath: path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs') });
    const form = new FormData();
    form.append('glb', new Blob([GLB]), 'car.glb');
    form.append('name', 'Test Car');
    const m = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    const key = 'Accents#1';
    const paint = pickColor(defaultPaint(), { level: key, key: 'accents', hex: '#896185', targets: [key], names: { [key]: 'Accents' } });
    assert.equal((await j(`/api/models/${m.id}`, 'PATCH', { scene: { paint } })).status, 200);
    const saved = (await j(`/api/models/${m.id}`)).body.scene.paint;
    assert.equal(saved.pieces[key].slot, 'accents', 'saved: survives a reload and the auto-save restore');
    assert.equal(saved.pieces[key].colors.accents, '#896185');
    assert.equal((await j(`/api/renders/${m.id}/start`, 'POST', { looks: ['studio'] })).status, 200);
    assert.equal((await j(`/api/renders/${m.id}/blender`, 'POST', { looks: ['studio'], frames: 0, still: 30 })).status, 202);
    let job;
    for (let i = 0; i < 100 && (!job || job.status === 'running'); i++) { await new Promise((ok) => setTimeout(ok, 30)); job = (await j(`/api/renders/${m.id}/blender`)).body; }
    assert.equal(job.status, 'done', job.error);
    const spec = JSON.parse(await readFile(path.join(data, 'models', m.id, 'blender-materials.json'), 'utf8')).materials[key];
    assert.equal(spec.base_color, '#896185', 'the Accents colour, not Primary');
    assert.equal(spec.slot, 'accents');
    assert.equal(spec.keep_color, false);
    assert.deepEqual(hexRgb(spec.base_color), [0x89, 0x61, 0x85]);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test('Blender keeps the imported colour when nothing was picked and multiplies a tint over the texture', () => {
  const py = read('render/blender_turntable.py');
  assert.match(py, /if spec\.get\("keep_color"\) and src_bsdf is not None:/);
  assert.match(py, /mix\.blend_type = "MULTIPLY"/);
  assert.match(py, /def hex_linear\(h\):\r?\n\s+return srgb_to_linear/, 'sRGB hex to linear, as three.js does');
});

test('glb-pieces: app piece i is node + material slot in Blender (Body = Paint + Accents is two pieces, one object)', async () => {
  const { glbPieces, locatePieces } = await import('../glb-pieces.mjs');
  const gltf = {
    scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Body', mesh: 0, children: [2] }, { name: 'Cabin', mesh: 1 }, { name: 'Light' }],
    meshes: [{ name: 'Cube', primitives: [{ material: 0 }, { material: 1 }] }, { name: 'Cube.001', primitives: [{ material: 0 }] }],
    materials: [{ name: 'Paint' }, { name: 'Accents' }],
  };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length, 8); head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const pieces = glbPieces(Buffer.concat([head, json]));
  assert.deepEqual(pieces, [
    { node: 'Body', prim: 0, prims: 2, material: 'Paint' },
    { node: 'Body', prim: 1, prims: 2, material: 'Accents' },
    { node: 'Cabin', prim: 0, prims: 1, material: 'Paint' },
  ]);
  const spec = locatePieces({ 'Cube_1#1': { base_color: '#896185' }, 'Cube#0@2': { base_color: '#000000' } }, pieces);
  assert.deepEqual(spec['Cube_1#1'], { base_color: '#896185', node: 'Body', prim: 1, prims: 2, source_material: 'Accents' });
  assert.equal(spec['Cube#0@2'].node, undefined, 'face groups keep their key');
  assert.deepEqual(glbPieces(Buffer.from('not a glb at all')), []);
  const py = read('render/blender_turntable.py');
  assert.match(py, /def piece_slots\(meshes, piece\):/);
  assert.match(py, /if piece\.get\("source_material"\) in names:/, 'the slot is found by material name');
  assert.match(read('server.mjs'), /const materials = locatePieces\(specs, where\);/);
});
