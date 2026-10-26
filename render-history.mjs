// Version history for renders: every finished render is kept as a version with a copy of its picture and the
// settings that made it (the model's scene plus the light rig and glass), per model in models/<id>/history.json, the
// pictures beside it as history-v<n>.<ext>. Restoring a version only puts its settings back; nothing is deleted.
import { readFile, writeFile, copyFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function createRenderHistory({ modelsDir }) {
  const file = (id) => path.join(modelsDir, id, 'history.json');
  const list = async (id) => JSON.parse(await readFile(file(id), 'utf8').catch(() => '[]'));
  let chain = Promise.resolve(); // one write at a time
  return {
    list,
    /**
     * picture: a finished render's picture file. pass: the render run it came from (its start time); a run renders
     * several pictures (looks, frames), and only its first one becomes a version. stamp: the run's start time as
     * burned into its pictures (stamp.js), shown in History.
     */
    add(id, { picture, pass = null, kind, stamp = '', settings, now = new Date() }) {
      const job = chain.then(async () => {
        const all = await list(id);
        if (pass && all.some((v) => v.pass === pass)) return null;
        const n = (all.at(-1)?.n ?? 0) + 1;
        const name = `history-v${n}${path.extname(picture).toLowerCase()}`;
        await copyFile(picture, path.join(modelsDir, id, name));
        const v = { n, at: now.toISOString(), pass, kind, ...(stamp && { stamp }), picture: name, settings: structuredClone(settings ?? {}) };
        await writeFile(file(id) + '.tmp', JSON.stringify([...all, v], null, 2));
        await rename(file(id) + '.tmp', file(id));
        return v;
      });
      chain = job.catch(() => {});
      return job;
    },
  };
}
