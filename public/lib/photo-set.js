// Several photos of one thing make ONE model. Each photo gets an angle (Front, Left, Back, Right or Other), guessed
// from a tiny copy of it and changed with a click. The best photo of each side goes to the engine, as many as it
// takes; the rest are kept with the model for checking detail. "Separate models" (off unless turned on) makes one
// model per photo instead. Pure logic: the setup screen, the server form and the tests share it.
import { VIEWS, ENGINES, PROVIDERS, normalize } from './engines.js';

export const ANGLES = ['front', 'left', 'back', 'right', 'other'];
export const ANGLE_NAMES = { front: 'Front', left: 'Left', back: 'Back', right: 'Right', other: 'Other' };
export const MAX_REFS = 8; // kept photos the server saves with a model

// How many photos an engine takes in one job: the multi-side engines take one per side (front, left, back, right).
export const photoLimit = (engine) => (ENGINES[engine]?.views ? VIEWS.length : 1);

/**
 * Cheap numbers about a small RGBA copy of a photo (about 64 px wide): how big and sharp the subject is, its shape,
 * how mirror-alike its two halves are, how much bright red it has (tail lights) and which end is lower (a car's hood).
 */
export function photoFeatures(data, w, h) {
  const px = (x, y) => (y * w + x) * 4;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  // The background is the median color of the border; the subject is whatever differs from it.
  const border = [];
  for (let x = 0; x < w; x++) border.push(px(x, 0), px(x, h - 1));
  for (let y = 0; y < h; y++) border.push(px(0, y), px(w - 1, y));
  const med = [0, 1, 2].map((c) => border.map((i) => data[i + c]).sort((a, b) => a - b)[border.length >> 1]);
  const mask = new Uint8Array(w * h);
  let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0, red = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = px(x, y);
      const d = Math.abs(data[i] - med[0]) + Math.abs(data[i + 1] - med[1]) + Math.abs(data[i + 2] - med[2]);
      if (d < 60) continue;
      mask[y * w + x] = 1;
      area++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (data[i] > 120 && data[i] > 1.8 * data[i + 1] && data[i] > 1.8 * data[i + 2]) red++;
    }
  }
  let sharp = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    sharp += Math.abs(4 * gray[k] - gray[k - 1] - gray[k + 1] - gray[k - w] - gray[k + w]);
  }
  sharp /= Math.max(1, (w - 2) * (h - 2)) * 255;
  if (x1 < 0) return { size: 0, aspect: 1, symmetry: 0, red: 0, lowEnd: 0, sharp };
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // Mirror test inside the subject's box: the shape and the shading of the left half against the right half.
  let same = 0, n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x < x0 + (bw >> 1); x++) {
    const m = x1 - (x - x0);
    const a = mask[y * w + x], b = mask[y * w + m];
    if (!a && !b) continue;
    n++;
    if (a && b) same += 1 - Math.min(1, Math.abs(gray[y * w + x] - gray[y * w + m]) / 64);
  }
  // The top edge of each third: a side view of a car has its low hood at the front end.
  const top = (from, to) => {
    let sum = 0, cols = 0;
    for (let x = from; x < to; x++) {
      let y = y0;
      while (y <= y1 && !mask[y * w + x]) y++;
      if (y <= y1) { sum += (y - y0) / bh; cols++; }
    }
    return cols ? sum / cols : 0;
  };
  const third = Math.max(1, Math.floor(bw / 3));
  return {
    size: area / (w * h), aspect: bw / bh, symmetry: n ? same / n : 0, red: red / Math.max(1, area),
    lowEnd: top(x0, x0 + third) - top(x1 + 1 - third, x1 + 1), sharp, // > 0: the left end is lower
  };
}

/**
 * The angle a photo most likely shows, and how sure (0 to 1). Wide and mostly mirror-alike: a side; the low end is the front,
 * and a car facing left in the picture shows its left side. Tall-ish and mirror-alike: front, or back with tail lights.
 */
// ponytail: hand-tuned rules on a 64 px copy, fine for cars on plain backgrounds; a small trained model if they miss.
export function guessAngle(f) {
  if (!f || f.size < 0.02) return { angle: 'other', sure: 0 };
  if (f.aspect >= 1.7 && f.symmetry >= 0.55 && f.symmetry < 0.9) { // a corner shot is wide too, but lopsided
    if (Math.abs(f.lowEnd) < 0.04) return { angle: 'other', sure: 0.3 };
    return { angle: f.lowEnd > 0 ? 'left' : 'right', sure: Math.min(1, 0.4 + (f.aspect - 1.7) + Math.abs(f.lowEnd)) };
  }
  if (f.aspect < 1.7 && f.symmetry >= 0.78) {
    return { angle: f.red >= 0.03 ? 'back' : 'front', sure: Math.min(1, f.symmetry - 0.3 + Math.min(0.3, f.red * 3)) };
  }
  return { angle: 'other', sure: 0.2 };
}

// Best photo first: a big, sharp subject.
const score = (p) => (p.features?.size || 0) * 2 + (p.features?.sharp || 0) * 10 + (p.sure || 0) * 0.1;

/**
 * Picks what goes to the engine. photos: [{ id, angle, sure?, features? }] (angle is the guess, or the one you
 * clicked). Returns { views: { front: id, left?: id, ... }, kept: [ids], frontWasGuessed }. With no Front photo the
 * best photo is used as the front. Engines that take one photo get only the front.
 */
export function pickViews(photos, limit = VIEWS.length) {
  if (!photos.length) return { views: {}, kept: [], frontWasGuessed: false };
  const best = (list) => [...list].sort((a, b) => score(b) - score(a))[0];
  const views = {};
  for (const v of VIEWS) {
    const of = photos.filter((p) => p.angle === v);
    if (of.length) views[v] = best(of).id;
  }
  let frontWasGuessed = false;
  if (!views.front) {
    const spare = photos.filter((p) => !Object.values(views).includes(p.id));
    views.front = best(spare.length ? spare : photos).id;
    frontWasGuessed = true;
    for (const v of VIEWS.slice(1)) if (views[v] === views.front) delete views[v];
  }
  const sent = Object.fromEntries(VIEWS.filter((v) => views[v]).slice(0, limit).map((v) => [v, views[v]]));
  const used = new Set(Object.values(sent));
  return { views: sent, kept: photos.filter((p) => !used.has(p.id)).map((p) => p.id), frontWasGuessed };
}

/**
 * The jobs for the photos on the setup screen. One model from all photos (the default): one job whose files are
 * the picked sides, in 'views' mode when it has 2 or more, plus the kept photos as refs. separate: one job per photo.
 * Returns { jobs: [{ files: { front, left, ... } of photo ids, refs: [ids], setup }], plan } where plan is pickViews'.
 */
export function planJobs(photos, setup, { separate = false } = {}) {
  if (!photos.length) return { jobs: [], plan: null };
  if (separate) return { jobs: photos.map((p) => ({ files: { front: p.id }, refs: [], setup: normalize({ ...setup, mode: 'single' }) })), plan: null };
  const plan = pickViews(photos, photoLimit(setup.engine));
  const mode = Object.keys(plan.views).length > 1 ? 'views' : 'single';
  return { jobs: [{ files: plan.views, refs: plan.kept.slice(0, MAX_REFS), setup: normalize({ ...setup, mode }) }], plan };
}

// One plain line about where the photos go, e.g. "4 of 5 photos go to Tripo. 1 is kept for checking detail."
export function planLine(photos, setup, { separate = false } = {}) {
  const n = photos.length;
  const name = ENGINES[setup.engine]?.provider === '3daistudio' ? ENGINES[setup.engine].label : PROVIDERS[setup.provider].name;
  if (n < 2) return '';
  if (separate) return `Each of the ${n} photos makes its own model.`;
  const { plan } = planJobs(photos, setup);
  const sent = Object.keys(plan.views).length;
  const kept = n - sent;
  const lines = [`${sent} of ${n} photos go to ${name}.`];
  if (photoLimit(setup.engine) === 1) lines[0] = `${name} takes one photo, so the best one is sent.`;
  if (kept) lines.push(`${kept} ${kept === 1 ? 'is' : 'are'} kept for checking detail.`);
  if (plan.frontWasGuessed) lines.push('No photo is marked Front, so the clearest one is used.');
  return lines.join(' ');
}

// In the page: guesses the angle of each photo that has none yet, from a 96 px copy. A photo the browser can't read
// (some HEIC files) stays Other. Sets angle, sure and features on each photo; returns the same list.
export async function guessPhotos(photos) {
  await Promise.all(photos.filter((p) => !p.angle).map(async (p) => {
    try {
      const bmp = await createImageBitmap(p.file);
      const w = 96, h = Math.max(8, Math.round((96 * bmp.height) / bmp.width));
      const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      p.features = photoFeatures(ctx.getImageData(0, 0, w, h).data, w, h);
      Object.assign(p, guessAngle(p.features));
    } catch { Object.assign(p, { angle: 'other', sure: 0 }); }
  }));
  return photos;
}
