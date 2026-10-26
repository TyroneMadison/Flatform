// The free auto-rig job, kept apart from everything else: its own folder (nothing shared with renders or the model
// folder), Blender twice (render/blender_autorig.py --dump, then --build), the limb finding and binding of
// public/lib/autorig.js in a worker thread so the app keeps answering, and a check of the finished file. Only a
// rigged model that passed every check leaves the job folder; the caller then makes it the new version.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BONES } from './public/lib/motion.js';
import { autoRig, rigFailure } from './public/lib/autorig.js';
import { glbNames } from './blender.mjs';

const SELF = fileURLToPath(import.meta.url);

/** Reads a --dump folder and works out the skeleton and weights; writes rig.json and weights.u8 when it worked. */
export async function solve(dir, markers = null) {
  const buf = (f) => readFile(path.join(dir, f));
  const p = await buf('positions.f32'), t = await buf('tris.u32');
  const pos = new Float32Array(p.buffer, p.byteOffset, p.length / 4);
  const tris = new Uint32Array(t.buffer, t.byteOffset, t.length / 4);
  const r = autoRig(pos, tris, { markers });
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(r.report, null, 1));
  if (!r.ok) return { ok: false, problems: r.problems, report: r.report };
  await writeFile(path.join(dir, 'rig.json'), JSON.stringify({ names: BONES, frame: r.frame, bones: r.bones, joints: r.joints }));
  const n = pos.length / 3, w = Buffer.alloc(n * 3);
  w.set(r.weights.b0, 0); w.set(r.weights.b1, n); w.set(r.weights.q, 2 * n);
  await writeFile(path.join(dir, 'weights.u8'), w);
  await writeFile(path.join(dir, 'cut.u32'), Buffer.from(r.cut.buffer, r.cut.byteOffset, r.cut.byteLength));
  return { ok: true, report: r.report };
}

// Runs solve() in a worker thread (a 1M-vertex model takes a few seconds of maths).
const solveInWorker = (dir, markers) => new Promise((resolve, reject) => {
  const w = new Worker(SELF, { workerData: { dir, markers } });
  w.once('message', resolve);
  w.once('error', reject);
  w.once('exit', (code) => { if (code) reject(new Error(`The rig maths stopped (exit ${code})`)); });
});
if (!isMainThread && workerData?.dir) solve(workerData.dir, workerData.markers).then((r) => parentPort.postMessage(r), (e) => parentPort.postMessage({ ok: false, problems: [e.message] }));

/** A finished rigged GLB has one skin with every bone Flatform poses. */
export function checkRigged(buf) {
  const { bones } = glbNames(buf);
  const missing = BONES.filter((b) => !bones.includes(b));
  return missing.length ? `The rigged model is missing joints (${missing.slice(0, 3).join(', ')})` : null;
}

/**
 * The whole job. glb: the model to rig (read only). dir: this job's own folder (made fresh, removed after).
 * run(args): runs Blender with those arguments and resolves when it exits cleanly. markers: the user's clicked
 * landmarks for the fallback, or null. onStep(text): plain progress. Resolves { file: <dir>/rigged.glb, report } or
 * throws an Error with .fallback = 'markers' when the limbs could not be found by themselves.
 */
export async function runAutoRig({ glb, dir, script, run, markers = null, onStep = () => {} }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const t0 = Date.now();
  onStep('Reading the model');
  await run(['-b', '-P', script, '--', '--glb', glb, '--dump', dir]);
  onStep('Finding the arms, legs and head');
  const solved = await solveInWorker(dir, markers);
  if (!solved.ok) {
    const f = markers ? { error: `Those clicks did not make a skeleton: ${solved.problems[0]}. Try the clicks again.`, fallback: 'markers' } : rigFailure(solved.problems);
    throw Object.assign(new Error(f.error), { fallback: f.fallback, problems: solved.problems });
  }
  onStep('Adding the joints in Blender');
  const out = path.join(dir, 'rigged.glb');
  await run(['-b', '-P', script, '--', '--glb', glb, '--build', dir, '--out', out]);
  if (!existsSync(out)) throw new Error('Blender finished without writing the rigged model');
  const bad = checkRigged(await readFile(out));
  if (bad) throw new Error(bad);
  return { file: out, report: { ...solved.report, seconds: Math.round((Date.now() - t0) / 100) / 10 } };
}
