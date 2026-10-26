// v0.6: Render moved into Compose. The feedback logic (ETA, status light, queue tray, connection lights) and the
// wiring: no Render tab or Renders rail entry left, every old render option present in Compose's render area.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { etaSeconds, formatEta, statusLight, taskLabel, resultFile, nextTask, waitingCount, trimQueue, blenderLight, accountLight, lookName } from '../public/lib/render-status.js';

test('ETA: from the pace of the current phase, null until there is something to go on', () => {
  const t0 = 1_000_000;
  assert.equal(etaSeconds({ t0, f0: 0, frame: 0, total: 72, now: t0 + 5000 }), null); // no frames yet
  assert.equal(etaSeconds({ t0, f0: 0, frame: 10, total: 72, now: t0 }), null); // no time passed
  assert.equal(etaSeconds({ t0, f0: 0, frame: 72, total: 72, now: t0 + 9000 }), null); // done
  assert.equal(etaSeconds({ t0, f0: 0, frame: 12, total: 72, now: t0 + 12_000 }), 60); // 1 s a frame, 60 to go
  assert.equal(etaSeconds({ t0, f0: 36, frame: 46, total: 72, now: t0 + 5000 }), 13); // phase restarted at frame 36
  assert.equal(formatEta(null), 'working out time left');
  assert.equal(formatEta(20), 'less than a minute left');
  assert.equal(formatEta(150), 'about 3 min left');
  assert.equal(formatEta(3600), 'about 1 h left');
  assert.equal(formatEta(3900), 'about 1 h 5 min left');
});

test('status light: idle, busy with % and ETA, paused, done, error, cancelled', () => {
  const model = { name: 'Audi R8' };
  assert.equal(statusLight(null).light, 'idle');
  const busy = statusLight({ model, frame: 36, total: 72, t0: 1, f0: 0 }, 2, 36_001);
  assert.deepEqual([busy.light, busy.pct], ['busy', 50]);
  assert.equal(busy.text, 'Audi R8: 50% · less than a minute left · 2 waiting');
  assert.equal(statusLight({ model, frame: 72, total: 72 }).pct, 99); // never 100% until it is really finished
  assert.equal(statusLight({ model, frame: 3, total: 72, paused: true }).light, 'paused');
  assert.deepEqual(statusLight({ model, done: true }), { light: 'done', pct: 100, text: 'Audi R8: done', tip: 'Finished. Click to see it in Compose' });
  assert.equal(statusLight({ model, done: true, error: 'Disk full' }).tip, 'Disk full');
  assert.equal(statusLight({ model, done: true, error: 'Cancelled', cancelled: true }).light, 'idle');
});

test('queue tray: plain labels, runs in order, keeps only the last few finished', () => {
  assert.equal(taskLabel({ still: true, t360: true, studio: true, transparent: true }), 'Still + 360° turntable · Compose scene, Transparent');
  assert.equal(taskLabel({ models: true, showroom: true }), 'Model files'); // looks only matter for pictures
  assert.equal(taskLabel({}), 'Nothing');
  assert.equal(lookName('studio'), 'Compose scene');
  const q = [{ id: 1, status: 'done' }, { id: 2, status: 'running' }, { id: 3, status: 'waiting' }, { id: 4, status: 'waiting' }];
  assert.equal(nextTask(q).id, 3);
  assert.equal(waitingCount(q), 2);
  assert.equal(nextTask([{ status: 'done' }]), null);
  const many = [...Array.from({ length: 8 }, (_, i) => ({ id: i, status: i % 2 ? 'failed' : 'done' })), { id: 'w', status: 'waiting' }];
  const trimmed = trimQueue(many, 3);
  assert.deepEqual(trimmed.map((t) => t.id), [5, 6, 7, 'w']);
});

test('done toast opens the right file: the viewer for turntables, else the still, else the model', () => {
  assert.equal(resultFile({ slug: 'audi', t360: true, still: true, looks: ['studio'] }), 'viewer.html');
  assert.equal(resultFile({ slug: 'audi', still: true, looks: ['studio'], yaw: 30 }), 'stills/audi_studio_030.png');
  assert.equal(resultFile({ slug: 'audi', models: true }), 'audi.glb');
});

test('connection lights: Blender and the provider in plain words', () => {
  assert.equal(blenderLight(null).ok, null);
  assert.deepEqual([blenderLight({ found: true, path: 'C:/b.exe' }).ok, blenderLight({ found: true, path: 'C:/b.exe' }).text], [true, 'Blender ready']);
  assert.equal(blenderLight({ found: false }).text, 'No Blender');
  assert.equal(accountLight('Tripo', undefined).ok, null);
  assert.equal(accountLight('Tripo', { hasKey: true }).text, 'Tripo connected');
  assert.equal(accountLight('Tripo', { hasKey: false }).text, 'Tripo: no key');
  assert.equal(accountLight('Tripo', { error: 'x' }).ok, false);
});

test('wiring: no Render tab or Renders rail entry, old links land in Compose', async () => {
  const app = await readFile('public/app.js', 'utf8');
  assert.ok(!existsSync('public/views/render.js'), 'the Render screen is gone');
  assert.doesNotMatch(app, /\['render', 'Render'\]/);
  assert.doesNotMatch(app, /\['Renders'/);
  assert.doesNotMatch(app.match(/const SCREENS = \[[^\]]*\]/)[0], /'render'/);
  assert.match(app, /name === 'render'\) return go\(id \? `#\/compose\/\$\{id\}\/render`/);
  for (const f of ['library', 'model', 'share', 'finish-tools', 'compose']) assert.doesNotMatch(await readFile(`public/views/${f}.js`, 'utf8'), /#\/render\//, f);
  const html = await readFile('public/index.html', 'utf8');
  for (const id of ['renderLight', 'blenderLight', 'accountStatus']) assert.match(html, new RegExp(`id="${id}"`));
  const compose = await readFile('public/views/compose.js', 'utf8');
  assert.match(compose, /id="renderArea"/);
  assert.match(compose, /mountRender\(/);
  assert.equal((compose.match(/data-render=/g) || []).length, 0, 'v3: Render is a dock tool, not a second button');
  assert.match(await readFile('public/lib/stage.js', 'utf8'), /render: \['renderIdeas', 'renderArea'\]/, 'the Render tool shows the render area');
});

test('Compose render area keeps every old render option, with a tooltip on each control', async () => {
  const r = await readFile('public/views/compose-render.js', 'utf8');
  for (const k of ['still', 't360', 't180', 'models']) assert.match(r, new RegExp(`card\\('${k}'`), k);
  for (const k of ['showroom', 'studio', 'transparent']) { assert.match(r, new RegExp(`look\\('${k}'`), k); assert.match(r, new RegExp(`data-preview="${k}"`), k); }
  for (const s of ['data-renderer="three"', 'data-renderer="blender"', 'data-format=', "data-glass=\"on\"", 'data-rig=', 'rig-reset', 'sheet360', 'sheet180',
    'data-act="folder"', 'data-act="run"', 'data-act="open"', 'data-act="pause"', 'data-act="cancel"', 'tennogenCard', 'mountExport(',
    '/api/renders/${model.id}/start', '/api/renders/${model.id}/blender', 'More settings', 'Add to queue', 'Show in folder', "classList.toggle('rendering'", 'setRenderLight(']) {
    assert.ok(r.includes(s), s);
  }
  const v = await readFile('public/views/compose-video.js', 'utf8');
  assert.ok(v.includes("send('/api/video'") && v.includes('track('), 'video export is in the render area and the queue tray');
  for (const [f, src] of [['compose-render', r], ['compose-video', v]]) {
    for (const tag of src.match(/<(button|select)\b[^>]*>/g)) if (!/data-preview|role="radio"/.test(tag) || true) assert.match(tag, /title=/, `${f}: ${tag}`);
  }
});

test('White Cyc Studio is the default background', async () => {
  const studio = await readFile('public/lib/studio.js', 'utf8');
  assert.match(studio, /settings\.defaultScene : 'white-cyc-studio'/);
  const server = await readFile('server.mjs', 'utf8');
  assert.match(server, /defaultScene: 'white-cyc-studio', alsoTransparent/);
  assert.match(server, /scenesV6/);
});
