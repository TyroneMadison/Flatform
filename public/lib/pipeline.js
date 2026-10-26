// Turntable and handoff rules shared by the browser renderer, the server and the tests.
// Pure functions only (no DOM, no fs) so both sides agree on every name and number.

export const FRAMES = 72; // a full turn in 5° steps
export const STEP = 5; // degrees per frame
export const HALF = 37; // the 180° half turn is frames 000–036, cut from the same 72
export const COLUMNS = 12; // sprite sheet columns
export const WEB_WIDTHS = [512, 256]; // frame widths of the web sprite sheets
export const LOOKS = {
  showroom: { width: 2048, height: 1536, label: 'Showroom' }, // 4:3, the 3D showroom: Dud Rents' house look
  studio: { width: 2048, height: 1536, label: 'Composed scene' }, // 4:3, whatever scene was set up in Compose
  transparent: { width: 2048, height: 2048, label: 'Transparent' }, // RGBA with a soft contact shadow
};

// The light rig and glass set in Compose's render area. Saved in settings, applied on top of each scene's own lights
// by the in-app renderer and by render/blender_turntable.py. key, fill and rim are multipliers (1 = the scene's own).
export const LIGHT_RANGES = {
  key: [0, 2], azimuth: [-180, 180], elevation: [5, 85], kelvin: [2700, 9000], fill: [0, 2], rim: [0, 2],
};
export const DEFAULT_LIGHTING = { key: 1, azimuth: -40, elevation: 40, kelvin: 5600, fill: 1, rim: 1 };
export const DEFAULT_GLASS = { on: true, tint: '#14202a', opacity: 0.15 };

// ---- model size and camera framing (shared by studio.js, the tests and mirrored in render/blender_turntable.py) ----
export const CAR_LENGTH = 4.6; // metres every car is normalised to ("Fit")
export const SENSOR_HALF = 17.5; // half of a 35 mm film gauge: horizontal fov = 2·atan(17.5 / lens)
export const hfovOf = (lens) => 2 * Math.atan(SENSOR_HALF / lens); // radians
// A car is longer than it is tall. Anything clearly taller than its longest horizontal span (a humanoid, a tower)
// is not a car: the fleet size lock doesn't apply to it and Fit means its tallest side is CAR_LENGTH.
export const isCarShape = ({ x, y, z }) => y <= 1.15 * Math.max(x, z);
// The scale that normalises a model of raw size {x, y, z}: cars by length (locked with sameSize), others by their
// largest side, with the Scale slider always live.
export function modelScale(size, { sameSize = true, scale = 1 } = {}) {
  const car = isCarShape(size);
  const fit = CAR_LENGTH / Math.max(car ? Math.max(size.x, size.z) : Math.max(size.x, size.y, size.z), 1e-6);
  return fit * (car && sameSize ? 1 : scale);
}
// Distance from which a sphere of `radius` fits a frame of horizontal fov `hfov` (radians) and `aspect`, with
// a little padding round it ("Frame all").
export function fitDistance(radius, hfov, aspect, pad = 1.1) {
  const half = Math.atan(Math.min(Math.tan(hfov / 2), Math.tan(hfov / 2) / aspect));
  return (Math.max(radius, 1e-6) * pad) / Math.sin(half);
}
// The free-roam orbit that frames a sphere, looking from the same direction as `from` (a position) towards it.
export function frameOrbit({ center, radius }, from, hfov, aspect) {
  const d = fitDistance(radius, hfov, aspect);
  let dir = from.map((v, i) => v - center[i]);
  const len = Math.hypot(...dir);
  dir = len > 1e-6 ? dir.map((v) => v / len) : [0, 0.25, 1].map((v) => v / Math.hypot(0, 0.25, 1));
  return { target: [...center], position: center.map((v, i) => v + dir[i] * d) };
}

// A look's frame (aspect) fitted inside a canvas of aspect `view`: the vertical fov (degrees) that keeps the frame's
// own vertical half-angle tangent `tanV`, so the scene shows at the same size whatever the window's shape.
export function letterbox(tanV, aspect, view) {
  return (2 * Math.atan(view >= aspect ? tanV : (tanV * aspect) / view) * 180) / Math.PI;
}

// Validates a full or partial lighting / glass object; returns the merged result or null if anything is off.
export function cleanLighting(next, base = DEFAULT_LIGHTING) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return null;
  const out = { ...base };
  for (const [k, v] of Object.entries(next)) {
    const r = Object.hasOwn(LIGHT_RANGES, k) && LIGHT_RANGES[k];
    if (!r || typeof v !== 'number' || !(v >= r[0] && v <= r[1])) return null;
    out[k] = v;
  }
  return out;
}
export function cleanGlass(next, base = DEFAULT_GLASS) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return null;
  const out = { ...base };
  for (const [k, v] of Object.entries(next)) {
    if (k === 'on' && typeof v === 'boolean') out.on = v;
    else if (k === 'tint' && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out.tint = v.toLowerCase();
    else if (k === 'opacity' && typeof v === 'number' && v >= 0 && v <= 1) out.opacity = v;
    else return null;
  }
  return out;
}

// 3D environments (environments.js): real places in metres. Each has an eye-level car-view camera (envCamera)
// calibrated so the car stands on the floor where its thumbnail shows it; light = the matched key/fill/rim.
export { ENVIRONMENTS } from './environments.js';
export const envThumb = (slug) => `/img/environments/${slug}.jpg`; // picker thumbnails only, never a background

// The car-view camera of an environment, for a frame of the given aspect. Calibration in fractions of the frame
// from the top: horizon = eye level, ground = where the car's centre touches the floor, width = metres visible
// across the frame at the car, hfov in degrees. Returns { position: [x, y, z], target: [x, y, z], vfov } in metres
// and degrees, Y up, car at the origin, camera on +Z. Pure maths so the in-app renderer and Blender agree.
export function envCamera({ horizon, ground, width, hfov }, aspect = 4 / 3) {
  const rad = Math.PI / 180;
  const tanH = Math.tan((hfov * rad) / 2);
  const tanV = tanH / aspect;
  const pitch = Math.atan((1 - 2 * horizon) * tanV); // > 0: looking down (horizon above the middle)
  const below = pitch - Math.atan((1 - 2 * ground) * tanV); // angle from the camera down to the car's ground point
  const distance = width / 2 / tanH; // along the view to the car, so `width` metres fill the frame there
  const y = distance * Math.sin(below);
  const z = distance * Math.cos(below);
  return {
    position: [0, y, z],
    target: [0, y - Math.tan(pitch) * z, 0], // straight ahead at the pitch, level with the car
    vfov: (2 * Math.atan(tanV)) / rad,
  };
}

// What each web file is for: the Dud Rents (dudrents.com) handoff. Shown in the app and written into HANDOFF.md.
// Showroom is the house look for the site; the admin lists keep the transparent cut-out.
export const DESTINATIONS = [
  { look: 'showroom', turn: 360, width: 512, label: 'Showroom 360 · 512', use: 'spinning thumbnails across dudrents.com' },
  { look: 'transparent', turn: 360, width: 256, label: 'Transparent 360 · 256', use: 'admin portal lists and the edit page' },
  { look: 'showroom', turn: 180, width: 512, label: 'Showroom 180', use: "swipe view on the car's detail page" },
];
export const DEFAULT_LOOKS = ['studio', 'transparent']; // switched on to begin with: the Compose scene (White Cyc Studio by default) and the cut-out

export function slugify(name) {
  const slug = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug || 'car';
}

// First free slug: audi-r8, audi-r8-2, audi-r8-3, …
export function uniqueSlug(name, taken) {
  const used = new Set(taken);
  const base = slugify(name);
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export const pad3 = (n) => String(n).padStart(3, '0');
export const frameName = (slug, i) => `${slug}_${pad3(i)}.png`;
export const framePath = (slug, look, i) => `frames/${look}/${frameName(slug, i)}`;
export const turnFrames = (turn) => (turn === 180 ? HALF : FRAMES);
// Turntable angle of each frame, relative to frame 000 (which is the scene's own turn, front ¾ by default).
export const angles = (frames = FRAMES) => Array.from({ length: frames }, (_, i) => i * STEP);
export const halfTurn = (list) => list.slice(0, HALF);

export function spriteGrid(frames, columns = COLUMNS) {
  const rows = Math.ceil(frames / columns);
  return { columns, rows, frames, lastRowFrames: frames - (rows - 1) * columns };
}
export const cellOf = (i, columns = COLUMNS) => ({ col: i % columns, row: Math.floor(i / columns) });
// Size of one frame of a look scaled to a web width (512 → 512×384 studio, 512×512 transparent).
export const frameSize = (look, width) => ({ width, height: Math.round((LOOKS[look].height * width) / LOOKS[look].width) });
export function sheetSize(look, turn, width) {
  const { columns, rows } = spriteGrid(turnFrames(turn));
  const f = frameSize(look, width);
  return { width: f.width * columns, height: f.height * rows };
}

export const sheetName = (look, turn, width, ext = 'webp') => `${look}-${turn}-${width}.${ext}`;
export const spriteJsonName = (look, turn) => `${look}-sprite-${turn}.json`;
export const posterName = (look, ext = 'webp') => `${look}-poster.${ext}`;
export const stillName = (slug, look, angle) => `${slug}_${look}_${pad3(((Math.round(angle) % 360) + 360) % 360)}.png`;
// Every sheet of a turn: WebP at 512 and 256, plus a PNG of the 512 for the 360.
export const sheetFiles = (look, turn) => [
  ...WEB_WIDTHS.map((width) => ({ width, type: 'image/webp', name: sheetName(look, turn, width) })),
  ...(turn === 360 ? [{ width: 512, type: 'image/png', name: sheetName(look, turn, 512, 'png') }] : []),
];

// web/<look>-sprite-<turn>.json. File names are relative to the json itself.
export function manifest({ slug, name, look, turn, renderer = 'three', version, renderedAt = new Date().toISOString() }) {
  const { columns, rows, frames, lastRowFrames } = spriteGrid(turnFrames(turn));
  const { width: frameWidth, height: frameHeight } = frameSize(look, 512);
  return {
    slug, name, look, frameWidth, frameHeight, columns, rows, frames, lastRowFrames,
    degreesPerFrame: STEP, startAngle: 0, loop: turn === 360,
    sheet: sheetName(look, turn, 512),
    sheets: Object.fromEntries(sheetFiles(look, turn).filter((s) => s.type === 'image/webp').map((s) => [s.width, s.name])),
    ...(turn === 360 && { sheetPng: sheetName(look, turn, 512, 'png') }),
    poster: posterName(look),
    sourceModel: `../models/${slug}.glb`,
    renderer, flatformVersion: version, renderedAt,
  };
}

// Relative paths of everything a render writes, for HANDOFF.md and the progress UI.
export function plannedFiles({ slug, looks, turns, stills = [], models = [] }) {
  const files = [];
  for (const look of looks) {
    if (turns.length) files.push(`frames/${look}/${frameName(slug, 0)} … ${frameName(slug, Math.max(...turns.map(turnFrames)) - 1)}`);
    for (const turn of turns) {
      files.push(...sheetFiles(look, turn).map((s) => `web/${s.name}`), `web/${spriteJsonName(look, turn)}`);
    }
    if (turns.length) files.push(`web/${posterName(look)}`, `web/${posterName(look, 'png')}`);
  }
  files.push(...stills.map((s) => `stills/${stillName(slug, s.look, s.angle)}`));
  files.push(...models.map((m) => `models/${m}`));
  if (turns.length) files.push('spin-viewer.js', 'viewer.html');
  return [...files, 'HANDOFF.md'];
}

export function handoffText({ slug, name, looks, turns, stills = [], models = [], renderer = 'three', version, renderedAt = new Date().toISOString() }) {
  const lines = [
    `# ${name} · handoff`, '',
    `Rendered by Flatform ${version} (${renderer === 'blender' ? 'Blender Cycles' : 'in-app renderer'}) on ${renderedAt.slice(0, 10)}. Folder: \`${slug}/\`.`, '',
    '## Where each piece goes', '',
  ];
  for (const d of DESTINATIONS) {
    const ok = looks.includes(d.look) && turns.includes(d.turn);
    lines.push(`- **${d.label}** → ${d.use}: ${ok ? `\`web/${sheetName(d.look, d.turn, d.width)}\` with \`web/${spriteJsonName(d.look, d.turn)}\`` : '_not rendered this time_'}`);
  }
  lines.push('', '## Files', '', ...plannedFiles({ slug, looks, turns, stills, models }).map((f) => `- \`${f}\``), '',
    '## How the turntable works', '',
    `- ${FRAMES} frames, ${STEP}° apart. Frame 000 is the front ¾ view; each next frame turns the car ${STEP}° more. The camera, lights and studio never move.`,
    `- The 360 loops. The 180 is frames 000–036 (${HALF} frames) of the same render and stops at both ends.`,
    `- Sprite sheets have ${COLUMNS} columns. 360: ${COLUMNS} × ${spriteGrid(FRAMES).rows}. 180: ${COLUMNS} × ${spriteGrid(HALF).rows}, last row has ${spriteGrid(HALF).lastRowFrames} frame. Each json lists frame size, columns, rows and frame count.`,
    '- Showroom and composed-scene frames are 2048 × 1536 (4:3). Transparent frames are 2048 × 2048 RGBA with a soft contact shadow.', '',
    '## Embedding the spinner', '',
    'Serve `spin-viewer.js` and the `web/` folder, then:', '',
    '```html',
    `<div data-flatform-spin="web/${spriteJsonName('showroom', 360)}" data-size="512"></div>`,
    '<script src="spin-viewer.js"></script>',
    '```', '',
    'Drag, swipe or use the arrow keys to turn. It shows the poster until the sheet loads. `viewer.html` is a working demo.', '');
  return lines.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// viewer.html: a demo of each destination. Manifests are inlined so it also works when opened straight from disk.
export function viewerHtml({ name, manifests }) {
  const blocks = DESTINATIONS.filter((d) => manifests[`${d.look}${d.turn}`]).map((d) => `
<section>
  <h2>${esc(d.label)}</h2><p>${esc(d.use)}</p>
  <div class="frame ${d.look}" style="max-width:${d.width}px">
    <div data-base="web/" data-size="${d.width}" data-flatform-spin="${esc(JSON.stringify(manifests[`${d.look}${d.turn}`]))}"></div>
  </div>
</section>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} · spin viewer</title>
<style>
  body { margin:0; padding:32px; background:#0b0a09; color:#efe7e3; font:15px/1.5 system-ui, sans-serif; }
  h1 { margin:0 0 4px; font-weight:600; } h2 { margin:0; font-size:16px; } p { margin:2px 0 12px; color:#ab9d96; }
  section { margin:32px 0; }
  .frame { border:1px solid #2a2220; border-radius:6px; overflow:hidden; }
  .frame.transparent { background:conic-gradient(#e5e7eb 25%, #fff 0 50%, #e5e7eb 0 75%, #fff 0) 0 0 / 20px 20px; }
  [data-flatform-spin]:focus-visible { outline:2px solid #ff7a66; outline-offset:-2px; }
</style>
</head>
<body>
<h1>${esc(name)}</h1>
<p>Drag, swipe or use the arrow keys to turn the car.</p>${blocks}
<script src="spin-viewer.js"></script>
</body>
</html>
`;
}
