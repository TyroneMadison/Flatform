// Versioning (VERSIONING.md): the release numbers, the update check's order across the 0.x → 1.x jump and the
// 1.9 → 2.0 step, the short version label the app shows, and the installer name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, createUpdater, pickAsset } from '../updates.mjs';
import { displayVersion } from '../public/lib/version.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

test('package.json is 1.3.0, X.Y.0 form, and the lock file agrees', () => {
  assert.equal(pkg.version, '1.3.0');
  assert.match(pkg.version, /^\d+\.\d\.0$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the update check sees 1.1.0 newer than 0.5.0 and 2.0.0 newer than 1.9.0', () => {
  assert.ok(compareVersions('1.1.0', '0.5.0') > 0);
  assert.ok(compareVersions('v1.1.0', '0.5.0') > 0);
  assert.ok(compareVersions('2.0.0', '1.9.0') > 0);
  assert.ok(compareVersions('0.5.0', '1.1.0') < 0);
  const steps = ['0.5.0', '1.1.0', '1.2.0', '1.9.0', '2.0.0', '2.1.0'];
  for (let i = 1; i < steps.length; i++) assert.ok(compareVersions(steps[i], steps[i - 1]) > 0, `${steps[i]} > ${steps[i - 1]}`);
});

test('an app still on 0.5.0 is offered 1.1.0; 1.9.0 is offered 2.0.0', async () => {
  const offered = async (current, tag) => {
    const fetchImpl = async () => ({ status: 200, json: async () => ({ tag_name: tag, html_url: `https://github.com/TyroneMadison/Flatform/releases/tag/${tag}`, body: '', assets: [] }) });
    const u = createUpdater({ current, url: 'https://example.invalid', settings: () => ({ autoCheck: false }), fetchImpl });
    return (await u.check()).newer;
  };
  assert.equal(await offered('0.5.0', 'v1.1.0'), true);
  assert.equal(await offered('1.9.0', 'v2.0.0'), true);
  assert.equal(await offered('1.1.0', 'v1.1.0'), false);
  assert.equal(await offered('2.0.0', 'v1.9.0'), false);
});

test('the app shows "1.3", not "1.3.0"', () => {
  assert.equal(displayVersion(pkg.version), '1.3');
  assert.equal(displayVersion('v2.0.0'), '2.0');
  assert.equal(displayVersion('1.1.2'), '1.1.2'); // a fix release shows in full
  assert.equal(displayVersion('1.2.0-beta.1'), '1.2.0-beta.1');
  assert.equal(displayVersion('nightly'), 'nightly');
  assert.equal(displayVersion(undefined), '');
});

test('the Windows installer is Flatform-Setup-1.3.0.exe and the update check finds it', () => {
  const name = pkg.build.nsis.artifactName.replace('${productName}', pkg.build.productName).replace('${version}', pkg.version).replace('${ext}', 'exe');
  assert.equal(name, 'Flatform-Setup-1.3.0.exe');
  assert.equal(pickAsset([{ name }, { name: `${name}.blockmap` }], 'win32', 'x64').name, name);
});

test('the release docs name this version', () => {
  assert.match(read('CHANGELOG.md'), /^## 1\.3 \(1\.3\.0\)$/m);
  assert.match(read('VERSIONING.md'), /v1\.3\.0/);
});
