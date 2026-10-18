# Tripo Studio

Unofficial desktop app for the [Tripo 3D API](https://developers.tripo3d.com). Not affiliated with Tripo or VAST.

Drop images and get 3D models. Each model is saved to a library on your computer, previewed in 3D, and can be exported to GLB, GLTF, FBX, USDZ, OBJ, STL, or 3MF for Blender, Unity, Unreal, Maya, AR or 3D printing.

## Install

Download the latest release from the [Releases page](https://github.com/TyroneMadison/Flatform/releases):

- **Windows:** `Tripo Studio Setup x.y.z.exe`. The app isn't code-signed yet, so Windows SmartScreen may warn you. Click **More info**, then **Run anyway**.
- **Mac:** use `Tripo Studio-x.y.z-arm64.dmg` for Apple Silicon or `Tripo Studio-x.y.z.dmg` for Intel, and drag the app into Applications. The app isn't notarized yet, so macOS blocks the first launch. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

On first launch, paste a Tripo API key from https://developers.tripo3d.com/en/keys. The key is encrypted by your operating system (Windows DPAPI or macOS Keychain) and is only sent to Tripo. You pay Tripo directly in credits; this app adds no fees.

## How it works

- `main.mjs` (Electron) starts the app server on a random local port and shows it in a window.
- `server.mjs` uploads the image (`POST /v3/files`), starts `image-to-model` (v3.1, textured PBR), and polls the task. When a task succeeds, it downloads the GLB and preview into the library right away, because Tripo's result URLs expire after 5 minutes.
- Exports call `POST /v3/models/convert` and are cached next to the GLB.
- The library is stored in the app's data folder: `%APPDATA%\Tripo Studio\library` on Windows, `~/Library/Application Support/Tripo Studio/library` on Mac.

## Develop

```bash
npm install
npm run app      # desktop app
npm test         # whole flow against a fake Tripo API, uses no credits
npm run dist     # build the installer for this OS into dist/
```

`npm run web` runs it as a local website instead. Put `TRIPO_API_KEY` in `.env` (see `.env.example`), then open http://localhost:5173.

Releases: push a tag like `v0.1.0`. GitHub Actions builds Windows and Mac and attaches them to a draft release.

## License

MIT
