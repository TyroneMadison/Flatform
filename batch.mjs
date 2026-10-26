// Batch export of colour variants: a persisted job queue. Each job is one variant (a saved colour/material preset,
// optionally with a scene preset) times one output (still, turntable, glb, tennogen). The page runs the jobs one
// by one and reports back; the queue file survives a crash, and running jobs come back as queued.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const OUTPUTS = { still: 'Still PNGs', turntable: 'Turntable video', glb: 'GLB', tennogen: 'TennoGen texture set' };
export const STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
const NEXT = { queued: ['running', 'cancelled'], running: ['done', 'failed', 'cancelled', 'queued'], failed: ['queued', 'cancelled'], done: [], cancelled: ['queued'] };

export const safeFolder = (name) => String(name || 'variant').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80) || 'variant';

/** Plan jobs: variants [{ id, name }], outputs ['still', ...] → one job per pair. */
export function planJobs({ modelId, variants = [], outputs = [], scene = null, angles = [0], turntable = null }) {
  if (!variants.length) throw new Error('Pick at least one preset');
  const outs = [...new Set(outputs)].filter((o) => Object.hasOwn(OUTPUTS, o));
  if (!outs.length) throw new Error('Pick at least one output');
  const jobs = [];
  for (const v of variants) for (const output of outs) {
    jobs.push({ id: `${v.id}:${output}`, modelId, variant: v.id, name: v.name || v.id, folder: safeFolder(v.name || v.id), output, scene, angles, turntable, status: 'queued', error: null, tries: 0 });
  }
  return jobs;
}

export function createQueue({ file, now = () => Date.now() } = {}) {
  let state = { batchId: null, createdAt: null, jobs: [] };
  const persist = async () => {
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2));
    await rename(`${file}.tmp`, file);
  };
  const find = (id) => {
    const j = state.jobs.find((x) => x.id === id);
    if (!j) throw Object.assign(new Error('No such job'), { status: 404 });
    return j;
  };
  const move = (j, to, error = null) => {
    if (!NEXT[j.status].includes(to)) throw Object.assign(new Error(`Can't go from ${j.status} to ${to}`), { status: 409 });
    j.status = to;
    j.error = to === 'failed' ? String(error || 'Failed') : null;
    if (to === 'running') j.tries += 1;
    j.updatedAt = now();
  };
  return {
    async load() {
      if (!file) return this.view();
      try { state = JSON.parse(await readFile(file, 'utf8')); } catch { return this.view(); }
      for (const j of state.jobs) if (j.status === 'running') { j.status = 'queued'; j.error = null; } // the app closed mid-job
      await persist();
      return this.view();
    },
    view: () => ({ ...state, counts: Object.fromEntries(STATUSES.map((s) => [s, state.jobs.filter((j) => j.status === s).length])) }),
    async start(plan) {
      if (state.jobs.some((j) => j.status === 'running' || j.status === 'queued')) throw Object.assign(new Error('A batch is already running'), { status: 409 });
      state = { batchId: `b${now()}`, createdAt: now(), jobs: planJobs(plan) };
      await persist();
      return this.view();
    },
    next() { return state.jobs.find((j) => j.status === 'queued') || null; },
    async set(id, status, error) { move(find(id), status, error); await persist(); return this.view(); },
    async retryFailed() { for (const j of state.jobs) if (j.status === 'failed') move(j, 'queued'); await persist(); return this.view(); },
    async cancelAll() { for (const j of state.jobs) if (['queued', 'running'].includes(j.status)) move(j, 'cancelled'); await persist(); return this.view(); },
    async clear() { if (state.jobs.some((j) => j.status === 'running')) throw Object.assign(new Error('Cancel the batch first'), { status: 409 }); state = { batchId: null, createdAt: null, jobs: [] }; await persist(); return this.view(); },
  };
}
