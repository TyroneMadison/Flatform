// Turntable and handoff rules shared by the browser renderer, the server and the tests.
// Pure functions only (no DOM, no fs) so both sides agree on every name and number.

export const FRAMES = 72; // a full turn in 5° steps
export const STEP = 5; // degrees per frame
export const HALF = 37; // the 180° half turn is frames 000–036, cut from the same 72
export const COLUMNS = 12; // sprite sheet columns
export const WEB_WIDTHS = [512, 256]; // frame widths of the web sprite sheets
export const LOOKS = {
  studio: { width: 2048, height: 1536, label: 'Studio backdrop' }, // 4:3
  transparent: { width: 2048, height: 2048, label: 'Transparent' }, // RGBA with a soft contact shadow
};

// What each web file is for. Shown in the app and written into HANDOFF.md.
export const DESTINATIONS = [
  { look: 'transparent', turn: 360, width: 512, label: 'Transparent 360 · 512', use: 'spinning thumbnails across dudrents.com' },
  { look: 'transparent', turn: 360, width: 256, label: 'Transparent 360 · 256', use: 'admin portal lists and the edit page' },
  { look: 'studio', turn: 180, width: 512, label: 'Studio 180', use: "swipe view on the car's detail page" },
];

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
    '- Studio frames are 2048 × 1536 (4:3). Transparent frames are 2048 × 2048 RGBA with a soft contact shadow.', '',
    '## Embedding the spinner', '',
    'Serve `spin-viewer.js` and the `web/` folder, then:', '',
    '```html',
    `<div data-flatform-spin="web/${spriteJsonName('transparent', 360)}" data-size="256"></div>`,
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
