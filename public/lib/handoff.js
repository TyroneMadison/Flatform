// The Dud Rents handoff format (E:\Claude Stuff\car-360-pipeline\handoff\<car>), matched file for file so a spin
// set plugs straight into the site's spin viewer and thumbnails. Pure names and JSON; the writing is in handoff.mjs.
//
//   <car>/frames/<look>/<car>_NNN.png            full frames (2048 × 1536 studio/showroom, 2048 × 2048 transparent)
//   <car>/web/<look>/sprite-360.json             manifest (schema below), sprite-180.json for the half turn
//   <car>/web/<look>/sprite-360-512.webp|.png    12-column sheets at 512 and 256 px, PNG fallback at 512
//   <car>/web/<look>/sprite-360-256.webp
//   <car>/web/<look>/poster.webp|.png            frame 000
//   <car>/spin-viewer.js, viewer.html, HANDOFF.md
import { COLUMNS, LOOKS, frameSize, spriteGrid, pad3 } from './pipeline.js';

export const SIZES = [512, 256];
export const START_VIEW = 'front three-quarter, driver side';
export const webDir = (look) => `web/${look}`;
export const frameFile = (slug, look, i) => `frames/${look}/${slug}_${pad3(i)}.png`;
export const sheetFile = (look, turn, size, ext = 'webp') => `${webDir(look)}/sprite-${turn}-${size}.${ext}`;
export const manifestFile = (look, turn) => `${webDir(look)}/sprite-${turn}.json`;
export const posterFile = (look, ext = 'webp') => `${webDir(look)}/poster.${ext}`;
/** Every sheet of a turn, in the site's naming: WebP at 512 and 256, PNG at 512. */
export const sheetSet = (look, turn) => [
  { size: 512, type: 'image/webp', file: sheetFile(look, turn, 512) },
  { size: 512, type: 'image/png', file: sheetFile(look, turn, 512, 'png') },
  { size: 256, type: 'image/webp', file: sheetFile(look, turn, 256) },
];

/** web/<look>/sprite-<turn>.json exactly as the site reads it. frames: how many; step: degrees per frame. */
export function handoffManifest({ slug, name, look, turn, frames, step = 5, renderDate = new Date().toISOString().slice(0, 10), sourceModel = `${slug}.glb` }) {
  const { width: frameWidth, height: frameHeight } = LOOKS[look] || LOOKS.studio;
  const { rows } = spriteGrid(frames, COLUMNS);
  const files = { full: { frameWidth, frameHeight, png: `sprite-${turn}-full.png` } };
  for (const size of SIZES) {
    const f = frameSize(look in LOOKS ? look : 'studio', size);
    files[size] = { frameWidth: f.width, frameHeight: f.height, ...(size === 512 && { png: `sprite-${turn}-${size}.png` }), webp: `sprite-${turn}-${size}.webp` };
  }
  return {
    car: slug, carName: name, look, turn: String(turn), frameWidth, frameHeight, columns: COLUMNS, rows, frameCount: frames,
    degreesPerFrame: step, startAngle: 0, startView: START_VIEW, loop: turn === 360, sourceModel, renderDate, files,
    poster: { webp: 'poster.webp', png: 'poster.png' },
  };
}

/** Everything a spin set writes, relative to <car>/, for the progress list and HANDOFF.md. */
export function spinFiles({ slug, looks, turns, frames }) {
  const out = [];
  for (const look of looks) {
    out.push(`${frameFile(slug, look, 0)} … ${frameFile(slug, look, frames - 1)}`);
    for (const turn of turns) out.push(manifestFile(look, turn), ...sheetSet(look, turn).map((s) => s.file));
    out.push(posterFile(look), posterFile(look, 'png'));
  }
  return [...out, 'spin-viewer.js', 'viewer.html', 'HANDOFF.md'];
}

export function spinHandoffText({ slug, name, looks, turns, frames, step = 5, renderer = 'Flatform', renderDate = new Date().toISOString().slice(0, 10), source = 'spin set' }) {
  const half = turns.includes(180) ? 37 : 0;
  return [
    `# ${name}: 360 views`, '', `Car: ${name}`, `Slug: ${slug}`, `Source model: ${source}`, `Render date: ${renderDate}`, `Renderer: ${renderer}`, '',
    '## Where each piece goes', '', '| Piece | Files | Use |', '|---|---|---|',
    ...looks.flatMap((look) => turns.map((turn) => `| ${LOOKS[look]?.label || look} ${turn} | \`${sheetFile(look, turn, 512)}\` (PNG fallback \`sprite-${turn}-512.png\`), \`${manifestFile(look, turn)}\` | ${turn === 360 ? 'Spinning thumbnails across dudrents.com' : 'The swipe view next to the photos on the car detail page'} |`)),
    `| Posters | \`web/<look>/poster.webp\`, \`web/<look>/poster.png\` | Shows before the sheet loads (frame 000) |`, '',
    '## How to show a sheet', '', 'Load `spin-viewer.js` once on the page. Then:', '', '```html',
    `<div data-spin="/cars/${slug}/${looks[0] || 'showroom'}/sprite-360.json" data-size="512" data-autoplay="12"></div>`, '```', '',
    '## Sheet facts', '',
    `- 360: ${frames} frames, ${COLUMNS} columns by ${spriteGrid(frames, COLUMNS).rows} rows, ${step} degrees per frame, loops.`,
    ...(half ? [`- 180: ${half} frames (000 to 036), ${COLUMNS} columns by ${spriteGrid(half, COLUMNS).rows} rows, stops at each end.`] : []),
    `- Frame 000 is the ${START_VIEW} view.`, '',
    '## Files', '', ...spinFiles({ slug, looks, turns, frames }).map((f) => `- \`${f}\``), '',
  ].join('\n');
}
