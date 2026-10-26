import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ENVIRONMENTS } from '../public/lib/environments.js';
import { envThumb, ROOM_THUMB_SIZE } from '../public/lib/pipeline.js';

// Width and height of a WebP file (lossy VP8, lossless VP8L or extended VP8X), or null if it is not one.
export function webpSize(b) {
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
  if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  return null;
}

test('webpSize reads all three WebP kinds and refuses anything else', () => {
  const riff = (kind, body) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP' + kind, 'latin1'), body]);
  const vp8 = Buffer.alloc(14); vp8.writeUInt16LE(320, 10); vp8.writeUInt16LE(200, 12);
  assert.deepEqual(webpSize(riff('VP8 ', vp8)), { w: 320, h: 200 });
  const vp8l = Buffer.alloc(9); vp8l.writeUInt32LE((320 - 1) | ((200 - 1) << 14), 5);
  assert.deepEqual(webpSize(riff('VP8L', vp8l)), { w: 320, h: 200 });
  const vp8x = Buffer.alloc(14); vp8x.writeUIntLE(319, 8, 3); vp8x.writeUIntLE(199, 11, 3);
  assert.deepEqual(webpSize(riff('VP8X', vp8x)), { w: 320, h: 200 });
  assert.equal(webpSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

test('every room in the World picker has its own picture: a 320 x 200 WebP in public/img/rooms', () => {
  for (const slug of Object.keys(ENVIRONMENTS)) {
    assert.equal(envThumb(slug), `/img/rooms/${slug}.webp`);
    const file = new URL(`../public${envThumb(slug)}`, import.meta.url);
    assert.ok(existsSync(file), `${slug}: no thumbnail (npx electron test-app/make-env-thumbs.mjs ${slug})`);
    const b = readFileSync(file);
    assert.deepEqual(webpSize(b), ROOM_THUMB_SIZE, `${slug}: not a ${ROOM_THUMB_SIZE.w} x ${ROOM_THUMB_SIZE.h} WebP`);
    assert.ok(b.length > 1500, `${slug}: ${b.length} bytes is too small to be a real render`);
  }
  // No two rooms share a picture.
  const bytes = Object.keys(ENVIRONMENTS).map((s) => readFileSync(new URL(`../public${envThumb(s)}`, import.meta.url)).toString('base64'));
  assert.equal(new Set(bytes).size, bytes.length);
});

test('the World picker shows each room as an image card with its name under it and a tooltip', () => {
  const js = readFileSync(new URL('../public/views/compose.js', import.meta.url), 'utf8');
  assert.match(js, /<div class="scn-th">\$\{thumb[\s\S]*?<div class="scn-t"><b>\$\{esc\(p\.label\)\}<\/b><\/div><\/button>/);
  assert.match(js, /data-preset="\$\{key\}"[^>]*title="\$\{esc\(p\.label\)\}: \$\{esc\(note\)\}/);
  const css = readFileSync(new URL('../public/styles/screens.css', import.meta.url), 'utf8');
  assert.match(css, /\.scn-th \{ aspect-ratio: 16 \/ 10;/);
});
