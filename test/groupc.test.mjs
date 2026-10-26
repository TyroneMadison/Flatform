// Overnight queue, usage dashboard, plugin sandbox, GitHub backup (off by default; git is faked, nothing is pushed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQueue } from '../batch.mjs';
import { planOvernight, morningSummary, awakeGuard } from '../overnight.mjs';
import { runPlugin, pluginStore } from '../plugins.mjs';
import { DEFAULTS, backupCommands, isSafeGit, runBackup, checkBackup } from '../backup.mjs';
import { disk, clearCache, renderTimes, enhanceSpend } from '../usage.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'flatform-c-'));

test('overnight: variants x paths x formats, auto-retry to 3 tries, timings, resume after a crash, keep-awake', async () => {
  const dir = await tmp(); let t = 0; const now = () => (t += 1000);
  const file = path.join(dir, 'overnight.json');
  const q = createQueue({ file, planner: planOvernight, maxTries: 3, now });
  await q.start({ modelId: 'm', variants: [{ id: 'red' }, { id: 'blue' }], paths: [{ id: 'a' }, { id: 'b' }], formats: ['mp4', 'still'] });
  assert.equal(q.view().jobs.length, 8);
  const j = q.next();
  for (let i = 0; i < 3; i++) { await q.set(j.id, 'running'); await q.set(j.id, 'failed', 'Blender crashed'); }
  assert.equal(q.view().jobs.find((x) => x.id === j.id).status, 'failed', 'gives up after 3 tries');
  const k = q.next(); await q.set(k.id, 'running'); await q.set(k.id, 'done');
  assert.ok(q.view().jobs.find((x) => x.id === k.id).ms > 0);
  await q.set(q.next().id, 'running');
  const again = createQueue({ file, planner: planOvernight, maxTries: 3 }); await again.load();
  assert.equal(again.view().counts.running, 0, 'running job comes back queued after a crash');
  const s = morningSummary(again.view());
  assert.equal(s.done, 1); assert.equal(s.failed[0].tries, 3);
  const calls = []; const g = awakeGuard((on) => calls.push(on));
  g(again.view()); g(again.view()); g({ jobs: [] });
  assert.deepEqual(calls, [true, false]);
});

test('plugin sandbox: scoped API only, timeouts, memory, crashes stay contained', async () => {
  const ok = await runPlugin('flatform.log("pieces", scene.pieces.length); scene.pieces.push("x"); flatform.setResult(scene);', { pieces: ['a'] });
  assert.equal(ok.ok, true); assert.deepEqual(ok.logs, ['pieces 1']); assert.deepEqual(ok.result.pieces, ['a', 'x']);
  for (const bad of ['require("fs")', 'process.exit(1)', 'fetch("http://example.com")']) {
    const r = await runPlugin(bad);
    assert.equal(r.ok, false, bad);
  }
  const esc = await runPlugin('let p; try { p = this.constructor.constructor("return typeof process")(); } catch (e) { p = "blocked"; } flatform.log(p);');
  assert.ok(['blocked', 'undefined'].includes(esc.logs[0]), 'no way back to the worker process');
  assert.match((await runPlugin('while(true){}', {}, { timeoutMs: 300 })).error, /timed out|Stopped/);
  assert.equal((await runPlugin('const a=[]; while(true) a.push(new Array(1e6).fill(1));', {}, { timeoutMs: 20000, memoryMb: 32 })).ok, false);
  const store = pluginStore(path.join(await tmp(), 'plugins'));
  await assert.rejects(store.install('bad one', 'x', { ok: false }), /Test the script first/);
  await store.install('tidy', 'flatform.log(1)', { ok: true });
  assert.deepEqual(await store.list(), ['tidy']);
});

test('backup: off by default, never main, never force, failures queue for later', async () => {
  assert.equal(DEFAULTS.enabled, false);
  assert.throws(() => checkBackup({ ...DEFAULTS, branch: 'main' }), /other than main/);
  assert.throws(() => checkBackup({ ...DEFAULTS, branch: '--force' }), /other than main/);
  const cmds = backupCommands(DEFAULTS);
  assert.ok(cmds.every(isSafeGit));
  assert.deepEqual(cmds.at(-1), ['push', 'origin', 'HEAD:refs/heads/flatform-backup']);
  assert.equal(isSafeGit(['push', '--force', 'origin', 'x']), false);
  assert.equal(isSafeGit(['push', 'origin', 'HEAD:refs/heads/main']), false);
  const ran = [];
  assert.equal((await runBackup(DEFAULTS, async (a) => ran.push(a))).skipped, 'Backup is off'); assert.equal(ran.length, 0);
  const failed = await runBackup({ ...DEFAULTS, enabled: true }, async (a) => { if (a[0] === 'push') throw new Error('offline'); });
  assert.equal(failed.pending, true);
  const okRun = await runBackup({ ...failed }, async () => {});
  assert.equal(okRun.pending, false);
});

test('usage: disk, render times, enhance spend, cache clearing only inside cache folders', async () => {
  const d = await tmp();
  await mkdir(path.join(d, 'cache'), { recursive: true }); await writeFile(path.join(d, 'cache', 'a.bin'), Buffer.alloc(2048));
  await mkdir(path.join(d, 'models'), { recursive: true }); await writeFile(path.join(d, 'models', 'm.glb'), Buffer.alloc(100));
  const u = await disk(d);
  assert.equal(u.cache, 2048); assert.equal(u.models, 100); assert.equal(u.total, 2148);
  await assert.rejects(clearCache(d, 'models'), /Not a cache/);
  await clearCache(d, 'cache'); assert.equal(existsSync(path.join(d, 'cache')), false); assert.ok(existsSync(path.join(d, 'models', 'm.glb')));
  assert.deepEqual(renderTimes({ jobs: [{ name: 'a', output: 'mp4', ms: 100 }, { name: 'b', output: 'mp4', ms: 300 }] }).avgMs, { mp4: 200 });
  assert.deepEqual(enhanceSpend([{ task: 'enhance', credits: 20, delta: 25 }, { task: 'convert', credits: 5 }]), { calls: 1, credits: 20, actualCredits: 25 });
});

test('API: overnight, usage, plugins and backup routes; backup run refused while off', async () => {
  const d = await tmp(); const awake = [];
  const app = await startServer({ dataDir: d, keyStore: createKeyStore({ env: {} }), keepAwake: (on) => awake.push(on) });
  const j = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${app.port}/api/${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await j('overnight', 'POST', { modelId: 'm', variants: [{ id: 'red' }], formats: ['mp4'] })).status, 201);
    assert.deepEqual(awake, [true]);
    await j('overnight/cancel', 'POST');
    assert.deepEqual(awake, [true, false]);
    assert.ok('disk' in (await j('usage')).body);
    assert.equal((await j('plugins/run', 'POST', { code: 'flatform.log(scene.n * 2)', scene: { n: 21 } })).body.logs[0], '42');
    assert.equal((await j('plugins/install', 'POST', { name: 'broken', code: 'throw new Error("nope")' })).status, 400);
    assert.equal((await j('backup')).body.enabled, false);
    assert.equal((await j('backup/run', 'POST')).status, 409);
    assert.equal((await j('backup', 'PUT', { branch: 'main' })).status, 400);
  } finally { await app.close(); }
});

test('plugin sandbox: host strings and globals do not leak host constructors', async () => {
  const r = await runPlugin('const t = []; for (const v of [globalThis, scene, flatform, flatform.log, Object.getPrototypeOf(globalThis)]) { try { t.push(v && v.constructor && v.constructor.constructor(\"return typeof process\")()); } catch (e) { t.push(\"blocked\"); } } flatform.log(t.join()); flatform.log(typeof __scene);', { a: 1 });
  assert.ok(!r.logs[0].includes('object'), r.logs[0]); assert.equal(r.logs[1], 'undefined');
});
