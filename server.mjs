// Flatform server: photo → Tripo 3D model → local library → scene → turntable renders → handoff folder.
// Used two ways: `npm run web` (key from .env) or embedded by the Electron app (main.mjs).
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, rm, copyFile, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { uniqueSlug, stillName, LOOKS, FRAMES, HALF, STEP } from './public/lib/pipeline.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const THREE = path.join(ROOT, 'node_modules', 'three');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// The app page may only run its own files (and its inline import map). WebAssembly is for the Draco/Meshopt decoders.
// GLTFLoader fetches a GLB's embedded textures from blob: URLs (and a .gltf's data: URIs), hence connect-src blob: data:.
const IMPORT_MAP = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
const CSP = [
  "default-src 'self'", `script-src 'self' 'wasm-unsafe-eval' 'sha256-${createHash('sha256').update(IMPORT_MAP).digest('base64')}'`,
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "worker-src 'self' blob:", "connect-src 'self' blob: data:",
  "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');
const FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'];
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg' };
const HEIC_TYPES = ['image/heic', 'image/heif'];
const MAX_IMAGE = 20 * 1024 * 1024; // Tripo's upload limit for images
const MAX_RENDER_FILE = 128 * 1024 * 1024; // a 6144 px PNG sprite sheet fits easily
const MAX_BACKDROP = 256 * 1024 * 1024; // 4K EXR HDRIs are big
const RENDER_TYPES = ['.png', '.webp', '.json', '.js', '.html', '.md', '.glb'];
const BACKDROP_TYPES = ['.jpg', '.jpeg', '.png', '.hdr', '.exr'];
const FAILED = ['failed', 'cancelled', 'banned'];
// Global keys work on .ai; .com (the host the docs show) is the China region and rejects global keys.
const REGIONS = { global: 'https://openapi.tripo3d.ai/v3', china: 'https://openapi.tripo3d.com/v3' };
const SCENES = ['gold', 'transparent', 'cyclorama', 'miami', 'custom'];
// Version fields mirrored at the top level of each library entry, so v0.2 readers and the UI see the active version.
const VERSION_FIELDS = ['task_id', 'status', 'progress', 'tripo_status', 'glb', 'thumb', 'credits', 'error', 'exports', 'source'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.usdz': 'model/vnd.usdz+zip',
  '.wasm': 'application/wasm',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// v1 keeps the v0.2 file names (model.glb, preview.webp, source.jpg); later versions get a -vN suffix.
const vname = (base, n) => (n > 1 ? `${base}-v${n}` : base);
const typeOf = (file) => (/\.png$/i.test(file) ? 'image/png' : 'image/jpeg');
const cleanName = (name) => String(name ?? '').trim().slice(0, 100) || 'Untitled';
const isLook = (look) => typeof look === 'string' && Object.hasOwn(LOOKS, look); // not "constructor" and friends

export function suggestedOutputRoot(platform = process.platform) {
  return platform === 'win32' ? 'E:\\Claude Stuff\\car-360-pipeline\\handoff' : path.join(os.homedir(), 'Flatform', 'handoff');
}

// Default install locations. Blender is optional and never bundled.
export function blenderCandidates(platform = process.platform) {
  if (platform === 'darwin') return ['/Applications/Blender.app/Contents/MacOS/Blender'];
  if (platform !== 'win32') return ['/usr/bin/blender', '/snap/bin/blender'];
  const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation');
  let dirs = [];
  try { dirs = readdirSync(base).filter((d) => /^blender/i.test(d)); } catch { /* not installed */ }
  return dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((d) => path.join(base, d, 'blender.exe'));
}

/**
 * Starts the app server on 127.0.0.1.
 * keyStore: { get(): string|undefined, set(key): void|Promise } — where the Tripo API key lives.
 * apiBase: fixed Tripo endpoint (tests, TRIPO_BASE). Without it the Region setting picks one of REGIONS.
 */
export async function startServer({
  dataDir,
  port = 0,
  apiBase: fixedApiBase,
  model = 'v3.1-20260211',
  keyStore,
  blenderScript = path.join(ROOT, 'render', 'blender_turntable.py'), // the packaged app ships it as a resource file
  // three.js addons (loaders, controls, decoders). electron-builder drops every dependency's examples/ folder,
  // so the packaged app ships this one as a resource file too.
  threeAddons = path.join(THREE, 'examples', 'jsm'),
}) {
  const MODELS = path.join(dataDir, 'models');
  const BACKDROPS = path.join(dataDir, 'backdrops');
  const LIB = path.join(dataDir, 'library.json');
  const SETTINGS = path.join(dataDir, 'settings.json');
  await mkdir(MODELS, { recursive: true });

  // Atomic JSON writes, one at a time, so a crash never leaves a half-written file.
  let writing = Promise.resolve();
  function writeAtomic(file, data) {
    const job = writing.then(async () => {
      await writeFile(file + '.tmp', JSON.stringify(data, null, 2));
      await rename(file + '.tmp', file);
    });
    writing = job.catch(() => {});
    return job;
  }

  const defaults = {
    region: 'global', model, texture: true, pbr: true,
    renderer: 'three', blenderPath: '', outputRoot: '', defaultScene: 'gold', alsoTransparent: true, backdrops: {},
  };
  const settings = { ...defaults, ...(existsSync(SETTINGS) ? JSON.parse(await readFile(SETTINGS, 'utf8')) : {}) };
  const apiBase = () => fixedApiBase || REGIONS[settings.region] || REGIONS.global;

  // ponytail: whole library in one JSON file rewritten on each change; move to SQLite past a few thousand models
  const library = existsSync(LIB) ? JSON.parse(await readFile(LIB, 'utf8')) : [];
  const save = () => writeAtomic(LIB, library);
  const active = (m) => m.versions.find((v) => v.n === m.activeVersion) || m.versions.at(-1);
  function mirror(m) {
    const v = active(m);
    m.activeVersion = v.n;
    for (const k of VERSION_FIELDS) m[k] = v[k];
    return m;
  }
  // v0.2 entries were one flat generation. Make that version 1 and give every model a unique slug.
  let migrated = false;
  for (const m of library) {
    if (!Array.isArray(m.versions)) {
      const v = { n: 1, created_at: m.created_at, exports: {} };
      for (const k of VERSION_FIELDS) if (m[k] !== undefined) v[k] = m[k];
      m.versions = [v];
      m.activeVersion = 1;
      migrated = true;
    }
    if (!m.slug) {
      m.slug = uniqueSlug(m.name, library.map((x) => x.slug).filter(Boolean));
      migrated = true;
    }
    mirror(m);
  }
  if (migrated) await save();
  const slugsExcept = (m) => library.filter((x) => x !== m).map((x) => x.slug);

  async function tripo(route, { json, body, key = keyStore.get() } = {}) {
    if (!key) throw new HttpError(401, 'Add your Tripo API key first');
    const res = await fetch(apiBase() + route, {
      method: json || body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(json && { 'Content-Type': 'application/json' }) },
      body: json ? JSON.stringify(json) : body,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.code !== 0) {
      const err = new HttpError(res.status === 401 ? 401 : 502, `Tripo: ${out.message || `HTTP ${res.status}`}${out.suggestion ? ` (${out.suggestion})` : ''}`);
      err.upstream = res.status;
      throw err;
    }
    return out.data;
  }

  // Polls a task. A task Tripo no longer knows will never finish, so it counts as failed (and can be retried).
  async function task(id) {
    try {
      return await tripo(`/tasks/${id}`);
    } catch (e) {
      if (e.upstream === 404) return { status: 'failed', missing: true };
      throw e;
    }
  }
  const failure = (t) => (t.missing ? 'Tripo has no record of this task' : `Tripo task ${t.status}`);

  // Docs show output.model_url; fall back to any other URL field in case a task type names it differently.
  const fileUrl = (output = {}) => output.model_url
    || Object.entries(output).find(([k, v]) => k !== 'rendered_image_url' && typeof v === 'string' && v.startsWith('http'))?.[1];

  // Tripo result URLs expire after 5 minutes, so results are copied locally the moment a task succeeds.
  async function download(url, dir, base, fallbackExt) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const name = base + (path.extname(new URL(url).pathname).toLowerCase() || fallbackExt);
    await writeFile(path.join(dir, name), Buffer.from(await res.arrayBuffer()));
    return name;
  }

  async function readBody(req, max, tooLarge = 'Request too large') {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      if ((size += chunk.length) > max) throw new HttpError(413, tooLarge);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req, max = 4096) {
    let body;
    try { body = JSON.parse((await readBody(req, max)).toString() || '{}'); } catch (e) { throw e.status ? e : new HttpError(400, 'Bad JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Bad JSON');
    return body;
  }

  // Streams a request body to a temp file, then swaps it in, so readers never see half a file.
  async function streamToFile(req, file, max) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    let size = 0;
    try {
      await pipeline(req, async function* (source) {
        for await (const chunk of source) {
          if ((size += chunk.length) > max) throw new HttpError(413, 'File too large');
          yield chunk;
        }
      }, createWriteStream(tmp));
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  // Photos come in as PNG, JPEG or HEIC. HEIC is converted to JPEG here because Tripo and browsers can't read it.
  async function readImage(req) {
    let type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!Object.hasOwn(IMAGE_TYPES, type) && !HEIC_TYPES.includes(type)) throw new HttpError(415, 'Use a PNG, JPEG or HEIC image');
    let image = await readBody(req, MAX_IMAGE, 'Image too large (max 20 MB)');
    if (HEIC_TYPES.includes(type)) {
      const { default: convert } = await import('heic-convert');
      try { image = Buffer.from(await convert({ buffer: image, format: 'JPEG', quality: 0.92 })); } catch {
        throw new HttpError(415, 'Could not read that HEIC photo. Export it as JPEG and try again.');
      }
      type = 'image/jpeg';
    }
    return { image, type };
  }

  async function generate(image, type) {
    const form = new FormData();
    form.append('file', new Blob([image], { type }), 'image' + IMAGE_TYPES[type]);
    const { file_token } = await tripo('/files', { body: form });
    const { task_id } = await tripo('/generation/image-to-model', {
      json: { input: file_token, model: settings.model, texture: settings.texture, pbr: settings.texture && settings.pbr },
    });
    return task_id;
  }

  const newVersion = (n, task_id, source) => ({
    n, created_at: new Date().toISOString(), task_id, status: 'generating', tripo_status: 'queued', progress: 0, source, exports: {},
  });

  async function createModel(req, name) {
    const { image, type } = await readImage(req);
    const task_id = await generate(image, type);
    const source = 'source' + IMAGE_TYPES[type];
    const m = {
      id: randomUUID(), name: cleanName(name), created_at: new Date().toISOString(), activeVersion: 1,
      versions: [newVersion(1, task_id, source)],
    };
    m.slug = uniqueSlug(m.name, slugsExcept(m));
    await mkdir(path.join(MODELS, m.id), { recursive: true });
    await writeFile(path.join(MODELS, m.id, source), image);
    library.unshift(mirror(m));
    await save();
    return m;
  }

  // Regenerate: a new Tripo task from a new photo (request body) or the active version's photo. Old versions stay.
  async function addVersion(req, m) {
    const n = Math.max(...m.versions.map((v) => v.n)) + 1;
    const fresh = Boolean(req.headers['content-type']);
    const { image, type } = fresh ? await readImage(req)
      : { image: await readFile(path.join(MODELS, m.id, active(m).source)), type: typeOf(active(m).source) };
    const task_id = await generate(image, type);
    const source = fresh ? vname('source', n) + IMAGE_TYPES[type] : active(m).source;
    if (fresh) await writeFile(path.join(MODELS, m.id, source), image);
    m.versions.push(newVersion(n, task_id, source));
    m.activeVersion = n;
    mirror(m);
    await save();
    return m;
  }

  async function retry(m) {
    const v = active(m);
    if (v.status !== 'failed') throw new HttpError(409, 'Only a failed model can be retried');
    const task_id = await generate(await readFile(path.join(MODELS, m.id, v.source)), typeOf(v.source));
    Object.assign(v, newVersion(v.n, task_id, v.source));
    delete v.error;
    mirror(m);
    await save();
    return m;
  }

  async function refreshVersion(m, v) {
    const t = await task(v.task_id);
    v.progress = t.progress ?? v.progress;
    v.tripo_status = t.status;
    if (t.status === 'success') {
      const dir = path.join(MODELS, m.id);
      const url = fileUrl(t.output);
      if (!url) Object.assign(v, { status: 'failed', error: 'Tripo returned no model URL' });
      else {
        v.glb = await download(url, dir, vname('model', v.n), '.glb');
        if (t.output.rendered_image_url) v.thumb = await download(t.output.rendered_image_url, dir, vname('preview', v.n), '.png');
        Object.assign(v, { status: 'ready', progress: 100, credits: t.credits_consumed });
      }
    } else if (FAILED.includes(t.status)) Object.assign(v, { status: 'failed', error: failure(t) });
  }

  async function refreshModel(m) {
    const pending = m.versions.filter((v) => v.status === 'generating');
    if (!pending.length) return;
    for (const v of pending) await refreshVersion(m, v);
    mirror(m);
    await save();
  }

  async function patchModel(m, body) {
    const allowed = ['name', 'activeVersion', 'scene'];
    if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError(400, `Only ${allowed.join(', ')} can be changed`);
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'Give the model a name');
      m.name = cleanName(body.name);
      m.slug = uniqueSlug(m.name, slugsExcept(m));
    }
    if ('activeVersion' in body) {
      if (!m.versions.some((v) => v.n === body.activeVersion)) throw new HttpError(400, 'No such version');
      m.activeVersion = body.activeVersion;
    }
    if ('scene' in body) {
      if (!body.scene || typeof body.scene !== 'object' || Array.isArray(body.scene)) throw new HttpError(400, 'Bad scene');
      m.scene = body.scene;
      await writeAtomic(path.join(MODELS, m.id, 'scene.json'), m.scene); // next to the model, so a render reproduces it
    }
    mirror(m);
    await save();
    return m;
  }

  async function startExport(m, fmt) {
    const v = active(m);
    if (v.status !== 'ready') throw new HttpError(409, 'Model is not ready yet');
    if (['converting', 'ready'].includes(v.exports[fmt]?.status)) return v.exports[fmt];
    const { task_id } = await tripo('/models/convert', { json: { input: v.task_id, format: fmt } });
    v.exports[fmt] = { status: 'converting', task_id };
    await save();
    return v.exports[fmt];
  }

  async function refreshExport(m, fmt) {
    const v = active(m);
    const e = v.exports[fmt];
    if (e?.status !== 'converting') return;
    const t = await task(e.task_id);
    if (t.status === 'success') {
      const url = fileUrl(t.output);
      if (!url) Object.assign(e, { status: 'failed', error: 'Tripo returned no file URL' });
      else {
        Object.assign(e, { status: 'ready', file: await download(url, path.join(MODELS, m.id), `${vname('model', v.n)}-${fmt.toLowerCase()}`, '.' + fmt.toLowerCase()) });
        if (m.renders?.formats?.includes(fmt)) await copyToHandoff(m, e.file).catch((err) => console.error(err));
      }
    } else if (FAILED.includes(t.status)) Object.assign(e, { status: 'failed', error: failure(t) });
    await save();
  }

  // ---- Settings (non-secret; the key lives in keyStore) ----

  async function checkOutputRoot(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new HttpError(400, 'Pick a full folder path for renders');
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(400, 'That output folder does not exist');
    const probe = path.join(dir, `.flatform-${randomUUID()}.tmp`);
    try { await writeFile(probe, ''); await rm(probe); } catch { throw new HttpError(400, 'Flatform cannot write to that output folder'); }
    return path.resolve(dir);
  }

  async function checkBlenderPath(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new HttpError(400, 'Pick the Blender program');
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory() && /\.app$/i.test(file)) { // a Mac app bundle
      file = path.join(file, 'Contents', 'MacOS', 'Blender');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile() || !/blender/i.test(path.basename(file))) throw new HttpError(400, 'That is not the Blender program');
    return file;
  }

  async function saveSettings(body) {
    const next = { ...settings };
    const bool = (k) => { if (typeof body[k] !== 'boolean') throw new HttpError(400, `${k} must be true or false`); next[k] = body[k]; };
    for (const k of Object.keys(body)) {
      if (k === 'region') {
        if (!Object.hasOwn(REGIONS, body.region)) throw new HttpError(400, `Region must be ${Object.keys(REGIONS).join(' or ')}`);
        next.region = body.region;
      } else if (k === 'model') {
        if (typeof body.model !== 'string' || !/^[\w.-]{1,64}$/.test(body.model)) throw new HttpError(400, 'That does not look like a Tripo model version');
        next.model = body.model;
      } else if (['texture', 'pbr', 'alsoTransparent'].includes(k)) bool(k);
      else if (k === 'renderer') {
        if (!['three', 'blender'].includes(body.renderer)) throw new HttpError(400, 'Renderer must be three or blender');
        next.renderer = body.renderer;
      } else if (k === 'defaultScene') {
        if (!SCENES.includes(body.defaultScene)) throw new HttpError(400, 'Unknown scene');
        next.defaultScene = body.defaultScene;
      } else if (k === 'outputRoot') next.outputRoot = body.outputRoot === '' ? '' : await checkOutputRoot(body.outputRoot);
      else if (k === 'blenderPath') next.blenderPath = body.blenderPath === '' ? '' : await checkBlenderPath(body.blenderPath);
      else throw new HttpError(400, `Unknown setting: ${k}`);
    }
    Object.assign(settings, next);
    await writeAtomic(SETTINGS, settings);
    return settingsView();
  }

  const settingsView = () => ({
    ...settings, apiBase: apiBase(), regions: REGIONS, version: VERSION, libraryDir: dataDir,
    suggestedOutputRoot: suggestedOutputRoot(), platform: process.platform,
  });

  // ---- Backdrops and HDRIs (shared by every car; kept in the library folder) ----

  async function uploadBackdrop(req, slot, name) {
    if (!['miami', 'custom'].includes(slot)) throw new HttpError(400, 'Unknown backdrop slot');
    const ext = path.extname(String(name || '')).toLowerCase();
    if (!BACKDROP_TYPES.includes(ext)) throw new HttpError(415, 'Use a JPG, PNG, HDR or EXR file');
    // Each upload gets its own file, so scenes that used an older one still render the same.
    const file = `${slot}-${Date.now()}${ext}`;
    await streamToFile(req, path.join(BACKDROPS, file), MAX_BACKDROP);
    settings.backdrops = { ...settings.backdrops, [slot]: file };
    await writeAtomic(SETTINGS, settings);
    return settings.backdrops;
  }

  // ---- Renders ----

  function renderFile(m, rel) {
    const dir = m.renders?.outDir;
    if (!dir) throw new HttpError(409, 'Start the render first');
    // Plain relative paths only: no drive letters, backslashes, NTFS streams or empty segments.
    if (typeof rel !== 'string' || !/^[\w.-]+(\/[\w.-]+)*$/.test(rel)) throw new HttpError(400, 'Bad file path');
    if (!RENDER_TYPES.includes(path.extname(rel).toLowerCase())) throw new HttpError(415, `Only ${RENDER_TYPES.join(' ')} files`);
    const file = path.resolve(dir, rel);
    if (!file.startsWith(dir + path.sep)) throw new HttpError(400, 'That path is outside the output folder');
    return file;
  }

  async function copyToHandoff(m, file) {
    await copyFile(path.join(MODELS, m.id, file), path.join(m.renders.outDir, 'models', m.slug + path.extname(file)));
  }

  // Makes <outputRoot>/<slug>/ and copies the model files. Frames, sheets and json arrive through PUT …/file.
  async function startRender(m, { looks = [], formats = [] }) {
    const v = active(m);
    if (v.status !== 'ready') throw new HttpError(409, 'Model is not ready yet');
    if (!Array.isArray(looks) || !looks.every(isLook)) throw new HttpError(400, 'Unknown look');
    if (!Array.isArray(formats) || formats.some((f) => !FORMATS.includes(f))) throw new HttpError(400, 'Unknown model format');
    if (!settings.outputRoot) throw new HttpError(409, 'Choose an output folder first');
    const outDir = path.join(await checkOutputRoot(settings.outputRoot).catch((e) => { throw new HttpError(409, e.message); }), m.slug);
    for (const sub of [...looks.map((l) => path.join('frames', l)), 'web', 'stills', 'models']) await mkdir(path.join(outDir, sub), { recursive: true });
    // A new output folder starts a new record; rendering into the same folder again keeps what's already there.
    const kept = m.renders?.outDir === outDir ? m.renders : { poster: m.renders?.poster };
    m.renders = { ...kept, outDir, formats, at: new Date().toISOString() };
    await copyToHandoff(m, v.glb);
    for (const fmt of formats) {
      if (v.exports[fmt]?.status === 'ready') await copyToHandoff(m, v.exports[fmt].file);
      else await startExport(m, fmt); // copied into the handoff when Tripo finishes converting
    }
    await save();
    return { outDir, slug: m.slug, renders: m.renders };
  }

  // Records what a finished render produced, so the library can show 360/180 badges and the poster.
  async function noteRenderFile(m, rel, file) {
    const sprite = rel.match(/^web\/(studio|transparent)-sprite-(360|180)\.json$/);
    const poster = rel.match(/^web\/(studio|transparent)-poster\.webp$/);
    const still = rel.match(/^stills\/([^/]+\.png)$/);
    if (sprite) m.renders[`${sprite[1]}${sprite[2]}`] = true;
    if (poster) {
      await copyFile(file, path.join(MODELS, m.id, `poster-${poster[1]}.webp`));
      if (poster[1] === 'studio' || !m.renders.poster) m.renders.poster = `poster-${poster[1]}.webp`;
    }
    if (still) m.renders.stills = [...new Set([...(m.renders.stills || []), still[1]])];
    if (sprite || poster || still) await save();
  }

  // ---- Optional Blender renderer ----

  const jobs = new Map(); // model id → running or finished Blender job
  function findBlender() {
    return [settings.blenderPath, ...blenderCandidates()].find((p) => p && existsSync(p)) || null;
  }
  const jobView = (job) => job && { status: job.status, look: job.look, frame: job.frame, frames: job.frames, looks: job.looks, error: job.error };

  function runBlender(job, bin, args) {
    // A .js/.mjs "blender" is run with Node; tests use one so they never need Blender.
    const script = /\.m?js$/i.test(bin);
    return new Promise((resolve, reject) => {
      const child = spawn(script ? process.execPath : bin, script ? [bin, ...args] : args, {
        windowsHide: true, env: script ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      });
      job.child = child;
      let tail = '';
      let buffered = '';
      const onData = (chunk) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop();
        for (const line of lines) {
          const hit = line.match(/^FLATFORM_FRAME (\d+) (\d+)/);
          if (hit) job.frame = Number(hit[1]);
          else if (line.trim()) tail = line.trim();
        }
      };
      child.stdout.setEncoding('utf8').on('data', onData);
      child.stderr.setEncoding('utf8').on('data', (d) => { tail = String(d).trim().split(/\r?\n/).at(-1) || tail; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(job.status === 'cancelled' ? 'Cancelled' : `Blender stopped (exit ${code}): ${tail}`))));
    });
  }

  function startBlender(m, { looks = [], frames = FRAMES, still }) {
    const bin = findBlender();
    if (!bin) throw new HttpError(409, 'Blender not found. Install Blender 4.x or locate it in Settings.');
    if (!m.renders?.outDir) throw new HttpError(409, 'Start the render first');
    if (!Array.isArray(looks) || !looks.length || !looks.every(isLook)) throw new HttpError(400, 'Unknown look');
    if (![FRAMES, HALF, 0].includes(frames)) throw new HttpError(400, `Render ${FRAMES} or ${HALF} frames`);
    if (still !== undefined && !(Number.isFinite(still) && still >= 0 && still < 360)) throw new HttpError(400, 'Bad still angle');
    if (jobs.get(m.id)?.status === 'running') throw new HttpError(409, 'Blender is already rendering this car');
    const v = active(m);
    const sceneFile = path.join(MODELS, m.id, 'scene.json');
    const job = { status: 'running', looks, look: looks[0], frame: 0, frames, error: null };
    jobs.set(m.id, job);
    (async () => {
      for (const look of looks) {
        job.look = look;
        job.frame = 0;
        const { width, height } = LOOKS[look];
        await runBlender(job, bin, [
          '-b', '-P', blenderScript, '--',
          '--glb', path.join(MODELS, m.id, v.glb), '--out', path.join(m.renders.outDir, 'frames', look), '--slug', m.slug,
          '--look', look, '--frames', String(frames), '--step', String(STEP), '--res', `${width}x${height}`,
          ...(existsSync(sceneFile) ? ['--scene', sceneFile] : []),
          ...(still !== undefined ? ['--still', String(still), '--still-out', path.join(m.renders.outDir, 'stills', stillName(m.slug, look, still))] : []),
        ]);
      }
      job.status = 'done';
    })().catch((e) => {
      if (job.status === 'running') job.status = 'failed';
      job.error = e.message;
    });
    return jobView(job);
  }

  // Overlapping polls for the same task share one refresh, so a result is never downloaded twice.
  const inflight = new Map();
  const once = (key, fn) => {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
  };

  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  function serveFile(res, file, headers = {}) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...headers });
    createReadStream(file).pipe(res);
  }

  // Resolves URL path parts under dir, refusing anything that climbs out of it.
  function inside(dir, parts) {
    if (parts.some((p) => p.includes('\0'))) throw new HttpError(404, 'Not found');
    const file = path.resolve(dir, ...parts);
    if (!file.startsWith(dir + path.sep)) throw new HttpError(404, 'Not found');
    return file;
  }

  const findModel = (id) => library.find((x) => x.id === id) || (() => { throw new HttpError(404, 'Model not found'); })();

  async function route(req, res) {
    // Only answer requests addressed to this server, so a web page can't reach it through DNS rebinding.
    const { port: actual } = server.address();
    const hosts = [`127.0.0.1:${actual}`, `localhost:${actual}`];
    if (!hosts.includes(req.headers.host)) throw new HttpError(403, 'Forbidden');
    // Any web page can still send requests to this port. Only the app's own pages may change anything.
    const { method } = req;
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin !== undefined && !hosts.some((h) => req.headers.origin === `http://${h}`)) {
      throw new HttpError(403, 'Forbidden');
    }
    const url = new URL(req.url, 'http://localhost');
    let parts;
    try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw new HttpError(400, 'Bad URL'); }

    if (parts[0] !== 'api') {
      if (method !== 'GET') throw new HttpError(404, 'Not found');
      if (parts[0] === 'files') return serveFile(res, inside(MODELS, parts.slice(1)));
      if (parts[0] === 'backdrops') return serveFile(res, inside(BACKDROPS, parts.slice(1)));
      if (parts[0] === 'vendor' && parts[1] === 'three' && parts[2] === 'examples' && parts[3] === 'jsm') return serveFile(res, inside(threeAddons, parts.slice(4)));
      if (parts[0] === 'vendor' && parts[1] === 'three' && parts[2] === 'build') return serveFile(res, inside(THREE, parts.slice(2)));
      const file = inside(PUBLIC, parts.length ? parts : ['index.html']);
      return serveFile(res, file, file.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {});
    }

    const [, area, id, sub, extra] = parts;
    if (area === 'account' && !id && method === 'GET') {
      if (!keyStore.get()) return send(res, 200, { hasKey: false });
      return send(res, 200, { hasKey: true, ...(await tripo('/account/balance')) });
    }
    if (area === 'settings' && !id && method === 'GET') return send(res, 200, settingsView());
    if (area === 'settings' && !id && method === 'POST') {
      const body = await readJson(req);
      if (!('apiKey' in body)) return send(res, 200, await saveSettings(body));
      const key = String(body.apiKey || '').trim();
      if (!/^[\w-]{10,200}$/.test(key)) throw new HttpError(400, 'That does not look like a Tripo API key');
      const balance = await tripo('/account/balance', { key }); // only save keys Tripo accepts
      await keyStore.set(key);
      return send(res, 200, { hasKey: true, ...balance });
    }
    if (area === 'blender' && !id && method === 'GET') {
      const found = findBlender();
      return send(res, 200, { found: Boolean(found), path: found, configured: settings.blenderPath });
    }
    if (area === 'backdrops' && !id && method === 'GET') return send(res, 200, settings.backdrops);
    if (area === 'backdrops' && !id && method === 'POST') {
      return send(res, 201, await uploadBackdrop(req, url.searchParams.get('slot'), url.searchParams.get('name')));
    }

    if (area === 'models') {
      if (!id && method === 'GET') return send(res, 200, library);
      if (!id && method === 'POST') return send(res, 201, await createModel(req, url.searchParams.get('name')));
      const m = findModel(id);
      if (!sub && method === 'GET') {
        await once(id, () => refreshModel(m));
        return send(res, 200, m);
      }
      if (!sub && method === 'PATCH') return send(res, 200, await patchModel(m, await readJson(req, 64 * 1024)));
      if (!sub && method === 'DELETE') {
        jobs.get(id)?.child?.kill();
        jobs.delete(id);
        library.splice(library.indexOf(m), 1);
        await rm(path.join(MODELS, id), { recursive: true, force: true });
        await save();
        return send(res, 200, { ok: true });
      }
      if (sub === 'retry' && method === 'POST') return send(res, 200, await retry(m));
      if (sub === 'versions' && method === 'POST') return send(res, 201, await addVersion(req, m));
      if (sub === 'exports' && FORMATS.includes(extra) && method === 'POST') return send(res, 202, await startExport(m, extra));
      if (sub === 'exports' && FORMATS.includes(extra) && method === 'GET') {
        await once(`${id}:${m.activeVersion}:${extra}`, () => refreshExport(m, extra));
        return send(res, 200, active(m).exports[extra] ?? null);
      }
    }

    if (area === 'renders' && id) {
      const m = findModel(id);
      if (sub === 'start' && method === 'POST') return send(res, 200, await startRender(m, await readJson(req)));
      if (sub === 'file' && method === 'PUT') {
        const rel = url.searchParams.get('path');
        const file = renderFile(m, rel);
        await streamToFile(req, file, MAX_RENDER_FILE);
        await noteRenderFile(m, rel, file);
        return send(res, 201, { ok: true });
      }
      if (sub === 'file' && method === 'GET') return serveFile(res, renderFile(m, url.searchParams.get('path')));
      if (sub === 'blender' && method === 'POST') return send(res, 202, startBlender(m, await readJson(req)));
      if (sub === 'blender' && method === 'GET') return send(res, 200, jobView(jobs.get(id)) ?? null);
      if (sub === 'blender' && method === 'DELETE') {
        const job = jobs.get(id);
        if (job?.status === 'running') {
          job.status = 'cancelled';
          job.child?.kill();
        }
        return send(res, 200, jobView(job) ?? null);
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => route(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    else res.destroy();
  }));
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return { server, port: server.address().port };
}

// `node server.mjs`: browser version, key from TRIPO_API_KEY.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let key = process.env.TRIPO_API_KEY;
  const { port } = await startServer({
    dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
    port: Number(process.env.PORT || 5173),
    ...(process.env.TRIPO_BASE && { apiBase: process.env.TRIPO_BASE }),
    ...(process.env.TRIPO_MODEL && { model: process.env.TRIPO_MODEL }),
    keyStore: { get: () => key, set: (k) => { key = k; } }, // in memory only; put it in .env to keep it
  });
  console.log(`Flatform on http://localhost:${port}`);
}
