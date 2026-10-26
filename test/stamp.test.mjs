// The render time stamp (public/lib/stamp.js): New York time text and file tag, the corner it is burned into, the
// Render step's Time stamp toggle, and the Blender path (server.mjs --stamp, render/blender_turntable.py burn_stamp).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampText, stampFile, stampLayout, burnStamp } from '../public/lib/stamp.js';
import { stillName, handoffText, HALF } from '../public/lib/pipeline.js';
import { resultFile } from '../public/lib/render-status.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');

test('stamp text is New York time, 12-hour, like 2026-10-26 5:25 AM ET', () => {
  assert.equal(stampText('2026-10-26T09:25:00Z'), '2026-10-26 5:25 AM ET', 'daylight time: UTC-4');
  assert.equal(stampText('2026-01-15T22:07:00Z'), '2026-01-15 5:07 PM ET', 'standard time: UTC-5');
  assert.equal(stampText('2026-10-26T04:00:00Z'), '2026-10-26 12:00 AM ET', 'midnight is 12 AM');
  assert.equal(stampText('2026-10-26T16:00:00Z'), '2026-10-26 12:00 PM ET', 'noon is 12 PM');
  assert.equal(stampText('2026-10-27T03:59:00Z'), '2026-10-26 11:59 PM ET', 'the New York date, not the UTC date');
  assert.equal(stampText(new Date('2026-03-08T07:30:00Z')), '2026-03-08 3:30 AM ET', 'the spring-forward night');
  assert.equal(stampText(Date.UTC(2026, 10, 1, 6, 30)), '2026-11-01 1:30 AM ET', 'the fall-back night (second 1:30)');
  for (const bad of [undefined, null, '', 'not a date']) assert.equal(stampText(bad), '', `no stamp for ${bad}`);
});

test('the file name tag is the same time, filesystem-safe on every system', () => {
  assert.equal(stampFile('2026-10-26T09:25:07Z'), '2026-10-26_05-25-07AM-ET');
  assert.equal(stampFile('2026-10-26T20:41:00Z'), '2026-10-26_04-41-00PM-ET');
  assert.notEqual(stampFile('2026-10-26T09:25:07Z'), stampFile('2026-10-26T09:25:40Z'), 'two renders in one minute keep both files');
  for (const at of ['2026-10-26T09:25:00Z', '2026-12-31T23:59:00Z', '2026-07-04T16:00:00Z']) assert.match(stampFile(at), /^[A-Za-z0-9_-]+$/, 'no spaces, colons or slashes');
  assert.equal(stampFile('nope'), '');
  assert.equal(stillName('audi-r8', 'studio', 30, stampFile('2026-10-26T09:25:00Z')), 'audi-r8_studio_030_2026-10-26_05-25-00AM-ET.png');
  assert.equal(stillName('audi-r8', 'studio', 30), 'audi-r8_studio_030.png', 'no time: the old name');
  assert.equal(resultFile({ slug: 'x', still: true, looks: ['showroom'], yaw: 30, when: '2026-10-26_05-25AM-ET' }), 'stills/x_showroom_030_2026-10-26_05-25AM-ET.png');
  assert.match(handoffText({ slug: 'x', name: 'X', looks: [], turns: [], stills: [{ look: 'studio', angle: 30, when: '2026-10-26_05-25AM-ET' }], models: [] }), /stills\/x_studio_030_2026-10-26_05-25AM-ET\.png/);
});

// A canvas that records what was drawn on it.
function fakeCanvas(width, height) {
  const calls = [];
  const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => { t[k] = v; calls.push([`=${String(k)}`, v]); return true; } });
  return { width, height, calls, getContext: () => g };
}

test('the stamp goes small in the bottom-right corner, and Time stamp off leaves the picture clean', () => {
  const L = stampLayout(2048, 1536);
  assert.ok(L.size >= 12 && L.size <= 48, 'small but readable');
  assert.ok(L.x > 2048 * 0.9 && L.y > 1536 * 0.9, 'bottom-right');
  assert.equal(stampLayout(256, 192).size, 12, 'never below 12 px');
  const c = fakeCanvas(2048, 1536);
  burnStamp(c, '2026-10-26 5:25 AM ET');
  assert.deepEqual(c.calls.find((x) => x[0] === 'fillText'), ['fillText', '2026-10-26 5:25 AM ET', L.x, L.y]);
  assert.ok(c.calls.some((x) => x[0] === '=textAlign' && x[1] === 'right'));
  assert.ok(c.calls.some((x) => x[0] === 'strokeText'), 'dark outline: readable on white and on black');
  const off = fakeCanvas(2048, 1536);
  assert.equal(burnStamp(off, ''), off);
  assert.deepEqual(off.calls, [], 'nothing drawn when the toggle is off');
});

test('every frame of a spin gets the same stamp: the render start time, not the frame time', () => {
  const at = '2026-10-26T09:25:00Z'; // what the server returns from /start as renders.at
  const job = { stamp: stampText(at) };
  const drawn = Array.from({ length: 72 }, () => { const c = fakeCanvas(2048, 1536); burnStamp(c, job.stamp); return c.calls.find((x) => x[0] === 'fillText')[1]; });
  assert.deepEqual(new Set(drawn), new Set(['2026-10-26 5:25 AM ET']));
  const src = read('public/views/compose-render.js');
  assert.match(src, /Object\.assign\(job, \{ stamp: o\.stamp !== false \? stampText\(started\.renders\.at\) : '', when: stampFile\(started\.renders\.at\) \}\)/, 'once per render, from its start');
  assert.match(src, /return burnStamp\(frame, job\.stamp\);/, 'every captured frame and still');
  assert.match(src, /burnStamp\(await vertical\(/, 'the phone crop gets it back');
  assert.match(src, /burnStamp\(await styled\(/, 'the painted and cartoon pictures too');
  assert.match(src, /const name = \[slug, look, o\.video, tag, job\.when\]/, 'the video file name');
  assert.match(read('public/views/compose-video.js'), /stampFile\(model\.renders\?\.at\)/, 'a video made later from the frames');
});

test('the Render step has a Time stamp toggle, on by default, with a tooltip', () => {
  const src = read('public/views/compose-render.js');
  assert.match(src, /models: false, stamp: true,/, 'on by default');
  assert.match(src, /card\('stamp', 'Time stamp', '[^']+', '[^']+'\)/, 'a plain label and a tooltip');
  assert.match(src, /stamp: o\.stamp !== false/, 'Blender is told when it is off');
  assert.match(read('public/views/history.js'), /a\.stamp \|\|/, 'History shows the render time');
});

test('Blender burns the same stamp at the same size and place', () => {
  const py = read('render/blender_turntable.py');
  assert.match(py, /p\.add_argument\("--stamp"\)/);
  assert.match(py, /render_to\(os\.path\.join\(args\.out, f"\{args\.slug\}_\{i:03d\}\.png"\), args\.stamp\)/, 'every frame');
  assert.match(py, /render_to\(args\.still_out, args\.stamp\)/, 'the still');
  assert.match(py, /size = max\(12, round\(min\(w, h\) \* 0\.022\)\)/);
  assert.match(py, /pad = round\(size \* 0\.8\)/);
  const js = read('public/lib/stamp.js');
  assert.match(js, /Math\.max\(12, Math\.round\(Math\.min\(w, h\) \* 0\.022\)\)/, 'same size as the app');
  assert.match(js, /Math\.round\(size \* 0\.8\)/);
});

const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 20, 0, 0, 0]), Buffer.alloc(8)]);
test('server: Blender gets one --stamp for every look, stills carry the time in their name, History keeps it', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'ff-stamp-'));
  const out = await mkdtemp(path.join(tmpdir(), 'ff-stamp-out-'));
  const app = await startServer({ dataDir: data, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', keyStore: createKeyStore({ env: {} }) });
  const base = `http://127.0.0.1:${app.port}`;
  const j = async (p, method = 'GET', body) => { const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const run = async (id, body) => {
    assert.equal((await j(`/api/renders/${id}/blender`, 'POST', body)).status, 202);
    let job;
    for (let i = 0; i < 200 && (!job || job.status === 'running'); i++) { await new Promise((ok) => setTimeout(ok, 30)); job = (await j(`/api/renders/${id}/blender`)).body; }
    assert.equal(job.status, 'done', job.error);
  };
  const argsOf = async (dir) => JSON.parse(await readFile(path.join(dir, 'fake-blender-args.json'), 'utf8'));
  const opt = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  try {
    await j('/api/settings', 'POST', { outputRoot: out, blenderPath: path.join(ROOT, 'test', 'fixtures', 'fake-blender.mjs') });
    const form = new FormData();
    form.append('glb', new Blob([GLB]), 'car.glb');
    form.append('name', 'Stamp Car');
    const m = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    const started = (await j(`/api/renders/${m.id}/start`, 'POST', { looks: ['studio', 'showroom'] })).body;
    const at = started.renders.at;
    await run(m.id, { looks: ['studio', 'showroom'], frames: HALF, still: 30 });
    const dir = started.outDir;
    const a = await argsOf(path.join(dir, 'frames', 'studio'));
    const b = await argsOf(path.join(dir, 'frames', 'showroom'));
    assert.equal(opt(a, '--stamp'), stampText(at), 'the render start time');
    assert.equal(opt(b, '--stamp'), opt(a, '--stamp'), 'the same stamp on every look and frame');
    const still = path.join(dir, 'stills', `${started.slug}_studio_030_${stampFile(at)}.png`);
    assert.equal(opt(a, '--still-out'), still);
    assert.ok(existsSync(still), 'the still is written under its timestamped name');
    const hist = (await j(`/api/models/${m.id}/history`)).body;
    assert.equal(hist.at(-1).stamp, stampText(at), 'History shows when it was rendered');

    // Time stamp off: no --stamp (a clean picture), the file name still has the time.
    const again = (await j(`/api/renders/${m.id}/start`, 'POST', { looks: ['studio'] })).body;
    await run(m.id, { looks: ['studio'], frames: 0, still: 90, stamp: false });
    const c = await argsOf(path.join(dir, 'frames', 'studio'));
    assert.equal(c.includes('--stamp'), false);
    assert.match(opt(c, '--still-out'), new RegExp(`_090_${stampFile(again.renders.at)}\\.png$`));
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});
