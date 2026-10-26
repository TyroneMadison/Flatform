// A small PNG reader/writer with no dependencies, for the TennoGen checker: read a size from the header, decode,
// resize and encode. 8 and 16 bit, colour types 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha), 6 (RGBA), filters 0–4.
// ponytail: interlaced PNGs are refused (Adam7 is rarely used for textures); output is always non-interlaced,
// filter 0 per row. Add sharp if this ever becomes the slow part.
import { inflateSync, deflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export const isPng = (buf) => buf.length >= 24 && buf.subarray(0, 8).equals(SIG);

// { width, height } from the IHDR, or null if it is not a PNG.
export function pngSize(buf) {
  if (!isPng(buf)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function* chunks(buf) {
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    yield { type, data: buf.subarray(p + 8, p + 8 + len) };
    p += 12 + len;
  }
}

// → { width, height, channels, data: Uint8Array (8-bit, channels per pixel) }
export function decode(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG');
  const ihdr = buf.subarray(16, 29);
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const type = ihdr[9];
  if (ihdr[12]) throw new Error('Interlaced PNGs are not supported');
  const perPixel = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!perPixel || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('Unsupported PNG format');
  const idat = [];
  let palette = null;
  let trns = null;
  for (const c of chunks(buf)) {
    if (c.type === 'IDAT') idat.push(c.data);
    else if (c.type === 'PLTE') palette = c.data;
    else if (c.type === 'tRNS') trns = c.data;
    else if (c.type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (perPixel * depth) >> 3); // bytes per pixel for the filters
  const stride = Math.ceil((width * perPixel * depth) / 8);
  const rows = Buffer.alloc(stride * height);
  for (let y = 0, src = 0, dst = 0; y < height; y++, src += stride + 1, dst += stride) {
    const filter = raw[src];
    for (let i = 0; i < stride; i++) {
      const x = raw[src + 1 + i];
      const a = i >= bpp ? rows[dst + i - bpp] : 0;
      const b = y > 0 ? rows[dst + i - stride] : 0;
      const c = y > 0 && i >= bpp ? rows[dst + i - stride - bpp] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      else throw new Error(`Bad PNG filter ${filter}`);
      rows[dst + i] = v & 0xff;
    }
  }
  // Unpack to 8-bit samples.
  const channels = type === 3 ? (trns ? 4 : 3) : perPixel;
  const data = new Uint8Array(width * height * channels);
  const sample = (row, i) => { // sample i of a row at the bit depth, scaled to 0–255
    if (depth === 8) return rows[row + i];
    if (depth === 16) return rows[row + i * 2];
    const bit = i * depth;
    const v = (rows[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    return type === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      if (type === 3) {
        const idx = sample(row, x);
        data[o] = palette[idx * 3]; data[o + 1] = palette[idx * 3 + 1]; data[o + 2] = palette[idx * 3 + 2];
        if (channels === 4) data[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else for (let c = 0; c < perPixel; c++) data[o + c] = sample(row, x * perPixel + c);
    }
  }
  return { width, height, channels, data };
}

// Area-average when shrinking, bilinear when growing. Non-uniform scales (2048x2048 → 1024x2048) are fine.
export function resize(img, width, height) {
  const { channels: ch } = img;
  const out = new Uint8Array(width * height * ch);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      if (sx >= 1 && sy >= 1) { // box average over the source pixels this one covers
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
        const sum = new Float64Array(ch);
        let n = 0;
        for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++, n++) {
          const i = (yy * img.width + xx) * ch;
          for (let c = 0; c < ch; c++) sum[c] += img.data[i + c];
        }
        for (let c = 0; c < ch; c++) out[o + c] = Math.round(sum[c] / n);
      } else { // bilinear
        const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5), fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
        const x0 = Math.max(0, Math.floor(fx)), y0 = Math.max(0, Math.floor(fy));
        const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
        const tx = Math.max(0, fx - x0), ty = Math.max(0, fy - y0);
        for (let c = 0; c < ch; c++) {
          const a = img.data[(y0 * img.width + x0) * ch + c], b = img.data[(y0 * img.width + x1) * ch + c];
          const d = img.data[(y1 * img.width + x0) * ch + c], e = img.data[(y1 * img.width + x1) * ch + c];
          out[o + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty);
        }
      }
    }
  }
  return { width, height, channels: ch, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 8-bit, colour type from the channel count, filter 0 on every row.
export function encode({ width, height, channels, data }) {
  const type = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels];
  if (type === undefined) throw new Error('channels must be 1–4');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = type; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const resizePng = (buf, width, height) => encode(resize(decode(buf), width, height));
