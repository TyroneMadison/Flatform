// Local image-to-3D engine: Microsoft TRELLIS (MIT, open weights) in a small Python service on the user's NVIDIA GPU.
// Flatform starts it on the first local generation, checks its health, and stops it when the app closes.
// Weights are downloaded once (with resume) into a folder the user picks. Local generations cost nothing.
// Everything that touches the outside world (spawn, fetch, nvidia-smi) is passed in, so the tests run on mocks.
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Python can't read inside app.asar, so the packaged app ships the script as a resource file.
export const SERVICE_SCRIPT = ROOT.includes('app.asar') && process.resourcesPath
  ? path.join(process.resourcesPath, 'local', 'trellis_service.py') : path.join(ROOT, 'local', 'trellis_service.py');
export const LOCAL_PORT = 41730;
const HF = 'https://huggingface.co/microsoft/TRELLIS-image-large/resolve/main';
// What TRELLIS-image-large needs (about 3.3 GB). The downloader is generic; this is just its default list.
export const TRELLIS_FILES = [
  'pipeline.json',
  ...['ss_dec_conv3d_16l8_fp16', 'ss_flow_img_dit_L_16l8_fp16', 'slat_dec_gs_swin8_B_64l8gs32_fp16', 'slat_dec_rf_swin8_B_64l8r16_fp16',
    'slat_dec_mesh_swin8_B_64l8m256c_fp16', 'slat_flow_img_dit_L_64l8p2_fp16'].flatMap((n) => [`ckpts/${n}.json`, `ckpts/${n}.safetensors`]),
].map((f) => ({ path: f, url: `${HF}/${f}` }));

export class LocalEngineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The GPU, or a clear error. run(cmd, args) → stdout (nvidia-smi). */
export async function checkCuda(run = execText) {
  let out;
  try { out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']); } catch {
    throw new LocalEngineError(503, 'No NVIDIA graphics card found. The free local engine needs one with CUDA (8 GB or more). Pick Tripo or 3D AI Studio instead.');
  }
  const [name, mem] = String(out).split('\n')[0].split(',').map((s) => s.trim());
  const memoryGB = Math.round(Number(mem) / 1024);
  if (!name) throw new LocalEngineError(503, 'No NVIDIA graphics card found.');
  if (memoryGB && memoryGB < 8) throw new LocalEngineError(503, `${name} has ${memoryGB} GB. The local engine needs 8 GB or more.`);
  return { name, memoryGB };
}
function execText(cmd, args) {
  return new Promise((ok, fail) => execFile(cmd, args, { timeout: 10000, windowsHide: true }, (e, out) => (e ? fail(e) : ok(out))));
}

/**
 * Downloads files into dir, resuming any .part left by a failed run (HTTP Range). Files already complete are
 * skipped. onProgress({ done, total, file }) in bytes (total is null until every size is known).
 */
export async function downloadWeights({ dir, files = TRELLIS_FILES, fetch = globalThis.fetch, onProgress = () => {}, signal } = {}) {
  await mkdir(dir, { recursive: true });
  const marker = path.join(dir, 'complete.json');
  if (existsSync(marker)) return { skipped: true, dir };
  let done = 0;
  for (const f of files) {
    const dest = path.join(dir, ...f.path.split('/'));
    if (existsSync(dest)) { done += (await stat(dest)).size; onProgress({ done, total: null, file: f.path }); continue; }
    await mkdir(path.dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const have = existsSync(part) ? (await stat(part)).size : 0;
    const res = await fetch(f.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal });
    if (!res.ok && res.status !== 206) throw new LocalEngineError(502, `Download of ${f.path} failed: HTTP ${res.status}. Try again; it picks up where it stopped.`);
    const resumed = res.status === 206;
    let got = resumed ? have : 0;
    done += got;
    const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    try {
      for await (const chunk of res.body) {
        out.write(chunk);
        got += chunk.length;
        done += chunk.length;
        onProgress({ done, total: null, file: f.path });
      }
    } finally { await new Promise((ok) => out.end(ok)); }
    const want = Number(res.headers.get('content-length'));
    if (want && got !== (resumed ? have + want : want)) throw new LocalEngineError(502, `Download of ${f.path} stopped early. Try again; it picks up where it stopped.`);
    await rename(part, dest);
  }
  await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), files: files.map((f) => f.path) }));
  onProgress({ done, total: done, file: null });
  return { skipped: false, dir };
}
export const weightsReady = (dir) => existsSync(path.join(dir, 'complete.json'));

/**
 * The local engine. opts: { weightsDir, python, port, spawn, fetch, cuda, script }.
 * submit(images, options) → { task_id }; status(id) → { status: queued|running|success|failed, progress, error };
 * result(id) → Buffer (GLB). stop() on app exit.
 */
export function localEngine({ weightsDir, python = 'python', port = LOCAL_PORT, spawn = nodeSpawn, fetch = globalThis.fetch,
  cuda = checkCuda, script = SERVICE_SCRIPT, startTimeoutMs = 120000, pollMs = 1000 } = {}) {
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let starting = null;
  const call = async (route, init) => {
    const res = await fetch(base + route, { ...init, signal: AbortSignal.timeout(init?.body ? 120000 : 10000) });
    const out = /json/.test(res.headers.get('content-type') || '') ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new LocalEngineError(res.status === 404 ? 404 : 502, `Local engine: ${out?.error || `HTTP ${res.status}`}`);
    return out;
  };
  const health = () => call('/health').catch(() => null);
  async function start() {
    if (await health()) return;
    if (!weightsReady(weightsDir)) throw new LocalEngineError(409, 'The local engine needs a one-time download first. Open Settings and click Download local engine.');
    await cuda();
    child = spawn(python, [script, '--port', String(port), '--weights', weightsDir], { windowsHide: true, stdio: 'ignore' });
    let exited = null;
    child.on?.('exit', (code) => { exited = code; child = null; });
    const until = Date.now() + startTimeoutMs;
    while (Date.now() < until) {
      const h = await health();
      if (h?.ok) return;
      if (h?.error) throw new LocalEngineError(503, `Local engine: ${h.error}`);
      if (exited !== null) throw new LocalEngineError(503, 'The local engine stopped while starting. Check that Python and TRELLIS are installed (see local/README.md).');
      await new Promise((ok) => setTimeout(ok, pollMs));
    }
    throw new LocalEngineError(504, 'The local engine took too long to start.');
  }
  const ensure = () => (starting ??= start().finally(() => { starting = null; }));
  return {
    base, health, ensure,
    get running() { return Boolean(child); },
    async submit(images, options = {}) {
      await ensure();
      return call('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images, options }) });
    },
    status: (id) => call(`/status/${encodeURIComponent(id)}`),
    result: (id) => call(`/result/${encodeURIComponent(id)}`),
    async stop() {
      if (!child) return;
      const c = child;
      await call('/shutdown', { method: 'POST' }).catch(() => {});
      setTimeout(() => { try { c.kill(); } catch { /* gone */ } }, 3000).unref?.();
    },
  };
}
