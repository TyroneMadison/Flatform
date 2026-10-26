// Camera moves and the sky playlist (Sadie half). Pure data and maths, shared by Compose, the in-app turntable
// render and the tests. A path is a list of stops (saved camera spots) placed along the clip from 0 to 1.
export const EASINGS = { linear: 'Steady', smooth: 'Smooth', curve: 'Curved path' };
export const MAX_STOPS = 12;

const clamp01 = (t) => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [0, 1, 2].map((i) => lerp(a[i], b[i], t));
const smooth = (t) => t * t * (3 - 2 * t);
// Catmull-Rom through p1..p2 with neighbours p0 and p3: a curve that passes through every stop.
const cr = (p0, p1, p2, p3, t) => [0, 1, 2].map((i) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
});

const finite3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
// Cleans a saved path: valid stops only, sorted by time, at most MAX_STOPS.
export function normalizePath(p) {
  const stops = (Array.isArray(p?.stops) ? p.stops : [])
    .filter((s) => s && finite3(s.position) && finite3(s.target))
    .map((s) => ({ position: s.position.slice(), target: s.target.slice(), lens: Number.isFinite(s.lens) ? s.lens : null, at: clamp01(Number(s.at) || 0), name: String(s.name || '').slice(0, 40) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_STOPS);
  return { on: !!p?.on && stops.length >= 2, easing: Object.hasOwn(EASINGS, p?.easing) ? p.easing : 'smooth', spin: p?.spin !== false, stops, name: String(p?.name || '').slice(0, 60) };
}
// Spreads the stops evenly from 0 to 1 (what "Even spacing" does).
export const spreadStops = (stops) => stops.map((s, i) => ({ ...s, at: stops.length > 1 ? i / (stops.length - 1) : 0 }));

// Camera at clip time t (0..1): { position, target, lens }. Before the first stop it holds the first, after the
// last it holds the last.
export function samplePath(path, t) {
  const p = normalizePath({ ...path, on: true });
  const s = p.stops;
  if (!s.length) return null;
  t = clamp01(t);
  if (s.length === 1 || t <= s[0].at) return pick(s[0]);
  if (t >= s[s.length - 1].at) return pick(s[s.length - 1]);
  let i = 0;
  while (i < s.length - 2 && t > s[i + 1].at) i++;
  const a = s[i], b = s[i + 1];
  const span = b.at - a.at || 1;
  let u = clamp01((t - a.at) / span);
  if (p.easing === 'smooth') u = smooth(u);
  const lens = a.lens != null && b.lens != null ? lerp(a.lens, b.lens, u) : a.lens ?? b.lens;
  if (p.easing === 'curve') {
    const p0 = s[i - 1] || a, p3 = s[i + 2] || b;
    return { position: cr(p0.position, a.position, b.position, p3.position, u), target: cr(p0.target, a.target, b.target, p3.target, u), lens };
  }
  return { position: lerp3(a.position, b.position, u), target: lerp3(a.target, b.target, u), lens };
}
const pick = (s) => ({ position: s.position.slice(), target: s.target.slice(), lens: s.lens });

// Builds a path from saved camera spots (bookmarks), spread evenly.
export const pathFromBookmarks = (marks, opts = {}) => normalizePath({ on: true, ...opts, stops: spreadStops((marks || []).map((b) => ({ ...b }))) });

// ---- Sky: turn the HDRI over the clip and switch between HDRIs at set points. ----
export function normalizeSky(s) {
  const list = (Array.isArray(s?.playlist) ? s.playlist : [])
    .filter((e) => e && typeof e.file === 'string' && e.file)
    .map((e) => ({ file: e.file, at: clamp01(Number(e.at) || 0) }))
    .sort((a, b) => a.at - b.at).slice(0, 8);
  const spin = Number(s?.spin);
  const fade = Number(s?.fade);
  return { on: !!s?.on, spin: Number.isFinite(spin) ? Math.max(-720, Math.min(720, spin)) : 0, fade: Number.isFinite(fade) ? Math.min(0.25, Math.max(0, fade)) : 0.06, playlist: list };
}
// The sky at clip time t: which HDRI (null = keep the look's own), the extra turn in degrees, and a brightness
// factor that dips to dark around each switch so the cut is a quick fade instead of a pop.
export function skyAt(sky, t) {
  const s = normalizeSky(sky);
  t = clamp01(t);
  if (!s.on) return { file: null, rotation: 0, dim: 1 };
  let file = null, dim = 1;
  for (const e of s.playlist) if (t >= e.at) file = e.file;
  for (const e of s.playlist) {
    if (e.at <= 0 || !s.fade) continue;
    const d = Math.abs(t - e.at);
    if (d < s.fade) dim = Math.min(dim, d / s.fade);
  }
  return { file, rotation: s.spin * t, dim };
}
