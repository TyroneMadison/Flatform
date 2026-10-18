# Flatform

Unofficial desktop app for the [Tripo 3D API](https://developers.tripo3d.com). Not affiliated with Tripo or VAST.

Drop a photo of a car and get a textured 3D model. Check it, place it in a studio scene, and render 360° and 180° turntables, stills and sprite sheets into a handoff folder for the website. Every model is kept in a library on your computer and can be exported to GLB, GLTF, FBX, USDZ, OBJ, STL or 3MF.

## Install

Download the latest release from the [Releases page](https://github.com/TyroneMadison/Flatform/releases):

- **Windows:** `Flatform-Setup-x.y.z.exe`. The app isn't code-signed yet, so Windows SmartScreen may warn you. Click **More info**, then **Run anyway**.
- **Mac:** use `Flatform-x.y.z-arm64.dmg` for Apple Silicon or `Flatform-x.y.z.dmg` for Intel, and drag the app into Applications. The app isn't notarized yet, so macOS blocks the first launch. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

On first launch, paste a Tripo API key from https://developers.tripo3d.com/en/keys. The key is encrypted by your operating system (Windows DPAPI or macOS Keychain) and is only sent to Tripo. You pay Tripo directly in credits; this app adds no fees.

## The five steps

1. **Drop.** Drop photos, choose them, or paste one (Ctrl+V / ⌘V or **Paste from clipboard**). PNG, JPEG or HEIC, up to 20 MB, one car per photo. Several photos queue several jobs.
2. **Generate.** Shows where Tripo is (uploaded → task started → building geometry → painting textures → saving the GLB), a scan preview of your photo and a queue of every job, with **Retry** on failed ones. **Run in background** lets you keep working.
3. **Review.** Your photo next to the 3D model (drag to orbit). Switch between versions, **Regenerate from same photo** or **with a better photo** (each is a new Tripo task and a new version; older versions are kept), turn auto-orient, centering and front/back flip on or off, and rename the model.
4. **Compose.** The scene composer (see below).
5. **Render.** Renders the composed scene into the handoff folder (see below).

The **Library** has search, filters (Ready, Generating, Failed, Rendered, Needs render), the rendered poster or Tripo preview for each car, 360/180 badges, downloads for every format, rename, regenerate and delete. **Settings** has the account (key, region, balance), generation defaults, rendering options and the app's folders.

### Credits and cancelling

- Tripo has no price-estimate endpoint, so Flatform never guesses a cost. It shows your **balance and frozen credits** from Tripo and, once you've made a model, **what the last generation used** (Tripo's `credits_consumed`).
- **There is no Cancel for jobs Tripo has started.** Tripo's v3 API only lets you read a task (`GET /v3/tasks/{id}`); there is no endpoint to cancel one, so a Cancel button could only pretend. Photos still waiting in Flatform's own upload queue (not sent yet) can be removed.

### HEIC

HEIC photos (iPhone) are converted to JPEG on your computer before upload, with [heic-convert](https://github.com/catdad-experiments/heic-convert). It decodes with libheif-js, an LGPL-3.0 WebAssembly build of libheif that ships as an unmodified npm module (see `THIRD_PARTY_NOTICES.md`).

## Scene composer

A Three.js studio with five scene presets:

- **Escalade gold-ring studio** — near-black room, glossy dark reflective floor, a warm gold ring set into the floor around the car, two vertical white light bars, an overhead softbox, and key/fill/rim lights. Built in code, identical every time.
- **Transparent** — no background, soft contact shadow only.
- **White cyclorama** — seamless white curved backdrop, soft top light, contact shadow.
- **Miami street at night** — a slot for your own HDRI (no free-licensed Miami HDRI is bundled).
- **Your backdrop or HDRI** — a JPG/PNG backdrop (a 2:1 image is used as a panorama) or an `.hdr`/`.exr` environment. Uploads are kept in the library folder.

The inspector has position, turn, scale (**Fit** scales every car to the same 4.6 m length), snap tires to floor, camera presets (Front ¾, Side, Rear ¾, Low hero), lens in mm, matched or manual key/fill/rim light, reflection strength and shadow softness. The viewport shows the scene, camera and look, and a safe frame for the 4:3 render. The turntable timeline has 72 ticks (5° each), the 180° range highlighted, play/pause and a 360/180 toggle. Drag in the viewport to turn the car, or use the arrow keys.

The scene is saved per model (`scene.json` next to the model in the library), so a render reproduces it.

**Conventions.** Every car is normalised on load: length along the camera axis, centred, tyres on the floor, scaled to 4.6 m. Yaw 0° has the nose pointing at the camera and positive yaw turns the car clockwise seen from above, so the default turn of 30° is the front ¾ view with the nose to the left of the frame. Frame 000 is that view; frame *n* is 5°·*n* further round. If a scan comes in back to front, use **Flip front and back**. The camera, lights and studio never move during a turntable.

## Render and export

Pick what to render (still image at the current angle, 360° turntable, 180° half turn, model files) and the looks: **Studio backdrop** (4:3, 2048 × 1536) and **Transparent** (RGBA 2048 × 2048 with a soft contact shadow). The in-app renderer draws each frame offscreen at full size with the same Three.js scene, turning only the car by exactly 5°, and sends each PNG to the app, which writes it to disk. Progress shows as "frame 023 of 072"; you can pause or cancel, and the render keeps going if you switch screens.

Output goes to the output folder you choose (Settings or the Render screen; the suggested one is `E:\Claude Stuff\car-360-pipeline\handoff` on Windows and `~/Flatform/handoff` on Mac), one folder per car:

```
<output folder>/<car-slug>/
  frames/studio/<slug>_000.png … _071.png
  frames/transparent/<slug>_000.png … _071.png
  web/<look>-360-512.webp  <look>-360-256.webp  <look>-360-512.png
  web/<look>-180-512.webp  <look>-180-256.webp
  web/<look>-sprite-360.json  <look>-sprite-180.json
  web/<look>-poster.webp  <look>-poster.png        (frame 000)
  stills/<slug>_<look>_<angle>.png
  models/<slug>.glb (+ converted formats if chosen)
  spin-viewer.js  viewer.html  HANDOFF.md
```

Sprite sheets have 12 columns: the 360 is 12 × 6 (72 frames), the 180 is frames 000–036 of the same render (37 frames, 12 × 4 with a partial last row, no re-render). Each `sprite-*.json` lists the frame size, grid, frame count, 5° per frame, whether it loops, the sheet and poster files, the renderer and the Flatform version.

**Where each piece goes** (also written into `HANDOFF.md`):

- Transparent 360 · 512 → spinning thumbnails across dudrents.com
- Transparent 360 · 256 → admin portal lists and the edit page
- Studio 180 → swipe view on the car's detail page

`spin-viewer.js` is a dependency-free drag/swipe/arrow-key viewer for those sheets (360 loops, 180 stops at the ends, poster until loaded); `viewer.html` is a working demo, even opened straight from disk.

### Optional: Blender (Cycles)

If Blender 4.x is installed (Windows: `C:\Program Files\Blender Foundation\Blender*\blender.exe`; Mac: `/Applications/Blender.app`), or you point Settings at it with **Locate Blender**, the Render screen offers **Render with Blender (Cycles)**. Flatform runs `render/blender_turntable.py`, which builds the same gold-ring studio (or the transparent look) in code and renders the same 72 frames; the sprite sheets, json and handoff files are then made exactly as for the in-app renderer. Blender is not bundled; without it, Settings shows "Not found · install Blender 4.x to render".

## Settings

- **Tripo account:** the key (shown masked; **Change key** checks it with Tripo before saving it), the region (Global `openapi.tripo3d.ai` or China `openapi.tripo3d.com`; only these two hosts are accepted) and your balance and frozen credits.
- **Generation defaults:** Tripo model version (`v3.1-20260211`), textures, PBR.
- **Rendering:** in-app or Blender, the Blender path, the default output folder, the default scene, and whether to always render the transparent look too.
- **App:** the library location and the version, with a link to the releases.

Settings other than the key are saved in `settings.json` in the library folder.

## How it works

- `main.mjs` (Electron) starts the app server on a random port on 127.0.0.1 and shows it in a window. `preload.cjs` gives the page four checked helpers (pick a folder, pick a file, show an item in its folder, open a folder); the page has no Node access.
- `server.mjs` uploads the photo (`POST /v3/files`), starts `image-to-model` and polls the task. When a task succeeds it downloads the GLB and preview into the library right away, because Tripo's result URLs expire after 5 minutes. Exports call `POST /v3/models/convert`.
- The server only answers requests addressed to its own host, refuses any state-changing request from another origin, and serves the page with a strict Content-Security-Policy. Library and settings writes are atomic.
- The front end is plain ES modules (`public/app.js`, `public/views/*.js`, `public/lib/*.js`, `public/styles/*.css`), no build step. `public/lib/pipeline.js` holds the turntable and handoff rules shared by the app, the server and the tests.
- The library lives in the app's data folder: `%APPDATA%\Flatform\library` on Windows, `~/Library/Application Support/Flatform/library` on Mac. Libraries from earlier versions are upgraded in place on first launch (each old model becomes version 1).

Fonts: Sora, Plus Jakarta Sans and IBM Plex Mono are bundled in `public/fonts` under the SIL Open Font License (texts included). Nothing is loaded from the internet except Tripo. See `THIRD_PARTY_NOTICES.md` for every third-party component.

## Develop

```bash
npm install
npm run app      # desktop app
npm test         # server and pipeline tests against a fake Tripo API and a fake Blender; no credits, no network
npm run dist     # build the installer for this OS into dist/
```

`npm run web` runs it as a local website instead. Put `TRIPO_API_KEY` in `.env` (see `.env.example`), then open http://localhost:5173. In this mode folder pickers become text fields.

Releases: push a tag like `v0.3.0`. GitHub Actions builds Windows and Mac and attaches them to a draft release.

## License

MIT
