# Flatform

Unofficial desktop app for the [Tripo 3D API](https://developers.tripo3d.com) and the [3D AI Studio API](https://www.3daistudio.com/Platform/API/Documentation). Not affiliated with Tripo, VAST or 3D AI Studio.

Drop a photo of a car (or four views of it) and get a textured 3D model. Check it, place it in a studio scene, and render 360° and 180° turntables, stills and sprite sheets into a handoff folder for the website. Every model is kept in a library on your computer and can be downloaded as GLB; models made with Tripo direct can also be exported to GLTF, FBX, USDZ, OBJ, STL or 3MF.

## Install

Download the latest release from the [Releases page](https://github.com/TyroneMadison/Flatform/releases):

- **Windows:** `Flatform-Setup-x.y.z.exe`. The app isn't code-signed yet, so Windows SmartScreen may warn you. Click **More info**, then **Run anyway**.
- **Mac:** use `Flatform-x.y.z-arm64.dmg` for Apple Silicon or `Flatform-x.y.z.dmg` for Intel, and drag the app into Applications. The app isn't notarized yet, so macOS blocks the first launch. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

On first launch, paste an API key for the provider you want to use (**Settings → Providers**): a Tripo key from https://developers.tripo3d.com/en/keys, a 3D AI Studio key from its API dashboard, or both. Keys are encrypted by your operating system and only sent to that provider (see [Keys](#keys)). You pay the providers directly in credits; this app adds no fees.

## The five steps

1. **Drop.** Drop photos, choose them, or paste one (Ctrl+V / ⌘V or **Paste from clipboard**). PNG, JPEG or HEIC, up to 20 MB, one car per photo. Nothing is sent yet.
2. **Generate.** First the setup screen (see below), where you pick the provider and quality and press **Generate**. Then the progress screen shows where the job is (sent → waiting → building geometry → painting textures → saving the GLB), a scan preview of your photo and a queue of every job, with **Retry** on failed ones. **Run in background** lets you keep working. Photos dropped on the queue skip the setup screen and use the last setup (the fast path; the button shows which one and its price).
3. **Review.** Your photo next to the 3D model (drag to orbit). Switch between versions, **Regenerate from same photo** or **with a better photo** (both open the setup screen; each is a new paid job and a new version; older versions are kept), turn auto-orient, centering and front/back flip on or off, and rename the model.
4. **Compose.** The scene composer (see below).
5. **Render.** Renders the composed scene into the handoff folder (see below).

The **Library** has search, filters (Ready, Generating, Failed, Rendered, Needs render), the rendered poster or provider preview for each car, 360/180 badges, downloads, rename, regenerate and delete. **Settings** has the providers and keys, rendering options, the output folder and the app's folders.

Neither provider has an endpoint to cancel a job it has started, so Flatform has no Cancel for those; photos still waiting in Flatform's own queue can be removed.

## Generate setup

The setup screen follows `design/api-controls-v2`: a provider switch at the top (**Tripo** direct or **3D AI Studio**, remembered for next time), presets as the main control, and the engine's own options in groups that stay collapsed to a one-line summary, one open at a time. Options that don't apply to the current choices are hidden, or disabled with a small ⓘ that says why. One cost line and **Generate** sit at the bottom, with your balance.

- **Photos:** a single photo (several photos = several models with the same setup), or **4 views** with Front (required), Left, Back and Right slots; at least two views including the front. Drop or choose a photo per slot. Engines that build from one photo (TRELLIS.2, and Tripo direct in Flatform) hide the 4-view switch and say so.
- **Controls:** segmented controls and selects for choices, switches for on/off, real sliders with a value for numbers (face limits on a log scale, with **Adaptive** at the far left where the engine can decide; TRELLIS.2 steps and decimation target; Hitem3D de-shading), and seed fields (empty = random). Arrow keys move within the provider switch, presets and segmented controls; focus rings are coral.

### Presets and prices

| Provider | Preset | What it is | Credits |
| --- | --- | --- | --- |
| Tripo | Fast draft | Color texture, texture model v3.5 with the fast tier | 30 |
| Tripo | Balanced | PBR, HD texture | 40 |
| Tripo | Max quality | Ultra geometry, PBR, 8K texture | 70 |
| 3D AI Studio | Draft | TRELLIS.2, 1024, textured, 2048 texture | 30 |
| 3D AI Studio | Balanced | Tripo 3.2, PBR, standard texture | 60 |
| 3D AI Studio | Max quality | Hitem3D 3.0, 2048 quality, textured | 150 |

**Custom** is whatever you set in the groups. The cost is computed from the published price lists in one module, `public/lib/pricing.js` (tested in `test/pricing.test.mjs`):

- **Tripo direct:** 20 untextured, 30 textured; HD texture +10, 8K +20, Ultra geometry +20, quad +5, smart low poly +10, parts +20.
- **3D AI Studio · Tripo 3.0/3.1/3.2:** 40 per image or multiview; texture +20 (fast or standard), +40 detailed, +60 extreme; detailed geometry +40, smart low poly +20, parts +40, quad +10.
- **3D AI Studio · Hunyuan 3D Pro:** 60; PBR +20; multi-view +20.
- **3D AI Studio · TRELLIS.2:** by resolution, geometry only / textured at 1024, 2048, 4096: 512 → 15 / 25 / 25 / 30, 1024 → 20 / 30 / 30 / 40, 1536 → 25 / 40 / 40 / 55; thumbnail +2.
- **3D AI Studio · Hitem3D 3.0:** 2048 quality 125 geometry only, 150 textured; 2048 master 625 / 650. PBR, de-shading, face limit and views don't change the price.

3D AI Studio takes credits when a job is submitted and refunds them if it fails. Tripo reports what each task used (`credits_consumed`), which Flatform shows once the model is ready.

### 3D AI Studio

- **Engines:** Tripo 3.2, 3.1 and 3.0, Hunyuan 3D Pro, TRELLIS.2 and Hitem3D 3.0, each with exactly its documented options. Photos are sent as base64 data URIs (HEIC is converted to JPEG first). Tripo's multiview takes the views in the order front, left, back, right; Hunyuan and Hitem3D take them by name.
- **Rate limit:** 3 requests a minute per key, counting submissions, status checks and balance checks. Every call goes through one limiter (`providers.mjs`) that never starts more than 3 in any minute (plus two seconds of slack), queues the rest and lets what you click go first. Status checks run in the background, at most two a minute, oldest job first, so each job is checked less often when more are running. If the account reports a lower limit, Flatform uses it; after a 429 everything waits a full minute.
- **Results:** download links last 24 hours, so the GLB (and a TRELLIS.2 thumbnail if you asked for one) is saved into the library the moment a job finishes. A job found on startup that is older than a day, or that 3D AI Studio answers with 410 Gone, is marked failed with a clear message; **Retry** sends the same photos and setup again.
- **Formats:** GLB only. Other formats come from Tripo's converter, which only works on models made with Tripo direct, so Flatform hides those buttons for 3D AI Studio models and says why.

### Tripo direct

The request is `POST /v3/generation/image-to-model` with `input`, `model`, `texture` and `pbr`, as in v0.3. The other options (geometry and texture quality, texture model v3.5 and lighting removal, alignment, autofix, face limit, quad, smart low poly, parts, real-world size, seeds) use the parameter names Tripo's task API and 3D AI Studio's Tripo proxy document, and are only sent when they differ from Tripo's defaults. Flatform has no Tripo v3 reference for them; see `tripoDirectBody` in `public/lib/engines.js`.

## Keys

**Settings → Providers** has the default provider and a card per provider with the same layout: name and host (Tripo's host picks the region: Global `openapi.tripo3d.ai` or China `openapi.tripo3d.com`), a status (**Saved · encrypted**, **From .env** or **Not set**), the key field (always hidden), **Test**, **Replace** and **Remove**, and the last result (balance, plus the rate limit for 3D AI Studio).

- Keys are encrypted with Electron's safeStorage (Windows DPAPI, macOS Keychain) into `keys/<provider>.bin` in the app's data folder, never into settings.json. A key is only saved after the provider accepted it on its free balance check, and is only ever sent to that provider's API. The page never gets a key back, not even its last characters: the server only says where a key comes from.
- **Test** runs the free balance check (`GET /v3/account/balance`, `GET /account/user/wallet/`) and spends no credits. 3D AI Studio's balance is remembered for 5 minutes, because the check counts towards the 3 requests a minute.
- Upgrading from v0.3: the Tripo key saved in `tripo-key.bin` is copied into the new store on first launch. The old file is kept (and still read if the copy can't be written) until you **Remove** the key.
- Without a saved key, `TRIPO_API_KEY` and `THREE_D_AI_STUDIO_KEY` from the environment are used (`npm run web` loads them from `.env`).

## Scene composer

A Three.js studio with five scene presets:

- **Escalade ring studio** — near-black room, glossy dark reflective floor, a coral ring set into the floor around the car, two vertical white light bars, an overhead softbox, and key/fill/rim lights. Built in code, identical every time. (v0.3 called it the gold-ring studio; saved scenes are renamed on upgrade.)
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
  models/<slug>.glb (+ converted formats if chosen, Tripo direct models only)
  spin-viewer.js  viewer.html  HANDOFF.md
```

Sprite sheets have 12 columns: the 360 is 12 × 6 (72 frames), the 180 is frames 000–036 of the same render (37 frames, 12 × 4 with a partial last row, no re-render). Each `sprite-*.json` lists the frame size, grid, frame count, 5° per frame, whether it loops, the sheet and poster files, the renderer and the Flatform version.

**Where each piece goes** (also written into `HANDOFF.md`):

- Transparent 360 · 512 → spinning thumbnails across dudrents.com
- Transparent 360 · 256 → admin portal lists and the edit page
- Studio 180 → swipe view on the car's detail page

`spin-viewer.js` is a dependency-free drag/swipe/arrow-key viewer for those sheets (360 loops, 180 stops at the ends, poster until loaded); `viewer.html` is a working demo, even opened straight from disk.

### Optional: Blender (Cycles)

If Blender 4.x is installed (Windows: `C:\Program Files\Blender Foundation\Blender*\blender.exe`; Mac: `/Applications/Blender.app`), or you point Settings at it with **Locate Blender**, the Render screen offers **Render with Blender (Cycles)**. Flatform runs `render/blender_turntable.py`, which builds the same ring studio (or the transparent look) in code and renders the same 72 frames; the sprite sheets, json and handoff files are then made exactly as for the in-app renderer. Blender is not bundled; without it, Settings shows "Not found · install Blender 4.x to render".

## Settings

- **Providers:** the default provider and the two key cards (see [Keys](#keys)).
- **Rendering:** in-app or Blender, the Blender path, the default scene, and whether to always render the transparent look too.
- **Output folder:** where renders go.
- **About:** the library location and the version, with a link to the releases.

Settings other than keys are saved in `settings.json` in the library folder, including the provider and the last setup used with each one.

## Look

Dark studio surfaces with a peach-coral accent: `#FF7A66` (accent), `#FF9A88` (light), `#E2523E` (deep), `#2A0C06` for text on coral, and the gradient `linear-gradient(160deg, #FFA594, #FF7A66 55%, #E2523E)` for primary buttons and the active step. The tokens are `--accent`, `--accent-hi`, `--accent-lo`, `--on-accent`, `--accent-grad` and `--glow` in `public/styles/base.css`; the studio ring (`RING` in `public/lib/studio.js`, `RING` in the Blender script) uses the same coral.

## How it works

- `main.mjs` (Electron) starts the app server on a random port on 127.0.0.1 and shows it in a window. `preload.cjs` gives the page four checked helpers (pick a folder, pick a file, show an item in its folder, open a folder); the page has no Node access.
- `server.mjs` takes the photos and setup from the page, checks the setup against the engine catalogue, and submits the job. Tripo: it uploads the photo (`POST /v3/files`), starts `image-to-model` and polls the task when the page asks; when a task succeeds it downloads the GLB and preview right away, because Tripo's result URLs expire after 5 minutes. Exports call `POST /v3/models/convert`. 3D AI Studio: see above; the client and the limiter are in `providers.mjs`.
- `keys.mjs` is the per-provider key store (and the v0.3 key move); `public/lib/engines.js` is the catalogue of providers, engines, options, presets and request bodies, shared by the page, the server and the tests; `public/lib/pricing.js` has the prices.
- The server only answers requests addressed to its own host, refuses any state-changing request from another origin, and serves the page with a strict Content-Security-Policy. Library and settings writes are atomic.
- The front end is plain ES modules (`public/app.js`, `public/views/*.js`, `public/lib/*.js`, `public/styles/*.css`), no build step. `public/lib/pipeline.js` holds the turntable and handoff rules shared by the app, the server and the tests.
- three.js is served from local files: `three/build` from inside the app, and the addons (`three/examples/jsm`: loaders, controls, Draco/Meshopt decoders) as an extra resource next to it, because electron-builder leaves every dependency's `examples/` folder out of the package. `render/blender_turntable.py` ships the same way so Blender can read it.
- The library lives in the app's data folder: `%APPDATA%\Flatform\library` on Windows, `~/Library/Application Support/Flatform/library` on Mac. Libraries from earlier versions are upgraded in place on first launch (each old model becomes version 1, and every older version is marked as made with Tripo).

Fonts: Sora, Plus Jakarta Sans and IBM Plex Mono are bundled in `public/fonts` under the SIL Open Font License (texts included). Nothing is loaded from the internet except the two providers' APIs and their result files. See `THIRD_PARTY_NOTICES.md` for every third-party component.

## Develop

```bash
npm install
npm run app      # desktop app
npm test         # server, providers, pricing and pipeline tests against a fake Tripo, a fake 3D AI Studio and a fake Blender; no credits, no network
npm run dist     # build the installer for this OS into dist/
```

`npm run web` runs it as a local website instead. Put `TRIPO_API_KEY` and/or `THREE_D_AI_STUDIO_KEY` in `.env` (see `.env.example`), then open http://localhost:5173. In this mode folder pickers become text fields, and keys pasted in Settings last until the server stops.

Releases: push a tag like `v0.4.0`. GitHub Actions builds Windows and Mac and attaches them to a draft release.

## License

MIT
