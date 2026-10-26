// v3 auto-rig: every model has a kind (humanoid or car), humanoids get a free Blender rig as a new version, cars are
// never rigged, and a humanoid's pose reaches the Blender render. Runs the fake Blender, never the real one.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { BONES } from '../public/lib/motion.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_BLENDER = path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs');
const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

test('the rig script builds exactly the bones rig.js maps', async () => {
  const py = await readFile(path.join(ROOT, 'render', 'blender_autorig.py'), 'utf8');
  const list = py.match(/^BONES = \[([^\]]+)\]/m)[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1));
  assert.deepEqual(list, BONES);
});

test('kind on create and PATCH; cars are never rigged; a humanoid rig is a new version; the pose reaches Blender', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-rig-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => {
    const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const glb = await readFile(path.join(ROOT, 'test-app', 'seed', 'humanoid.glb'));
  const upload = async (fields) => {
    const form = new FormData();
    form.append('glb', new Blob([glb]), 'model.glb');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const r = await fetch(`${base}/api/models/import`, { method: 'POST', body: form });
    return r.json();
  };
  try {
    const hero = await upload({ name: 'Hero', workspace: 'warframe' });
    const car = await upload({ name: 'Car', workspace: 'car' });
    const chosen = await upload({ name: 'Chosen', workspace: 'car', kind: 'humanoid' });
    assert.deepEqual([hero.kind, car.kind, chosen.kind], ['humanoid', 'car', 'humanoid']);
    assert.equal((await json(`/api/models/${car.id}`, 'PATCH', { kind: 'robot' })).status, 400);
    assert.equal((await json(`/api/models/${chosen.id}`, 'PATCH', { kind: 'car' })).body.kind, 'car');

    const refused = await json(`/api/models/${car.id}/rig`, 'POST');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /cars are never rigged/);

    if (!(await json('/api/blender')).body.found) { // no Blender on this computer: a plain answer, nothing runs
      const none = await json(`/api/models/${hero.id}/rig`, 'POST');
      assert.equal(none.status, 409);
      assert.match(none.body.error, /Blender, which was not found\. Install Blender/);
    }
    assert.equal((await json('/api/settings', 'POST', { blenderPath: FAKE_BLENDER })).status, 200);
    assert.equal((await json(`/api/models/${hero.id}/rig`, 'POST')).status, 202);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await json(`/api/models/${hero.id}/rig`)).body;
      if (job.status !== 'running') break;
      await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.equal(job.status, 'done', job.error);
    const rigged = (await json(`/api/models/${hero.id}`)).body;
    assert.deepEqual([rigged.activeVersion, rigged.glb, rigged.versions.at(-1).rigged, rigged.versions.length], [2, 'rigged-v2.glb', true, 2]);
    // Blender only read the model and worked in the job's own folder, which is cleaned away afterwards.
    const rigArgs = JSON.parse(await readFile(path.join(data, 'models', hero.id, 'model.glb.dump-args.json'), 'utf8'));
    assert.match(rigArgs[2], /render[\\/]blender_autorig\.py$/);
    assert.match(rigArgs[rigArgs.indexOf('--dump') + 1], /rig-jobs[\\/][\w-]+-\d+$/);
    assert.deepEqual(await readdir(path.join(data, 'rig-jobs')), []);
    assert.equal(rigged.versions.at(-1).from, 1);

    // The pose goes to the turntable as Euler degrees per standard bone; the car gets none.
    const renderArgs = async (m) => {
      assert.equal((await json(`/api/renders/${m.id}/start`, 'POST', { looks: [] })).status, 200);
      assert.equal((await json(`/api/renders/${m.id}/blender`, 'POST', { looks: ['studio'], frames: 0 })).status, 202);
      for (let i = 0; i < 100; i++) {
        const j = (await json(`/api/renders/${m.id}/blender`)).body;
        if (j.status !== 'running') { assert.equal(j.status, 'done', j.error); break; }
        await new Promise((ok) => setTimeout(ok, 50));
      }
      const out = (await json(`/api/models/${m.id}`)).body.renders.outDir;
      return JSON.parse(await readFile(path.join(out, 'frames', 'studio', 'fake-blender-args.json'), 'utf8'));
    };
    // (blender.mjs blenderPose: the model's own bone names, so this uses the sample with a skeleton.)
    const skinned = new FormData();
    skinned.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', 'humanoid-rigged.glb'))]), 'model.glb');
    skinned.append('name', 'Posed'); skinned.append('kind', 'humanoid');
    const posed = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: skinned })).json();
    await json(`/api/models/${posed.id}`, 'PATCH', { scene: { motion: { pose: { preset: 'apose', bones: { Head: [0, 20, 0] } } } } });
    const args = await renderArgs(posed);
    const pose = JSON.parse(args[args.indexOf('--pose') + 1]);
    assert.deepEqual([pose.bones.LeftArm, pose.bones.Head, args[args.indexOf('--kind') + 1]], [[0, 0, -45], [0, 20, 0], 'humanoid']);
    await json(`/api/models/${car.id}`, 'PATCH', { scene: { motion: { pose: { preset: 'apose' } } } });
    assert.ok(!(await renderArgs(car)).includes('--pose'));
  } finally {
    await app.close();
  }
});

test('a failed Blender run reports the script\'s own error, not a warning or the banner', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-rigfail-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => (await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) })).json();
  try {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', 'humanoid.glb'))]), 'model.glb');
    form.append('name', 'Hero'); form.append('kind', 'humanoid');
    const hero = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    const blender = await json('/api/settings', 'POST', { blenderPath: path.join(ROOT, 'test', 'fixtures', 'failing-blender.mjs') });
    assert.ok(blender);
    assert.equal((await json('/api/blender')).configured, path.join(ROOT, 'test', 'fixtures', 'failing-blender.mjs')); // the picked one, not one found by itself
    await json(`/api/models/${hero.id}/rig`, 'POST');
    let job;
    for (let i = 0; i < 100 && (job = await json(`/api/models/${hero.id}/rig`)).status === 'running'; i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'The model could not be placed');
  } finally {
    await app.close();
  }
});

test('an environment model is parented to its own empty, never to itself (Blender 5 refuses that)', async () => {
  const py = await readFile(path.join(ROOT, 'render', 'blender_turntable.py'), 'utf8');
  const i = py.indexOf('imported = set(bpy.context.scene.objects) - before');
  assert.ok(i > 0 && i < py.indexOf('root = bpy.data.objects.new(f"env glb'));
});

test('rigging runs as its own job: the model stays as it is until the rig is checked, Blender renders wait, a failed rig offers the landmark clicks', async () => {
  const { humanoidMesh } = await import('./fixtures/humanoid-mesh.mjs');
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-rigjob-'));
  temps.push(data);
  const app = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${app.port}`;
  const json = async (url, method = 'GET', body) => {
    const r = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const add = async (name) => {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', 'humanoid.glb'))]), 'model.glb');
    form.append('name', name); form.append('kind', 'humanoid');
    return (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
  };
  const wait = async (id) => { let j; for (let i = 0; i < 200 && (j = (await json(`/api/models/${id}/rig`)).body).status === 'running'; i++) await new Promise((ok) => setTimeout(ok, 50)); return j; };
  try {
    await json('/api/settings', 'POST', { blenderPath: FAKE_BLENDER });
    const hero = await add('Hero');
    process.env.FAKE_RIG_DELAY = '700';
    assert.equal((await json(`/api/models/${hero.id}/rig`, 'POST', {})).status, 202);
    const during = (await json(`/api/models/${hero.id}`)).body;
    assert.deepEqual([during.activeVersion, during.versions.length, during.glb], [1, 1, 'model.glb'], 'the model on screen is untouched while rigging');
    const job = (await json(`/api/models/${hero.id}/rig`)).body;
    assert.equal(job.status, 'running');
    assert.ok(job.step, 'a plain step for the panel');
    assert.equal((await json(`/api/models/${hero.id}/rig`, 'POST', {})).status, 409);
    assert.equal((await json(`/api/renders/${hero.id}/start`, 'POST', { looks: [] })).status, 200);
    const held = await json(`/api/renders/${hero.id}/blender`, 'POST', { looks: ['studio'], frames: 0 });
    assert.equal(held.status, 423);
    assert.match(held.body.error, /^Rigging… .*The render starts when they are done\.$/);
    delete process.env.FAKE_RIG_DELAY;
    assert.equal((await wait(hero.id)).status, 'done');
    const after = (await json(`/api/models/${hero.id}`)).body;
    assert.deepEqual([after.activeVersion, after.glb, after.versions.at(-1).from], [2, 'rigged-v2.glb', 1]);
    assert.equal((await json(`/api/renders/${hero.id}/blender`, 'POST', { looks: ['studio'], frames: 0 })).status, 202, 'the render goes once the joints are in');
    assert.equal((await json(`/api/models/${hero.id}/rig`, 'POST', {})).status, 409, 'a version with joints is not rigged again');

    // Limbs it can't find by itself: a plain error, the landmark clicks offered, the model untouched; the clicks work.
    const bent = await add('Bent');
    process.env.FAKE_RIG_ARMS = 'bent';
    await json(`/api/models/${bent.id}/rig`, 'POST', {});
    const fail = await wait(bent.id);
    assert.equal(fail.status, 'failed');
    assert.equal(fail.fallback, 'markers');
    assert.match(fail.error, /^Could not place the joints by itself: .+Show me where the joints are instead\.$/);
    assert.equal((await json(`/api/models/${bent.id}`)).body.versions.length, 1);
    const t = humanoidMesh({ arms: 'bent' }).truth;
    const front = (p, dz = 0.05) => [p[0], p[1], p[2] + dz];
    const markers = { chin: [0, 1.56, 0.1], groin: [0, 0.86, 0.09], leftElbow: front(t.LeftForeArm), leftWrist: front(t.LeftHand, 0.03), rightElbow: front(t.RightForeArm), rightWrist: front(t.RightHand, 0.03), leftKnee: front(t.LeftLeg), leftAnkle: front(t.LeftFoot, 0.03), rightKnee: front(t.RightLeg), rightAnkle: front(t.RightFoot, 0.03) };
    assert.equal((await json(`/api/models/${bent.id}/rig`, 'POST', { markers: [1, 2] })).status, 400);
    await json(`/api/models/${bent.id}/rig`, 'POST', { markers });
    assert.equal((await wait(bent.id)).status, 'done');
    assert.equal((await json(`/api/models/${bent.id}`)).body.versions.at(-1).rig.markers, true);
    assert.deepEqual(await readdir(path.join(data, 'rig-jobs')), [], 'every job folder is cleaned away');
  } finally {
    delete process.env.FAKE_RIG_DELAY;
    delete process.env.FAKE_RIG_ARMS;
    await app.close();
  }
});
