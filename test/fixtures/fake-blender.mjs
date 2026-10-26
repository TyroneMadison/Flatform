// Stands in for the Blender program in tests: reads Flatform's arguments, writes tiny PNG frames and reports progress
// the way render/blender_turntable.py does. Never needs Blender.
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanoidMesh } from './humanoid-mesh.mjs';

const args = process.argv.slice(process.argv.indexOf('--') + 1);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const out = opt('out');
if (opt('dump')) { // render/blender_autorig.py --dump: a made-up armoured person (FAKE_RIG_ARMS picks its arms)
  if (process.env.FAKE_RIG_DELAY) await new Promise((ok) => setTimeout(ok, Number(process.env.FAKE_RIG_DELAY))); // a slow Blender
  const m = humanoidMesh({ arms: process.env.FAKE_RIG_ARMS || 'a' });
  mkdirSync(opt('dump'), { recursive: true });
  writeFileSync(path.join(opt('dump'), 'positions.f32'), m.positions);
  writeFileSync(path.join(opt('dump'), 'tris.u32'), m.tris);
  writeFileSync(path.join(opt('dump'), 'mesh.json'), JSON.stringify({ objects: [{ name: 'Body', verts: m.positions.length / 3 }], verts: m.positions.length / 3 }));
  writeFileSync(`${opt('glb')}.dump-args.json`, JSON.stringify(process.argv.slice(2)));
  console.log('FLATFORM_DUMP');
  process.exit(0);
}
if (/\.glb$/i.test(out || '')) { // --build: the seed's rigged person, so the result has a real skin
  copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-app', 'seed', 'humanoid-rigged.glb'), out);
  writeFileSync(`${out}.args.json`, JSON.stringify(process.argv.slice(2)));
  console.log('FLATFORM_RIG 22 0');
  process.exit(0);
}
const frames = Number(opt('frames'));
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'fake-blender-args.json'), JSON.stringify(process.argv.slice(2)));
for (let i = 0; i < frames; i++) {
  writeFileSync(path.join(out, `${opt('slug')}_${String(i).padStart(3, '0')}.png`), png);
  console.log(`FLATFORM_FRAME ${i + 1} ${frames}`);
}
if (opt('still-out')) writeFileSync(opt('still-out'), png);
