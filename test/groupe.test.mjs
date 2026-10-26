// Finish, share, usage and settings screens: server side of poster-only shares, plus wiring and theme checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createShares, MOCK_BASE } from '../share.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'flatform-e-'));

test('shares: a poster alone is enough; nothing at all is refused; links are practice links until set up', async () => {
  let t = Date.parse('2026-10-01T00:00:00Z');
  const s = createShares({ file: path.join(await tmp(), 'shares.json'), now: () => t });
  await assert.rejects(s.create({ modelId: 'm' }), /video or a picture/);
  const a = await s.create({ modelId: 'm', title: 'Audi', poster: 'poster-showroom.webp', expiresInDays: 1 });
  assert.equal(a.mock, true); assert.ok(a.url.startsWith(MOCK_BASE));
  assert.equal(a.video ?? null, null);
  t += 2 * 864e5;
  assert.equal((await s.list())[0].expired, true);
  const b = await s.setExpiry(a.id, null); assert.equal(b.expiresAt, null); assert.equal(b.expired, false);
  assert.equal(await s.remove(a.id), true); assert.deepEqual(await s.list(), []);
});

test('share API: poster-only link, change how long it works, turn it off', async () => {
  const app = await startServer({ dataDir: await tmp(), keyStore: createKeyStore({ env: {} }) });
  const j = async (p, method = 'GET', body) => { const r = await fetch(`http://127.0.0.1:${app.port}/api/${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    assert.equal((await j('shares', 'POST', { modelId: 'm' })).status, 400);
    const made = await j('shares', 'POST', { modelId: 'm', title: 'Car', poster: 'poster-studio.webp', expiresInDays: 7 });
    assert.equal(made.status, 201);
    assert.equal((await j(`shares/${made.body.id}`, 'PATCH', { expiresInDays: 1 })).status, 200);
    assert.equal((await j(`shares/${made.body.id}`, 'DELETE')).body.ok, true);
    assert.deepEqual((await j('shares')).body, []);
  } finally { await app.close(); }
});

test('wiring: new screens routed, on the rail, settings sections listed, stylesheet linked', async () => {
  const app = await readFile('public/app.js', 'utf8');
  for (const s of ['preview', 'finish', 'share', 'usage']) assert.match(app, new RegExp(`'${s}'`));
  assert.match(app, /#\/usage/); assert.match(app, /installHotkeys\(/);
  const set = await readFile('public/views/settings-extra.js', 'utf8');
  for (const s of ['shortcuts', 'backup', 'plugins']) assert.match(set, new RegExp(`\\['${s}'`));
  assert.match(set, /Off until you turn it on\. Saves to a backup branch, never main\./);
  assert.match(await readFile('public/index.html', 'utf8'), /styles\/nova\.css/);
});

test('contrast: every text colour in nova.css comes from the theme tokens (no hard-coded colours)', async () => {
  const css = await readFile('public/styles/nova.css', 'utf8');
  const colours = [...css.matchAll(/(?:^|[;{\s])color:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(colours.length > 10);
  for (const c of colours) assert.match(c, /^var\(--(text|muted|accent|accent-hi|on-accent|ok|bad)\)$|^currentColor$/, c);
});
