// Overnight render queue: colour variants x camera paths x formats, run unattended in order. Built on the batch
// queue (persisted, resumes after a crash), plus automatic retries, timings, a morning summary and keep-awake.
import { safeFolder } from './batch.mjs';

export const FORMATS = { mp4: 'MP4 video', still: 'Still PNGs', spin: 'Spin set' };
export const MAX_TRIES = 3;

export function planOvernight({ modelId, variants = [], paths = [{ id: 'turntable', name: 'Turntable' }], formats = ['mp4'], outDir = null }) {
  if (!modelId) throw new Error('Pick a model');
  if (!variants.length) throw new Error('Pick at least one colour');
  if (!paths.length) throw new Error('Pick at least one camera path');
  const fmts = [...new Set(formats)].filter((f) => Object.hasOwn(FORMATS, f));
  if (!fmts.length) throw new Error('Pick at least one format');
  const jobs = [];
  for (const v of variants) for (const p of paths) for (const output of fmts) {
    jobs.push({ id: `${v.id}:${p.id}:${output}`, modelId, variant: v.id, name: `${v.name || v.id} · ${p.name || p.id}`, folder: safeFolder(`${v.name || v.id} ${p.name || p.id}`), path: p.id, output, outDir, status: 'queued', error: null, tries: 0 });
  }
  return jobs;
}

/** In the morning: what finished, what failed and why, how long it took. */
export function morningSummary(view) {
  const jobs = view.jobs || [];
  const times = jobs.filter((j) => j.ms > 0).map((j) => j.ms);
  return {
    total: jobs.length, done: jobs.filter((j) => j.status === 'done').length,
    failed: jobs.filter((j) => j.status === 'failed').map((j) => ({ name: j.name, error: j.error, tries: j.tries })),
    totalMs: times.reduce((a, b) => a + b, 0), avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
  };
}

export const busy = (view) => (view.jobs || []).some((j) => j.status === 'queued' || j.status === 'running');

/** keepAwake(on) is Electron's powerSaveBlocker in the app; a no-op in tests. Starts once, stops once. */
export function awakeGuard(keepAwake = () => {}) {
  let on = false;
  return (view) => { const want = busy(view); if (want !== on) { on = want; keepAwake(on); } return on; };
}
