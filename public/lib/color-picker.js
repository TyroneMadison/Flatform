// A full-range colour picker: HSV wheel (hue ring, saturation/value square inside), hex and RGB fields, the
// browser's EyeDropper, recent swatches and a Warframe-style palette grid. One instance per inspector.
// A wheel drag calls onPreview(hex) at most once a frame (show it, don't save it) and onPick(hex) once when it ends;
// a swatch, the hex field or the RGB fields call onPick(hex) straight away. Keyboard: the fields are plain inputs.
import { hexRgb, rgbHex, paletteGrid } from './tenno.js';

const SIZE = 164; // wheel diameter in CSS px
const RING = 18; // hue ring width

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, max ? d / max : 0, max];
}
export function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
// The colour from hex, keeping the hue (and saturation) a grey or black has no say in, so the wheel never jumps.
export function hsvFromHex(hex, prev = [0, 0, 0]) {
  const [h, s, v] = rgbToHsv(...hexRgb(hex));
  return [s && v ? h : prev[0], v ? s : prev[1], v];
}
const clamp01 = (n) => Math.min(1, Math.max(0, n));
// Which part of the wheel a press at (x, y) CSS px hits: 'hue' (the ring), 'sv' (inside) or null (the corners).
export function wheelZone(x, y, size = SIZE, ring = RING) {
  const c = size / 2, d = Math.hypot(x - c, y - c);
  return d > c + 2 ? null : d > c - ring - 2 ? 'hue' : 'sv';
}
// The new [h, s, v] for a drag at (x, y) in a zone. Clamped: dragging past the square's edge or out of the wheel
// stays on the edge, it never jumps. square: { x0, y0, side } in CSS px.
export function wheelPick(zone, x, y, hsv, square, size = SIZE) {
  const c = size / 2;
  if (zone === 'hue') return (x === c && y === c) ? [...hsv] : [((Math.atan2(y - c, x - c) * 180) / Math.PI + 360) % 360, hsv[1], hsv[2]];
  const { x0, y0, side } = square;
  return [hsv[0], clamp01((x - x0) / side), clamp01(1 - (y - y0) / side)];
}
export const normalizeHex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s).trim()); return m ? `#${m[1].toLowerCase()}` : null; };

export class ColorPicker {
  constructor(el, { value = '#808080', recent = [], onPick, onPreview }) {
    this.el = el;
    this.onPick = onPick;
    this.onPreview = onPreview;
    this.recent = recent;
    this.hsv = hsvFromHex(normalizeHex(value) || '#808080');
    el.className = 'cp';
    el.innerHTML = `
      <canvas class="cp-wheel" width="${SIZE * 2}" height="${SIZE * 2}" style="width:${SIZE}px;height:${SIZE}px" aria-label="Colour wheel: the ring picks the colour, the square picks how strong and how bright" title="Drag the ring for the colour, the square for strength and brightness"></canvas>
      <div class="cp-fields">
        <label>Hex <input class="inp mono cp-hex" maxlength="7" spellcheck="false" aria-label="Hex colour" title="Type a colour code like #896185"></label>
        <div class="cp-rgb">${['r', 'g', 'b'].map((c) => `<label>${c.toUpperCase()} <input class="inp mono cp-${c}" type="number" min="0" max="255" aria-label="${c}" title="${{ r: 'Red', g: 'Green', b: 'Blue' }[c]}, 0 to 255"></label>`).join('')}</div>
        ${typeof EyeDropper === 'function' ? '<button class="btn sm ghostbtn cp-eye" type="button" title="Pick a colour from the screen">Eyedropper</button>' : ''}
      </div>
      <div class="cp-recent" aria-label="Recent colours"></div>
      <div class="cp-grid" aria-label="Palette">${paletteGrid().map((row) => row.map((c) => `<button type="button" class="sw" style="background:${c}" data-hex="${c}" aria-label="${c}" title="Use ${c}"></button>`).join('')).join('')}</div>`;
    this.canvas = el.querySelector('.cp-wheel');
    this.bind();
    this.draw();
    this.fields();
    this.renderRecent();
  }

  get hex() { return rgbHex(...hsvToRgb(...this.hsv)); }
  set(hex, { fire = true } = {}) {
    const n = normalizeHex(hex);
    if (!n) return;
    this.hsv = hsvFromHex(n, this.hsv);
    this.draw();
    this.fields();
    if (fire) this.onPick?.(n);
  }
  setRecent(list) { this.recent = list; this.renderRecent(); }

  draw() {
    const g = this.canvas.getContext('2d');
    const S = SIZE * 2, c = S / 2, R = c, r = c - RING * 2;
    g.clearRect(0, 0, S, S);
    // Hue ring.
    for (let a = 0; a < 360; a++) {
      g.beginPath();
      g.arc(c, c, R - 1, ((a - 0.6) * Math.PI) / 180, ((a + 0.6) * Math.PI) / 180);
      g.arc(c, c, r + 1, ((a + 0.6) * Math.PI) / 180, ((a - 0.6) * Math.PI) / 180, true);
      g.fillStyle = `hsl(${a} 100% 50%)`;
      g.fill();
    }
    // Saturation / value square inside the ring.
    const side = Math.floor(r * Math.SQRT2) - 8;
    const x0 = c - side / 2, y0 = c - side / 2;
    const [h, s, v] = this.hsv;
    const sat = g.createLinearGradient(x0, 0, x0 + side, 0);
    sat.addColorStop(0, '#fff');
    sat.addColorStop(1, `hsl(${h} 100% 50%)`);
    g.fillStyle = sat;
    g.fillRect(x0, y0, side, side);
    const val = g.createLinearGradient(0, y0, 0, y0 + side);
    val.addColorStop(0, 'rgba(0,0,0,0)');
    val.addColorStop(1, '#000');
    g.fillStyle = val;
    g.fillRect(x0, y0, side, side);
    // Markers.
    const ha = (h * Math.PI) / 180;
    g.lineWidth = 3;
    g.strokeStyle = '#fff';
    g.beginPath(); g.arc(c + Math.cos(ha) * (R - RING), c + Math.sin(ha) * (R - RING), 7, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(x0 + s * side, y0 + (1 - v) * side, 6, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#000'; g.lineWidth = 1;
    g.beginPath(); g.arc(x0 + s * side, y0 + (1 - v) * side, 7, 0, Math.PI * 2); g.stroke();
    this.square = { x0: x0 / 2, y0: y0 / 2, side: side / 2 };
  }

  fields() {
    const [r, g, b] = hsvToRgb(...this.hsv).map(Math.round);
    this.el.querySelector('.cp-hex').value = this.hex;
    this.el.querySelector('.cp-r').value = r;
    this.el.querySelector('.cp-g').value = g;
    this.el.querySelector('.cp-b').value = b;
    this.el.style.setProperty('--cp', this.hex);
  }

  renderRecent() {
    this.el.querySelector('.cp-recent').innerHTML = this.recent.map((c) => `<button type="button" class="sw" style="background:${c}" data-hex="${c}" aria-label="Recent ${c}" title="Use ${c} again"></button>`).join('') || '<span class="fine">Recent colours appear here</span>';
  }

  bind() {
    const cv = this.canvas;
    let zone = null, last = null, raf = 0;
    // CSS px inside the wheel, whatever the page zoom.
    const at = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) * SIZE) / (r.width || SIZE), ((e.clientY - r.top) * SIZE) / (r.height || SIZE)]; };
    const show = () => {
      raf = 0;
      if (!zone || !last) return;
      this.hsv = wheelPick(zone, ...at(last), this.hsv, this.square);
      this.draw();
      this.fields();
      this.onPreview?.(this.hex);
    };
    const end = (e) => {
      if (!zone) return;
      if (raf) cancelAnimationFrame(raf);
      last = e.type === 'pointerup' ? e : last;
      show();
      zone = null; last = null;
      if (cv.hasPointerCapture?.(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      this.onPick?.(this.hex); // the one saved step for the whole drag
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      zone = wheelZone(...at(e));
      if (!zone) return;
      e.preventDefault();
      cv.setPointerCapture?.(e.pointerId);
      last = e;
      show();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!zone) return;
      last = e;
      if (!raf) raf = requestAnimationFrame(show);
    });
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
    // Typing a full colour code shows it at once; the change event (Enter, leaving the field) also saves odd input.
    this.el.addEventListener('input', (e) => { if (e.target.classList.contains('cp-hex') && normalizeHex(e.target.value) && normalizeHex(e.target.value) !== this.hex) this.set(e.target.value); });
    this.el.addEventListener('change', (e) => {
      if (e.target.classList.contains('cp-hex')) { if (normalizeHex(e.target.value)) { if (normalizeHex(e.target.value) !== this.hex) this.set(e.target.value); } else this.fields(); }
      if (/cp-[rgb]$/.test(e.target.className)) {
        const v = (c) => Number(this.el.querySelector(`.cp-${c}`).value) || 0;
        this.set(rgbHex(v('r'), v('g'), v('b')));
      }
    });
    this.el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.hex) this.set(b.dataset.hex);
      if (b.classList.contains('cp-eye')) {
        try { const { sRGBHex } = await new EyeDropper().open(); this.set(sRGBHex); } catch { /* cancelled */ }
      }
    });
  }
}
