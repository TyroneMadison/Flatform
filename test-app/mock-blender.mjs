// Flatform Test's Blender: answers Flatform's Blender calls the way render/blender_turntable.py and
// render/blender_autorig.py do, in a moment, with no Blender. Point Settings at the real Blender to test real renders.
// - Auto-rig: the sample humanoid gets its real rig (seed/humanoid-rigged.glb, made by blender_autorig.py); any other
//   model fails with a clear message.
// - Renders: every frame is the environment's picker thumbnail (or the showroom's), so a render looks like its place.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { humanoidMesh } from '../test/fixtures/humanoid-mesh.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THUMBS = path.join(HERE, '..', 'public', 'img', 'environments');
const args = process.argv.slice(process.argv.indexOf('--') + 1);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const out = opt('out');

if (opt('dump') || /\.glb$/i.test(out || '')) {
  const sample = path.join(HERE, 'seed', 'humanoid.glb');
  if (statSync(opt('glb')).size !== statSync(sample).size) {
    console.log('FLATFORM_ERROR Mock Blender only rigs the sample humanoid. Set the real Blender in Settings to rig your own model.');
    process.exit(1);
  }
  if (opt('dump')) { // a made-up person stands in for the sample's mesh while Flatform finds the limbs
    const m = humanoidMesh({ arms: 'a' });
    mkdirSync(opt('dump'), { recursive: true });
    writeFileSync(path.join(opt('dump'), 'positions.f32'), m.positions);
    writeFileSync(path.join(opt('dump'), 'tris.u32'), m.tris);
    writeFileSync(path.join(opt('dump'), 'mesh.json'), JSON.stringify({ verts: m.positions.length / 3 }));
    process.exit(0);
  }
  copyFileSync(path.join(HERE, 'seed', 'humanoid-rigged.glb'), out);
  console.log('FLATFORM_RIG 22 0');
  process.exit(0);
}

const place = opt('environment') ? JSON.parse(opt('environment')).slug : opt('look') === 'transparent' ? null : 'showroom';
const frame = place ? readFileSync(path.join(THUMBS, `${place}.jpg`)) : readFileSync(path.join(HERE, 'seed', 'photos', 'car.png'));
const frames = Number(opt('frames') || 0);
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'mock-blender-args.json'), JSON.stringify(args, null, 2)); // what the real Blender would get
for (let i = 0; i < frames; i++) {
  writeFileSync(path.join(out, `${opt('slug')}_${String(i).padStart(3, '0')}.png`), frame);
  console.log(`FLATFORM_FRAME ${i + 1} ${frames}`);
}
if (opt('still-out')) { mkdirSync(path.dirname(opt('still-out')), { recursive: true }); writeFileSync(opt('still-out'), frame); }
