// v3 gaps: the Render tool's types and Run, the four new Render ideas (their maths and their Blender arguments), the
// inspector card's Hide and Select similar, notices as toasts, the 3D model ring's time left, templates without the
// retired "modeled" switch, and the key dialog's help.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { RENDER_TYPES, COLOURS, planRun, colourVariant, bodyPieces, verticalCrop, posterLayout, explodeOffsets, cleanExtras, typeOf, defaultOption } from '../public/lib/render-types.js';
import { updateNotice, lowNotice } from '../public/lib/notices.js';
import { timeLeft } from '../public/lib/stage.js';
import { similarPieces, applyPaint, listPieces, pickPiece } from '../public/lib/paint.js';
import { templateScene, normalizeTemplate, TEMPLATE_KEYS } from '../public/lib/templates.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

test('Render types: the six from the mock-up, in order, each with a time and plain words', () => {
  assert.deepEqual(RENDER_TYPES.map((t) => t.label), ['Picture', 'Spin video', 'Camera move video', 'Painted or cartoon look', 'Every colour', 'Overnight list']);
  for (const t of RENDER_TYPES) assert.ok(t.desc.length > 15 && /about|until/.test(t.time), t.id);
  assert.deepEqual(typeOf('spin').options.map(([k]) => k), ['full', 'half', 'photos'], 'the spin set from photos is an option of Spin video');
  assert.equal(typeOf('nope').id, 'picture');
  assert.equal(defaultOption('painted'), 'painterly');
  assert.equal(defaultOption('picture'), null);
});

test('Run: each type becomes the right render tasks', () => {
  const one = (type, opt, ctx) => planRun(type, opt, ctx).tasks;
  assert.deepEqual(one('picture')[0].patch, { still: true, t360: false, t180: false });
  assert.deepEqual(one('spin', 'full')[0].patch, { still: false, t360: true, t180: true, video: 'spin' });
  assert.deepEqual(one('spin', 'half')[0].patch, { still: false, t360: false, t180: true, video: 'half' });
  assert.deepEqual(planRun('spin', 'photos'), { tasks: [], go: 'spin' });
  assert.match(planRun('move').error, /camera move/i);
  assert.equal(planRun('move').fix, 'camera');
  const move = one('move', null, { cameraMove: true })[0].patch;
  assert.deepEqual([move.t360, move.studio, move.showroom, move.video, move.renderer], [true, true, false, 'move', 'three']);
  assert.equal(one('painted', 'cel')[0].patch.style, 'cel');
  assert.equal(one('painted')[0].patch.style, 'painterly');
  assert.match(planRun('colours', null, { paint: { pieces: {} } }).error, /Infer colours from photo/);
  // A painted car: one picture per colour, the body repainted, the rest untouched, file names apart.
  const paint = { pieces: { 'Body#0': { region: { label: 'paint' }, material: { roughness: 0.3 } }, 'Tyre#1': { region: { label: 'rubber' } }, 'Door#2': { slot: 'primary' } } };
  const colours = one('colours', null, { paint });
  assert.equal(colours.length, COLOURS.length);
  assert.deepEqual(colours.map((t) => t.patch.suffix), ['red', 'black', 'white', 'blue', 'yellow', 'silver']);
  assert.deepEqual(colours[0].patch.paint.pieces['Body#0'].material, { roughness: 0.3, color: '#c81e1e' });
  assert.equal(colours[0].patch.paint.pieces['Door#2'].material.color, '#c81e1e');
  assert.equal(colours[0].patch.paint.pieces['Tyre#1'].material, undefined);
  assert.equal(paint.pieces['Body#0'].material.color, undefined, 'the scene paint is not changed');
  // Overnight: every colour as a picture and a spin video, with the server's job ids.
  const night = planRun('overnight', null, { paint });
  assert.equal(night.tasks.length, COLOURS.length * 2);
  assert.deepEqual(night.tasks.slice(0, 2).map((t) => t.job), ['red:turntable:still', 'red:turntable:mp4']);
  assert.deepEqual(night.overnight.formats, ['still', 'mp4']);
  assert.equal(planRun('overnight').tasks.length, 2, 'an unpainted model still gets a picture and a spin video');
  // A Render idea's extras ride along.
  assert.equal(one('picture', null, { extras: { poster: 'Hello' } })[0].label, 'Hero poster');
  assert.equal(one('spin', 'full', { extras: { vertical: true } })[0].patch.video, 'phone');
});

test('Render idea maths: 9:16 crop, poster title, exploded parts, checked extras', () => {
  assert.deepEqual(verticalCrop(2048, 1536), { x: 592, y: 0, width: 864, height: 1536 });
  assert.deepEqual(verticalCrop(400, 1000), { x: 0, y: 145, width: 400, height: 710 });
  const c = verticalCrop(1366, 768);
  assert.ok(Math.abs(c.width / c.height - 9 / 16) < 0.01 && c.width % 2 === 0 && c.height % 2 === 0);
  const p = posterLayout(2048, 1536, 'Ferrari 296');
  assert.equal(p.text, 'Ferrari 296');
  assert.ok(p.size > 100 && p.size <= 1536 * 0.12 && p.y < 1536 / 3 && p.maxWidth <= 2048);
  assert.equal(posterLayout(800, 600, '  \u0007 ').text, 'Untitled');
  assert.ok(posterLayout(800, 600, 'x'.repeat(200)).text.length <= 60);
  assert.deepEqual(explodeOffsets([[0, 0, 0]], 4), [[0, 0, 0]], 'one part: nothing to pull apart');
  const off = explodeOffsets([[-1, 0, 0], [1, 0, 0], [0, 0, 0]], 4, 0.25);
  assert.deepEqual(off, [[-1, 0, 0], [1, 0, 0], [0, 0, 0]], 'outward from the middle, 0.25 of the size each');
  const lifted = explodeOffsets([[0, 2, 0], [0, -2, 0], [-3, -1, 0], [3, -1, 0]], 1, 1);
  assert.ok(lifted.every((o) => o[1] >= 0), 'nothing goes down through the floor');
  assert.deepEqual(lifted[1], [0, 0, 0], 'a part right under the middle stays put');
  assert.ok(lifted[0][1] > 0.99 && lifted[2][0] < -0.99 && lifted[3][0] > 0.99);
  assert.deepEqual(cleanExtras({ effect: { explode: 5, override: 'chrome' }, poster: 'a\u0000b', vertical: 'yes', evil: 1 }), { effect: { explode: 1 }, poster: 'ab' });
  assert.deepEqual(cleanExtras({ effect: { override: 'blueprint' } }), { effect: { override: 'blueprint' } });
  assert.deepEqual(cleanExtras(), {});
});

test('colourVariant and bodyPieces', () => {
  assert.equal(colourVariant(null, '#fff'), null);
  assert.deepEqual(bodyPieces({ pieces: { a: { slot: 'primary' }, b: { slot: 'secondary' }, c: { region: { label: 'paint' } } } }), ['a', 'c']);
});

test('Inspector card: Hide hides a part (and its face group), Select similar finds the same material', () => {
  const red = new THREE.MeshStandardMaterial({ name: 'Paint' });
  const black = new THREE.MeshStandardMaterial({ name: 'Tyre' });
  const box = () => { const g = new THREE.BoxGeometry(1, 1, 1); g.clearGroups(); return g; };
  const model = new THREE.Group();
  const body = new THREE.Mesh(box(), red); body.name = 'Body';
  const door = new THREE.Mesh(box(), new THREE.MeshStandardMaterial({ name: 'Paint' })); door.name = 'Door';
  const tyre = new THREE.Mesh(box(), black); tyre.name = 'Tyre'; tyre.position.x = 3;
  const split = new THREE.Mesh(box(), [red, black]); split.name = 'Split'; split.position.x = -3; // a mesh with two face groups
  split.geometry.addGroup(0, 18, 0); split.geometry.addGroup(18, 18, 1);
  for (const o of [body, door, tyre, split]) { o.userData.material = o.material; model.add(o); }
  const pieces = listPieces(model);
  assert.deepEqual(pieces.map((p) => p.key), ['Body#0', 'Door#1', 'Tyre#2', 'Split#3@0', 'Split#3@1']);
  assert.deepEqual(similarPieces(pieces, 'Body#0').slice(0, 3), ['Body#0', 'Door#1', 'Split#3@0'], 'same material, or the same material name');
  assert.ok(!similarPieces(pieces, 'Body#0').includes('Tyre#2'));
  assert.deepEqual(similarPieces(pieces, 'nope'), []);
  const cache = new Map();
  applyPaint(model, { pieces: { 'Tyre#2': { hidden: true }, 'Split#3@1': { hidden: true } } }, cache);
  assert.equal(tyre.visible, false);
  assert.equal(body.visible, true);
  assert.equal(split.material[1].visible, false, 'a hidden face group draws nothing');
  assert.notEqual(split.material[0].visible, false);
  // A hidden part can't be clicked: the ray goes on to what is behind it.
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(10, 0, 0); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  model.updateMatrixWorld(true);
  assert.equal(pickPiece(model, cam, 0, 0), 'Body#0', 'the hidden tyre in front of the body is skipped');
  applyPaint(model, { pieces: { 'Tyre#2': { hidden: false } } }, cache);
  assert.equal(tyre.visible, true, 'Show brings it back');
  // The card and the Parts list have the buttons, with tooltips.
  const compose = read('public/views/compose.js');
  for (const act of ['insp-rename', 'insp-hide', 'insp-similar']) assert.match(compose, new RegExp(`data-act="${act}" title="`), act);
  assert.match(compose, /Select similar<\/button>/);
  const paintView = read('public/views/compose-paint.js');
  assert.match(paintView, /data-unhide=/);
  assert.match(paintView, /act === 'insp-similar'/);
});

test('Low balance and updates are toasts plus a top-bar marker, not banners', () => {
  const html = read('public/index.html');
  for (const gone of ['id="lowBalance"', 'id="update"', 'lowTopUp', 'updateSkip']) assert.ok(!html.includes(gone), gone);
  assert.match(html, /id="updatePill" hidden title="/);
  const app = read('public/app.js');
  assert.match(app, /label: 'Top up'/);
  assert.match(app, /label: 'Skip this version'/);
  assert.match(app, /dot \$\{low \? 'low'/);
  assert.equal(updateNotice({ newer: false }), null);
  assert.equal(updateNotice({ newer: true, skipped: true, latest: '1.2.0' }), null);
  assert.deepEqual(updateNotice({ newer: true, latest: '1.2.0', notes: 'Faster' }, (v) => v.replace(/\.0$/, '')), { version: '1.2.0', title: 'Flatform 1.2 is ready', note: 'Faster', pill: 'Update 1.2' });
  assert.equal(lowNotice({ services: { tripo: { low: false } } }, {}), null);
  const low = lowNotice({ services: { tripo: { low: true, balance: 90, threshold: 200, daysLeft: 3 }, '3daistudio': { low: true, balance: 1, threshold: 5 } } }, { tripo: { name: 'Tripo' }, '3daistudio': { name: '3D AI Studio' } });
  assert.deepEqual([low.service, low.title], ['tripo', 'Tripo balance is low']);
  assert.equal(low.note, '90 credits left, under your alert of 200 · about 3 days at this pace · 3D AI Studio is low too');
  assert.match(low.dot, /Click to top up/);
});

test('3D model step: big ring with the time left, Recipe card and Ready to build', () => {
  assert.equal(timeLeft(0, 1000), 'A few minutes left');
  assert.equal(timeLeft(50, 20_000), 'Less than a minute left');
  assert.equal(timeLeft(25, 60_000), 'About 3 min left');
  assert.equal(timeLeft(100, 60_000), 'A few minutes left');
  const gen = read('public/views/generate.js');
  assert.match(gen, /class="ring genring"/);
  assert.match(gen, /Run in background/);
  assert.match(gen, /timeLeft\(/);
  assert.doesNotMatch(gen, /bigpct|fstage/);
  const setup = read('public/views/setup.js');
  assert.match(setup, />Recipe</);
  assert.match(setup, /Ready to build/);
  assert.match(setup, />Make 3D model</);
});

test('templates: the retired "modeled" switch is gone, old saved templates still load', () => {
  assert.ok(!TEMPLATE_KEYS.includes('modeled'));
  assert.doesNotMatch(read('public/lib/templates.js').replace(/^\/\/.*$/gm, ''), /modeled/);
  const old = normalizeTemplate({ id: 'my-old', name: 'Old one', scene: { preset: 'showroom', modeled: true, matchLighting: 1, lens: 500 } });
  assert.deepEqual(old.scene, { preset: 'showroom', lens: 200, matchLighting: true });
  assert.deepEqual(templateScene({ modeled: false }), {});
});

test('key dialog: Where do I find this? with plain steps', () => {
  const html = read('public/index.html');
  const dialog = html.match(/<dialog id="keyDialog"[\s\S]*?<\/dialog>/)[0];
  assert.match(dialog, /id="keyLink"[^>]*title="[^"]+">Where do I find this\?<\/a>/);
  assert.match(dialog, /<ol class="muted keysteps">[\s\S]*Sign in[\s\S]*Create[\s\S]*paste it below/);
  assert.doesNotMatch(dialog, /API key|token/i);
});

test('Render tool: types and Run first, the old controls under More settings, Run is the only start', () => {
  const r = read('public/views/compose-render.js');
  assert.match(r, /id="raTypes" role="radiogroup"/);
  assert.match(r, /<details class="ra-settings" id="raMore"><summary title="[^"]+">More settings<\/summary>/);
  const more = r.slice(r.indexOf('id="raMore"'), r.indexOf('</details>`;'));
  for (const id of ['id="left"', 'id="right"', 'sheet360']) assert.ok(more.includes(id), `${id} is under More settings`);
  assert.equal((r.match(/data-act="(render|run)"/g) || []).length, 1, 'one Run button');
  assert.match(r, /planRun\(pick\.type/);
  assert.match(r, /mountExport\(\$\('#raMore', el\)/, 'video export and batch list are under More settings too');
  assert.match(read('public/views/compose.js'), /\$\('#raIdeasSlot', el\)\?\.append\(\$\('#renderIdeas', el\)\)/);
});

// The server hands a Render idea's effect, a repainted body and hidden pieces to Blender (the fake one here).
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
test('Blender gets --effect, the Every colour paint and hidden pieces', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'ff-v3-'));
  const out = await mkdtemp(path.join(tmpdir(), 'ff-v3-out-'));
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  const base = `http://127.0.0.1:${app.port}`;
  const j = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await j('/api/settings', 'POST', { outputRoot: out, blenderPath: path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs') })).status, 200);
    // The page's import map is allowed by its hash as the browser sees it (LF line ends), on a CRLF checkout too.
    const map = read('public/index.html').match(/<script type="importmap">([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(map).digest('base64')}'`), csp);
    const form = new FormData();
    form.append('glb', new Blob([GLB]), 'car.glb');
    form.append('name', 'Test Car');
    const m = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    await j(`/api/models/${m.id}`, 'PATCH', { scene: { paint: { pieces: { 'Wheel#1': { hidden: true } } } } });
    assert.equal((await j(`/api/renders/${m.id}/start`, 'POST', { looks: ['studio'] })).status, 200);
    const run = async (body) => {
      const r = await j(`/api/renders/${m.id}/blender`, 'POST', { looks: ['studio'], frames: 0, still: 30, ...body });
      if (r.status !== 202) return r;
      let job;
      for (let i = 0; i < 100 && (!job || job.status === 'running'); i++) { await new Promise((ok) => setTimeout(ok, 30)); job = (await j(`/api/renders/${m.id}/blender`)).body; }
      assert.equal(job.status, 'done', job.error);
      const args = JSON.parse(await readFile(path.join(out, 'test-car', 'frames', 'studio', 'fake-blender-args.json'), 'utf8'));
      const materials = JSON.parse(await readFile(path.join(data, 'models', m.id, 'blender-materials.json'), 'utf8')).materials;
      return { args, opt: (k) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : undefined), materials };
    };
    const a = await run({ effect: { explode: 0.35, override: 'blueprint', evil: true } });
    assert.deepEqual(JSON.parse(a.opt('effect')), { explode: 0.35, override: 'blueprint' });
    assert.equal(a.materials['Wheel#1'].hidden, true, 'a part hidden in Scene stays hidden in Blender');
    const b = await run({ paint: { pieces: { 'Body#0': { region: { label: 'paint' }, material: { color: '#c81e1e' } } } } });
    assert.equal(b.opt('effect'), undefined, 'no effect, no argument');
    assert.equal(b.materials['Body#0'].base_color, '#c81e1e', 'Every colour repaints the body for this render only');
    assert.equal(b.materials['Wheel#1'], undefined);
    assert.equal((await j(`/api/models/${m.id}`)).body.scene.paint.pieces['Wheel#1'].hidden, true, 'the saved scene is untouched');
    assert.equal((await run({ paint: [1] })).status, 400);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
