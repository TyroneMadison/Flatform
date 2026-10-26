// Style transfer: post-process only. Takes a rendered frame (ImageData-like {data,width,height}) and returns a new
// one; the model and materials are never touched. painterly = Kuwahara filter; cel = toon ramp plus a dark outline
// where luminance jumps. Applied per frame, so MP4s get it frame by frame before encoding. Fully local.
export const STYLES = ['none', 'painterly', 'cel'];
const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

export function kuwahara({ data, width, height }, r = 3) {
  const out = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let best = Infinity, mean = null;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      let n = 0, s = [0, 0, 0], s2 = 0, sl = 0;
      for (let j = 0; j <= r; j++) for (let i = 0; i <= r; i++) {
        const px = Math.min(width - 1, Math.max(0, x + sx * i)), py = Math.min(height - 1, Math.max(0, y + sy * j));
        const k = (py * width + px) * 4, l = lum(data, k);
        s[0] += data[k]; s[1] += data[k + 1]; s[2] += data[k + 2]; sl += l; s2 += l * l; n++;
      }
      const v = s2 / n - (sl / n) ** 2;
      if (v < best) { best = v; mean = s.map((c) => c / n); }
    }
    const o = (y * width + x) * 4; out[o] = mean[0]; out[o + 1] = mean[1]; out[o + 2] = mean[2];
  }
  return { data: out, width, height };
}

export function cel({ data, width, height }, { steps = 4, edge = 40 } = {}) {
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < data.length; i += 4) {
    const l = lum(data, i) || 1, q = Math.min(255, (Math.floor((l / 256) * steps) + 0.5) * (256 / steps));
    for (let c = 0; c < 3; c++) out[i + c] = data[i + c] * (q / l);
  }
  for (let y = 0; y < height - 1; y++) for (let x = 0; x < width - 1; x++) {
    const k = (y * width + x) * 4, g = Math.abs(lum(data, k) - lum(data, k + 4)) + Math.abs(lum(data, k) - lum(data, k + width * 4));
    if (g > edge && data[k + 3] > 0) { out[k] = out[k + 1] = out[k + 2] = 20; }
  }
  return { data: out, width, height };
}

export const applyStyle = (img, style, opts) => (style === 'painterly' ? kuwahara(img, opts?.radius) : style === 'cel' ? cel(img, opts) : img);
