// The render time stamp: the render's start time in New York time, burned small into the bottom-right corner of every
// picture of a render (one stamp for every frame of a spin) and put in its file names. The Blender script
// (render/blender_turntable.py burn_stamp) draws the same text at the same size and place.
const TZ = 'America/New_York';
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h12' });

function parts(at) {
  const d = new Date(at ?? NaN);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return { ...p, dayPeriod: p.dayPeriod.toUpperCase() };
}

/** "2026-10-26 5:25 AM ET". '' for a missing or bad time. */
export function stampText(at) {
  const p = parts(at);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.dayPeriod} ET` : '';
}

/** The same time for a file name, with seconds so two renders in one minute never share a name:
 * "2026-10-26_05-25-07AM-ET". '' for a missing or bad time. */
export function stampFile(at) {
  const p = parts(at);
  return p ? `${p.year}-${p.month}-${p.day}_${p.hour.padStart(2, '0')}-${p.minute}-${p.second}${p.dayPeriod}-ET` : '';
}

/** Where the stamp goes on a w×h picture: text size and its bottom-right corner (text right- and bottom-aligned). */
export function stampLayout(w, h) {
  const size = Math.max(12, Math.round(Math.min(w, h) * 0.022));
  const pad = Math.round(size * 0.8);
  return { size, x: w - pad, y: h - pad, outline: Math.max(1, Math.round(size * 0.08)) };
}

/** Burns text into a canvas (white with a dark outline, readable on any background). No text: leaves it clean. */
export function burnStamp(canvas, text) {
  if (!text) return canvas;
  const L = stampLayout(canvas.width, canvas.height);
  const g = canvas.getContext('2d');
  g.save();
  g.font = `600 ${L.size}px system-ui, "Segoe UI", sans-serif`;
  g.textAlign = 'right';
  g.textBaseline = 'bottom';
  g.lineJoin = 'round';
  g.lineWidth = L.outline * 2;
  g.strokeStyle = 'rgba(0,0,0,.8)';
  g.strokeText(text, L.x, L.y);
  g.fillStyle = '#ffffff';
  g.fillText(text, L.x, L.y);
  g.restore();
  return canvas;
}
