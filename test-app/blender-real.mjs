// Real Blender checks, run by hand (not part of npm test): starts Flatform's own server on a scratch library, lets it
// find Blender the way the app does (no Blender path set), then auto-rigs the sample humanoid and renders stills of the
// sample car in Night City Rain (rain), Golden Hour Coast and Desert Highway Dusk (sky turned onto the key light),
// and in White Cyc Studio with shelf items (a street lamp and the rigged person).
//   node test-app/blender-real.mjs [outDir]      default: E:\Claude Stuff\flatform-blender-checks
// BLENDER_WRAP=<a blender*.mjs wrapper> uses that as the Blender path instead (to log Blender's full output).
import { readFile, mkdir, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
const OUT = path.resolve(process.argv[2] || 'E:\\Claude Stuff\\flatform-blender-checks');
await rm(path.join(OUT, 'library'), { recursive: true, force: true });
await mkdir(path.join(OUT, 'renders'), { recursive: true });
const srv = await startServer({ dataDir: path.join(OUT, 'library'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
const base = `http://127.0.0.1:${srv.port}`;
const call = async (url, method = 'GET', body) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${url}: ${j?.error || r.status}`);
  return j;
};
const add = async (file, kind, name) => {
  const form = new FormData();
  form.append('glb', new Blob([await readFile(path.join(SEED, file))]), file);
  form.append('name', name); form.append('kind', kind);
  const r = await fetch(`${base}/api/models/import`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`import ${name}: ${r.status}`);
  return (await r.json()).id;
};
const wait = async (url) => { for (;;) { const j = await call(url); if (j?.status !== 'running') return j; await new Promise((ok) => setTimeout(ok, 2000)); } };
const report = [];

const blender = await call('/api/blender');
report.push(`Blender found: ${blender.found} at ${blender.path}`);
if (!blender.found) { console.log(report.join('\n')); process.exit(1); }
await call('/api/settings', 'POST', { outputRoot: path.join(OUT, 'renders'), ...(process.env.BLENDER_WRAP && { blenderPath: process.env.BLENDER_WRAP }) });

// 1. Auto-rig
let t = Date.now();
const human = await add('humanoid.glb', 'humanoid', 'Rig check');
await call(`/api/models/${human}/rig`, 'POST');
const rig = await wait(`/api/models/${human}/rig`);
const m = (await call('/api/models')).find((x) => x.id === human);
report.push(`Auto-rig: ${rig.status}${rig.error ? ` (${rig.error})` : ''}, version ${rig.version}, ${m.versions.at(-1).glb}, ${Math.round((Date.now() - t) / 1000)} s`);

// 2. Stills in three places
// 3. A shelf scene: a street lamp and the rigged person dropped beside the car (Compose, Add things).
const shelf = [{ id: 'a', src: '/env/street_lamp_01.glb', group: 'props', label: 'Street lamp', at: [-3.2, -1.5] },
  { id: 'b', src: `/files/${human}/rigged-v2.glb`, group: 'characters', label: 'Person', at: [3, 0.8] }];
for (const [preset, extras] of [['night-city-rain'], ['golden-hour-coast'], ['desert-highway-dusk'], ['white-cyc-studio', shelf]]) {
  t = Date.now();
  const id = await add('car.glb', 'car', `${extras ? 'Shelf' : 'Sky'} ${preset}`);
  await call(`/api/models/${id}`, 'PATCH', { scene: { preset, ...(extras && { extras }) } });
  await call(`/api/renders/${id}/start`, 'POST', { looks: ['studio'] });
  await call(`/api/renders/${id}/blender`, 'POST', { looks: ['studio'], frames: 0, still: 30 });
  const job = await wait(`/api/renders/${id}/blender`);
  const dir = (await call('/api/models')).find((x) => x.id === id).renders.outDir;
  const stills = await readdir(path.join(dir, 'stills')).catch(() => []);
  report.push(`${extras ? 'shelf ' : ''}${preset}: ${job.status}${job.error ? ` (${job.error.slice(-300)})` : ''}, ${stills.map((s) => path.join(dir, 'stills', s)).join(', ') || 'no still'}, ${Math.round((Date.now() - t) / 1000)} s`);
}
console.log(report.join('\n'));
process.exit(0);
