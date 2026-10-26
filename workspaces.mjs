// Workspaces: Warframe and Car (plus any you add). Each one is a separate data folder (models, library, scenes,
// backdrops, presets, batch queue, settings), so nothing leaks between them. The existing library is the Car
// workspace and stays exactly where it is (no files move); a backup list of what it held is written once.
import { readFile, writeFile, mkdir, readdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const KINDS = { car: { label: 'Car', icon: 'car', camera: 'car' }, warframe: { label: 'Warframe', icon: 'frame', camera: 'free' } };
const DEFAULTS = [{ id: 'car', name: 'Car', kind: 'car', dir: '.' }, { id: 'warframe', name: 'Warframe', kind: 'warframe', dir: 'workspaces/warframe' }];
const ID = /^[a-z0-9-]{1,40}$/;

export function createWorkspaces({ baseDir }) {
  const file = path.join(baseDir, 'workspaces.json');
  let data = null;
  const write = async () => { await mkdir(baseDir, { recursive: true }); await writeFile(file, JSON.stringify(data, null, 2)); };
  const dirOf = (w) => path.resolve(baseDir, w.dir);
  const self = {
    async load() {
      try { data = JSON.parse(await readFile(file, 'utf8')); } catch { data = null; }
      if (!data?.list?.length) {
        data = { active: 'car', list: DEFAULTS.map((w) => ({ ...w })), migratedAt: null };
        await self.migrate();
        await write();
      }
      for (const w of data.list) await mkdir(dirOf(w), { recursive: true });
      return self.view();
    },
    // Non-destructive: the old library already is the Car workspace. Settings get copied to a backup first.
    async migrate() {
      const had = existsSync(path.join(baseDir, 'library.json')) || existsSync(path.join(baseDir, 'models'));
      if (had) {
        const backup = path.join(baseDir, 'backup-before-workspaces');
        await mkdir(backup, { recursive: true });
        for (const f of ['library.json', 'settings.json']) if (existsSync(path.join(baseDir, f))) await copyFile(path.join(baseDir, f), path.join(backup, f));
        const models = existsSync(path.join(baseDir, 'models')) ? await readdir(path.join(baseDir, 'models')) : [];
        await writeFile(path.join(backup, 'models.txt'), models.join('\n'));
      }
      data.migratedAt = new Date().toISOString();
      data.migrated = had;
    },
    view: () => ({ active: data.active, list: data.list.map((w) => ({ id: w.id, name: w.name, kind: w.kind, ...KINDS[w.kind] })) }),
    active: () => data.list.find((w) => w.id === data.active) || data.list[0],
    activeDir: () => dirOf(self.active()),
    dirFor: (id) => { const w = data.list.find((x) => x.id === id); if (!w) throw Object.assign(new Error('No such workspace'), { status: 404 }); return dirOf(w); },
    async setActive(id) {
      if (!data.list.some((w) => w.id === id)) throw Object.assign(new Error('No such workspace'), { status: 404 });
      data.active = id; await write(); return self.view();
    },
    async add({ name, kind = 'car' }) {
      name = String(name || '').trim().slice(0, 40);
      if (!name) throw Object.assign(new Error('Give the workspace a name'), { status: 400 });
      if (!Object.hasOwn(KINDS, kind)) throw Object.assign(new Error('Kind must be car or warframe'), { status: 400 });
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
      if (!ID.test(id)) id = 'workspace';
      let n = 2; const base = id; while (data.list.some((w) => w.id === id)) id = `${base}-${n++}`;
      const w = { id, name, kind, dir: `workspaces/${id}` };
      data.list.push(w); await mkdir(dirOf(w), { recursive: true }); await write();
      return self.view();
    },
  };
  return self;
}
// The Car workspace lives at the base folder, so the others' folder must never be read as a model.
export const isWorkspaceFolder = (name) => name === 'workspaces' || name === 'backup-before-workspaces';
