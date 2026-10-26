// Local video encoding with ffmpeg (turntables, animation previews, camera paths). Finds ffmpeg from Settings, the
// FFMPEG environment variable or PATH. Never uploads anything: it reads a PNG sequence and writes a file.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ffmpegArgs } from './public/lib/turntable.js';

export function findFfmpeg({ configured, env = process.env, exists = existsSync, which = whichFfmpeg } = {}) {
  for (const p of [configured, env.FFMPEG]) if (p && exists(p)) return p;
  return which();
}
function whichFfmpeg() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
    const first = r.status === 0 && r.stdout.split(/\r?\n/).find(Boolean);
    return first || null;
  } catch { return null; }
}

/** Encode a PNG sequence. Returns a promise of { output }. spawn is swapped in tests. */
export function encodeVideo({ ffmpeg, framesDir, pattern, outDir, fileName, spawn = nodeSpawn, ...opts }) {
  if (!ffmpeg) return Promise.reject(Object.assign(new Error('ffmpeg not found. Install it or set its path in Settings.'), { status: 400 }));
  if (!outDir || !path.isAbsolute(outDir)) return Promise.reject(Object.assign(new Error('Pick an output folder'), { status: 400 }));
  if (!fileName || /[\\/]/.test(fileName)) return Promise.reject(Object.assign(new Error('Bad file name'), { status: 400 }));
  const output = path.join(outDir, fileName);
  const args = ffmpegArgs({ ...opts, input: path.join(framesDir, pattern), output });
  return new Promise((ok, fail) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok({ output, args }) : fail(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`))));
  });
}
