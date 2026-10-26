// Renders every environment's scene-picker thumbnail with the sample car, in the app's own renderer (studio.js),
// so it needs no Blender. Also the quickest look at every place after an edit to environments.js.
//   npx electron test-app/make-env-thumbs.mjs [slug ...]
// Writes public/img/environments/<slug>.jpg (320 x 240).
import { app, BrowserWindow } from 'electron';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { ENVIRONMENTS } from '../public/lib/environments.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const only = process.argv.slice(2).filter((a) => ENVIRONMENTS[a]);

app.whenReady().then(async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'flatform-thumbs-'));
  const server = await startServer({ dataDir: data, defaultOutputRoot: path.join(data, 'out'), keyStore: createKeyStore({ env: {} }), apiBase: 'http://127.0.0.1:9/v3', threeDAIBase: 'http://127.0.0.1:9' });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const form = new FormData();
    form.append('glb', new Blob([await readFile(path.join(ROOT, 'test-app', 'seed', 'car.glb'))]), 'car.glb');
    form.append('name', 'Thumb car');
    const car = await (await fetch(`${base}/api/models/import`, { method: 'POST', body: form })).json();
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } });
    await win.loadURL(`${base}/`); // the app page, for its import map; its body is replaced below
    for (const slug of only.length ? only : Object.keys(ENVIRONMENTS)) {
      const jpg = await win.webContents.executeJavaScript(`(async () => {
        document.body.innerHTML = '<canvas width="640" height="480"></canvas>';
        const { Studio, defaultScene } = await import('/lib/studio.js');
        const s = new Studio(document.querySelector('canvas'), { preserveDrawingBuffer: true });
        s.resize(640, 480, 1);
        await s.setState({ ...defaultScene({}), preset: ${JSON.stringify(slug)} });
        await s.load('/files/${car.id}/${encodeURIComponent(car.glb)}');
        await s.setState({});
        for (let i = 0; i < 30; i++) { s.render(); await new Promise((ok) => requestAnimationFrame(ok)); }
        const out = document.createElement('canvas');
        out.width = 320; out.height = 240;
        const f = s.frameRect;
        out.getContext('2d').drawImage(s.renderer.domElement, f.x, f.y, f.width, f.height, 0, 0, 320, 240);
        const url = out.toDataURL('image/jpeg', 0.86);
        if (s.message) console.warn(${JSON.stringify(slug)}, s.message);
        s.dispose();
        return url;
      })()`);
      await writeFile(path.join(ROOT, 'public', 'img', 'environments', `${slug}.jpg`), Buffer.from(jpg.split(',')[1], 'base64'));
      console.log('thumb', slug);
    }
  } finally {
    await server.close();
    await rm(data, { recursive: true, force: true });
    app.quit();
  }
});
