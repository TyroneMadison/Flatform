// Renders every environment's World-picker thumbnail with the sample car at the place's default camera, in the app's
// own renderer (studio.js), so it needs no Blender. Also the quickest look at every place after an edit to
// environments.js. A place a built-in template uses (Night City) gets that template's look, bloom included.
//   npx electron test-app/make-env-thumbs.mjs [slug ...] [--before-after <dir>]
// Writes public/img/rooms/<slug>.webp (320 x 200). --before-after also writes Night City at 640 x 480 with the old
// bloom and signs (night-city-before.png) and as it is now (night-city-after.png) into <dir>.
import { app, BrowserWindow } from 'electron';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';
import { createKeyStore } from '../keys.mjs';
import { ENVIRONMENTS } from '../public/lib/environments.js';
import { BUILTIN_TEMPLATES } from '../public/lib/templates.js';
import { envThumb, ROOM_THUMB_SIZE } from '../public/lib/pipeline.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const shots = argv.includes('--before-after') ? argv[argv.indexOf('--before-after') + 1] : null;
const only = argv.filter((a) => ENVIRONMENTS[a]);
const lookOf = (slug) => BUILTIN_TEMPLATES.find((t) => t.kind === 'car' && t.scene.preset === slug)?.scene.look || null;

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
    // One shot of a place: the 4:3 car-view frame, centre-cropped to w x h. `old` puts back Night City's bloom and
    // signs from before a50406e (minus the glow cap in post.js, which stays).
    const shot = (slug, look, { w, h, type, old = false }) => win.webContents.executeJavaScript(`(async () => {
      document.body.innerHTML = '<canvas width="640" height="480"></canvas>';
      const { Studio, defaultScene } = await import('/lib/studio.js');
      const { ENVIRONMENTS } = await import('/lib/environments.js');
      const m = ENVIRONMENTS['night-city-rain'].mats, emit = { pink: 2, cyan: 2, lamp: 2.5 };
      for (const k in emit) m[k].emit = ${old} ? { pink: 4, cyan: 4, lamp: 5 }[k] : emit[k];
      const s = new Studio(document.querySelector('canvas'), { preserveDrawingBuffer: true });
      s.resize(640, 480, 1);
      await s.setState({ ...defaultScene({}), preset: ${JSON.stringify(slug)}, look: ${JSON.stringify(look)} });
      await s.load('/files/${car.id}/${encodeURIComponent(car.glb)}');
      await s.setState({});
      for (let i = 0; i < 30; i++) { s.render(); await new Promise((ok) => requestAnimationFrame(ok)); }
      const out = document.createElement('canvas');
      out.width = ${w}; out.height = ${h};
      const f = s.frameRect, ch = f.width * ${h / w};
      out.getContext('2d').drawImage(s.renderer.domElement, f.x, f.y + (f.height - ch) / 2, f.width, ch, 0, 0, ${w}, ${h});
      if (s.message) console.warn(${JSON.stringify(slug)}, s.message);
      s.dispose();
      return out.toDataURL(${JSON.stringify(type)}, 0.86);
    })()`).then((url) => Buffer.from(url.split(',')[1], 'base64'));

    await mkdir(path.join(ROOT, 'public', 'img', 'rooms'), { recursive: true });
    for (const slug of only.length ? only : Object.keys(ENVIRONMENTS)) {
      await writeFile(path.join(ROOT, 'public', envThumb(slug)), await shot(slug, lookOf(slug), { ...ROOM_THUMB_SIZE, type: 'image/webp' }));
      console.log('thumb', slug);
    }
    if (shots) {
      await mkdir(shots, { recursive: true });
      const big = { w: 640, h: 480, type: 'image/png' };
      await writeFile(path.join(shots, 'night-city-before.png'), await shot('night-city-rain', { bloom: { on: true, strength: 0.5, threshold: 0.9 } }, { ...big, old: true }));
      await writeFile(path.join(shots, 'night-city-after.png'), await shot('night-city-rain', lookOf('night-city-rain'), big));
      console.log('before/after in', shots);
    }
  } finally {
    await server.close();
    await rm(data, { recursive: true, force: true });
    app.quit();
  }
});
