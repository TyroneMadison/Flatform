// Real Blender: small Cycles renders of every 3D environment, a hand-made pose on a Mixamo-named rig (checked bone by
// bone against the app's own three.js pose), and the Compose render path through the real server with the default
// White Cyc Studio. Run with `npm run test:blender`. Skipped, with a SKIP line, when Blender is not on this computer.
// Blender: FLATFORM_BLENDER, else the usual places (blender.mjs). Renders: FLATFORM_BLENDER_OUT, else
// E:\Claude Stuff\flatform-blender-tests on Windows, else a temp folder.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { findBlender, blenderVersion, blenderPose } from '../blender.mjs';
import { ENVIRONMENTS, blenderEnvironment } from '../public/lib/environments.js';
import { envCamera, stillName } from '../public/lib/pipeline.js';
import { stampFile } from '../public/lib/stamp.js';
import { applyHips } from '../public/lib/handpose.js';
import { decode } from '../png.mjs';
import { blenderMaterial, deserializeMaterial, resolveColors } from '../public/lib/tenno.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { humanoidMesh } from './fixtures/humanoid-mesh.mjs';
import { loadGlb, poseDamage } from './rig-check.mjs';
import { fromPreset } from '../public/lib/handpose.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'render', 'blender_turntable.py');
const HDRI = path.join(ROOT, 'public', 'img', 'hdri');
const BIN = findBlender(process.env.FLATFORM_BLENDER);
const OUT = process.env.FLATFORM_BLENDER_OUT || (process.platform === 'win32' && existsSync('E:\\') ? 'E:\\Claude Stuff\\flatform-blender-tests' : path.join(tmpdir(), 'flatform-blender-tests'));
const FIX = path.join(OUT, 'fixtures');
const LONG = { timeout: 15 * 60 * 1000 };

function blender(args) {
  return new Promise((ok, fail) => {
    const child = spawn(BIN, ['-b', '--factory-startup', ...args], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
    child.on('error', fail);
    child.on('close', (code) => ok({ code, out }));
  });
}
const render = (args) => blender(['-P', SCRIPT, '--', ...args]);
const ok = (r) => assert.equal(r.code, 0, `Blender failed:\n${r.out.split(/\r?\n/).filter((l) => /FLATFORM_ERROR|Error|Traceback/.test(l)).join('\n') || r.out.slice(-2000)}`);

// Mean [r, g, b] (0-255) of one box of a PNG (box: [x0, y0, x1, y1] as shares of the size).
async function rgb(file, box) {
  const img = decode(await readFile(file));
  const [x0, y0, x1, y1] = box.map((v, i) => Math.round(v * (i % 2 ? img.height : img.width)));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * img.width + x) * img.channels; for (let c = 0; c < 3; c++) sum[c] += img.data[i + c]; n++; }
  return sum.map((v) => v / n);
}

// Mean brightness (0-255) of a PNG, or of one box in it, and how much it varies: a real picture is not one flat colour.
async function stats(file, box = null) {
  const img = decode(await readFile(file));
  const [x0, y0, x1, y1] = box ? box.map((v, i) => Math.round(v * (i % 2 ? img.height : img.width))) : [0, 0, img.width, img.height];
  let sum = 0, sq = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * img.channels;
    const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
    sum += l; sq += l * l; n++;
  }
  const mean = sum / n;
  return { width: img.width, height: img.height, mean, spread: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

if (!BIN) {
  console.log('SKIP: Blender not found. Install Blender 4.x or newer, or set FLATFORM_BLENDER to blender.exe, then run npm run test:blender again.');
  test('real Blender renders', { skip: 'SKIP: Blender not found' }, () => {});
} else {
  const outputs = [];
  before(async () => {
    console.log(`Blender ${await blenderVersion(BIN)}: ${BIN}\nRenders: ${OUT}`);
    for (const d of ['fixtures', 'environments', 'pose', 'compose', 'ideas', 'autorig']) await rm(path.join(OUT, d), { recursive: true, force: true });
    const r = await blender(['-P', path.join(ROOT, 'test', 'blender', 'make_fixtures.py'), '--', FIX]);
    ok(r);
    assert.ok(existsSync(path.join(FIX, 'car.glb')) && existsSync(path.join(FIX, 'mixamo-rig.glb')), 'test models were not made');
  });
  after(() => console.log(`Render files:\n${outputs.map((f) => `  ${f}`).join('\n')}`));

  test('every 3D environment renders around a car in Blender', LONG, async () => {
    for (const slug of Object.keys(ENVIRONMENTS)) {
      const env = blenderEnvironment(slug, envCamera(ENVIRONMENTS[slug].cam, 4 / 3), { hdri: (n) => path.join(HDRI, `${n}.hdr`) });
      const dir = path.join(OUT, 'environments', slug);
      const r = await render(['--glb', path.join(FIX, 'car.glb'), '--out', dir, '--slug', slug, '--look', 'studio', '--frames', '1', '--res', '400x300', '--samples', '24', '--environment', JSON.stringify(env)]);
      ok(r);
      const file = path.join(dir, `${slug}_000.png`);
      assert.ok(existsSync(file), `${slug}: no picture`);
      const s = await stats(file);
      assert.deepEqual([s.width, s.height], [400, 300], slug);
      assert.ok(s.spread > 4, `${slug}: the picture is one flat colour (mean ${s.mean.toFixed(1)})`);
      assert.ok(s.mean > 8, `${slug}: the picture is black`);
      outputs.push(file);
    }
  });

  test('a hand-made pose on the Mixamo rig matches the app bone for bone, and renders', LONG, async () => {
    const motion = { type: 'auto', pose: {
      preset: 'tpose', hips: [0.05, -0.1, 0.02], // what Pose by hand saves
      bones: { Spine: [10, 15, 0], Head: [0, 30, -10], LeftArm: [10, 20, -60], LeftForeArm: [0, -45, 0], RightArm: [-30, 0, 50], RightForeArm: [0, 70, 10], LeftUpLeg: [-40, 0, 0], LeftLeg: [60, 0, 0] },
    } };
    const glbFile = path.join(FIX, 'mixamo-rig.glb');
    const glb = await readFile(glbFile);
    const pose = blenderPose(glb, motion);
    assert.equal(Object.keys(pose.bones).length, 8);
    const dir = path.join(OUT, 'pose');
    const r = await render(['--glb', glbFile, '--out', dir, '--slug', 'posed', '--look', 'studio', '--frames', '1', '--res', '400x300', '--samples', '24', '--pose', JSON.stringify(pose), '--report-bones']);
    ok(r);
    assert.match(r.out, /FLATFORM_POSED 22/);
    const [, scale, rotZ] = r.out.match(/FLATFORM_MODEL (\S+) (\S+)/).map(Number);
    const got = Object.fromEntries([...r.out.matchAll(/FLATFORM_BONE (\S+) (\S+) (\S+) (\S+)/g)].map((m) => [m[1], [m[2], m[3], m[4]].map(Number)]));

    // The app's pose (rig.js applyMotion): rest rotation times the Euler, the hips moved in the turntable's space.
    const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length);
    const gltf = await new GLTFLoader().parseAsync(ab, '');
    const pivot = new THREE.Group(), model = new THREE.Group();
    model.scale.setScalar(scale);
    model.rotation.y = rotZ; // Blender's turn about Z is a turn about Y in glTF axes
    pivot.add(model); model.add(gltf.scene);
    const bones = {};
    gltf.scene.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    for (const [name, d] of Object.entries(pose.bones)) {
      bones[name].quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...d.map((v) => THREE.MathUtils.degToRad(v)))));
    }
    applyHips(pivot, bones.Hips, motion.pose.hips);
    pivot.updateMatrixWorld(true);
    let worst = 0;
    for (const [name, b] of Object.entries(bones)) {
      const want = model.worldToLocal(b.getWorldPosition(new THREE.Vector3())).toArray();
      assert.ok(got[name], `Blender did not report ${name}`);
      const off = Math.hypot(...want.map((v, i) => v - got[name][i]));
      worst = Math.max(worst, off);
      assert.ok(off < 0.002, `${name}: Blender ${got[name].map((v) => v.toFixed(3))} vs app ${want.map((v) => v.toFixed(3))}`);
    }
    console.log(`pose: 22 bones match the app within ${(worst * 1000).toFixed(2)} mm`);
    const hand = got.LeftHand, rest = [0.82, 1.42, 0]; // the T-pose hand, in the rig's own metres
    assert.ok(Math.hypot(...hand.map((v, i) => v - rest[i])) > 0.2, 'the left hand did not move');
    const file = path.join(dir, 'posed_000.png');
    assert.ok((await stats(file)).spread > 4);
    outputs.push(file);
  });

  // Render ideas in Blender (render-types.js / --effect): exploded parts, clay, blueprint, and a part hidden in Scene.
  // The poster title and the 9:16 crop are done by the page on the finished PNGs, so they are not Blender's job.
  test('Render ideas render in Blender: exploded parts, clay, blueprint, a hidden part', LONG, async () => {
    const dir = path.join(OUT, 'ideas');
    await mkdir(dir, { recursive: true });
    const env = blenderEnvironment('white-cyc-studio', envCamera(ENVIRONMENTS['white-cyc-studio'].cam, 4 / 3), { hdri: (n) => path.join(HDRI, `${n}.hdr`) });
    const shot = async (slug, extra) => {
      const r = await render(['--glb', path.join(FIX, 'car.glb'), '--out', path.join(dir, slug), '--slug', slug, '--look', 'studio', '--frames', '1', '--res', '400x300', '--samples', '16', '--environment', JSON.stringify(env), ...extra]);
      ok(r);
      const file = path.join(dir, slug, `${slug}_000.png`);
      assert.ok(existsSync(file), `${slug}: no picture`);
      outputs.push(file);
      return { out: r.out, file, rgb: await rgb(file, [0.3, 0.45, 0.7, 0.65]), corner: await rgb(file, [0, 0, 0.12, 0.12]) };
    };
    const plain = await shot('plain', []);
    assert.ok(plain.rgb[0] > plain.rgb[1] + 15, `the fixture car is red paint (${plain.rgb.map(Math.round)})`);
    const exploded = await shot('exploded', ['--effect', JSON.stringify({ explode: 0.15 })]);
    assert.match(exploded.out, /FLATFORM_EXPLODED 6/, 'body, cabin and four wheels all moved out');
    const clay = await shot('clay', ['--effect', JSON.stringify({ override: 'clay' })]);
    assert.match(clay.out, /FLATFORM_OVERRIDE clay/);
    assert.ok(Math.abs(clay.rgb[0] - clay.rgb[1]) < 20 && clay.rgb[0] > 60, `clay is one plain light colour, not red paint (${clay.rgb.map(Math.round)})`);
    const blue = await shot('blueprint', ['--effect', JSON.stringify({ override: 'blueprint' })]);
    assert.ok(blue.corner[2] > blue.corner[0] + 40, `blueprint background is blue (${blue.corner.map(Math.round)})`);
    // A wheel hidden in Scene: the key the app gives it is name#index; try every index so the test needs no import order.
    const spec = path.join(dir, 'hidden.json');
    await writeFile(spec, JSON.stringify({ materials: Object.fromEntries([0, 1, 2, 3, 4, 5].map((i) => [`Wheel_FL#${i}`, { ...blenderMaterial(deserializeMaterial(null), resolveColors(null, {})), hidden: true }])), groups: {} }));
    const hidden = await shot('hidden', ['--materials', spec]);
    assert.match(hidden.out, /FLATFORM_HIDDEN 1/);
  });

  test('Compose render path: real server, default White Cyc Studio, a car and a posed character', LONG, async () => {
    const dir = path.join(OUT, 'compose');
    const data = path.join(dir, 'library'), handoff = path.join(dir, 'handoff');
    await mkdir(handoff, { recursive: true });
    const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
    const base = `http://127.0.0.1:${app.port}`;
    const j = async (p, method = 'GET', body) => {
      const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    try {
      assert.equal((await j('/api/settings', 'POST', { outputRoot: handoff, blenderPath: BIN, renderer: 'blender' })).status, 200);
      const info = (await j('/api/blender')).body;
      assert.deepEqual([info.found, info.path], [true, BIN]);
      assert.match(info.version, /^\d+\.\d+/);
      assert.equal((await j('/api/settings')).body.defaultScene, 'white-cyc-studio'); // White Cyc Studio is the default
      const add = async (file, name) => {
        const form = new FormData();
        form.append('glb', new Blob([await readFile(file)]), path.basename(file));
        form.append('name', name);
        const res = await fetch(`${base}/api/models/import`, { method: 'POST', body: form });
        assert.equal(res.status, 201);
        return res.json();
      };
      const still = async (m, scene) => {
        if (scene) assert.equal((await j(`/api/models/${m.id}`, 'PATCH', { scene })).status, 200);
        const started = await j(`/api/renders/${m.id}/start`, 'POST', { looks: ['studio'] });
        assert.equal(started.status, 200);
        assert.equal((await j(`/api/renders/${m.id}/blender`, 'POST', { looks: ['studio'], frames: 0, still: 30 })).status, 202);
        let job;
        for (let i = 0; i < 1200 && (!job || job.status === 'running'); i++) { await new Promise((r) => setTimeout(r, 250)); job = (await j(`/api/renders/${m.id}/blender`)).body; }
        assert.equal(job.status, 'done', job.error);
        const file = path.join(handoff, m.slug, 'stills', stillName(m.slug, 'studio', 30, stampFile(started.body.renders.at))); // named with the render time
        assert.ok(existsSync(file), `no still for ${m.name}`);
        outputs.push(file);
        return file;
      };
      // A car with no scene saved yet: the default scene, White Cyc Studio, at the Studio look's full size.
      const car = await add(path.join(FIX, 'car.glb'), 'Test Car');
      const carStill = await still(car);
      const s = await stats(carStill);
      assert.deepEqual([s.width, s.height], [2048, 1536]);
      const corner = await stats(carStill, [0, 0, 0.15, 0.15]);
      assert.ok(corner.mean > 150, `the background is not white (mean ${corner.mean.toFixed(1)}): not the White Cyc Studio`);
      // A character posed by hand in Compose, saved in the scene the way Compose saves it.
      const rig = await add(path.join(FIX, 'mixamo-rig.glb'), 'Test Character');
      await still(rig, { preset: 'cyclorama', camera: 'front34', fit: 'all', motion: { type: 'auto', pose: { preset: 'tpose', bones: { LeftArm: [0, 0, -70], RightArm: [0, 0, 70], LeftUpLeg: [-30, 0, 0], LeftLeg: [50, 0, 0] }, hips: null } } });
    } finally { await app.close(); }
  });

  // Auto-rig for real: Flatform's own server, Blender, a multi-piece armoured person facing sideways (open,
  // non-manifold plates, the way Tripo makes them) and the test humanoid. Each rig is timed, posed in the Hero
  // landing the way the app does it (three.js, rig.js) and checked for tearing, then rendered by Blender in that pose.
  // FLATFORM_RIG_SAMPLE=<a GLB> rigs that too (Tyrone's Warframe); FLATFORM_RIG_MARKERS=<json> gives its landmarks.
  test('auto-rig: armoured and plain humanoids rig in Blender, hold together in the Hero landing and render', LONG, async () => {
    const dir = path.join(OUT, 'autorig');
    await mkdir(dir, { recursive: true });
    const armour = path.join(dir, 'armoured.glb');
    const m = humanoidMesh({ arms: 'a', facing: [1, 0, 0] });
    await writeFile(path.join(dir, 'armoured.json'), JSON.stringify({ positions: [...m.positions], tris: [...m.tris] }));
    ok(await blender(['-P', path.join(ROOT, 'test', 'blender', 'mesh_from_json.py'), '--', path.join(dir, 'armoured.json'), armour]));
    const hero = JSON.parse(await readFile(path.join(ROOT, 'public', 'poses', 'hero-landing.json'), 'utf8'));
    const motion = { type: 'humanoid', pose: { preset: 'tpose', ...fromPreset(hero) } };
    const app = await startServer({ dataDir: path.join(dir, 'library'), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
    const base = `http://127.0.0.1:${app.port}`;
    const j = async (p, method = 'GET', body) => {
      const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const times = [];
    try {
      assert.equal((await j('/api/settings', 'POST', { blenderPath: BIN })).status, 200);
      const rig = async (file, name, markers = null) => {
        const form = new FormData();
        form.append('glb', new Blob([await readFile(file)]), path.basename(file));
        form.append('name', name); form.append('kind', 'humanoid');
        const model = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
        const t0 = Date.now();
        let job = (await j(`/api/models/${model.id}/rig`, 'POST', {})).body;
        while (job.status === 'running') { await new Promise((r) => setTimeout(r, 250)); job = (await j(`/api/models/${model.id}/rig`)).body; }
        let seconds = (Date.now() - t0) / 1000;
        if (job.status === 'failed' && job.fallback === 'markers' && markers) { // the landmark clicks, as the panel offers
          times.push(`${name}: found by itself? no (${job.error}) after ${seconds.toFixed(1)} s`);
          const t1 = Date.now();
          job = (await j(`/api/models/${model.id}/rig`, 'POST', { markers })).body;
          while (job.status === 'running') { await new Promise((r) => setTimeout(r, 250)); job = (await j(`/api/models/${model.id}/rig`)).body; }
          seconds = (Date.now() - t1) / 1000;
        }
        assert.equal(job.status, 'done', `${name}: ${job.error}`);
        const after = (await j(`/api/models/${model.id}`)).body;
        const file2 = path.join(dir, 'library', 'models', model.id, after.glb);
        const damage = poseDamage(await loadGlb(await readFile(file2)), motion);
        times.push(`${name}: ${seconds.toFixed(1)} s, ${damage.edges} edges checked, ${(damage.share * 100).toFixed(2)}% stretched past 3x`);
        assert.ok(damage.share < 0.01, `${name} tore in the Hero landing: ${JSON.stringify(damage)}`);
        // Blender renders it in the Hero landing (the render path's own pose code) and from three sides.
        const pose = blenderPose(await readFile(file2), motion);
        const r = await render(['--glb', file2, '--out', path.join(dir, name), '--slug', name, '--look', 'studio', '--frames', '1', '--res', '480x360', '--samples', '16', '--kind', 'humanoid', '--pose', JSON.stringify(pose)]);
        ok(r);
        const pic = path.join(dir, name, `${name}_000.png`);
        const st = await stats(pic);
        assert.ok(st.spread > 4 && st.mean > 8, `${name}: the render is flat`);
        outputs.push(pic);
        ok(await blender(['-P', path.join(ROOT, 'test', 'blender', 'posed_views.py'), '--', file2, JSON.stringify(pose), path.join(dir, `${name}-hero`)]));
        for (const v of ['front', 'side', 'threequarter']) outputs.push(path.join(dir, `${name}-hero-${v}.png`));
        return { model: after, seconds };
      };
      const a = await rig(armour, 'armoured');
      assert.ok(a.model.versions.at(-1).rig.pieces > 7, 'the plates are separate pieces');
      await rig(path.join(ROOT, 'test-app', 'seed', 'humanoid.glb'), 'humanoid');
      if (process.env.FLATFORM_RIG_SAMPLE) {
        const markers = process.env.FLATFORM_RIG_MARKERS ? JSON.parse(await readFile(process.env.FLATFORM_RIG_MARKERS, 'utf8')) : null;
        await rig(process.env.FLATFORM_RIG_SAMPLE, 'sample', markers);
      }
      console.log(['Rig times:', ...times.map((t) => `  ${t}`)].join('\n'));
    } finally { await app.close(); }
  });
}