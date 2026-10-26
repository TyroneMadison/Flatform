// Renders every room's scene-list thumbnail in Blender, with the sample car, through the same --room argument the
// server sends (rooms.js blenderRoom). Also the quickest check that each room builds in Blender.
//   node test-app/make-room-thumbs.mjs <blender.exe> [slug ...]
// Writes public/img/rooms/<slug>-thumb.png.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOMS, blenderRoom } from '../public/lib/rooms.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [blender, ...only] = process.argv.slice(2);
if (!blender) throw new Error('Pass the Blender program');
const dir = path.join(ROOT, 'public', 'img', 'rooms');
for (const slug of only.length ? only : Object.keys(ROOMS)) {
  const out = mkdtempSync(path.join(dir, '.thumb-')); // same drive, so the rename works
  const room = blenderRoom(slug, { dir });
  execFileSync(blender, ['-b', '-P', path.join(ROOT, 'render', 'blender_turntable.py'), '--',
    '--glb', path.join(ROOT, 'test-app', 'seed', 'car.glb'), '--out', out, '--slug', slug, '--look', 'studio',
    '--frames', '1', '--res', '400x300', '--samples', '32', '--room', JSON.stringify(room)], { stdio: ['ignore', 'ignore', 'inherit'] });
  renameSync(path.join(out, readdirSync(out)[0]), path.join(dir, `${slug}-thumb.png`));
  rmSync(out, { recursive: true });
  console.log('thumb', slug);
}
