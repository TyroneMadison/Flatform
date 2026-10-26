import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_TEMPLATES, templatesFor, templateScene, normalizeTemplate } from '../public/lib/templates.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

test('built-in templates: five per kind, each sets lighting, camera and background', () => {
  assert.deepEqual(templatesFor('warframe').map((t) => t.name), ['Orokin hall', 'Void black', 'Relay plaza', 'Studio turnaround', 'TennoGen shot']);
  assert.deepEqual(templatesFor('car').map((t) => t.name), ['Dud Rents showroom', 'Garage', 'Desert dusk', 'White cyclorama', 'Night city']);
  for (const t of BUILTIN_TEMPLATES) {
    const s = templateScene(t.scene);
    assert.ok(s.preset && s.camera && s.look?.lights && s.look?.background, t.id);
    assert.ok(!/\u2014/.test(t.name + t.note), 'no em dashes');
  }
});

test('templateScene keeps only scene-setting keys and clamps values', () => {
  const s = templateScene({ preset: 'ring', camera: 'side', lens: 999, turn: 'x', view: 'bad', paint: { a: 1 }, decals: [1], look: { background: { kind: 'solid', color: '#000000' } } });
  assert.equal(s.lens, 200); assert.equal(s.turn, undefined); assert.equal(s.view, undefined);
  assert.equal(s.paint, undefined); assert.equal(s.decals, undefined);
  assert.equal(s.look.background.color, '#000000');
  assert.equal(normalizeTemplate({ name: '  ' }), null);
});

test('save, list and delete your own templates per workspace', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ff-tpl-'));
  const srv = await startServer({ dataDir, keyStore: createKeyStore({ env: {} }), cudaCheck: async () => false, apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9', updateUrl: 'http://127.0.0.1:9/latest', updateDelayMs: 3600000 });
  const base = `http://127.0.0.1:${srv.port}/api/templates`;
  try {
    const r = await fetch(`${base}?workspace=warframe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'My hall', scene: { preset: 'cyclorama', camera: 'front34', paint: 1 } }) });
    assert.equal(r.status, 201);
    const t = await r.json();
    assert.match(t.id, /^my-/); assert.equal(t.scene.paint, undefined);
    assert.equal((await (await fetch(`${base}?workspace=warframe`)).json()).length, 1);
    assert.equal((await (await fetch(`${base}?workspace=car`)).json()).length, 0);
    assert.equal((await fetch(`${base}?workspace=warframe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":""}' })).status, 400);
    const d = await fetch(`${base}/${t.id}?workspace=warframe`, { method: 'DELETE' });
    assert.equal(d.status, 200); assert.deepEqual(await d.json(), []);
  } finally { await srv.close(); }
});
