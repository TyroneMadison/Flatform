// "Send to Dud Rents": zips a finished spin set plus a metadata JSON into the car's handoff folder and writes a
// ready.json marker that Tyrone's bots watch for. Nothing leaves this computer. The zip container is written here
// (node:zlib has deflate and crc32 but no zip), stored with deflate; a few dozen files, so one pass in memory.
import { readFile, writeFile, readdir, stat, rename } from 'node:fs/promises';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
// DOS time/date fields of a zip entry.
function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** A zip of entries [{ name, data: Buffer, mtime? }] (names with forward slashes). */
export function zip(entries, now = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(String(e.name).replaceAll('\\', '/'), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const packed = deflateRawSync(data);
    const stored = packed.length >= data.length; // tiny or already-compressed files (PNG, WebP) stay as they are
    const body = stored ? data : packed;
    const { time, date } = dosTime(e.mtime || now);
    const crc = crc32(data);
    const head = Buffer.concat([u16(20), u16(0x0800), u16(stored ? 0 : 8), u16(time), u16(date), u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0)]);
    locals.push(Buffer.concat([u32(0x04034b50), head, name, body]));
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), head, u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += locals.at(-1).length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, central, end]);
}

/** Entry names and sizes of a zip made by zip() (the central directory), for tests and the ready marker. */
export function zipEntries(buf) {
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(endAt + 10);
  let p = buf.readUInt32LE(endAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), size: buf.readUInt32LE(p + 24) });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

async function walk(dir, base = dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).replaceAll('\\', '/'));
  }
  return out.sort();
}

export const ZIP_NAME = (slug) => `${slug}-spin-set.zip`;
export const READY = 'ready.json';
const SPIN_FILE = /^(frames|web)\/|^(spin-viewer\.js|viewer\.html|HANDOFF\.md)$/;

/**
 * Zips the spin set in <carDir> (frames/, web/, viewer files) with metadata.json into <carDir>/<slug>-spin-set.zip
 * and writes <carDir>/ready.json. meta: whatever the app knows about the car (name, make, model, year, colour…).
 * Returns the marker. Throws when there is no spin set to send.
 */
export async function sendToDudRents({ carDir, slug, name, meta = {}, version = null, now = new Date() }) {
  const files = (await walk(carDir)).filter((f) => SPIN_FILE.test(f));
  if (!files.some((f) => /^web\/.+\/sprite-\d+\.json$/.test(f))) throw new Error('No finished spin set in this folder yet');
  const metadata = { car: slug, name, ...meta, files, flatformVersion: version, exportedAt: now.toISOString() };
  const entries = [{ name: 'metadata.json', data: Buffer.from(JSON.stringify(metadata, null, 2)) }];
  for (const f of files) entries.push({ name: f, data: await readFile(path.join(carDir, f)), mtime: (await stat(path.join(carDir, f))).mtime });
  const zipFile = path.join(carDir, ZIP_NAME(slug));
  await writeFile(zipFile + '.tmp', zip(entries, now));
  await rename(zipFile + '.tmp', zipFile);
  const marker = { car: slug, name, zip: ZIP_NAME(slug), files: files.length, bytes: (await stat(zipFile)).size, readyAt: now.toISOString(), flatformVersion: version, meta };
  await writeFile(path.join(carDir, READY), JSON.stringify(marker, null, 2));
  return marker;
}
