# Third-party notices

Flatform is MIT licensed (see `LICENSE`). It ships these third-party components.

## Runtime libraries (npm `dependencies`, shipped inside the app)

| Package | Version | License | Used for |
| --- | --- | --- | --- |
| [three](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | 3D review, scene composer and the in-app renderer |
| [heic-convert](https://github.com/catdad-experiments/heic-convert) | 2.1.0 | ISC | HEIC → JPEG before upload |
| [heic-decode](https://github.com/catdad-experiments/heic-decode) | 2.1.0 | ISC | used by heic-convert |
| [libheif-js](https://github.com/catdad-experiments/libheif-js) | 1.23.5 | **LGPL-3.0** | used by heic-decode |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | 0.4.4 | BSD-3-Clause | used by heic-convert |
| [pngjs](https://github.com/pngjs/pngjs) | 6.0.0 | MIT | used by heic-convert |

### libheif-js (LGPL-3.0)

libheif-js is a WebAssembly build of [libheif](https://github.com/strukturag/libheif) (LGPL-3.0) with its HEVC decoder.
Flatform uses it as an **unmodified npm module**: it is installed from the npm registry and loaded at runtime
from `node_modules/libheif-js`, as a separate file that is not compiled or bundled into Flatform's own code.
Its license texts ship with it in `node_modules/libheif-js/LICENSE` and `node_modules/libheif-js/libheif-wasm/LICENSE`.
You may replace it with a modified version of the library: install it over `node_modules/libheif-js` (in the packaged
app, inside `resources/app.asar`). The source code is at https://github.com/catdad-experiments/libheif-js and
https://github.com/strukturag/libheif.

## Fonts (bundled in `public/fonts/`, SIL Open Font License 1.1)

| Font | License text |
| --- | --- |
| Sora | `public/fonts/OFL-sora.txt` |
| Plus Jakarta Sans | `public/fonts/OFL-plusjakartasans.txt` |
| IBM Plex Mono | `public/fonts/OFL-ibmplexmono.txt` |

## App shell

The desktop app is built with [Electron](https://github.com/electron/electron) (MIT), which bundles Chromium and
Node.js. Their notices ship with every build (`LICENSE.electron.txt` and `LICENSES.chromium.html`).

## Not bundled

[Blender](https://www.blender.org) (GPL) is optional and never shipped. When you install it yourself, Flatform runs it
as a separate program with `render/blender_turntable.py`.
