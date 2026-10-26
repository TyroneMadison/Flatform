// Texture library on disk: syncs CC0 surfaces from ambientCG and Poly Haven into <dataDir>/textures/cache (so they
// work offline after one sync) and keeps the user's own imports per workspace in <dataDir>/textures/custom/<ws>.
// Each cached item has meta.json with its source page, license and when it was fetched. fetch is injectable for tests.
import { mkdir, readFile, writeFile, rm, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { LIBRARY, MAPS, libraryItem, isCustomId, sourceFiles } from './public/lib/textures.js';

export class TextureError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const ws = (w) => (/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(w)) ? String(w) : 'car'); // a workspace id; anything else is Car
const MAX_IMPORT = 25 * 1024 * 1024;

// Just enough of the zip format for ambientCG downloads: stored or deflated entries, found via the central directory.
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new TextureError(502, 'Download was not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new TextureError(502, 'Broken zip file');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out[name] = () => (method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' : null);

export function createTextureLibrary({ dir, fetch = globalThis.fetch }) {
  const cache = path.join(dir, 'cache');
  const custom = (w) => path.join(dir, 'custom', ws(w));
  const job = { running: false, done: 0, total: 0, current: null, errors: {} };

  const cached = (id) => existsSync(path.join(cache, id, 'meta.json'));
  async function customIndex(w) {
    try { return JSON.parse(await readFile(path.join(custom(w), 'index.json'), 'utf8')); } catch { return []; }
  }
  async function list(w) {
    const mine = (await customIndex(w)).map((t) => ({ ...t, kind: 'custom', cached: true, maps: ['color'] }));
    return {
      items: [...LIBRARY.map((t) => ({ ...t, cached: cached(t.id), maps: MAPS })), ...mine],
      sync: { running: job.running, done: job.done, total: job.total, current: job.current, errors: job.errors },
    };
  }

  const get = async (url, what) => {
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(60000) }); } catch (e) { throw new TextureError(502, `Could not reach ${what}: ${e.message}. Textures you already have still work offline.`); }
    if (!res.ok) throw new TextureError(502, `${what} answered HTTP ${res.status}`);
    return res;
  };
  // Downloads one library item's maps into a temp folder, then swaps it in, so a failed sync never leaves half an item.
  async function fetchItem(item) {
    const src = sourceFiles(item);
    const files = {};
    if (src.zip) {
      const entries = unzip(Buffer.from(await (await get(src.zip, item.source)).arrayBuffer()));
      for (const map of MAPS) {
        const name = Object.keys(entries).find((n) => n.endsWith(src.names[map]));
        if (!name) throw new TextureError(502, `${item.name}: no ${map} map in the download`);
        files[map] = entries[name]();
      }
    } else {
      const info = await (await get(src.api, item.source)).json();
      for (const map of MAPS) {
        const url = info?.[src.keys[map]]?.['1k']?.jpg?.url;
        if (typeof url !== 'string' || !url.startsWith('https://')) throw new TextureError(502, `${item.name}: no ${map} map listed`);
        files[map] = Buffer.from(await (await get(url, item.source)).arrayBuffer());
      }
    }
    for (const [map, b] of Object.entries(files)) if (!b || sniff(b) !== 'jpg') throw new TextureError(502, `${item.name}: ${map} map is not a JPEG`);
    const tmp = path.join(cache, `${item.id}.tmp`);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    for (const [map, b] of Object.entries(files)) await writeFile(path.join(tmp, `${map}.jpg`), b);
    const { id, name, source, sourceId, page, license, licenseUrl } = item;
    await writeFile(path.join(tmp, 'meta.json'), JSON.stringify({ id, name, source, sourceId, page, license, licenseUrl, fetchedAt: new Date().toISOString() }, null, 2));
    await rm(path.join(cache, item.id), { recursive: true, force: true });
    await rename(tmp, path.join(cache, item.id));
  }

  // Sync: fetch every library item not cached yet (or just `ids`). One at a time; errors are kept per item.
  function sync(ids) {
    if (job.running) return job.promise;
    const todo = LIBRARY.filter((t) => (!ids || ids.includes(t.id)) && !cached(t.id));
    Object.assign(job, { running: true, done: 0, total: todo.length, current: null, errors: {} });
    job.promise = (async () => {
      await mkdir(cache, { recursive: true });
      for (const item of todo) {
        job.current = item.id;
        try { await fetchItem(item); } catch (e) { job.errors[item.id] = e.message; }
        job.done++;
      }
    })().finally(() => Object.assign(job, { running: false, current: null }));
    return job.promise;
  }

  async function file(id, map, w) {
    if (libraryItem(id)) {
      if (!MAPS.includes(map)) throw new TextureError(404, 'No such map');
      const f = path.join(cache, id, `${map}.jpg`);
      if (!existsSync(f)) throw new TextureError(404, 'Not synced yet. Click Get textures.');
      return { file: f, type: 'image/jpeg' };
    }
    if (!isCustomId(id) || map !== 'color') throw new TextureError(404, 'No such texture');
    const t = (await customIndex(w)).find((x) => x.id === id);
    if (!t) throw new TextureError(404, 'No such texture in this workspace');
    return { file: path.join(custom(w), t.file), type: t.file.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }

  async function importTexture(w, name, buf) {
    if (buf.length > MAX_IMPORT) throw new TextureError(413, 'Texture too large (max 25 MB)');
    const ext = sniff(buf);
    if (!ext) throw new TextureError(415, 'Use a PNG or JPEG image');
    const clean = String(name || 'texture').replace(/\.[^.]+$/, '').replace(/[^\w ()-]+/g, ' ').trim().slice(0, 60) || 'texture';
    const index = await customIndex(w);
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'texture';
    let id = `my-${slug}`;
    for (let i = 2; index.some((t) => t.id === id); i++) id = `my-${slug}-${i}`;
    await mkdir(custom(w), { recursive: true });
    const t = { id, name: clean, file: `${id}.${ext}`, source: 'Imported', license: 'Your own file', importedAt: new Date().toISOString() };
    await writeFile(path.join(custom(w), t.file), buf);
    await writeFile(path.join(custom(w), 'index.json'), JSON.stringify([...index, t], null, 2));
    return { ...t, kind: 'custom', cached: true, maps: ['color'] };
  }

  async function remove(w, id) {
    if (!isCustomId(id)) throw new TextureError(400, 'Only your own textures can be removed');
    const index = await customIndex(w);
    const t = index.find((x) => x.id === id);
    if (!t) throw new TextureError(404, 'No such texture in this workspace');
    await rm(path.join(custom(w), t.file), { force: true });
    await writeFile(path.join(custom(w), 'index.json'), JSON.stringify(index.filter((x) => x !== t), null, 2));
  }

  // LICENSES: every synced item with its source and license, for the export folder or a credits page.
  async function licenses() {
    const out = [];
    for (const id of existsSync(cache) ? await readdir(cache) : []) {
      try { out.push(JSON.parse(await readFile(path.join(cache, id, 'meta.json'), 'utf8'))); } catch { /* not a finished item */ }
    }
    return out;
  }

  return { list, sync, file, importTexture, remove, licenses, job };
}
