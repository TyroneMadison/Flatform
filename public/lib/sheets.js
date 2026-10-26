// Sprite sheets from frames, in the page (canvas): high-quality downscale, a light sharpen, and sheet assembly.
// Used by Compose's render area (Flatform's own web/ layout) and the Spin set screen (the Dud Rents layout).
import * as P from './pipeline.js';

export const toBlob = (canvas, type, quality) => new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error(`Could not save the ${type} picture`))), type, quality));

// High-quality downscale: halve with smoothing until within 2x of the target, then one last step. Each halving
// averages 2x2 pixels, so fine detail (badges, panel gaps) survives where one big jump would alias.
export function downscale(source, width, height) {
  let cur = source;
  for (;;) {
    const last = cur.width / 2 < width * 1.01;
    const c = document.createElement('canvas');
    Object.assign(c, last ? { width, height } : { width: Math.round(cur.width / 2), height: Math.round(cur.height / 2) });
    const g = c.getContext('2d', { willReadFrequently: last });
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
    if (last) return cur;
  }
}
// Light unsharp mask (3x3) on opaque pixels, to undo the softening of the downscale. Edges against
// transparency are left alone so the transparent look gets no halos.
export function sharpen(canvas, amount = 0.35) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(img.data);
  const w = canvas.width;
  for (let y = 1; y < canvas.height - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = (y * w + x) * 4;
      if (src[p + 3] < 255) continue;
      for (let c = 0; c < 3; c++) {
        const blur = (src[p + c - 4] + src[p + c + 4] + src[p + c - w * 4] + src[p + c + w * 4]) / 4;
        img.data[p + c] = src[p + c] + (src[p + c] - blur) * amount;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return canvas;
}
// The frame at every web width: 512 from the full frame, 256 from the 512, each sharpened lightly.
export function webFrames(source, look) {
  const out = {};
  let cur = source;
  for (const width of P.WEB_WIDTHS) { // 512, 256
    const f = P.frameSize(look, width);
    cur = downscale(cur, f.width, f.height);
    out[width] = cur;
  }
  for (const width of P.WEB_WIDTHS) sharpen(out[width]);
  return out;
}

/**
 * Draws frames into sheets as they arrive, so nothing is rendered twice. files: [{ turn, width, type, name }]
 * (one canvas per turn and width; a PNG and WebP of the same size share it). put(name, blob) writes a sheet;
 * poster(frame0Small) is written as posterNames { webp, png }.
 */
export function makeSheets(look, files, { put, posterNames }) {
  const sheets = [];
  for (const file of files) {
    const same = sheets.find((s) => s.turn === file.turn && s.width === file.width);
    if (same) { same.also = file; continue; }
    const canvas = document.createElement('canvas');
    Object.assign(canvas, P.sheetSize(look in P.LOOKS ? look : 'studio', file.turn, file.width));
    sheets.push({ turn: file.turn, width: file.width, type: file.type, name: file.name, canvas, frames: P.turnFrames(file.turn) });
  }
  return {
    draw(i, source) {
      const small = webFrames(source, look in P.LOOKS ? look : 'studio');
      for (const s of sheets) {
        if (i >= s.frames) continue;
        const { col, row } = P.cellOf(i);
        const f = P.frameSize(look in P.LOOKS ? look : 'studio', s.width);
        s.canvas.getContext('2d').drawImage(small[s.width], col * f.width, row * f.height);
      }
      return small;
    },
    async write(poster) {
      for (const s of sheets) {
        await put(s.name, await toBlob(s.canvas, s.type, 0.9));
        if (s.also) await put(s.also.name, await toBlob(s.canvas, s.also.type));
        s.canvas.width = s.canvas.height = 0; // free the memory
      }
      await put(posterNames.webp, await toBlob(poster, 'image/webp', 0.92));
      await put(posterNames.png, await toBlob(poster, 'image/png'));
    },
  };
}
