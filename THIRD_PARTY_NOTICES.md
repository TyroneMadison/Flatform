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
| [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) | 0.0.27 | MIT | path-traced preview in the scene composer |
| [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) | 0.9.16 | MIT | used by three-gpu-pathtracer |

### libheif-js (LGPL-3.0)

libheif-js is a WebAssembly build of [libheif](https://github.com/strukturag/libheif) (LGPL-3.0) with its HEVC decoder.
Flatform uses it as an **unmodified npm module**: it is installed from the npm registry and loaded at runtime
from `node_modules/libheif-js`, as a separate file that is not compiled or bundled into Flatform's own code.
Its license texts ship with it in `node_modules/libheif-js/LICENSE` and `node_modules/libheif-js/libheif-wasm/LICENSE`.
You may replace it with a modified version of the library: install it over `node_modules/libheif-js` (in the packaged
app, inside `resources/app.asar`). The source code is at https://github.com/catdad-experiments/libheif-js and
https://github.com/strukturag/libheif.

## Studio HDRIs (bundled in `public/img/hdri/`, CC0 1.0)

Seven 1k environment maps from [Poly Haven](https://polyhaven.com), released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain, no attribution required; credited with thanks).

| File | Source |
| --- | --- |
| `studio_small_03.hdr` | https://polyhaven.com/a/studio_small_03 (Sergej Majboroda) |
| `studio_small_08.hdr` | https://polyhaven.com/a/studio_small_08 (Sergej Majboroda) |
| `brown_photostudio_02.hdr` | https://polyhaven.com/a/brown_photostudio_02 (Sergej Majboroda) |
| `kloofendal_48d_partly_cloudy_puresky.hdr` | https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky (Greg Zaal) |
| `garage.hdr` | https://polyhaven.com/a/garage (Greg Zaal) |
| `goegap_road.hdr` | https://polyhaven.com/a/goegap_road (Greg Zaal) |
| `white_studio_02.hdr` | https://polyhaven.com/a/white_studio_02 (Grzegorz Wronkowski) |

## Room HDRIs and floor textures (bundled in `public/img/rooms/`, CC0 1.0)

The 3D rooms behind every scene (`public/lib/rooms.js`). All from [Poly Haven](https://polyhaven.com), released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain, no attribution required; credited with thanks).
HDRIs are the 2k `.hdr`; textures are the 1k JPG diffuse, roughness and OpenGL normal maps. Downloaded 2026-10-26.

| Files | Room | Source |
| --- | --- | --- |
| `autoshop_01_2k.hdr` | Luxury Garage | https://polyhaven.com/a/autoshop_01 (Oliksiy Yakovlyev) |
| `umhlanga_sunrise_2k.hdr` | Golden Hour Coast | https://polyhaven.com/a/umhlanga_sunrise (Greg Zaal) |
| `shanghai_bund_2k.hdr` | Night City Rain | https://polyhaven.com/a/shanghai_bund (Greg Zaal) |
| `goegap_road_2k.hdr` | Desert Highway Dusk | https://polyhaven.com/a/goegap_road (Greg Zaal, James Ray Cock) |
| `pool_2k.hdr` | Modern Villa Driveway | https://polyhaven.com/a/pool (Greg Zaal) |
| `concrete_floor_01_*_1k.jpg` | Luxury Garage floor | https://polyhaven.com/a/concrete_floor_01 (Rob Tuytel) |
| `coast_sand_01_*_1k.jpg` | Golden Hour Coast floor | https://polyhaven.com/a/coast_sand_01 (Rob Tuytel) |
| `asphalt_02_*_1k.jpg` | Night City Rain floor | https://polyhaven.com/a/asphalt_02 (Rob Tuytel) |
| `asphalt_01_*_1k.jpg` | Desert Highway Dusk floor | https://polyhaven.com/a/asphalt_01 (Dario Barresi, Charlotte Baglioni) |
| `large_floor_tiles_02_*_1k.jpg` | Modern Villa Driveway floor | https://polyhaven.com/a/large_floor_tiles_02 (Rob Tuytel) |

The room thumbnails (`*-thumb.png`) are Flatform's own Blender renders of these rooms (`test-app/make-room-thumbs.mjs`),
and the White Cyc Studio, Soft studio and Showroom rooms are built in code. The Flatform Test app's sample humanoid and
car (`test-app/seed/`) are made in code by `test-app/make-samples.py`; they are part of Flatform (MIT).

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
