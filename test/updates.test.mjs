// Update checks (updates.mjs): version order, the installer for each computer, which links may ever open, the
// banner's note, quiet failures, the 6-hour schedule on a fake clock, and the /api/update endpoints of the server
// against a fake GitHub. No network.
import test, { after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareVersions, pickAsset, releaseUrl, shortNotes, getLatest, updateOptions, createUpdater, LATEST_URL, RELEASES_PAGE } from '../updates.mjs';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PAGE = (tag) => `https://github.com/TyroneMadison/Flatform/releases/tag/${tag}`;
const DL = 'https://github.com/TyroneMadison/Flatform/releases/download/v0.5.0/';
// What electron-builder attaches to a release.
const ASSETS = ['Flatform-Setup-0.5.0.exe', 'Flatform-Setup-0.5.0.exe.blockmap', 'Flatform-0.5.0-arm64.dmg', 'Flatform-0.5.0-arm64.dmg.blockmap',
  'Flatform-0.5.0.dmg', 'Flatform-0.5.0.dmg.blockmap', 'latest.yml', 'latest-mac.yml'].map((name) => ({ name, browser_download_url: DL + name }));
// GitHub's reply for GET /repos/TyroneMadison/Flatform/releases/latest.
const release = (tag, extra = {}) => ({
  tag_name: tag, name: `Flatform ${tag.slice(1)}`, draft: false, prerelease: false, html_url: PAGE(tag), assets: ASSETS,
  body: "## What's new\r\n\r\nFaster renders and a **new** studio scene.\r\n\r\n- Details", ...extra,
});
// A stand-in for fetch that answers `status` and `body` (objects as JSON) and keeps every request.
function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ...opts });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, json: async () => JSON.parse(text) };
  };
  fn.calls = calls;
  return fn;
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const flush = () => new Promise((ok) => setImmediate(ok));

test('versions: semver order, with or without a v; a prerelease comes before its release', () => {
  const order = ['0.3.9', '0.4.0-alpha', '0.4.0-alpha.1', '0.4.0-alpha.beta', '0.4.0-beta', '0.4.0-beta.2', '0.4.0-beta.11', '0.4.0-rc.1',
    '0.4.0', 'v0.4.1', '0.4.2', '0.4.10', '0.10.0', '1.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) assert.equal(Math.sign(compareVersions(order[i], order[j])), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
  }
  assert.equal(compareVersions('v0.4.1', '0.4.1'), 0);
  assert.equal(compareVersions('0.4.1+build.7', '0.4.1'), 0); // build metadata doesn't count
  for (const bad of ['0.4', 'latest', '', undefined, 'v0.4.1.2']) assert.ok(Number.isNaN(compareVersions(bad, '0.4.0')), String(bad));
});

test('the installer for each computer; none for others', () => {
  assert.equal(pickAsset(ASSETS, 'win32', 'x64').name, 'Flatform-Setup-0.5.0.exe');
  assert.equal(pickAsset(ASSETS, 'win32', 'arm64').name, 'Flatform-Setup-0.5.0.exe'); // x64 runs there too
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64').name, 'Flatform-0.5.0-arm64.dmg');
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64').name, 'Flatform-0.5.0.dmg');
  assert.equal(pickAsset(ASSETS, 'linux', 'x64'), undefined);
  assert.equal(pickAsset(ASSETS.filter((a) => !a.name.includes('.exe')), 'win32', 'x64'), undefined);
  assert.equal(pickAsset(ASSETS.filter((a) => !a.name.includes('arm64')), 'darwin', 'arm64'), undefined);
  for (const assets of [undefined, null, 'x', [null, 7, { name: 3 }]]) assert.equal(pickAsset(assets, 'darwin', 'x64'), undefined);
});

test('only https links to this repository on github.com are ever opened', () => {
  for (const ok of [PAGE('v0.5.0'), `${DL}Flatform-Setup-0.5.0.exe`, RELEASES_PAGE]) assert.equal(releaseUrl(ok), ok);
  for (const bad of [
    'http://github.com/TyroneMadison/Flatform/releases', 'https://evil.example/TyroneMadison/Flatform/releases', 'https://github.com.evil.example/TyroneMadison/Flatform/',
    'https://evil.example/https://github.com/TyroneMadison/Flatform/', 'https://github.com@evil.example/TyroneMadison/Flatform/', 'https://user:pw@github.com/TyroneMadison/Flatform/x',
    'https://github.com:8443/TyroneMadison/Flatform/x', 'https://github.com/TyroneMadison/Flatform-fork/releases', 'https://github.com/someone/Flatform/releases',
    'https://github.com/TyroneMadison/Flatform/../../evil/x', 'https://github.com/TyroneMadison/Flatform/%2e%2e/%2e%2e/evil/x', 'https://api.github.com/repos/TyroneMadison/Flatform/releases',
    'https://objects.githubusercontent.com/TyroneMadison/Flatform/x.exe', 'javascript:alert(1)', 'file:///C:/Flatform-Setup.exe', '', undefined, 42,
  ]) assert.equal(releaseUrl(bad), null, String(bad));
});

test("the banner's note: the first paragraph as plain text, at most 140 characters", () => {
  assert.equal(shortNotes('# Flatform 0.5.0\n\n## New\nFaster **renders** and a [new studio](https://x.example) scene.\nSee `Settings`.\n\nMore below.'),
    'Faster renders and a new studio scene. See Settings.');
  // GitHub's "Generate release notes".
  assert.equal(shortNotes("## What's Changed\n* Update banner by @TyroneMadison in https://github.com/TyroneMadison/Flatform/pull/7\n* Fix HEIC import by @someone in https://github.com/TyroneMadison/Flatform/pull/8\n\n**Full Changelog**: https://github.com/TyroneMadison/Flatform/compare/v0.4.0...v0.5.0"),
    'Update banner · Fix HEIC import');
  assert.equal(shortNotes('**Full Changelog**: https://github.com/TyroneMadison/Flatform/compare/v0.4.0...v0.5.0'), '');
  assert.equal(shortNotes('<!-- template -->\n![shot](https://x.example/a.png)\n> _Big_ update: blender_turntable.py ~~old~~ <b>new</b>'), 'Big update: blender_turntable.py old new');
  const long = shortNotes('Renders '.repeat(40));
  assert.ok(long.length <= 140 && long.endsWith('Renders…'), long);
  for (const empty of [undefined, null, '', '---\n\n## Only headings', '🎉']) assert.equal(shortNotes(empty), '', String(empty));
});

test('getLatest: one unauthenticated GET to the GitHub API; version, note and links from its reply', async () => {
  const fetchImpl = fakeFetch(200, release('v0.5.0'));
  assert.deepEqual(await getLatest({ current: '0.4.1', fetchImpl, platform: 'darwin', arch: 'arm64' }), {
    version: '0.5.0', notes: 'Faster renders and a new studio scene.', pageUrl: PAGE('v0.5.0'), downloadUrl: `${DL}Flatform-0.5.0-arm64.dmg`,
  });
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.deepEqual([call.url, call.method, call.body], [LATEST_URL, undefined, undefined]);
  assert.equal(call.headers.Accept, 'application/vnd.github+json');
  assert.match(call.headers['User-Agent'], /^Flatform\/0\.4\.1 /);
  assert.deepEqual(Object.keys(call.headers).filter((h) => /authorization|cookie/i.test(h)), []);
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal((await getLatest({ fetchImpl: fakeFetch(200, release('v0.5.0')), platform: 'win32', arch: 'x64' })).downloadUrl, `${DL}Flatform-Setup-0.5.0.exe`);
  // No installer for this computer: the release page.
  assert.equal((await getLatest({ fetchImpl: fakeFetch(200, release('v0.5.0')), platform: 'linux', arch: 'x64' })).downloadUrl, PAGE('v0.5.0'));
  assert.equal((await getLatest({ fetchImpl: fakeFetch(200, release('v0.5.0', { assets: [] })), platform: 'win32', arch: 'x64' })).downloadUrl, PAGE('v0.5.0'));
  // Links anywhere else are never used.
  const elsewhere = release('v0.5.0', { html_url: 'https://evil.example/r', assets: [{ name: 'Flatform-Setup-0.5.0.exe', browser_download_url: 'https://evil.example/Flatform-Setup-0.5.0.exe' }] });
  const r = await getLatest({ fetchImpl: fakeFetch(200, elsewhere), platform: 'win32', arch: 'x64' });
  assert.deepEqual([r.pageUrl, r.downloadUrl], [RELEASES_PAGE, RELEASES_PAGE]);
});

test('getLatest fails quietly: offline, timeout, rate limits, other statuses, bad JSON, drafts, prereleases', async () => {
  const cases = {
    offline: async () => { throw new TypeError('fetch failed'); },
    timeout: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    'rate limit 403': fakeFetch(403, { message: 'API rate limit exceeded for 203.0.113.7.' }),
    'rate limit 429': fakeFetch(429, {}),
    'no releases 404': fakeFetch(404, { message: 'Not Found' }),
    'server error 500': fakeFetch(500, 'Internal Server Error'),
    'bad JSON': fakeFetch(200, '{"tag_name": "v0.5'),
    'JSON null': fakeFetch(200, 'null'),
    draft: fakeFetch(200, release('v0.5.0', { draft: true })),
    prerelease: fakeFetch(200, release('v0.5.0', { prerelease: true })),
    'prerelease tag': fakeFetch(200, release('v0.5.0-beta.1')),
    'not a version': fakeFetch(200, release('nightly')),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) assert.equal(await getLatest({ current: '0.4.1', fetchImpl, timeoutMs: 20 }), null, name);
});

test('FLATFORM_UPDATE_URL and FLATFORM_UPDATE_DELAY_MS: https anywhere, plain http on 127.0.0.1 only', (t) => {
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(updateOptions({}), { updateUrl: LATEST_URL });
  assert.deepEqual(updateOptions({ FLATFORM_UPDATE_URL: 'http://127.0.0.1:8787/latest', FLATFORM_UPDATE_DELAY_MS: '0' }), { updateUrl: 'http://127.0.0.1:8787/latest', updateDelayMs: 0 });
  assert.equal(updateOptions({ FLATFORM_UPDATE_URL: 'https://staging.example/latest' }).updateUrl, 'https://staging.example/latest');
  for (const bad of ['http://localhost:8787/', 'http://192.168.1.5/latest', 'http://evil.example/', 'ftp://127.0.0.1/x', 'nonsense']) {
    assert.equal(updateOptions({ FLATFORM_UPDATE_URL: bad }).updateUrl, LATEST_URL, bad);
  }
  for (const bad of ['soon', '-5', '']) assert.equal(updateOptions({ FLATFORM_UPDATE_DELAY_MS: bad }).updateDelayMs, undefined, bad);
});

// A clock that only moves when the test says so.
function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    timer: { set: (fn, ms) => { const t = { at: now + ms, fn }; timers.add(t); return t; }, clear: (t) => timers.delete(t) },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        timers.delete(next);
        now = next.at;
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

test('schedule: a check a few seconds after start, then every 6 hours; none while auto-check is off', async () => {
  const HOUR = 3600000;
  const clock = fakeClock();
  const saved = { autoCheck: true, skippedVersion: null };
  const fetchImpl = fakeFetch(200, release('v0.5.0'));
  const updater = createUpdater({ current: '0.4.1', url: LATEST_URL, settings: () => saved, delayMs: 5000, fetchImpl, now: clock.now, timer: clock.timer });
  assert.deepEqual(updater.view(), { current: '0.4.1', latest: null, newer: false, skipped: false, notes: '', downloadUrl: null, pageUrl: RELEASES_PAGE, checkedAt: null, failed: false });
  updater.start();
  await clock.advance(4999);
  assert.equal(fetchImpl.calls.length, 0);
  await clock.advance(1);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual([updater.view().latest, updater.view().checkedAt], ['0.5.0', new Date(5000).toISOString()]);
  await clock.advance(6 * HOUR - 1);
  assert.equal(fetchImpl.calls.length, 1);
  await clock.advance(1);
  assert.equal(fetchImpl.calls.length, 2);
  await clock.advance(6 * HOUR);
  assert.equal(fetchImpl.calls.length, 3);

  // Turned off: nothing, however long it runs. Back on: a check a few seconds later.
  saved.autoCheck = false;
  updater.start();
  await clock.advance(48 * HOUR);
  assert.equal(fetchImpl.calls.length, 3);
  saved.autoCheck = true;
  updater.start();
  await clock.advance(5000);
  assert.equal(fetchImpl.calls.length, 4);
  updater.stop();
  await clock.advance(48 * HOUR);
  assert.equal(fetchImpl.calls.length, 4);

  // Off from the start: GitHub is never asked on its own; asking by hand still works.
  const quiet = fakeFetch(200, release('v0.5.0'));
  const off = createUpdater({ current: '0.4.1', url: LATEST_URL, settings: () => ({ autoCheck: false }), fetchImpl: quiet, now: clock.now, timer: clock.timer });
  off.start();
  await clock.advance(48 * HOUR);
  assert.equal(quiet.calls.length, 0);
  assert.equal((await off.check()).latest, '0.5.0');
  // Without a URL (tests) nothing is ever asked.
  const none = fakeFetch(200, release('v0.5.0'));
  assert.equal((await createUpdater({ current: '0.4.1', settings: () => ({ autoCheck: true }), fetchImpl: none }).check()).failed, true);
  assert.equal(none.calls.length, 0);
});

test('newer, same or older; Skip this version hides that one and older ones, never a newer one', async () => {
  const saved = { autoCheck: true, skippedVersion: null };
  let reply = [200, null];
  const fetchImpl = async () => ({ status: reply[0], json: async () => reply[1] });
  const updater = createUpdater({ current: '0.4.1', url: LATEST_URL, settings: () => saved, fetchImpl });
  const seen = async (tag) => {
    reply = [200, release(tag)];
    const v = await updater.check();
    return [v.latest, v.newer, v.skipped];
  };
  assert.deepEqual(await seen('v0.5.0'), ['0.5.0', true, false]);
  assert.deepEqual(await seen('v0.4.1'), ['0.4.1', false, false]); // this version
  assert.deepEqual(await seen('v0.4.0'), ['0.4.0', false, false]); // older
  saved.skippedVersion = '0.5.0';
  assert.deepEqual(await seen('v0.5.0'), ['0.5.0', true, true]);
  assert.deepEqual(await seen('v0.4.9'), ['0.4.9', true, true]);
  assert.deepEqual(await seen('v0.5.1'), ['0.5.1', true, false]); // newer than the skipped one: shown again
  // A failed check keeps what GitHub said last, and says it failed.
  const { checkedAt } = updater.view();
  reply = [403, { message: 'API rate limit exceeded' }];
  const failed = await updater.check();
  assert.deepEqual([failed.latest, failed.newer, failed.failed, failed.checkedAt], ['0.5.1', true, true, checkedAt]);
  // Overlapping checks share one request.
  let calls = 0;
  const shared = createUpdater({ current: '0.4.1', url: LATEST_URL, settings: () => saved, fetchImpl: async () => { calls++; return { status: 200, json: async () => release('v0.5.0') }; } });
  await Promise.all([shared.check(), shared.check(), shared.check()]);
  assert.equal(calls, 1);
});

// ---- the server's /api/update endpoints, against a fake GitHub on 127.0.0.1 ----

const github = { asked: [], reply: [200, release('v99.0.0')] };
const fake = http.createServer((req, res) => {
  github.asked.push(req.headers);
  const [status, body] = github.reply;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
});
const fakePort = await new Promise((ok) => fake.listen(0, '127.0.0.1', () => ok(fake.address().port)));
const UPDATE_URL = `http://127.0.0.1:${fakePort}/repos/TyroneMadison/Flatform/releases/latest`;
const temps = [];
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
  fake.close();
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

async function start(dataDir) {
  // The providers point at the fake too, so nothing here can reach a real one.
  const s = await startServer({ dataDir, keyStore: createKeyStore({ env: {} }), apiBase: `${UPDATE_URL}/tripo`, threeDAIBase: UPDATE_URL, updateUrl: UPDATE_URL, updateDelayMs: 0 });
  servers.push(s);
  const j = async (p, opts = {}) => {
    const r = await fetch(`http://127.0.0.1:${s.port}${p}`, opts);
    return { status: r.status, body: await r.json() };
  };
  const post = (p, data, headers = {}) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const checked = async () => {
    for (let i = 0; i < 200; i++) {
      const u = (await j('/api/update')).body;
      if (u.checkedAt) return u;
      await sleep(20);
    }
    throw new Error('never checked');
  };
  return { port: s.port, close: s.close, j, post, checked };
}

test('/api/update: checked a moment after start; check now, skip a version, turn auto-check off', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flatform-updates-'));
  temps.push(dir);
  const app = await start(dir);
  const { checkedAt, downloadUrl, ...u } = await app.checked();
  assert.deepEqual(u, { current: VERSION, latest: '99.0.0', newer: true, skipped: false, notes: 'Faster renders and a new studio scene.', pageUrl: PAGE('v99.0.0'), failed: false });
  assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  assert.ok(releaseUrl(downloadUrl), downloadUrl);
  assert.equal(github.asked.length, 1);
  assert.equal(github.asked[0].accept, 'application/vnd.github+json');
  assert.match(github.asked[0]['user-agent'], new RegExp(`^Flatform/${VERSION.replace(/\./g, '\\.')} `));
  assert.equal(github.asked[0].authorization, undefined);

  // Only the app's own page may check or skip; versions are checked.
  const evil = { Origin: 'http://evil.example' };
  assert.equal((await app.post('/api/update/check', {}, evil)).status, 403);
  assert.equal((await app.post('/api/update/skip', { version: '99.0.0' }, evil)).status, 403);
  for (const version of ['soon', '', 99, null, undefined]) assert.equal((await app.post('/api/update/skip', { version })).status, 400, String(version));
  assert.equal((await app.j('/api/update/later', { method: 'POST' })).status, 404);
  const status = await new Promise((ok) => http.get({ host: '127.0.0.1', port: app.port, path: '/api/update', headers: { Host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode); }));
  assert.equal(status, 403); // the DNS-rebinding guard

  // Skip this version: remembered in settings.json. A newer version shows again.
  const skipped = await app.post('/api/update/skip', { version: '99.0.0' });
  assert.deepEqual([skipped.status, skipped.body.latest, skipped.body.skipped], [200, '99.0.0', true]);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).updates.skippedVersion, '99.0.0');
  assert.equal((await app.j('/api/update')).body.skipped, true);
  github.reply = [200, release('v99.0.1')];
  const newer = (await app.post('/api/update/check', {})).body;
  assert.deepEqual([newer.latest, newer.newer, newer.skipped, newer.failed], ['99.0.1', true, false, false]);

  // Rate limited, broken or offline: quiet. The last answer stays.
  for (const reply of [[403, { message: 'API rate limit exceeded' }], [429, {}], [500, 'oops'], [200, '{"tag_name": ']]) {
    github.reply = reply;
    const r = await app.post('/api/update/check', {});
    assert.deepEqual([r.status, r.body.failed, r.body.latest, r.body.newer, r.body.checkedAt], [200, true, '99.0.1', true, newer.checkedAt], String(reply[0]));
  }
  // This version itself is not news.
  github.reply = [200, release(`v${VERSION}`)];
  assert.deepEqual(await app.post('/api/update/check', {}).then((r) => [r.body.latest, r.body.newer, r.body.failed]), [VERSION, false, false]);

  // The automatic check is a setting, saved with the rest.
  assert.deepEqual((await app.j('/api/settings')).body.updates, { autoCheck: true, skippedVersion: '99.0.0' });
  for (const updates of [{ autoCheck: 'no' }, { autoCheck: false, skippedVersion: '1.0.0' }, {}, null, [], 'off']) {
    assert.equal((await app.post('/api/settings', { updates })).status, 400, JSON.stringify(updates));
  }
  assert.equal((await app.post('/api/settings', { updates: { autoCheck: false } }, evil)).status, 403);
  assert.deepEqual((await app.post('/api/settings', { updates: { autoCheck: false } })).body.updates, { autoCheck: false, skippedVersion: '99.0.0' });
  assert.equal(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).updates.autoCheck, false);
  await app.close();

  // Restarted with auto-check off: GitHub is never asked on its own.
  const asked = github.asked.length;
  const again = await start(dir);
  await sleep(300);
  assert.equal(github.asked.length, asked);
  assert.deepEqual(await again.j('/api/update').then((r) => [r.body.checkedAt, r.body.latest]), [null, null]);
  // Turned back on: checked a moment later.
  github.reply = [200, release('v99.0.0')];
  assert.equal((await again.post('/api/settings', { updates: { autoCheck: true } })).status, 200);
  assert.deepEqual(await again.checked().then((x) => [x.latest, x.skipped]), ['99.0.0', true]); // still skipped after a restart
  assert.equal(github.asked.length, asked + 1);
});
