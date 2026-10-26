// Auto-crop: trims renders to the model. bounds() finds the box of pixels that are not background (alpha above a
// threshold; shadows count when includeShadow, since they are semi-transparent). For a spin set or turntable, union()
// gives one box for every frame so the sequence never jitters. fit() pads and grows the box to a target aspect.
export function bounds({ data, width, height }, { alphaMin = 8, includeShadow = true, shadowAlpha = 96 } = {}) {
  const min = includeShadow ? alphaMin : Math.max(alphaMin, shadowAlpha);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] >= min) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function union(boxes) {
  const b = boxes.filter(Boolean);
  if (!b.length) return null;
  const x = Math.min(...b.map((r) => r.x)), y = Math.min(...b.map((r) => r.y));
  return { x, y, w: Math.max(...b.map((r) => r.x + r.w)) - x, h: Math.max(...b.map((r) => r.y + r.h)) - y };
}

/** Pad (fraction of the larger side) and widen/heighten to aspect (w/h), centred, clamped to the image. */
export function fit(box, { width, height }, { padding = 0.05, aspect = null } = {}) {
  if (!box) return { x: 0, y: 0, w: width, h: height };
  const p = Math.round(Math.max(box.w, box.h) * padding);
  let w = box.w + 2 * p, h = box.h + 2 * p;
  if (aspect) { if (w / h < aspect) w = Math.round(h * aspect); else h = Math.round(w / aspect); }
  w = Math.min(w, width); h = Math.min(h, height);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const x = Math.round(Math.min(Math.max(cx - w / 2, 0), width - w)), y = Math.round(Math.min(Math.max(cy - h / 2, 0), height - h));
  return { x, y, w, h };
}

/** One crop rectangle for a whole sequence of frames (ImageData-like). */
export const sequenceCrop = (frames, opts = {}) => fit(union(frames.map((f) => bounds(f, opts))), frames[0], opts);
