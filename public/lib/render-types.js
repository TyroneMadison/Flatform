// The Render tool's "pick one type, press Run" (v3). Each type turns into one or more render tasks for the queue in
// views/compose-render.js; the old checkboxes (what to render, looks, engine, file types) still exist under
// More settings and ride along. Pure (no DOM), so node tests can check every type and option.

// The paint colours "Every colour" and "Overnight list" use, in this order.
export const COLOURS = [['Red', '#c81e1e'], ['Black', '#111111'], ['White', '#f2f2f2'], ['Blue', '#1e4fd8'], ['Yellow', '#f2c200'], ['Silver', '#a8acb3']];

export const RENDER_TYPES = [
  { id: 'picture', label: 'Picture', desc: 'One picture of exactly what you see', time: 'about 20 s' },
  { id: 'spin', label: 'Spin video', desc: 'The car turns all the way round (or half way). Can also save photo frames for Dud Rents', time: 'about 6 min',
    options: [['full', 'All the way round', 'A full turn: a video plus a spin people can drag on a website'],
      ['half', 'Half way', 'Front to back only, for a detail page'],
      ['photos', 'Photo frames for Dud Rents', 'Make a spin from your own photos, or render one, and send it to Dud Rents']] },
  { id: 'move', label: 'Camera move video', desc: 'The camera flies around as a video', time: 'about 4 min' },
  { id: 'painted', label: 'Painted or cartoon look', desc: 'Same view, drawn in an art style', time: 'about 40 s',
    options: [['painterly', 'Painted', 'Soft brush strokes, like an oil painting'], ['cel', 'Cartoon', 'Flat colours with dark outlines']] },
  { id: 'colours', label: 'Every colour', desc: `Same view once in each paint colour (${COLOURS.map(([n]) => n.toLowerCase()).join(', ')})`, time: 'about 2 min each' },
  { id: 'overnight', label: 'Overnight list', desc: 'Big list that runs while you sleep: every colour as a picture and a spin video', time: 'until done' },
];
export const typeOf = (id) => RENDER_TYPES.find((t) => t.id === id) || RENDER_TYPES[0];
export const defaultOption = (id) => typeOf(id).options?.[0][0] ?? null;

// The pieces "Every colour" repaints: the body paint (Infer colours from photo labels it) or anything on the Primary slot.
const isBody = (p) => p?.region?.label === 'paint' || p?.slot === 'primary';
export const bodyPieces = (paint) => Object.keys(paint?.pieces || {}).filter((k) => isBody(paint.pieces[k]));

/** The paint with every body piece in colour hex, or null when no piece is known to be body paint. */
export function colourVariant(paint, hex) {
  const keys = bodyPieces(paint);
  if (!keys.length) return null;
  const pieces = { ...paint.pieces };
  for (const k of keys) pieces[k] = { ...pieces[k], material: { ...(pieces[k].material || {}), color: hex } };
  return { ...paint, pieces };
}

const STILL = { still: true, t360: false, t180: false };
const FULL = { still: false, t360: true, t180: true };
const HALF = { still: false, t360: false, t180: true };
const NEEDS_BODY = 'Every colour needs to know which parts are body paint. In Look, press Infer colours from photo first (or give the body the Primary colour), then press Run again.';

/**
 * What pressing Run does for a type: { tasks: [{ label, patch, job? }], go?, error?, fix?, overnight? }. patch is laid
 * over the More settings options for that task, and may carry: video ('spin' | 'half' | 'move' | 'phone': an MP4 from
 * the frames), style ('painterly' | 'cel'), paint (a repainted body), suffix (added to file names so the colours don't
 * overwrite each other) and the extras (effect, poster, vertical). ctx: { paint, cameraMove (a camera move is set up), extras (from a Render idea) }.
 */
export function planRun(type, option, { paint = null, cameraMove = false, extras = {} } = {}) {
  const t = typeOf(type);
  const opt = option ?? defaultOption(t.id);
  const ex = { ...extras };
  if (t.id === 'picture') return { tasks: [{ label: ex.poster ? 'Hero poster' : ex.effect?.override ? `Picture · ${ex.effect.override === 'clay' ? 'clay' : 'blueprint'}` : ex.effect?.explode ? 'Picture · exploded' : 'Picture', patch: { ...STILL, ...ex } }] };
  if (t.id === 'spin') {
    if (opt === 'photos') return { tasks: [], go: 'spin' };
    return { tasks: [{ label: ex.vertical ? 'Phone spin 9:16' : opt === 'half' ? 'Spin video · half way' : 'Spin video', patch: { ...(opt === 'half' ? HALF : FULL), video: ex.vertical ? 'phone' : opt === 'half' ? 'half' : 'spin', ...ex } }] };
  }
  if (t.id === 'move') {
    if (!cameraMove) return { tasks: [], error: 'Set up a camera move first: open Camera, pick a move (like Orbit or Fly by), then press Run again.', fix: 'camera' };
    return { tasks: [{ label: 'Camera move video', patch: { ...FULL, t180: false, showroom: false, transparent: false, studio: true, video: 'move', renderer: 'three', ...ex } }] }; // Blender can't follow a camera move yet
  }
  if (t.id === 'painted') return { tasks: [{ label: opt === 'cel' ? 'Cartoon picture' : 'Painted picture', patch: { ...STILL, ...ex, style: opt === 'cel' ? 'cel' : 'painterly' } }] };
  if (t.id === 'colours') {
    if (!colourVariant(paint, '#000000')) return { tasks: [], error: NEEDS_BODY, fix: 'look' };
    return { tasks: COLOURS.map(([name, hex]) => ({ label: `Picture · ${name}`, patch: { ...STILL, ...ex, paint: colourVariant(paint, hex), suffix: name.toLowerCase() } })) };
  }
  if (t.id === 'overnight') {
    const variants = colourVariant(paint, '#000000') ? COLOURS.map(([name, hex]) => ({ id: name.toLowerCase(), name, paint: colourVariant(paint, hex) })) : [{ id: 'current', name: 'Current colours', paint: null }];
    const tasks = variants.flatMap((v) => [
      { label: `${v.name} · picture`, job: `${v.id}:turntable:still`, patch: { ...STILL, ...ex, ...(v.paint && { paint: v.paint, suffix: v.id }) } },
      { label: `${v.name} · spin video`, job: `${v.id}:turntable:mp4`, patch: { ...FULL, video: 'spin', ...ex, ...(v.paint && { paint: v.paint, suffix: v.id }) } },
    ]);
    return { tasks, overnight: { variants: variants.map(({ id, name }) => ({ id, name })), paths: [{ id: 'turntable', name: 'Spin' }], formats: ['still', 'mp4'] } };
  }
  return { tasks: [] };
}

// ---- after the render: extras a Render idea adds, done on the finished PNGs so both engines get them ----

/** The centred 9:16 box inside a w × h frame: { x, y, width, height } in whole pixels, even sizes for video. */
export function verticalCrop(w, h) {
  let height = h, width = Math.round((h * 9) / 16);
  if (width > w) { width = w; height = Math.round((w * 16) / 9); }
  width -= width % 2; height -= height % 2;
  return { x: Math.floor((w - width) / 2), y: Math.floor((h - height) / 2), width, height };
}

/** Where the poster title goes on a w × h picture: big, bold, near the top, never wider than the picture. */
export function posterLayout(w, h, title) {
  const text = String(title || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Untitled';
  const size = Math.round(Math.min(h * 0.12, (w * 0.9) / Math.max(4, text.length * 0.6)));
  return { text, size, x: Math.round(w / 2), y: Math.round(h * 0.08 + size), maxWidth: Math.round(w * 0.9) };
}

/** Exploded parts: how far each part moves, outward from the model's centre. centers: [[x, y, z]], amount: 0..1 of the
 * size. Nothing moves down (up: the vertical axis, Y in three.js), so wheels never sink through the floor. */
export function explodeOffsets(centers, size, amount = 0.15, up = 1) {
  if (centers.length < 2) return centers.map(() => [0, 0, 0]);
  const mid = [0, 1, 2].map((i) => centers.reduce((s, c) => s + c[i], 0) / centers.length);
  return centers.map((c) => {
    const d = c.map((v, i) => (i === up ? Math.max(0, v - mid[i]) : v - mid[i]));
    const len = Math.hypot(...d);
    return len < 1e-6 ? [0, 0, 0] : d.map((v) => (v / len) * size * amount);
  });
}

/** The extras a task carries, checked: { explode, override, poster, vertical }. Anything else is dropped. */
export function cleanExtras(x = {}) {
  const out = {};
  if (x.effect?.explode > 0) out.effect = { explode: Math.min(1, Number(x.effect.explode)) };
  if (['clay', 'blueprint'].includes(x.effect?.override)) out.effect = { ...out.effect, override: x.effect.override };
  if (typeof x.poster === 'string') out.poster = x.poster.replace(/[\u0000-\u001f]/g, '').slice(0, 60);
  if (x.vertical === true) out.vertical = true;
  return out;
}
