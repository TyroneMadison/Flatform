// Flatform server: drag-drop image → Tripo 3D model → local library → export.
// Used two ways: `npm run web` (key from .env) or embedded by the Electron app (main.mjs).
import http from 'node:http';
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEV_VIEWER = path.join(ROOT, 'node_modules', '@google', 'model-viewer', 'dist', 'model-viewer.min.js');
const FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'];
const IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg' };
const MAX_IMAGE = 20 * 1024 * 1024; // Tripo's upload limit for images
const FAILED = ['failed', 'cancelled', 'banned'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.usdz': 'model/vnd.usdz+zip',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Starts the app server on 127.0.0.1.
 * keyStore: { get(): string|undefined, set(key): void|Promise } — where the Tripo API key lives.
 */
export async function startServer({
  dataDir,
  port = 0,
  // Global keys work on .ai; .com (the host the docs show) is the China region and rejects global keys.
  apiBase = 'https://openapi.tripo3d.ai/v3',
  model = 'v3.1-20260211',
  keyStore,
  viewerPath = DEV_VIEWER, // the packaged app ships the 3D viewer script as a resource file
}) {
  const MODELS = path.join(dataDir, 'models');
  const LIB = path.join(dataDir, 'library.json');
  await mkdir(MODELS, { recursive: true });

  // ponytail: whole library in one JSON file rewritten on each change; move to SQLite past a few thousand models
  const library = existsSync(LIB) ? JSON.parse(await readFile(LIB, 'utf8')) : [];
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(async () => {
    await writeFile(LIB + '.tmp', JSON.stringify(library, null, 2));
    await rename(LIB + '.tmp', LIB); // atomic swap so a crash never leaves a half-written library
  }));

  async function tripo(route, { json, body, key = keyStore.get() } = {}) {
    if (!key) throw new HttpError(401, 'Add your Tripo API key first');
    const res = await fetch(apiBase + route, {
      method: json || body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${key}`, ...(json && { 'Content-Type': 'application/json' }) },
      body: json ? JSON.stringify(json) : body,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.code !== 0) {
      throw new HttpError(res.status === 401 ? 401 : 502, `Tripo: ${out.message || `HTTP ${res.status}`}${out.suggestion ? ` (${out.suggestion})` : ''}`);
    }
    return out.data;
  }

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

  async function readBody(req, max) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      if ((size += chunk.length) > max) throw new HttpError(413, 'Too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function createModel(req, name) {
    const type = req.headers['content-type'];
    const ext = IMAGE_TYPES[type];
    if (!ext) throw new HttpError(415, 'Use a PNG or JPEG image');
    const image = await readBody(req, MAX_IMAGE);
    const form = new FormData();
    form.append('file', new Blob([image], { type }), 'image' + ext);
    const { file_token } = await tripo('/files', { body: form });
    const { task_id } = await tripo('/generation/image-to-model', {
      json: { input: file_token, model, texture: true, pbr: true },
    });
    const m = {
      id: randomUUID(), name: (name || 'Untitled').slice(0, 100), status: 'generating', progress: 0,
      task_id, created_at: new Date().toISOString(), source: 'source' + ext, exports: {},
    };
    await mkdir(path.join(MODELS, m.id), { recursive: true });
    await writeFile(path.join(MODELS, m.id, m.source), image);
    library.unshift(m);
    await save();
    return m;
  }

  async function refreshModel(m) {
    if (m.status !== 'generating') return;
    const t = await tripo(`/tasks/${m.task_id}`);
    m.progress = t.progress ?? m.progress;
    if (t.status === 'success') {
      const dir = path.join(MODELS, m.id);
      const url = fileUrl(t.output);
      if (!url) Object.assign(m, { status: 'failed', error: 'Tripo returned no model URL' });
      else {
        m.glb = await download(url, dir, 'model', '.glb');
        if (t.output.rendered_image_url) m.thumb = await download(t.output.rendered_image_url, dir, 'preview', '.png');
        Object.assign(m, { status: 'ready', progress: 100, credits: t.credits_consumed });
      }
    } else if (FAILED.includes(t.status)) Object.assign(m, { status: 'failed', error: `Tripo task ${t.status}` });
    await save();
  }

  async function startExport(m, fmt) {
    if (m.status !== 'ready') throw new HttpError(409, 'Model is not ready yet');
    if (['converting', 'ready'].includes(m.exports[fmt]?.status)) return m.exports[fmt];
    const { task_id } = await tripo('/models/convert', { json: { input: m.task_id, format: fmt } });
    m.exports[fmt] = { status: 'converting', task_id };
    await save();
    return m.exports[fmt];
  }

  async function refreshExport(m, fmt) {
    const e = m.exports[fmt];
    if (e?.status !== 'converting') return;
    const t = await tripo(`/tasks/${e.task_id}`);
    if (t.status === 'success') {
      const url = fileUrl(t.output);
      if (!url) Object.assign(e, { status: 'failed', error: 'Tripo returned no file URL' });
      else Object.assign(e, { status: 'ready', file: await download(url, path.join(MODELS, m.id), `model-${fmt.toLowerCase()}`, '.' + fmt.toLowerCase()) });
    } else if (FAILED.includes(t.status)) Object.assign(e, { status: 'failed', error: `Tripo task ${t.status}` });
    await save();
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

  function serveFile(res, file) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  async function route(req, res) {
    // Only answer requests addressed to this server, so a web page can't reach it through DNS rebinding.
    const { port: actual } = server.address();
    if (![`127.0.0.1:${actual}`, `localhost:${actual}`].includes(req.headers.host)) throw new HttpError(403, 'Forbidden');
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (req.method === 'GET' && url.pathname === '/') return serveFile(res, path.join(ROOT, 'public', 'index.html'));
    if (req.method === 'GET' && url.pathname === '/vendor/model-viewer.js') return serveFile(res, viewerPath);
    if (req.method === 'GET' && parts[0] === 'files') {
      const file = path.join(MODELS, ...parts.slice(1));
      if (!file.startsWith(MODELS + path.sep)) throw new HttpError(404, 'Not found');
      return serveFile(res, file);
    }
    if (url.pathname === '/api/account' && req.method === 'GET') {
      if (!keyStore.get()) return send(res, 200, { hasKey: false });
      return send(res, 200, { hasKey: true, ...(await tripo('/account/balance')) });
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const { apiKey } = JSON.parse((await readBody(req, 4096)).toString() || '{}');
      const key = String(apiKey || '').trim();
      if (!/^[\w-]{10,200}$/.test(key)) throw new HttpError(400, 'That does not look like a Tripo API key');
      const balance = await tripo('/account/balance', { key }); // only save keys Tripo accepts
      await keyStore.set(key);
      return send(res, 200, { hasKey: true, ...balance });
    }
    if (parts[0] !== 'api' || parts[1] !== 'models') throw new HttpError(404, 'Not found');
    const [, , id, sub, fmt] = parts;
    if (!id && req.method === 'GET') return send(res, 200, library);
    if (!id && req.method === 'POST') return send(res, 201, await createModel(req, url.searchParams.get('name')));
    const m = library.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'Model not found');
    if (!sub && req.method === 'GET') {
      await once(id, () => refreshModel(m));
      return send(res, 200, m);
    }
    if (!sub && req.method === 'DELETE') {
      library.splice(library.indexOf(m), 1);
      await rm(path.join(MODELS, id), { recursive: true, force: true });
      await save();
      return send(res, 200, { ok: true });
    }
    if (sub === 'exports' && FORMATS.includes(fmt) && req.method === 'POST') return send(res, 202, await startExport(m, fmt));
    if (sub === 'exports' && FORMATS.includes(fmt) && req.method === 'GET') {
      await once(id + fmt, () => refreshExport(m, fmt));
      return send(res, 200, m.exports[fmt] ?? null);
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer((req, res) => route(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (err.status === 413 && req.url.startsWith('/api/models')) err.message = 'Image too large (max 20 MB)';
    if (!res.headersSent) send(res, err.status || 500, { error: err.message });
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
