// Auto-save snapshots, crash detection and recents, kept in <library>/session/ (the app's user data folder, per
// workspace). A "running" marker is written at start and removed on a clean quit: if it is still there next start,
// Flatform did not close properly and the page offers "Restore last session".
import { readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { KEEP, snapName, prunable, sameSnapshot, bumpRecent, SNAP } from './public/lib/session.js';

const ID = /^[\w-]{1,80}$/;

/** A snapshot from the page, checked: { modelId, scene, frame } or throws. */
export function cleanSnapshot(b) {
  if (!b || typeof b !== 'object' || !ID.test(String(b.modelId || ''))) throw new Error('Bad snapshot');
  if (!b.scene || typeof b.scene !== 'object' || Array.isArray(b.scene)) throw new Error('Bad snapshot');
  const frame = Number.isInteger(b.frame) && b.frame >= 0 && b.frame < 1000 ? b.frame : 0;
  return { modelId: b.modelId, scene: b.scene, frame };
}

export function createSession({ dir, keep = KEEP, now = Date.now }) {
  const marker = path.join(dir, 'running');
  const recentsFile = path.join(dir, 'recents.json');
  let crashed = false;
  const atomic = async (file, data) => { await writeFile(`${file}.tmp`, JSON.stringify(data)); await rename(`${file}.tmp`, file); };
  const names = async () => (await readdir(dir).catch(() => [])).filter((n) => SNAP.test(n)).sort();
  const self = {
    /** Call once when the server starts. Returns true when the last run ended without a clean quit. */
    start() {
      mkdirSync(dir, { recursive: true });
      crashed = existsSync(marker);
      writeFileSync(marker, String(now()));
      return crashed;
    },
    /** Clean quit: sync, so it also works from Electron's will-quit. */
    markClean() { rmSync(marker, { force: true }); },
    get crashed() { return crashed; },
    dismiss() { crashed = false; },
    async latest() {
      const last = (await names()).at(-1);
      return last ? JSON.parse(await readFile(path.join(dir, last), 'utf8')) : null;
    },
    async list() { return (await names()).reverse(); },
    async recents() { return JSON.parse(await readFile(recentsFile, 'utf8').catch(() => '[]')); },
    /** Writes a snapshot (unless nothing changed), keeps the newest few, and moves its model to the top of recents. */
    async snapshot(body) {
      const snap = { ...cleanSnapshot(body), at: now() };
      if (!sameSnapshot(snap, await self.latest())) {
        await atomic(path.join(dir, snapName(snap.at)), snap);
        for (const old of prunable(await names(), keep)) await rm(path.join(dir, old), { force: true });
      }
      const recents = bumpRecent(await self.recents(), { id: snap.modelId, at: snap.at, frame: snap.frame });
      await atomic(recentsFile, recents);
      return { at: snap.at, recents };
    },
  };
  return self;
}
