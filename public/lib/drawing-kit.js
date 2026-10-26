// The drawing kit: photos of the printed Flatform drawing template (assets/template, 7 pages) read back into views
// for one multi-view generation, the cover's color legend and the color map page's part roles. A port of the
// approved reference parser (flatform_parse.py) with no Python and no OpenCV: js-aruco2 finds the corner squares,
// jsQR reads the page's QR. Pure: images are { width, height, data: RGBA }, the two libraries are passed in
// ({ AR, jsQR }), so the node tests and the page (views/drawing.js) run the same code.
//
// Every page has 4 ArUco markers (DICT_4X4_50 ids 0-3; the outer corner of marker k is its corner k) and a QR
// with { t: 'ft', v: 1, p: <page>, s: <sheet id> } (a blank template adds g: 0, no guide). Box positions come
// from layout.json by p, never from the QR.

export const S = 8; // px per mm of the straightened page
export const PAGES = ['cover', 'front', 'back', 'left', 'right', 'detail', 'colormap'];
export const VIEW_PAGES = ['front', 'back', 'left', 'right'];
export const PAGE_NAMES = { cover: 'Cover', front: 'Front', back: 'Back', left: 'Left side', right: 'Right side', detail: 'Close-ups', colormap: 'Color map' };
// The template's role names to Part colors' role ids (roles.js ROLES).
export const ROLE_OF = { Primary: 'primary', Secondary: 'secondary', Tertiary: 'tertiary', Accent: 'accents', Glow: 'emissive', Energy: 'energy' };
const NONE = 255;

// ---- the QR and the layout ----
/** The page's QR text as { page, sheet, guide }, or null when it is not one of ours. */
export function parseQr(text) {
  let q;
  try { q = JSON.parse(String(text)); } catch { return null; }
  if (!q || q.t !== 'ft' || q.v !== 1 || !PAGES.includes(q.p) || typeof q.s !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(q.s)) return null;
  return { page: q.p, sheet: q.s.toUpperCase(), guide: q.g !== 0 };
}
/** A page's boxes in mm from layout.json: { index, title, regions }. */
export function pageLayout(layout, p) {
  const pg = layout.pages.find((x) => x.p === p);
  if (!pg) throw new Error(`The template has no ${p} page`);
  return { index: pg.index, title: pg.title, regions: pg.regions_mm };
}
/** Where each marker's outer corner is on the page, in mm: [TL, TR, BR, BL] (marker k's corner k). */
export function markerTargets(layout) {
  const m = layout.markers_mm;
  return [[m[0][0], m[0][1]], [m[1][0] + m[1][2], m[1][1]], [m[2][0] + m[2][2], m[2][1] + m[2][3]], [m[3][0], m[3][1] + m[3][3]]];
}

// ---- geometry ----
/** The 3 x 3 projective map (flat, h8 = 1) taking 4 points `from` to 4 points `to`. */
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) throw new Error('The corner squares are in a line');
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
export const project = (h, x, y) => {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
};
/**
 * Straightens part of the photo: the page area x0, y0, w, h (mm) at `scale` px per mm. h: page mm to photo px.
 * Bilinear; outside the photo is white.
 */
export function warp(img, h, { x0 = 0, y0 = 0, w, h: hh, scale = S }) {
  const W = Math.round(w * scale), H = Math.round(hh * scale);
  const out = new Uint8ClampedArray(W * H * 4);
  const { width: sw, height: sh, data } = img;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const [fx, fy] = project(h, x0 + (i + 0.5) / scale, y0 + (j + 0.5) / scale);
      const x = fx - 0.5, y = fy - 0.5, o = (j * W + i) * 4;
      const xi = Math.floor(x), yi = Math.floor(y);
      if (xi < 0 || yi < 0 || xi >= sw - 1 || yi >= sh - 1) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255; continue; }
      const ax = x - xi, ay = y - yi, p = (yi * sw + xi) * 4, q = p + sw * 4;
      for (let k = 0; k < 3; k++) {
        out[o + k] = (data[p + k] * (1 - ax) + data[p + 4 + k] * ax) * (1 - ay) + (data[q + k] * (1 - ax) + data[q + 4 + k] * ax) * ay;
      }
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}
/** A smaller copy (box average by a whole factor) so the marker search stays quick on big photos. */
export function shrink(img, maxSide) {
  const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / maxSide));
  if (f === 1) return { img, f };
  const W = Math.floor(img.width / f), H = Math.floor(img.height / f), out = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const s = [0, 0, 0];
      for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) { const p = ((j * f + y) * img.width + i * f + x) * 4; s[0] += img.data[p]; s[1] += img.data[p + 1]; s[2] += img.data[p + 2]; }
      const o = (j * W + i) * 4;
      out[o] = s[0] / (f * f); out[o + 1] = s[1] / (f * f); out[o + 2] = s[2] / (f * f); out[o + 3] = 255;
    }
  }
  return { img: { width: W, height: H, data: out }, f };
}

// ---- finding the page ----
/**
 * The page's 4 outer corners in the photo ([TL, TR, BR, BL] as [x, y]) from the found markers ({ id, corners:
 * [{x, y}] }), or { missing: [ids] }. A marker's outer corner is the one farthest from the middle of all four, so
 * it does not depend on the library's corner order.
 */
export function outerCorners(markers) {
  const best = {};
  const size = (m) => Math.hypot(m.corners[0].x - m.corners[2].x, m.corners[0].y - m.corners[2].y);
  for (const m of markers) if (m.id >= 0 && m.id <= 3 && (!best[m.id] || size(m) > size(best[m.id]))) best[m.id] = m;
  const missing = [0, 1, 2, 3].filter((k) => !best[k]);
  if (missing.length) return { missing };
  const centre = (m) => [m.corners.reduce((t, c) => t + c.x, 0) / 4, m.corners.reduce((t, c) => t + c.y, 0) / 4];
  const mids = [0, 1, 2, 3].map((k) => centre(best[k]));
  const cx = mids.reduce((t, c) => t + c[0], 0) / 4, cy = mids.reduce((t, c) => t + c[1], 0) / 4;
  return { corners: [0, 1, 2, 3].map((k) => best[k].corners.reduce((a, c) => (Math.hypot(c.x - cx, c.y - cy) > Math.hypot(a.x - cx, a.y - cy) ? c : a))).map((c) => [c.x, c.y]) };
}
export function findMarkers(img, AR) {
  const { img: small, f } = shrink(img, 1600);
  const det = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' });
  return det.detect(small).map((m) => ({ id: m.id, corners: m.corners.map((c) => ({ x: (c.x + 0.5) * f - 0.5, y: (c.y + 0.5) * f - 0.5 })) }));
}
const toGray = (img) => {
  const g = new Uint8Array(img.width * img.height);
  for (let i = 0; i < g.length; i++) g[i] = (img.data[i * 4] * 299 + img.data[i * 4 + 1] * 587 + img.data[i * 4 + 2] * 114) / 1000;
  return g;
};
/** Otsu's threshold of a gray image. */
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; at = t; }
  }
  return at;
}
/** Reads the QR from a zoomed straightened copy of its area, at a few zooms, plain and black-and-white. */
export function readQr(img, h, layout, jsQR) {
  const [qx, qy, qw, qh] = layout.qr_mm;
  for (const Q of [16, 10, 24, 8]) {
    const q = warp(img, h, { x0: qx - 3, y0: qy - 3, w: qw + 6, h: qh + 6, scale: Q });
    const gray = toGray(q), t = otsu(gray);
    const bw = new Uint8ClampedArray(q.data.length);
    for (let i = 0; i < gray.length; i++) { const v = gray[i] > t ? 255 : 0; bw[i * 4] = bw[i * 4 + 1] = bw[i * 4 + 2] = v; bw[i * 4 + 3] = 255; }
    for (const data of [q.data, bw]) {
      const r = jsQR(data, q.width, q.height, { inversionAttempts: 'dontInvert' });
      if (r?.data) return r.data;
    }
  }
  return '';
}
/** Paper to white: each channel scaled so its 97th percentile is 255 (takes the color of the light off). */
export function flattenPaper(img) {
  const n = img.width * img.height, out = new Uint8ClampedArray(img.data);
  for (let k = 0; k < 3; k++) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < n; i++) hist[img.data[i * 4 + k]]++;
    let c = 0, p = 255;
    for (let v = 0; v < 256; v++) { c += hist[v]; if (c >= n * 0.97) { p = Math.max(1, v); break; } }
    for (let i = 0; i < n; i++) out[i * 4 + k] = (img.data[i * 4 + k] / p) * 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/**
 * Reads one photo: finds the page, reads its QR and straightens it to S px per mm with the paper made white.
 * Returns { qr: { page, sheet, guide }, page: image } or { error: 'markers' | 'qr', missing? }.
 */
export function readPage(img, layout, { AR, jsQR }) {
  const found = outerCorners(findMarkers(img, AR));
  if (!found.corners) return { error: 'markers', missing: found.missing };
  const h = homography(markerTargets(layout), found.corners);
  const qr = parseQr(readQr(img, h, layout, jsQR));
  if (!qr) return { error: 'qr' };
  const [W, H] = layout.page_mm;
  return { qr, page: flattenPaper(warp(img, h, { w: W, h: H })) };
}

// ---- colors ----
/** OpenCV's 8-bit HSV: h 0..180, s and v 0..255. */
export function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return [h / 2, max ? (d / max) * 255 : 0, max];
}
const LIN = Array.from({ length: 256 }, (_, v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
/** CIE Lab on OpenCV's 8-bit scale (L 0..255, a and b offset by 128), so the reference parser's limits carry over. */
export function lab(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const x = fLab((0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456);
  const y = fLab(0.212671 * R + 0.715160 * G + 0.072169 * B);
  const z = fLab((0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754);
  return [(116 * y - 16) * 2.55, 500 * (x - y) + 128, 200 * (y - z) + 128];
}
export const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgbHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** The sky blue guide (#A4DDED) and the paper go white, so only the drawing is left. guide: false on a blank page. */
export function removeGuide(img, { guide = true } = {}) {
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    const [h, s, v] = hsv(r, g, b);
    const blue = guide && (((b - r > 25) && (g - r > 15) && v > 170 && s < 130 && Math.abs(h - 97) < 14) || ((b - r > 12) && v > 185 && s < 70));
    if (blue || (s < 35 && v > 165)) out[i] = out[i + 1] = out[i + 2] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}
/** A box of the straightened page ([x, y, w, h] mm), `inset` mm in from its printed border. */
export function crop(img, [x, y, w, h], inset = 1.5) {
  const x0 = Math.round((x + inset) * S), y0 = Math.round((y + inset) * S);
  const W = Math.round((x + w - inset) * S) - x0, H = Math.round((y + h - inset) * S) - y0;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) out.set(img.data.subarray(((y0 + j) * img.width + x0) * 4, ((y0 + j) * img.width + x0 + W) * 4), j * W * 4);
  return { width: W, height: H, data: out };
}
/** A legend swatch's color as #rrggbb, or null when under 30% of it is colored in (not set). */
export function readSwatch(img, [x, y, w, h]) {
  const x0 = Math.round((x + w * 0.12) * S), x1 = Math.round((x + w * 0.88) * S), y0 = Math.round((y + h * 0.2) * S), y1 = Math.round((y + h * 0.8) * S);
  const ink = [[], [], []];
  let n = 0;
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const p = (j * img.width + i) * 4, [, s, v] = hsv(img.data[p], img.data[p + 1], img.data[p + 2]);
      n++;
      if (s > 45 || v < 200) for (let k = 0; k < 3; k++) ink[k].push(img.data[p + k]);
    }
  }
  if (ink[0].length <= n * 0.3) return null;
  return rgbHex(ink.map((c) => c.sort((a, b) => a - b)[c.length >> 1]));
}

// ---- checking a drawing ----
/** The drawn pixels (saturated or dark) after a 3 x 3 opening that drops specks. */
export function inkMask(img) {
  const { width: W, height: H } = img, n = W * H;
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const [, s, v] = hsv(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]); fg[i] = s > 45 || v < 170 ? 1 : 0; }
  const pass = (src, keep) => { // keep = 1: erode (all 9 set), 0: dilate (any set)
    const out = new Uint8Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let all = 1, any = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)), v = src[yy * W + xx];
          all &= v; any |= v;
        }
        out[y * W + x] = keep ? all : any;
      }
    }
    return out;
  };
  return pass(pass(fg, 1), 0);
}
/**
 * The pre-check of one drawn box (cleaned crop): { present, inBox, plainBg } and for front and back also
 * { armsOut, armpitGaps, legGap }, the reference parser's checks.
 */
export function checkDrawing(img, view) {
  const { width: W, height: H } = img, fg = inkMask(img);
  let count = 0, x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fg[y * W + x]) { count++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (count / (W * H) < 0.02) return { present: false };
  const e = 2 * S, hgt = y1 - y0;
  const share = (xa, xb, ya, yb) => { let c = 0; for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) c += fg[y * W + x]; return c / ((xb - xa) * (yb - ya)); };
  const out = {
    present: true,
    inBox: y0 > e && y1 < H - e && x0 > e && x1 < W - e,
    plainBg: share(0, W, 0, e) + share(0, W, H - e, H) + share(0, e, 0, H) + share(W - e, W, 0, H) < 0.04,
  };
  if (view === 'front' || view === 'back') {
    const runs = (f) => { const y = Math.floor(y0 + hgt * f); let r = 0; for (let x = 0; x < W; x++) if (fg[y * W + x] && (x === 0 || !fg[y * W + x - 1])) r++; return r; };
    Object.assign(out, {
      armsOut: (x1 - x0) / hgt > 0.55,
      armpitGaps: Math.min(...[0.30, 0.34, 0.38].map(runs)) >= 3,
      legGap: Math.min(...[0.65, 0.75, 0.85].map(runs)) >= 2,
    });
  }
  return out;
}

// ---- the color map ----
/** The printed key colors as photographed (more faithful than the pure ones), else layout.keys. */
export function readKeys(img, layout) {
  const boxes = pageLayout(layout, 'colormap').regions.keys;
  return Object.fromEntries(Object.entries(layout.keys).map(([role, hex]) => {
    const seen = readSwatch(img, boxes[role]);
    return [role, seen && hsv(...hexRgb(seen))[1] > 90 ? seen : hex];
  }));
}
/**
 * Every pixel to the nearest key color in Lab (lightness counts a third), or NONE (255) when it is pale (white,
 * paper, pencil) or far from every key. Then a 5 x 5 median, as the reference parser. Returns Uint8Array labels
 * (index into Object.keys(keys)).
 */
export function classifyKeys(img, keys) {
  const K = Object.values(keys).map((h) => lab(...hexRgb(h)));
  const { width: W, height: H } = img, raw = new Uint8Array(W * H);
  for (let i = 0; i < raw.length; i++) {
    const r = img.data[i * 4], g = img.data[i * 4 + 1], b = img.data[i * 4 + 2];
    raw[i] = NONE;
    if (hsv(r, g, b)[1] <= 90) continue;
    const L = lab(r, g, b);
    let best = NONE, bd = 45;
    K.forEach((k, j) => { const d = Math.hypot((L[0] - k[0]) * 0.35, L[1] - k[1], L[2] - k[2]); if (d < bd) { bd = d; best = j; } });
    raw[i] = best;
  }
  const out = new Uint8Array(W * H), counts = new Map();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      counts.clear();
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const v = raw[Math.min(H - 1, Math.max(0, y + dy)) * W + Math.min(W - 1, Math.max(0, x + dx))];
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      let seen = 0;
      for (const v of [...counts.keys()].sort((a, b) => a - b)) { seen += counts.get(v); if (seen >= 13) { out[y * W + x] = v; break; } }
    }
  }
  return out;
}
/**
 * The labels on a coarse grid (cell px square): each cell its most common label, '.' when mostly nothing. One
 * row per line, '0'..'5' for the keys. Small enough to keep in the model's scene.
 */
export function coarseMap(labels, W, H, cell = 2 * S) {
  const cols = Math.floor(W / cell), rows = Math.floor(H / cell), lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const n = new Map();
      for (let y = r * cell; y < (r + 1) * cell; y++) for (let x = c * cell; x < (c + 1) * cell; x++) { const v = labels[y * W + x]; n.set(v, (n.get(v) || 0) + 1); }
      const [v] = [...n].sort((a, b) => b[1] - a[1])[0];
      line += v === NONE ? '.' : String(v);
    }
    lines.push(line);
  }
  return lines.join('\n');
}
/**
 * The color map page as it is kept with the model: { roles: [role ids in key order], front, back (coarseMap),
 * cols, rows, top, ground (the guide's head top and ground as a share of the box height), aspect (box w / h) }.
 */
export function readColorMap(page, layout, { guide = true } = {}) {
  const { regions } = pageLayout(layout, 'colormap');
  const keys = readKeys(page, layout);
  const out = { roles: Object.keys(keys).map((k) => ROLE_OF[k]), top: layout.guide.head_top_norm, ground: layout.guide.ground_norm, aspect: regions.front[2] / regions.front[3] };
  let used = 0;
  for (const side of ['front', 'back']) {
    const c = removeGuide(crop(page, regions[side]), { guide });
    const labels = classifyKeys(c, keys);
    out[side] = coarseMap(labels, c.width, c.height);
    used += labels.filter((v) => v !== NONE).length;
  }
  const lines = out.front.split('\n');
  Object.assign(out, { rows: lines.length, cols: lines[0].length });
  return used ? out : null;
}
/**
 * Part roles from the color map. parts: [{ key, c, min, max }] in model space (y up, facing +z), box: the model's
 * { min, max }. The model stands in the map box as on the guide (head top to ground, centred); each part looks at
 * the middle of its own rectangle on the FRONT map and, mirrored, the BACK map, weighted by how far forward it sits,
 * and takes its most common key. Returns { key: role } for the parts the map colors.
 */
export function rolesFromColorMap(parts, box, map) {
  const grid = (s) => s.split('\n');
  const F = grid(map.front), B = grid(map.back);
  const H = box.max[1] - box.min[1] || 1, D = box.max[2] - box.min[2] || 1, cx = (box.min[0] + box.max[0]) / 2;
  const k = (map.ground - map.top) / H; // box heights per model unit
  const u = (x, back) => 0.5 + ((back ? -1 : 1) * (x - cx) * k) / map.aspect;
  const v = (y) => map.top + (box.max[1] - y) * k;
  const out = {};
  for (const p of parts) {
    const votes = new Array(map.roles.length).fill(0);
    const wf = Math.min(1, Math.max(0, (p.c[2] - box.min[2]) / D));
    for (const [rows, back, w] of [[F, false, wf], [B, true, 1 - wf]]) {
      if (!w) continue;
      const ua = u(p.min[0], back), ub = u(p.max[0], back), mid = (ua + ub) / 2, half = Math.abs(ub - ua) * 0.3;
      const vm = (v(p.min[1]) + v(p.max[1])) / 2, vh = Math.abs(v(p.min[1]) - v(p.max[1])) * 0.3;
      const c0 = Math.floor((mid - half) * map.cols), c1 = Math.floor((mid + half) * map.cols);
      const r0 = Math.floor((vm - vh) * map.rows), r1 = Math.floor((vm + vh) * map.rows);
      for (let r = Math.max(0, r0); r <= Math.min(map.rows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(map.cols - 1, c1); c++) {
          const ch = rows[r]?.[c];
          if (ch && ch !== '.') votes[Number(ch)] += w;
        }
      }
    }
    const best = votes.indexOf(Math.max(...votes));
    if (votes[best] > 0) out[p.key] = map.roles[best];
  }
  return out;
}

// ---- one photo, read ----
/**
 * What a read page holds. View pages: { view, image (the cleaned box), check }; cover: { colors: { role: hex } };
 * detail: { crops: { helmet: image|null, ... } }; colormap: { map }.
 */
export function readContent(page, qr, layout) {
  const { regions } = pageLayout(layout, qr.page);
  const guide = qr.guide;
  if (VIEW_PAGES.includes(qr.page)) {
    const image = removeGuide(crop(page, regions[qr.page]), { guide });
    return { view: qr.page, image, check: checkDrawing(image, qr.page) };
  }
  if (qr.page === 'cover') {
    const colors = {};
    for (const [name, box] of Object.entries(regions.swatches)) { const c = readSwatch(page, box); if (c) colors[ROLE_OF[name]] = c; }
    return { colors };
  }
  if (qr.page === 'detail') {
    const crops = {};
    for (const [name, box] of Object.entries(regions)) { const c = removeGuide(crop(page, box), { guide }); crops[name] = checkDrawing(c).present ? c : null; }
    return { crops };
  }
  return { map: readColorMap(page, layout, { guide }) };
}

// ---- grouping and the pre-check ----
/**
 * Photos by sheet id, each slotted by page. scans: [{ name, qr, ... }] (the ones that read). A second photo of the
 * same page replaces the first. Returns { [sheet]: { pages: { [page]: scan }, dupes: [page] } }.
 */
export function groupBySheet(scans) {
  const out = {};
  for (const s of scans) {
    if (!s.qr) continue;
    const g = (out[s.qr.sheet] ||= { pages: {}, dupes: [] });
    if (g.pages[s.qr.page] && !g.dupes.includes(s.qr.page)) g.dupes.push(s.qr.page);
    g.pages[s.qr.page] = s;
  }
  return out;
}
const VIEW_WORD = { front: 'Front', back: 'Back', left: 'Left side', right: 'Right side' };
/**
 * The summary card's facts, before anything is paid for. scans: [{ name, qr?, error?, content? }]. Picks the sheet
 * that has a FRONT (else the one with most pages). Returns { sheet, views: [view], pages, colors, map, details,
 * warnings: [text], blocker: text|null }. blocker set means Generate stays off.
 */
export function precheck(scans) {
  const warnings = [];
  for (const s of scans) {
    if (s.error === 'markers') warnings.push(`${s.name}: we could not find the 4 corner squares. Take the photo again with the whole page in view.`);
    else if (s.error === 'qr') warnings.push(`${s.name}: we could not read the square code at the top. Take the photo again closer and in good light.`);
    else if (s.error) warnings.push(`${s.name}: ${s.error}`);
  }
  const groups = groupBySheet(scans);
  const ids = Object.keys(groups);
  if (!ids.length) return { sheet: null, views: [], pages: {}, colors: {}, map: null, details: 0, warnings, blocker: scans.length ? 'None of these photos show a Flatform drawing page.' : 'Add photos of your drawing pages.' };
  const score = (id) => (groups[id].pages.front ? 100 : 0) + Object.keys(groups[id].pages).length;
  const sheet = ids.sort((a, b) => score(b) - score(a))[0];
  const { pages, dupes } = groups[sheet];
  const others = ids.filter((id) => id !== sheet);
  if (others.length) {
    const n = others.reduce((t, id) => t + Object.keys(groups[id].pages).length, 0);
    warnings.push(`${n} photo${n > 1 ? 's are' : ' is'} from another sheet (${others.join(', ')}). We left ${n > 1 ? 'them' : 'it'} out.`);
  }
  for (const p of dupes) warnings.push(`Two photos of the ${PAGE_NAMES[p]} page. We used the last one.`);
  const views = [];
  for (const v of VIEW_PAGES) {
    const c = pages[v]?.content?.check;
    if (!c) continue;
    if (!c.present) { warnings.push(`The ${VIEW_WORD[v]} box looks empty, so we skip it.`); continue; }
    views.push(v);
    if (!c.inBox) warnings.push(`${VIEW_WORD[v]}: the drawing goes outside the box.`);
    if (!c.plainBg) warnings.push(`${VIEW_WORD[v]}: there are marks near the edge of the box.`);
    if (v === 'front' || v === 'back') {
      if (!c.armpitGaps) warnings.push(`${VIEW_WORD[v]}: the arms touch the body. Leave a gap at the armpits.`);
      else if (!c.armsOut) warnings.push(`${VIEW_WORD[v]}: hold the arms further out.`);
      if (!c.legGap) warnings.push(`${VIEW_WORD[v]}: the legs touch. Leave a gap between them.`);
    }
  }
  const colors = pages.cover?.content?.colors || {};
  const map = pages.colormap?.content?.map || null;
  if (pages.colormap && !map) warnings.push('The color map page looks empty, so we guess the part colors.');
  const details = Object.values(pages.detail?.content?.crops || {}).filter(Boolean).length;
  const blocker = !pages.front ? 'Add a photo of the FRONT page (page 2). We need it to make the model.'
    : !views.includes('front') ? 'The FRONT box looks empty. Draw your character there, then take the photo again.' : null;
  return { sheet, views, pages, colors, map, details, warnings, blocker };
}
