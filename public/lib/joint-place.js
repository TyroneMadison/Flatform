// The joints placement screen, the thinking half (compose-motion.js draws it). When Add joints can't find the limbs
// by itself the user clicks 10 spots on the model. Pure: node tests run it.
// Points are the model's own (glTF) coordinates, y up. Which way is the body's left comes from autorig.js bodyFrame.
import { MARKERS, bodyFrame } from './autorig.js';

export const SPOTS = MARKERS; // chin, groin, leftElbow, leftWrist, rightElbow, rightWrist, leftKnee, leftAnkle, rightKnee, rightAnkle
export const SPOT_NAMES = { chin: 'Chin', groin: 'Groin', leftElbow: 'Left elbow', leftWrist: 'Left wrist', rightElbow: 'Right elbow', rightWrist: 'Right wrist', leftKnee: 'Left knee', leftAnkle: 'Left ankle', rightKnee: 'Right knee', rightAnkle: 'Right ankle' };
/** One helper line per spot, for the Next spot card. */
export function spotHelp(key) {
  if (key === 'chin') return 'The bottom of the face, in the middle.';
  if (key === 'groin') return 'Where the legs meet, in the middle.';
  return key.startsWith('left') ? "The model's own left. When it faces you, that's on your right." : "The model's own right. When it faces you, that's on your left.";
}
/** The other side's spot (leftElbow → rightElbow), or null for chin and groin. */
export const twinOf = (key) => (key.startsWith('left') ? `right${key.slice(4)}` : key.startsWith('right') ? `left${key.slice(5)}` : null);
// Live bones between placed spots: the spine, chin to elbows to wrists, groin to knees to ankles.
export const BONE_LINES = [['chin', 'groin'], ['chin', 'leftElbow'], ['leftElbow', 'leftWrist'], ['chin', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['groin', 'leftKnee'], ['leftKnee', 'leftAnkle'], ['groin', 'rightKnee'], ['rightKnee', 'rightAnkle']];

/** A fresh placement. mirror: on by default (place the left side, the right one is copied). */
export const newPlacement = (mirror = true) => ({ points: {}, mirrored: {}, current: null, mirror, history: [] });
export const placedCount = (pl) => SPOTS.filter((k) => pl.points[k]).length;
/** The spot to place now: the one the user picked, else the first one not placed yet (null when all 10 are in). */
export const currentSpot = (pl) => pl.current || SPOTS.find((k) => !pl.points[k]) || null;
export const canRig = (pl) => placedCount(pl) === SPOTS.length;
/** The Rig it button's words: 'Rig it · 2 spots left' until all 10 are in. */
export function rigLabel(pl) {
  const left = SPOTS.length - placedCount(pl);
  return left ? `Rig it · ${left} spot${left === 1 ? '' : 's'} left` : 'Rig it';
}
// The body's middle: an up-down plane through c with its left-right direction n. A number is the plane x = that number.
const planeOf = (m) => (typeof m === 'number' ? { n: [1, 0, 0], c: [m, 0, 0] } : m);
/** A point mirrored across the model's middle plane (see middleOf), or the plane x = m when m is a number. */
export function mirrorPoint(p, m = 0) {
  const { n, c } = planeOf(m);
  const d = 2 * ((p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2]);
  return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
}
/**
 * The body's middle plane from points of the model: n is the body's own left, c sits in the middle of the chest
 * (the median sideways), forward is the way it faces.
 */
export function middleOf(verts) {
  if (!verts.length) return { n: [1, 0, 0], c: [0, 0, 0], forward: [0, 0, 1] };
  const f = bodyFrame(Float32Array.from(verts.flat()));
  let lo = Infinity, hi = -Infinity;
  for (const v of verts) { lo = Math.min(lo, v[1]); hi = Math.max(hi, v[1]); }
  const side = (v) => v[0] * f.left[0] + v[2] * f.left[2];
  const chest = verts.filter((v) => v[1] > lo + 0.55 * (hi - lo) && v[1] < lo + 0.8 * (hi - lo)).map(side).sort((a, b) => a - b);
  const u = chest.length ? (chest[(chest.length - 1) >> 1] + chest[chest.length >> 1]) / 2 : 0;
  return { n: f.left, c: [u * f.left[0], 0, u * f.left[2]], forward: f.forward };
}

const snap = (pl) => ({ points: { ...pl.points }, mirrored: { ...pl.mirrored } });
const round = (p) => p.map((n) => Math.round(n * 1e5) / 1e5);
// A left spot with mirror on also places its right twin, unless the user placed that one by hand.
function copyLeft(pl, key, mid) {
  const twin = twinOf(key);
  if (!pl.mirror || !key.startsWith('left') || !pl.points[key] || (pl.points[twin] && !pl.mirrored[twin])) return;
  pl.points[twin] = round(mirrorPoint(pl.points[key], mid));
  pl.mirrored[twin] = true;
}
/**
 * Places the current spot at p (one undo step). mid: the body's middle (middleOf, or a number for the plane x = mid).
 * Returns { key, twin } (twin: the mirrored spot placed with it).
 */
export function place(pl, p, mid = 0) {
  const key = currentSpot(pl);
  if (!key || !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return null;
  pl.history.push(snap(pl));
  pl.points[key] = round(p);
  delete pl.mirrored[key];
  const before = pl.points[twinOf(key)];
  copyLeft(pl, key, mid);
  pl.current = null;
  const twin = twinOf(key);
  return { key, twin: pl.mirrored[twin] && pl.points[twin] !== before ? twin : null };
}
/** Mirror on or off. Turning it on copies the left spots already placed to their empty right ones (one undo step). */
export function setMirror(pl, on, mid = 0) {
  pl.mirror = Boolean(on);
  if (!on) return;
  const keep = snap(pl);
  for (const k of SPOTS) if (k.startsWith('left') && !pl.points[twinOf(k)]) copyLeft(pl, k, mid);
  if (placedCount({ points: keep.points }) !== placedCount(pl)) pl.history.push(keep);
}
/** Clicking a row: that spot is placed next (again, if it was placed). */
export const pick = (pl, key) => { if (SPOTS.includes(key)) pl.current = key; };
/** Takes back the last placement (with the mirrored twin it brought). Returns false when there is nothing to undo. */
export function undoLast(pl) {
  const s = pl.history.pop();
  if (!s) return false;
  Object.assign(pl, s, { current: null });
  return true;
}
export function startOver(pl) { Object.assign(pl, newPlacement(pl.mirror)); }

/**
 * Where a spot probably is, from the model's own shape, so the target ring can sit on it. verts: [x, y, z] samples
 * of the model in its own coordinates; mid: the body's middle (middleOf). Placed spots win: a placed twin is mirrored.
 * ponytail: body proportions plus the farthest hand points, not a real limb finder; the click is what counts.
 */
export function guessSpot(key, verts, pl = newPlacement(), mid = middleOf(verts)) {
  if (!verts.length) return null;
  const twin = twinOf(key);
  if (twin && pl.points[twin]) return mirrorPoint(pl.points[twin], mid);
  // Work in the body's own frame: [left, up, forward] from the middle plane.
  const { n } = planeOf(mid), fw = mid.forward || [-n[2], 0, n[0]], c = planeOf(mid).c;
  const toB = (v) => [(v[0] - c[0]) * n[0] + (v[2] - c[2]) * n[2], v[1], (v[0] - c[0]) * fw[0] + (v[2] - c[2]) * fw[2]];
  const fromB = (b) => [c[0] + b[0] * n[0] + b[2] * fw[0], b[1], c[2] + b[0] * n[2] + b[2] * fw[2]];
  const vs = verts.map(toB);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); }
  const H = hi[1] - lo[1] || 1;
  const at = (f) => lo[1] + f * H;
  // The middle of the body's slice at height f on one side (s: 1 left, -1 right, 0 the middle).
  const band = (f, s) => {
    const pts = vs.filter((v) => Math.abs(v[1] - at(f)) < 0.03 * H && (s === 0 ? Math.abs(v[0]) < 0.08 * H : s * v[0] > 0.02 * H));
    if (!pts.length) return fromB([s * 0.1 * H, at(f), (lo[2] + hi[2]) / 2]);
    const m = [0, 1, 2].map((a) => pts.reduce((t, v) => t + v[a], 0) / pts.length);
    return fromB([m[0], at(f), m[2]]);
  };
  if (key === 'chin') return band(0.86, 0);
  if (key === 'groin') return band(0.48, 0);
  const s = key.startsWith('left') ? 1 : -1;
  if (/Knee$/.test(key)) return band(0.28, s);
  if (/Ankle$/.test(key)) return band(0.05, s);
  // Arms: the hand is the point farthest from the shoulder on that side, above the hips.
  const shoulder = [s * 0.11 * H, at(0.81), (lo[2] + hi[2]) / 2];
  let tip = null, best = -1;
  for (const v of vs) {
    if (v[1] < at(0.4) || s * v[0] < 0.12 * H) continue;
    const d = Math.hypot(v[0] - shoulder[0], v[1] - shoulder[1], v[2] - shoulder[2]);
    if (d > best) { best = d; tip = v; }
  }
  if (!tip) return fromB(shoulder);
  const t = /Wrist$/.test(key) ? 0.88 : 0.48;
  return fromB(shoulder.map((x, a) => x + (tip[a] - x) * t));
}

/**
 * The inside middle of the limb under a click. hits: every place the ray crosses the skin, nearest first, as
 * { distance, entering } (entering: the ray goes into the body there). Returns the distance halfway through the
 * first piece of body it enters, or null when it hits nothing.
 */
export function insideDistance(hits) {
  const i = hits.findIndex((h) => h.entering);
  if (i < 0) return hits.length ? hits[0].distance : null;
  const out = hits.slice(i + 1).find((h) => !h.entering);
  return out ? (hits[i].distance + out.distance) / 2 : hits[i].distance;
}
