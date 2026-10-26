// The shared picture-import flow: what the home screens accept, and the workspace stamp on created and imported models.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyFiles, dragHasFiles, MAX_PHOTO, MAX_MODEL, WORKSPACES } from '../public/lib/import-rules.js';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';

test('classifyFiles: pictures by type or extension, 3D models by extension, everything else rejected with a reason', () => {
  const f = (name, type = '', size = 1000) => ({ name, type, size });
  const r = classifyFiles([f('a.jpg', 'image/jpeg'), f('b.HEIC'), f('c.png', ''), f('car.glb'), f('bits.FBX'), f('notes.txt', 'text/plain'), f('big.png', 'image/png', MAX_PHOTO + 1), f('huge.obj', '', MAX_MODEL + 1), f('clip.mp4', 'video/mp4')]);
  assert.deepEqual(r.photos.map((x) => x.name), ['a.jpg', 'b.HEIC', 'c.png']);
  assert.deepEqual(r.models.map((x) => x.name), ['car.glb', 'bits.FBX']);
  assert.deepEqual(r.rejected.map((x) => [x.file.name, x.reason]), [
    ['notes.txt', 'use a PNG, JPEG or HEIC picture, or a GLB, GLTF, FBX, OBJ or USDZ model'],
    ['big.png', 'too large (max 20 MB)'], ['huge.obj', 'too large (max 300 MB)'],
    ['clip.mp4', 'use a PNG, JPEG or HEIC picture, or a GLB, GLTF, FBX, OBJ or USDZ model']]);
  assert.equal(dragHasFiles({ types: ['Files'] }), true);
  assert.equal(dragHasFiles({ types: ['text/uri-list'] }), false);
  assert.equal(dragHasFiles(null), false);
  assert.deepEqual(Object.keys(WORKSPACES), ['warframe', 'car']);
});

const temps = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));

test('an imported model keeps the workspace it came from; the default is car; PATCH can change it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flatform-import-'));
  temps.push(dir);
  const app = await startServer({ dataDir: dir, keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const glb = Buffer.alloc(32);
    glb.write('glTF', 0, 'latin1');
    glb.writeUInt32LE(2, 4);
    const post = async (workspace) => {
      const form = new FormData();
      form.append('name', 'Shield');
      form.append('glb', new File([glb], 'model.glb', { type: 'model/gltf-binary' }));
      form.append('fileName', 'shield.glb');
      if (workspace) form.append('workspace', workspace);
      const r = await fetch(`${base}/api/models/import`, { method: 'POST', body: form, headers: { Origin: base } });
      return r.json();
    };
    const wf = await post('warframe');
    const car = await post();
    const odd = await post('kitchen');
    assert.deepEqual([wf.workspace, car.workspace, odd.workspace], ['warframe', 'car', 'car']);
    const patched = await (await fetch(`${base}/api/models/${car.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ workspace: 'warframe' }) })).json();
    assert.equal(patched.workspace, 'warframe');
    const bad = await fetch(`${base}/api/models/${car.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ workspace: 'boat' }) });
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});
