// Usage dashboard: render times (batch and overnight queues), credit spend (ledger.mjs, Enhance split out) and disk
// used by the library folder and its caches. Clear-cache only ever deletes inside the named cache folders.
import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

export const CACHES = ['cache', 'tmp', 'thumbs'];

export async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

export async function disk(dataDir, extra = {}) {
  const out = {};
  for (const name of ['models', 'backdrops', 'plugins', ...CACHES]) out[name] = await dirSize(path.join(dataDir, name));
  for (const [k, d] of Object.entries(extra)) if (d) out[k] = await dirSize(d);
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

export async function clearCache(dataDir, name) {
  if (!CACHES.includes(name)) throw new Error('Not a cache folder');
  await rm(path.join(dataDir, name), { recursive: true, force: true });
}

export function renderTimes(...views) {
  const jobs = views.flatMap((v) => v?.jobs || []).filter((j) => j.ms > 0);
  const by = {};
  for (const j of jobs) (by[j.output] ||= []).push(j.ms);
  return {
    jobs: jobs.map((j) => ({ name: j.name, output: j.output, ms: j.ms })),
    avgMs: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)])),
  };
}

export function enhanceSpend(entries) {
  const e = entries.filter((x) => x.task === 'enhance');
  return { calls: e.length, credits: e.reduce((s, x) => s + (x.credits || 0), 0), actualCredits: e.reduce((s, x) => s + (x.delta ?? x.credits ?? 0), 0) };
}

export const human = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
