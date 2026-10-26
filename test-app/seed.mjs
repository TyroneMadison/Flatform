// Fills a fresh Flatform Test library through the app's own API: the rigged and the unrigged sample humanoid, the
// sample car, the car in every room, a humanoid in the garage, and the sample photos in a folder beside the library.
// Runs once per data folder (test-seed.json marks it done; delete the "Flatform Test" folder to start over).
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS } from '../public/lib/pipeline.js';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed');
export const MOCK_BLENDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-blender.mjs');

export async function seedTestApp({ base, dataDir, photosDir }) {
  const marker = path.join(dataDir, 'test-seed.json');
  if (existsSync(marker)) return JSON.parse(await readFile(marker, 'utf8'));
  const call = async (url, method, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${url}: ${(await r.json().catch(() => ({}))).error || r.status}`);
    return r.json();
  };
  const glbs = { humanoid: 'humanoid.glb', 'humanoid-rigged': 'humanoid-rigged.glb', car: 'car.glb' };
  const photo = { humanoid: 'person.png', 'humanoid-rigged': 'person.png', car: 'car.png' };
  async function add(name, file, kind, scene) {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(SEED, glbs[file]))]), glbs[file]);
    form.append('preview', new Blob([await readFile(path.join(SEED, 'photos', photo[file]))], { type: 'image/png' }), 'preview.png');
    form.append('name', name);
    form.append('kind', kind);
    const r = await fetch(`${base}/api/models/import`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`import ${name}: ${r.status}`);
    const m = await r.json();
    if (scene) await call(`/api/models/${m.id}`, 'PATCH', { scene });
    return m.id;
  }
  const models = {};
  // Imported newest first, so the library lists the three samples at the top.
  for (const [slug, p] of Object.entries(ENVIRONMENTS).reverse()) models[`room-${slug}`] = await add(`Room · ${p.label}`, 'car', 'car', { preset: slug });
  models['room-scale'] = await add('Room scale · person in the garage', 'humanoid-rigged', 'humanoid', { preset: 'luxury-garage', motion: { pose: { preset: 'idle' } } });
  models.car = await add('Sample car', 'car', 'car');
  models.humanoid = await add('Sample humanoid (no skeleton)', 'humanoid', 'humanoid');
  models['humanoid-rigged'] = await add('Sample humanoid (rigged)', 'humanoid-rigged', 'humanoid', { motion: { pose: { preset: 'apose' } } });
  // Mock Blender, update checks off (the test app never asks GitHub anyway).
  await call('/api/settings', 'POST', { blenderPath: MOCK_BLENDER });
  await call('/api/settings', 'POST', { updates: { autoCheck: false } });
  await mkdir(photosDir, { recursive: true });
  for (const f of await readdir(path.join(SEED, 'photos'))) await copyFile(path.join(SEED, 'photos', f), path.join(photosDir, f));
  const seed = { models, photosDir, at: new Date().toISOString() };
  await writeFile(marker, JSON.stringify(seed, null, 2));
  return seed;
}
