// Stands in for the Blender program in tests: reads Flatform's arguments, writes tiny PNG frames and reports progress
// the way render/blender_turntable.py does. Never needs Blender.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(process.argv.indexOf('--') + 1);
const opt = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64');
const out = opt('out');
const frames = Number(opt('frames'));
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'fake-blender-args.json'), JSON.stringify(process.argv.slice(2)));
for (let i = 0; i < frames; i++) {
  writeFileSync(path.join(out, `${opt('slug')}_${String(i).padStart(3, '0')}.png`), png);
  console.log(`FLATFORM_FRAME ${i + 1} ${frames}`);
}
if (opt('still-out')) writeFileSync(opt('still-out'), png);
