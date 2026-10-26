// Flatform server: photos → 3D model (Tripo direct or 3D AI Studio) → local library → scene → turntable renders →
// handoff folder. Used two ways: `npm run web` (keys from .env) or embedded by the Electron app (main.mjs).
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, rm, copyFile, stat, open } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { uniqueSlug, stillName, LOOKS, FRAMES, HALF, STEP, DEFAULT_LIGHTING, DEFAULT_GLASS, cleanLighting, cleanGlass, PLATES, plateCamera } from './public/lib/pipeline.js';
import { PROVIDERS, VIEWS, normalize, tripoDirectBody, threeDAIRequest } from './public/lib/engines.js';
import { estimate } from './public/lib/pricing.js';
import { threeDAIStudio, createLimiter, THREE_D_AI_BASE, HIGH } from './providers.mjs';
import { createKeyStore } from './keys.mjs';
import { createUpdater, parseVersion, updateOptions } from './updates.mjs';
import { SERVICES, CONVERT_CREDITS, entry, append, parse, summary, defaultThresholds } from './ledger.mjs';
import { check as checkTennogen, fixPlan, CONTENT_TYPES, EXPORT_MODES } from './public/lib/tennogen.js';
import { pngSize, resizePng } from './png.mjs';

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
const MAX_IMAGE = 20 * 1024 * 1024; // Tripo's and 3D AI Studio's limit for images
const MAX_FORM = VIEWS.length * MAX_IMAGE + 1024 * 1024; // four views and the setup
const MAX_MODEL = 300 * 1024 * 1024; // a dropped 3D model: its GLB, the original file and a preview
export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.usdz']; // 3D files the Drop step takes
const MAX_RENDER_FILE = 128 * 1024 * 1024; // a 6144 px PNG sprite sheet fits easily
const MAX_BACKDROP = 256 * 1024 * 1024; // 4K EXR HDRIs are big
const RENDER_TYPES = ['.png', '.webp', '.json', '.js', '.html', '.md', '.glb'];
const BACKDROP_TYPES = ['.jpg', '.jpeg', '.png', '.hdr', '.exr'];
const FAILED = ['failed', 'cancelled', 'banned'];
// Global keys work on .ai; .com (the host the docs show) is the China region and rejects global keys.
const REGIONS = { global: 'https://openapi.tripo3d.ai/v3', china: 'https://openapi.tripo3d.com/v3' };
const SCENES = [...Object.keys(PLATES), 'ring', 'transparent', 'cyclorama', 'miami', 'custom']; // 'ring' was called 'gold' before v0.4
// Version fields mirrored at the top level of each library entry, so v0.2 readers and the UI see the active version.
const VERSION_FIELDS = ['task_id', 'status', 'progress', 'tripo_status', 'glb', 'thumb', 'credits', 'error', 'exports', 'source',
  'provider', 'engine', 'mode', 'views', 'upstream_status', 'note', 'generation', 'file', 'fileName'];
const RESULTS_KEPT = 24 * 60 * 60 * 1000; // 3D AI Studio deletes results after 24 hours
const EXPIRED = '3D AI Studio keeps results for 24 hours and this job is older, so its model is gone. Retry to generate it again.';
const KEY_FORMAT = /^[\x21-\x7e]{10,300}$/; // printable, no spaces; it goes into an Authorization header
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

// Where Blender usually lives. Blender is optional and never bundled. On Windows that is the installer's
// Program Files folder on any drive, Steam, a portable zip unpacked in the home folder, or anything on PATH.
export function blenderCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['/Applications/Blender.app/Contents/MacOS/Blender', path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender')];
  const onPath = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
    .map((d) => path.join(d, platform === 'win32' ? 'blender.exe' : 'blender'));
  if (platform !== 'win32') return [...onPath, '/usr/bin/blender', '/snap/bin/blender'];
  // Newest version first inside each folder that holds versioned Blender folders.
  const versions = (base) => {
    let dirs = [];
    try { dirs = readdirSync(base).filter((d) => /^blender/i.test(d)); } catch { /* not there */ }
    return dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((d) => path.join(base, d, 'blender.exe'));
  };
  const home = env.USERPROFILE || os.homedir();
  const drives = [];
  for (let c = 67; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; if (existsSync(d)) drives.push(d); } // C: to Z:
  const programFiles = [...new Set([env.ProgramFiles, env['ProgramFiles(x86)'], ...drives.flatMap((d) => [`${d}Program Files`, `${d}Program Files (x86)`])].filter(Boolean))];
  const steam = [...new Set([env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Steam'), ...drives.flatMap((d) => [`${d}SteamLibrary`, `${d}Steam`])].filter(Boolean))];
  return [
    ...programFiles.flatMap((p) => versions(path.join(p, 'Blender Foundation'))),
    ...steam.map((s) => path.join(s, 'steamapps', 'common', 'Blender', 'blender.exe')),
    ...(env.LOCALAPPDATA ? versions(path.join(env.LOCALAPPDATA, 'Programs')) : []),
    ...versions(home), ...versions(path.join(home, 'Blender')), // portable zips
    ...onPath,
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'blender.exe')] : []), // Microsoft Store alias
  ];
}

/**
 * Starts the app server on 127.0.0.1.
 * keyStore: keys.mjs createKeyStore() — get/source/set/remove(provider). Keys never reach the page.
 * apiBase: fixed Tripo endpoint (tests, TRIPO_BASE). Without it the Region setting picks one of REGIONS.
 * threeDAIBase: 3D AI Studio endpoint (tests, THREE_D_AI_STUDIO_BASE). rateWindowMs: its rate-limit window (tests).
 * updateUrl, updateDelayMs: where and how soon after start to look for a newer release (updates.mjs updateOptions).
 * Without updateUrl, as in tests, nothing ever asks GitHub.
 */
export async function startServer({
  dataDir,
  port = 0,
  apiBase: fixedApiBase,
  model = 'v3.1-20260211',
  keyStore,
  threeDAIBase = THREE_D_AI_BASE,
  rateWindowMs, // default: a minute plus slack, see providers.mjs
  blenderScript = path.join(ROOT, 'render', 'blender_turntable.py'), // the packaged app ships it as a resource file
  // three.js addons (loaders, controls, decoders). electron-builder drops every dependency's examples/ folder,
  // so the packaged app ships this one as a resource file too.
  threeAddons = path.join(THREE, 'examples', 'jsm'),
  updateUrl,
  updateDelayMs,
  onLowBalance, // (service, { balance, threshold }) when GET /api/spend finds a balance under its alert (main.mjs notifies)
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
    region: 'global', model, texture: true, pbr: true, provider: 'tripo', setups: {},
    renderer: 'three', blenderPath: '', outputRoot: '', defaultScene: 'showroom', alsoTransparent: true, backdrops: {},
    lighting: DEFAULT_LIGHTING, glass: DEFAULT_GLASS,
    updates: { autoCheck: true, skippedVersion: null },
    spend: { thresholds: defaultThresholds() }, // low-balance alert per provider, in credits
    tennogenCheck: 'warn', // before an export of a Warframe model with a texture folder: warn, block or off
  };
  const settings = { ...defaults, ...(existsSync(SETTINGS) ? JSON.parse(await readFile(SETTINGS, 'utf8')) : {}) };
  if (settings.defaultScene === 'gold') settings.defaultScene = 'ring';
  // v0.5: Showroom became the default scene. 'ring' was the old built-in default, so it moves over once.
  if (!settings.scenesV5) Object.assign(settings, { scenesV5: true, ...(settings.defaultScene === 'ring' && { defaultScene: 'showroom' }) });
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
  // Before v0.4 every version came from Tripo, and the gold-ring studio preset was called 'gold'.
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
    for (const v of m.versions) if (!v.provider) { v.provider = 'tripo'; migrated = true; }
    if (m.scene?.preset === 'gold') {
      m.scene.preset = 'ring';
      if (existsSync(path.join(MODELS, m.id))) await writeAtomic(path.join(MODELS, m.id, 'scene.json'), m.scene);
      migrated = true;
    }
    mirror(m);
  }
  // A 3D AI Studio job older than a day can never be downloaded any more.
  for (const m of library) {
    for (const v of m.versions) {
      if (v.provider === '3daistudio' && v.status === 'generating' && Date.now() - Date.parse(v.submitted_at || v.created_at) > RESULTS_KEPT) {
        Object.assign(v, { status: 'failed', error: EXPIRED });
        mirror(m);
        migrated = true;
      }
    }
  }
  if (migrated) await save();
  const slugsExcept = (m) => library.filter((x) => x !== m).map((x) => x.slug);

  async function tripo(route, { json, body, key = keyStore.get('tripo') } = {}) {
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

  // Photos come in as PNG, JPEG or HEIC. HEIC is converted to JPEG here because the providers and browsers can't read it.
  async function toImage(image, type) {
    type = String(type || '').split(';')[0].trim().toLowerCase();
    if (!Object.hasOwn(IMAGE_TYPES, type) && !HEIC_TYPES.includes(type)) throw new HttpError(415, 'Use a PNG, JPEG or HEIC image');
    if (image.length > MAX_IMAGE) throw new HttpError(413, 'Image too large (max 20 MB)');
    if (HEIC_TYPES.includes(type)) {
      const { default: convert } = await import('heic-convert');
      try { image = Buffer.from(await convert({ buffer: image, format: 'JPEG', quality: 0.92 })); } catch {
        throw new HttpError(415, 'Could not read that HEIC photo. Export it as JPEG and try again.');
      }
      type = 'image/jpeg';
    }
    return { image, type };
  }

  // What a generation was made with before v0.4 (and what a bare photo upload still gets): Tripo direct with the
  // model and texture settings. Sends exactly the request v0.3 did.
  const legacySetup = () => normalize({
    provider: 'tripo', engine: 'tripo-direct',
    options: { model: settings.model, texture: !settings.texture ? 'none' : settings.pbr ? 'pbr' : 'color' },
  });
  const setupOf = (v) => (v.engine ? normalize({ provider: v.provider, engine: v.engine, mode: v.mode, options: v.options }) : legacySetup());

  /**
   * The setup and photos of a request. Either multipart (fields "setup" and "name", files front/left/back/right),
   * or one raw image with its own Content-Type (the v0.3 API: Tripo direct with the saved defaults).
   * Without any body: { setup: null, views: {} }, so the caller reuses what it had.
   */
  async function readInput(req) {
    const contentType = String(req.headers['content-type'] || '');
    if (!contentType) return { setup: null, views: {} };
    if (!/^multipart\/form-data/i.test(contentType)) return { setup: legacySetup(), views: { front: await toImage(await readBody(req, MAX_IMAGE, 'Image too large (max 20 MB)'), contentType) } };
    let form;
    try { form = await new Response(await readBody(req, MAX_FORM, 'Photos too large (max 20 MB each)'), { headers: { 'Content-Type': contentType } }).formData(); } catch (e) {
      throw e.status ? e : new HttpError(400, 'Bad form');
    }
    let setup;
    try { setup = normalize(JSON.parse(String(form.get('setup')))); } catch { throw new HttpError(400, 'Unknown provider or engine'); }
    const views = {};
    for (const view of VIEWS) {
      const file = form.get(view);
      if (file && typeof file === 'object') views[view] = await toImage(Buffer.from(await file.arrayBuffer()), file.type);
    }
    return { setup, views, name: form.get('name'), workspace: workspaceOf(form.get('workspace')) };
  }
  const workspaceOf = (w) => (w === 'warframe' ? 'warframe' : 'car');

  // Checks a setup has the photos it needs. views: { front, left, back, right } of { image, type }.
  function checkViews(setup, views) {
    if (!views.front) throw new HttpError(400, setup.mode === 'views' ? 'Add the front view' : 'Add a photo');
    if (setup.mode === 'views' && Object.keys(views).length < 2) throw new HttpError(400, 'Add the front view and at least one more');
    if (setup.mode === 'single') for (const v of VIEWS.slice(1)) delete views[v];
    if (setup.provider === '3daistudio' && !keyStore.get('3daistudio')) throw new HttpError(401, 'Add your 3D AI Studio API key first');
  }

  // Starts a generation with the provider. Returns its task id.
  async function submit(setup, views, modelId) {
    const spend = {
      task: setup.mode === 'views' ? 'multiview_to_model' : 'image_to_model', model: setup.options.model || setup.engine,
      credits: estimate(setup).credits, modelId,
    };
    if (setup.provider === 'tripo') {
      const { image, type } = views.front;
      const form = new FormData();
      form.append('file', new Blob([image], { type }), 'image' + IMAGE_TYPES[type]);
      const { file_token } = await tripo('/files', { body: form }); // uploads are free
      const { task_id } = await paid('tripo', spend, () => tripo('/generation/image-to-model', { json: tripoDirectBody(setup.options, file_token) }));
      return task_id;
    }
    const uris = Object.fromEntries(Object.entries(views).map(([view, { image, type }]) => [view, `data:${type};base64,${image.toString('base64')}`]));
    const { path: route, body } = threeDAIRequest(setup, uris);
    const { task_id } = await paid('3daistudio', spend, () => ai.submit(route, body));
    if (typeof task_id !== 'string' || !task_id) throw new HttpError(502, '3D AI Studio: no task id in the reply');
    if (wallet.at) wallet.balance -= estimate(setup).credits; // charged on submission, so the balance is right without asking
    wakePoller();
    return task_id;
  }

  // Saves a version's photos: source{-vN}.ext for the front (or only) photo, source{-vN}-left.ext and so on.
  async function saveViews(m, n, views) {
    const names = {};
    for (const [view, { image, type }] of Object.entries(views)) {
      names[view] = vname('source', n) + (view === 'front' ? '' : `-${view}`) + IMAGE_TYPES[type];
      await writeFile(path.join(MODELS, m.id, names[view]), image);
    }
    return names;
  }
  async function readViews(m, v) {
    const names = v.views || { front: v.source };
    const views = {};
    for (const [view, file] of Object.entries(names)) views[view] = { image: await readFile(path.join(MODELS, m.id, file)), type: typeOf(file) };
    return views;
  }

  // What a generation was made with, kept with the version for the model page. Versions from before v0.5 have
  // no record (their options may be a guess from the settings of the day), so the page says "not recorded".
  const generationOf = (setup) => ({
    provider: setup.provider, engine: setup.engine, mode: setup.mode, options: setup.options,
    prompt: typeof setup.options?.prompt === 'string' ? setup.options.prompt : null, credits: estimate(setup).credits,
  });
  const newVersion = (n, setup, task_id, names) => {
    const now = new Date().toISOString();
    return {
      n, created_at: now, submitted_at: now, provider: setup.provider, engine: setup.engine, mode: setup.mode, options: setup.options,
      generation: generationOf(setup),
      estimate: estimate(setup).credits, task_id, status: 'generating', progress: 0,
      ...(setup.provider === 'tripo' ? { tripo_status: 'queued' } : { upstream_status: 'PENDING' }),
      source: names.front, ...(setup.mode === 'views' && { views: names }), exports: {},
    };
  };

  // A 3D model dropped on the Drop step. The page sends a GLB (the file itself, or converted in the page with
  // three.js loaders from GLTF, FBX, OBJ or USDZ), the original file and a PNG preview. It skips Generate.
  async function importModel(req) {
    const contentType = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data/i.test(contentType)) throw new HttpError(415, 'Send the model as a form');
    let form;
    try { form = await new Response(await readBody(req, MAX_MODEL, 'Model too large (max 300 MB)'), { headers: { 'Content-Type': contentType } }).formData(); } catch (e) {
      throw e.status ? e : new HttpError(400, 'Bad form');
    }
    const glbFile = form.get('glb');
    if (!glbFile || typeof glbFile !== 'object') throw new HttpError(400, 'Add a 3D model');
    const glb = Buffer.from(await glbFile.arrayBuffer());
    if (glb.length < 20 || glb.toString('latin1', 0, 4) !== 'glTF' || glb.readUInt32LE(4) !== 2) throw new HttpError(415, 'That is not a GLB 2.0 file');
    const original = form.get('original');
    const originalName = path.basename(String((original && typeof original === 'object' ? original.name : form.get('fileName')) || ''));
    const ext = path.extname(originalName).toLowerCase();
    if (originalName && !MODEL_EXTS.includes(ext)) throw new HttpError(415, `Use a ${MODEL_EXTS.join(', ').toUpperCase().replaceAll('.', '')} file`);
    const preview = form.get('preview');
    const id = randomUUID();
    const now = new Date().toISOString();
    const m = { id, name: cleanName(form.get('name') || originalName.replace(/\.[^.]+$/, '')), created_at: now, activeVersion: 1, versions: [], workspace: workspaceOf(form.get('workspace')) };
    m.slug = uniqueSlug(m.name, slugsExcept(m));
    await mkdir(path.join(MODELS, m.id), { recursive: true });
    await writeFile(path.join(MODELS, m.id, 'model.glb'), glb);
    const v = { n: 1, created_at: now, provider: 'upload', status: 'ready', progress: 100, glb: 'model.glb', exports: {}, credits: 0, generation: null };
    if (original && typeof original === 'object' && ext !== '.glb') {
      v.file = `original${ext}`;
      await writeFile(path.join(MODELS, m.id, v.file), Buffer.from(await original.arrayBuffer()));
    }
    v.fileName = originalName || 'model.glb';
    if (preview && typeof preview === 'object' && preview.size && preview.size < MAX_IMAGE) {
      const png = Buffer.from(await preview.arrayBuffer());
      if (png.subarray(1, 4).toString('latin1') === 'PNG') { v.thumb = 'preview.png'; await writeFile(path.join(MODELS, m.id, v.thumb), png); }
    }
    m.versions.push(v);
    library.unshift(mirror(m));
    await save();
    return m;
  }

  async function createModel(req, queryName) {
    const { setup, views, name, workspace } = await readInput(req);
    if (!setup) throw new HttpError(400, 'Add a photo');
    checkViews(setup, views);
    const id = randomUUID();
    const task_id = await submit(setup, views, id);
    const m = { id, name: cleanName(name ?? queryName), created_at: new Date().toISOString(), activeVersion: 1, versions: [], workspace: workspace || 'car' };
    m.slug = uniqueSlug(m.name, slugsExcept(m));
    await mkdir(path.join(MODELS, m.id), { recursive: true });
    m.versions.push(newVersion(1, setup, task_id, await saveViews(m, 1, views)));
    library.unshift(mirror(m));
    await save();
    return m;
  }

  // Regenerate: a new task, with a new setup and/or new photos when the request has them, otherwise the active
  // version's. Old versions stay.
  async function addVersion(req, m) {
    const n = Math.max(...m.versions.map((v) => v.n)) + 1;
    const input = await readInput(req);
    const setup = input.setup || setupOf(active(m));
    const fresh = Boolean(input.views.front);
    const views = fresh ? input.views : await readViews(m, active(m));
    checkViews(setup, views);
    const task_id = await submit(setup, views, m.id);
    const names = fresh ? await saveViews(m, n, views)
      : Object.fromEntries(Object.keys(views).map((view) => [view, (active(m).views || { front: active(m).source })[view]]));
    m.versions.push(newVersion(n, setup, task_id, names));
    m.activeVersion = n;
    mirror(m);
    await save();
    return m;
  }

  async function retry(m) {
    const v = active(m);
    if (v.status !== 'failed') throw new HttpError(409, 'Only a failed model can be retried');
    const setup = setupOf(v);
    const views = await readViews(m, v);
    checkViews(setup, views);
    const task_id = await submit(setup, views, m.id);
    for (const k of ['error', 'note', 'checked_at', 'tripo_status', 'upstream_status']) delete v[k];
    Object.assign(v, newVersion(v.n, setup, task_id, v.views || { front: v.source }));
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

  // Tripo tasks are checked when the page asks. 3D AI Studio jobs are checked by the poller below instead.
  async function refreshModel(m) {
    const pending = m.versions.filter((v) => v.status === 'generating' && v.provider === 'tripo');
    if (!pending.length) return;
    for (const v of pending) await refreshVersion(m, v);
    mirror(m);
    await save();
  }

  // ---- 3D AI Studio: every call goes through one limiter (3 a minute) ----

  const ai = threeDAIStudio({ base: threeDAIBase, key: () => keyStore.get('3daistudio'), limiter: createLimiter(rateWindowMs ? { windowMs: rateWindowMs } : {}) });
  // Status checks run in the background, at most two a minute between them, so the third request of each minute
  // is free for a Generate click or a key test. The oldest-checked job goes first, so with more jobs waiting each
  // one is checked less often.
  const pollGap = Math.ceil(ai.limiter.windowMs / 2);
  const aiJobs = () => library.flatMap((m) => m.versions.filter((v) => v.provider === '3daistudio' && v.status === 'generating').map((v) => ({ m, v })));
  let pollTimer = null;
  let stopped = false;
  function wakePoller(delay = pollGap) {
    if (pollTimer || stopped) return;
    pollTimer = setTimeout(pollNext, delay);
    pollTimer.unref?.();
  }
  async function pollNext() {
    const [job] = aiJobs().sort((a, b) => String(a.v.checked_at || '').localeCompare(String(b.v.checked_at || '')));
    if (job) await once(`ai:${job.v.task_id}`, () => checkAiJob(job.m, job.v)).catch((e) => console.error(e.message));
    pollTimer = null;
    if (aiJobs().length) wakePoller();
  }

  async function checkAiJob(m, v) {
    if (v.status !== 'generating') return;
    if (Date.now() - Date.parse(v.submitted_at || v.created_at) > RESULTS_KEPT) return finishAiJob(m, v, { status: 'failed', error: EXPIRED });
    v.checked_at = new Date().toISOString();
    let s;
    try {
      s = await ai.status(v.task_id);
    } catch (e) {
      if (e.upstream === 410) return finishAiJob(m, v, { status: 'failed', error: EXPIRED });
      if (e.upstream === 404) return finishAiJob(m, v, { status: 'failed', error: '3D AI Studio has no record of this job' });
      if (e.status === 401) return finishAiJob(m, v, { note: 'Waiting for a working 3D AI Studio key' });
      throw e; // offline or rate limited: try again on its next turn
    }
    delete v.note;
    v.upstream_status = s.status;
    if (Number.isFinite(s.progress)) v.progress = Math.max(0, Math.min(100, Math.round(s.progress)));
    if (s.status === 'FAILED') {
      return finishAiJob(m, v, { status: 'failed', error: `3D AI Studio: ${String(s.failure_reason || 'generation failed').slice(0, 300)}. The credits are refunded.` });
    }
    if (s.status !== 'FINISHED') return finishAiJob(m, v, {});
    // Download at once: the links stop working after 24 hours. A failed download is tried again on the next turn.
    const results = Array.isArray(s.results) ? s.results : [];
    const glb = results.find((r) => r?.asset_type === '3D_MODEL') || results.find((r) => /\.glb(\?|$)/i.test(r?.asset || ''));
    const image = results.find((r) => r !== glb && /IMAGE|THUMBNAIL/i.test(r?.asset_type || ''));
    if (!glb?.asset) return finishAiJob(m, v, { status: 'failed', error: '3D AI Studio returned no model' });
    const dir = path.join(MODELS, m.id);
    const done = { glb: await downloadAsset(glb.asset, dir, vname('model', v.n), ['.glb']), status: 'ready', progress: 100, credits: v.estimate };
    if (image?.asset) done.thumb = await downloadAsset(image.asset, dir, vname('preview', v.n), ['.png', '.jpg', '.jpeg', '.webp']).catch(() => undefined);
    wallet.at = 0; // the balance changed
    return finishAiJob(m, v, done);
  }
  async function finishAiJob(m, v, changes) {
    if (!library.includes(m)) return; // deleted meanwhile
    Object.assign(v, changes);
    if (v.status === 'failed') wallet.at = 0; // refunded
    mirror(m);
    await save();
  }

  // Streams a result file into the model folder under a fixed name and extension.
  async function downloadAsset(url, dir, base, exts) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Bad result URL');
    const res = await ai.fetchAsset(url);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    const name = base + (exts.includes(ext) ? ext : exts[0]);
    const tmp = path.join(dir, `${name}.${randomUUID()}.tmp`);
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      await rename(tmp, path.join(dir, name));
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return name;
  }

  // ---- accounts and keys ----

  const wallet = { at: 0 }; // last 3D AI Studio balance; it costs one of the 3 requests a minute, so it's kept a while
  async function account(provider, fresh) {
    if (!keyStore.get(provider)) return { hasKey: false };
    if (provider === 'tripo') return { hasKey: true, ...(await tripo('/account/balance')) };
    if (fresh || Date.now() - wallet.at > 5 * 60 * 1000) {
      const expected = wallet.at ? Number(wallet.balance) : null; // the last balance minus the estimates charged since
      Object.assign(wallet, await ai.wallet({ priority: fresh ? HIGH : undefined }), { at: Date.now() });
      const actual = Number(wallet.balance);
      if (expected != null && Number.isFinite(actual) && expected - actual > 0.005) {
        append(SPEND, entry({ service: '3daistudio', task: 'unlogged charge', model: null, credits: 0, balanceBefore: expected, balanceAfter: actual }))
          .catch((e) => console.error(`Spend ledger: ${e.message}`));
      }
    }
    return { hasKey: true, balance: wallet.balance, rateLimit: wallet.rateLimit, checkedAt: new Date(wallet.at).toISOString() };
  }

  // Saves a key only after the provider accepted it on its free balance check.
  async function saveKey(provider, key) {
    key = String(key ?? '').trim();
    if (!KEY_FORMAT.test(key)) throw new HttpError(400, `That does not look like a ${PROVIDERS[provider].name} API key`);
    const balance = provider === 'tripo' ? await tripo('/account/balance', { key }) : await ai.wallet({ apiKey: key, priority: HIGH });
    await keyStore.set(provider, key);
    if (provider === '3daistudio') { Object.assign(wallet, balance, { at: Date.now() }); wakePoller(1000); } // jobs waiting for a key
    return { hasKey: true, ...balance };
  }
  const keySources = () => Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, keyStore.source(p)]));
  const providerParam = (p) => {
    if (!Object.hasOwn(PROVIDERS, p)) throw new HttpError(404, 'Unknown provider');
    return p;
  };

  // ---- Spend ledger (ledger.mjs): every paid call goes through paid(), which notes the balance before and after ----

  const SPEND = path.join(dataDir, 'spend.jsonl');
  // A balance for the ledger, or null. Never throws and never waits long: the ledger must not hold up a job.
  // 3D AI Studio: the last known balance, since a wallet call costs one of its 3 requests a minute.
  function balanceNow(service) {
    if (service === '3daistudio') return wallet.at ? wallet.balance : null;
    const timeout = new Promise((ok) => setTimeout(ok, 5000, null).unref());
    return Promise.race([account(service).then((a) => a.balance ?? null), timeout]).catch(() => null);
  }
  // fields: { task, model, credits, modelId }. The task id comes from the reply.
  // ponytail: two jobs running at once share their before/after window, so one may show the other's charge as unlogged.
  async function paid(service, fields, call) {
    const balanceBefore = await balanceNow(service);
    const out = await call();
    (async () => {
      let balanceAfter = null;
      // 3D AI Studio allows 3 requests a minute (polls included), so no extra wallet call here: its balance after
      // is checked at the next regular wallet refresh, which logs anything charged beyond the estimates (account()).
      if (service === 'tripo') balanceAfter = await balanceNow(service);
      await append(SPEND, entry({ service, ...fields, taskId: out?.task_id ?? null, balanceBefore, balanceAfter }));
    })().catch((e) => console.error(`Spend ledger: ${e.message}`));
    return out;
  }

  async function spendView() {
    const balances = {};
    for (const s of SERVICES) balances[s] = !keyStore.get(s) ? null : s === '3daistudio' && wallet.at ? wallet.balance : await account(s).then((a) => a.balance ?? null, () => null);
    const view = summary(parse(await readFile(SPEND, 'utf8').catch(() => '')), { balances, thresholds: settings.spend.thresholds });
    for (const [s, v] of Object.entries(view.services)) if (v.low) onLowBalance?.(s, v);
    return view;
  }

  // ---- TennoGen texture set check (public/lib/tennogen.js): names and sizes of the PNGs in a folder ----

  async function textureFolder(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new HttpError(400, 'Pick the folder with the texture files');
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(400, 'That texture folder does not exist');
    return path.resolve(dir);
  }
  const contentType = (type) => {
    if (!Object.hasOwn(CONTENT_TYPES, type)) throw new HttpError(400, `Content type must be one of ${Object.keys(CONTENT_TYPES).join(', ')}`);
    return type;
  };
  // Reads the names and PNG sizes of the files in a texture folder (top level only).
  async function textureFiles(dir) {
    const files = [];
    for (const name of readdirSync(dir).sort()) {
      if (!/\.(png|jpe?g|tga|tif|tiff|bmp|psd|fbx)$/i.test(name)) continue;
      const f = { name };
      if (/\.png$/i.test(name)) {
        const head = Buffer.alloc(24);
        const fh = await open(path.join(dir, name));
        try { await fh.read(head, 0, 24, 0); } finally { await fh.close(); }
        Object.assign(f, pngSize(head) || {});
      }
      files.push(f);
    }
    return files;
  }
  async function tennogenReport(dir, type) {
    dir = await textureFolder(dir);
    type = contentType(type);
    const files = await textureFiles(dir);
    return { dir, files, ...checkTennogen(type, files) };
  }
  // Applies the report's fixes: renames in place, resizes with the original kept in tennogen-original/.
  async function tennogenFix(dir, type) {
    const report = await tennogenReport(dir, type);
    const applied = [];
    for (const fix of fixPlan(report)) {
      const from = path.join(report.dir, fix.file);
      if (fix.kind === 'rename') {
        const to = path.join(report.dir, fix.to);
        if (existsSync(to)) { applied.push({ ...fix, ok: false, error: `${fix.to} already exists` }); continue; }
        await rename(from, to);
        applied.push({ ...fix, ok: true });
      } else if (fix.kind === 'resize') {
        const keep = path.join(report.dir, 'tennogen-original');
        await mkdir(keep, { recursive: true });
        if (!existsSync(path.join(keep, fix.file))) await copyFile(from, path.join(keep, fix.file));
        try {
          await writeFile(from, resizePng(await readFile(from), fix.width, fix.height));
          applied.push({ ...fix, ok: true });
        } catch (e) { applied.push({ ...fix, ok: false, error: e.message }); }
      }
    }
    return { applied, ...(await tennogenReport(report.dir, type)) };
  }

  async function patchModel(m, body) {
    const allowed = ['name', 'activeVersion', 'scene', 'approved', 'workspace', 'tennogen'];
    if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError(400, `Only ${allowed.join(', ')} can be changed`);
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'Give the model a name');
      m.name = cleanName(body.name);
      m.slug = uniqueSlug(m.name, slugsExcept(m));
    }
    if ('approved' in body) {
      if (typeof body.approved !== 'boolean') throw new HttpError(400, 'approved must be true or false');
      m.approved = body.approved; // "Approve this model" in Compose
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
    if ('workspace' in body) {
      if (!['car', 'warframe'].includes(body.workspace)) throw new HttpError(400, 'workspace must be car or warframe');
      m.workspace = body.workspace;
    }
    if ('tennogen' in body) { // the model's TennoGen texture folder and content type, or null
      if (body.tennogen === null) delete m.tennogen;
      else m.tennogen = { dir: await textureFolder(body.tennogen?.dir), type: contentType(body.tennogen?.type) };
    }
    mirror(m);
    await save();
    return m;
  }

  const TRIPO_ONLY = 'Other formats are converted by Tripo, which only works on models made with Tripo direct. GLB works everywhere.';
  async function startExport(m, fmt) {
    const v = active(m);
    if (v.status !== 'ready') throw new HttpError(409, 'Model is not ready yet');
    if (v.provider !== 'tripo') throw new HttpError(409, TRIPO_ONLY);
    if (['converting', 'ready'].includes(v.exports[fmt]?.status)) return v.exports[fmt];
    const { task_id } = await paid('tripo', { task: 'convert', model: `${fmt} conversion`, credits: CONVERT_CREDITS, modelId: m.id },
      () => tripo('/models/convert', { json: { input: v.task_id, format: fmt } }));
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
      } else if (k === 'provider') {
        if (!Object.hasOwn(PROVIDERS, body.provider)) throw new HttpError(400, 'Unknown provider');
        next.provider = body.provider;
      } else if (k === 'setups') {
        // The setup last used with each provider, for the setup screen and the quick queue.
        if (!body.setups || typeof body.setups !== 'object' || Array.isArray(body.setups)) throw new HttpError(400, 'Bad setups');
        next.setups = { ...settings.setups };
        for (const [p, setup] of Object.entries(body.setups)) {
          if (!Object.hasOwn(PROVIDERS, p)) throw new HttpError(400, 'Unknown provider');
          try { next.setups[p] = normalize({ ...setup, provider: p }); } catch { throw new HttpError(400, 'Unknown provider or engine'); }
        }
      } else if (['texture', 'pbr', 'alsoTransparent'].includes(k)) bool(k);
      else if (k === 'renderer') {
        if (!['three', 'blender'].includes(body.renderer)) throw new HttpError(400, 'Renderer must be three or blender');
        next.renderer = body.renderer;
      } else if (k === 'defaultScene') {
        if (!SCENES.includes(body.defaultScene)) throw new HttpError(400, 'Unknown scene');
        next.defaultScene = body.defaultScene;
      } else if (k === 'outputRoot') next.outputRoot = body.outputRoot === '' ? '' : await checkOutputRoot(body.outputRoot);
      else if (k === 'lighting' || k === 'glass') {
        const v = k === 'lighting' ? cleanLighting(body.lighting, settings.lighting) : cleanGlass(body.glass, settings.glass);
        if (!v) throw new HttpError(400, `Bad ${k}`);
        next[k] = v;
      } else if (k === 'blenderPath') next.blenderPath = body.blenderPath === '' ? '' : await checkBlenderPath(body.blenderPath);
      else if (k === 'updates') {
        // Only the automatic check is set here; a skipped version comes from POST /api/update/skip.
        if (typeof body.updates?.autoCheck !== 'boolean' || Object.keys(body.updates).length !== 1) throw new HttpError(400, 'updates must be { autoCheck: true or false }');
        next.updates = { ...settings.updates, autoCheck: body.updates.autoCheck };
      } else if (k === 'spend') {
        // Low-balance alerts: { thresholds: { tripo: credits, '3daistudio': credits } }, either or both.
        const t = body.spend?.thresholds;
        const ok = t && typeof t === 'object' && !Array.isArray(t) && Object.keys(body.spend).length === 1
          && Object.entries(t).every(([s, n]) => SERVICES.includes(s) && Number.isFinite(n) && n >= 0 && n <= 1e7);
        if (!ok) throw new HttpError(400, 'spend must be { thresholds: { tripo, 3daistudio } } in credits');
        next.spend = { thresholds: { ...settings.spend.thresholds, ...t } };
      } else if (k === 'tennogenCheck') {
        if (!Object.hasOwn(EXPORT_MODES, body.tennogenCheck)) throw new HttpError(400, `tennogenCheck must be ${Object.keys(EXPORT_MODES).join(', ')}`);
        next.tennogenCheck = body.tennogenCheck;
      } else throw new HttpError(400, `Unknown setting: ${k}`);
    }
    const replan = next.updates.autoCheck !== settings.updates.autoCheck;
    Object.assign(settings, next);
    await writeAtomic(SETTINGS, settings);
    if (replan) updater.start(); // on: a check in a few seconds; off: none until it's on again
    return settingsView();
  }

  // keys: where each provider's key comes from ('saved', 'env' or 'none'), never the key.
  const settingsView = () => ({
    ...settings, apiBase: apiBase(), regions: REGIONS, version: VERSION, libraryDir: dataDir,
    suggestedOutputRoot: suggestedOutputRoot(), platform: process.platform, keys: keySources(),
  });

  // ---- Update checks (updates.mjs): this server asks GitHub, never the page ----

  const updater = createUpdater({ current: VERSION, url: updateUrl, delayMs: updateDelayMs, settings: () => settings.updates });
  // "Skip this version": its banner never shows again; a newer version's does. Settings still offers it.
  async function skipVersion(version) {
    if (typeof version !== 'string' || !parseVersion(version)) throw new HttpError(400, 'That is not a version number');
    settings.updates = { ...settings.updates, skippedVersion: version };
    await writeAtomic(SETTINGS, settings);
    return updater.view();
  }

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
    if (formats.length && v.provider !== 'tripo') throw new HttpError(409, TRIPO_ONLY);
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
    const looks = Object.keys(LOOKS).join('|');
    const sprite = rel.match(new RegExp(`^web/(${looks})-sprite-(360|180)\\.json$`));
    const poster = rel.match(new RegExp(`^web/(${looks})-poster\\.webp$`));
    const still = rel.match(/^stills\/([^/]+\.png)$/);
    if (sprite) m.renders[`${sprite[1]}${sprite[2]}`] = true;
    if (poster) {
      await copyFile(file, path.join(MODELS, m.id, `poster-${poster[1]}.webp`));
      // The library card shows the house look first: Showroom, then the composed scene, then the cut-out.
      const rank = (file) => ['showroom', 'studio', 'transparent'].indexOf(String(file).replace(/^poster-|\.webp$/g, ''));
      if (!m.renders.poster || rank(`poster-${poster[1]}.webp`) <= rank(m.renders.poster)) m.renders.poster = `poster-${poster[1]}.webp`;
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
    // Photo scenes: Blender renders the car on a shadow catcher with the plate's camera and light; the page lays
    // the frames over the plate when it makes the sprites. The Showroom look always uses the showroom plate.
    const plateArg = (look) => {
      const preset = look === 'showroom' ? 'showroom' : look === 'transparent' ? null : m.scene?.preset || settings.defaultScene;
      if (!PLATES[preset]) return [];
      const modeled = preset === 'showroom' && Boolean(m.scene?.modeled);
      return ['--plate', JSON.stringify({ slug: preset, modeled, camera: plateCamera(PLATES[preset].cam, 4 / 3), light: PLATES[preset].light })];
    };
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
          '--rig', JSON.stringify({ lighting: settings.lighting, glass: settings.glass }),
          ...plateArg(look),
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
    // Balance per provider (Tripo by default). ?fresh asks 3D AI Studio now instead of the last answer.
    if (area === 'account' && !id && method === 'GET') {
      return send(res, 200, await account(providerParam(url.searchParams.get('provider') || 'tripo'), url.searchParams.has('fresh')));
    }
    // Keys go in and can be removed; nothing ever reads one back.
    if (area === 'keys' && id && !sub) {
      const provider = providerParam(id);
      if (method === 'PUT') return send(res, 200, { ...(await saveKey(provider, (await readJson(req)).key)), keys: keySources() });
      if (method === 'DELETE') {
        await keyStore.remove(provider);
        if (provider === '3daistudio') wallet.at = 0;
        return send(res, 200, { keys: keySources() });
      }
    }
    if (area === 'settings' && !id && method === 'GET') return send(res, 200, settingsView());
    if (area === 'settings' && !id && method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      if ('apiKey' in body) return send(res, 200, await saveKey('tripo', body.apiKey)); // the v0.3 key dialog
      return send(res, 200, await saveSettings(body));
    }
    if (area === 'spend' && !id && method === 'GET') return send(res, 200, await spendView());
    if (area === 'update' && !sub) {
      if (!id && method === 'GET') return send(res, 200, updater.view());
      if (id === 'check' && method === 'POST') return send(res, 200, await updater.check());
      if (id === 'skip' && method === 'POST') return send(res, 200, await skipVersion((await readJson(req)).version));
    }
    if (area === 'blender' && !id && method === 'GET') {
      const found = findBlender();
      return send(res, 200, { found: Boolean(found), path: found, configured: settings.blenderPath });
    }
    // TennoGen: check a texture folder, or check and fix it (renames, resizes).
    if (area === 'tennogen' && id === 'check' && !sub && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await tennogenReport(b.dir, b.type));
    }
    if (area === 'tennogen' && id === 'fix' && !sub && method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await tennogenFix(b.dir, b.type));
    }
    if (area === 'backdrops' && !id && method === 'GET') return send(res, 200, settings.backdrops);
    if (area === 'backdrops' && !id && method === 'POST') {
      return send(res, 201, await uploadBackdrop(req, url.searchParams.get('slot'), url.searchParams.get('name')));
    }

    if (area === 'models') {
      if (!id && method === 'GET') return send(res, 200, library);
      if (!id && method === 'POST') return send(res, 201, await createModel(req, url.searchParams.get('name')));
      if (id === 'import' && method === 'POST') return send(res, 201, await importModel(req));
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
  if (aiJobs().length) wakePoller(2000); // jobs that were running when the app closed
  updater.start();
  const close = () => {
    stopped = true;
    clearTimeout(pollTimer);
    ai.limiter.stop();
    updater.stop();
    return new Promise((ok) => server.close(ok));
  };
  return { server, port: server.address().port, close };
}

// `node server.mjs`: browser version, keys from TRIPO_API_KEY and THREE_D_AI_STUDIO_KEY.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { port } = await startServer({
    dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
    port: Number(process.env.PORT || 5173),
    ...(process.env.TRIPO_BASE && { apiBase: process.env.TRIPO_BASE }),
    ...(process.env.TRIPO_MODEL && { model: process.env.TRIPO_MODEL }),
    ...(process.env.THREE_D_AI_STUDIO_BASE && { threeDAIBase: process.env.THREE_D_AI_STUDIO_BASE }),
    ...updateOptions(process.env), // GitHub, or FLATFORM_UPDATE_URL and FLATFORM_UPDATE_DELAY_MS (screenshots, tests)
    keyStore: createKeyStore({ env: process.env }), // keys pasted here live in memory only; put them in .env to keep them
  });
  console.log(`Flatform on http://localhost:${port}`);
}
