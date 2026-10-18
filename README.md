# Tripo Studio

Unofficial desktop client for the [Tripo 3D API](https://developers.tripo3d.com). Not affiliated with Tripo or VAST.

Drop images and get 3D models from Tripo's official API. Each model is saved to a local library, previewed in 3D, and can be exported to GLB, GLTF, FBX, USDZ, OBJ, STL, or 3MF.

## Run

1. Create an API key at https://developers.tripo3d.com/en/keys and add credits.
2. Copy `.env.example` to `.env` and set `TRIPO_API_KEY`.
3. Run `npm start`, then open http://localhost:5173

Needs Node 22 or later. There are no npm dependencies.

## How it works

- `server.mjs` uploads the image (`POST /v3/files`), starts `image-to-model` (v3.1, textured PBR), and polls the task.
- The moment a task succeeds, the server downloads the GLB and preview into `data/models/<id>/`, because Tripo's result URLs expire after 5 minutes.
- Exports call `POST /v3/models/convert` and are cached next to the GLB.
- `data/library.json` is the library.
- The API key stays on the server, and the server listens only on 127.0.0.1.

`npm test` runs the whole flow against a fake Tripo API. It uses no credits.

You pay Tripo directly in credits; this app adds no fees.
