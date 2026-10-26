// TennoGen naming and size checker. Pure: no DOM, no fs. The server reads PNG sizes and applies fixes; the page
// shows the report. Rules come from Digital Extremes' official TennoGen guides (fetched 2026-10-26):
// - https://www.warframe.com/en/steamworkshop/texturing-guide
//   "Materials must be in PNG format". Exactly six maps per set: Body_d, Body_e, Body_n, Body_r, Body_s, Body_t,
//   "Where Body_ is replaced by Helmet_ Weapon_ Syandana_ Liset_ for the appropriate content type."
//   "Please don't add custom names here."
// - https://www.warframe.com/en/steamworkshop/exporting-tennogen-files
//   Texture_x.png: "We only expect one character after the underscore (_)" (Excalibur_diffuse.png is wrong);
//   "The 'texture set' before the underscore must be the same" (Excal_s.png with Excalibur_d.png is wrong);
//   "Too many underscores" (Excalibur_bake_n.png is wrong); "Name is not descriptive / type is not declared"
//   (emissives.png is wrong). "One node will export one FBX file."
// - https://www.warframe.com/en/steamworkshop/creating-a-warframe-skin
//   Warframe skin: "Maps Authored at 2048 x 2048", "In-game Resolution: 2048 x 2048",
//   "1024 x 1024 for tintmask and emissive."
// - https://www.warframe.com/en/steamworkshop/content-files-and-examples
//   Alt helmet: 8,000 tris, authored 1024x2048, in-game 512x1024, tintmask 256x512.
//   Syandana: 7,500 tris, authored 2048 x 1024, in-game 1024 x 512.
//   Melee weapon skins: 7,500 tris (swords, daggers, rapiers, machetes 3,500; dual nikana 9,000), 2048 x 1024 → 1024 x 512.
//   Operator accessories: 1,500 tris, 2048 x 1024 → 1024 x 512, "only use 2 tint channels".
//   Armor: chest 2,500 tris, shoulder/leg 5,000, authored 1024 x 1024, in-game 512 x 512.
//   The page gives no Liset numbers, so Liset only gets the naming rules.

export const MAPS = { d: 'base colour', e: 'emissive mask', n: 'tangent normal', r: 'roughness', s: 'reflectance', t: 'tint mask' };
export const MAP_KEYS = Object.keys(MAPS); // d e n r s t

// Per content type. set: the only allowed name before the underscore (null: the guides name none, sizes only).
// authored: [w, h] for d/n/r/s. tint and emissive: their own [w, h], or null when the guide gives none.
export const CONTENT_TYPES = {
  warframe: { label: 'Warframe skin', set: 'Body', authored: [2048, 2048], ingame: [2048, 2048], tint: [1024, 1024], emissive: [1024, 1024], tris: null },
  helmet: { label: 'Alt helmet', set: 'Helmet', authored: [1024, 2048], ingame: [512, 1024], tint: [256, 512], emissive: null, tris: 8000 },
  syandana: { label: 'Syandana', set: 'Syandana', authored: [2048, 1024], ingame: [1024, 512], tint: null, emissive: null, tris: 7500 },
  weapon: { label: 'Weapon skin', set: 'Weapon', authored: [2048, 1024], ingame: [1024, 512], tint: null, emissive: null, tris: 7500, trisNote: 'swords, daggers, rapiers and machetes 3,500 · dual nikana 9,000' },
  liset: { label: 'Liset skin', set: 'Liset', authored: null, ingame: null, tint: null, emissive: null, tris: null },
  operator: { label: 'Operator accessory', set: null, authored: [2048, 1024], ingame: [1024, 512], tint: null, emissive: null, tris: 1500, tintChannels: 2 },
  armor: { label: 'Armor piece', set: null, authored: [1024, 1024], ingame: [512, 512], tint: null, emissive: null, tris: 2500, trisNote: 'chest 2,500 · shoulders or legs 5,000 for the pair' },
};
export const SET_NAMES = Object.values(CONTENT_TYPES).map((t) => t.set).filter(Boolean);

// Long suffixes people type, and the one-letter map they mean.
const SUFFIX_ALIASES = {
  d: ['d', 'diffuse', 'diff', 'albedo', 'basecolor', 'basecolour', 'base', 'color', 'colour', 'col'],
  e: ['e', 'emissive', 'emis', 'emit', 'glow', 'emission'],
  n: ['n', 'normal', 'nrm', 'norm', 'nor', 'normals'],
  r: ['r', 'roughness', 'rough', 'rgh'],
  s: ['s', 'specular', 'spec', 'reflectance', 'metal', 'metalness', 'metallic', 'met'],
  t: ['t', 'tint', 'tintmask', 'mask', 'tintmap'],
};
const ILLEGAL = /[^A-Za-z0-9_.-]/;
const hasExt = (name, ext) => name.toLowerCase().endsWith(ext);
const stem = (name) => name.replace(/\.[^.]+$/, '');

// The map letter a suffix means, or null.
export function mapOf(suffix) {
  const s = String(suffix).toLowerCase();
  return MAP_KEYS.find((k) => SUFFIX_ALIASES[k].includes(s)) || null;
}

// Parses a texture file name: { set, suffix, map, underscores } or null when there is no underscore at all.
export function parseName(name) {
  const base = stem(name);
  const parts = base.split('_');
  if (parts.length < 2) return null;
  const suffix = parts.at(-1);
  return { set: parts.slice(0, -1).join('_'), suffix, map: mapOf(suffix), underscores: parts.length - 1 };
}

// The one right name for a map of a content type.
export const properName = (type, map) => `${CONTENT_TYPES[type].set || 'Body'}_${map}.png`;

const sizeText = ([w, h]) => `${w} × ${h}`;

/**
 * Checks a texture set. files: [{ name, width?, height? }] (meshes as .fbx entries are checked for naming only).
 * Returns { type, pass, errors, warnings, issues: [{ file, code, severity, message, fix? }], maps: { d: name, … },
 * missing: [map letters] }. fix: { kind: 'rename', to } or { kind: 'resize', width, height }.
 */
export function check(type, files) {
  const t = CONTENT_TYPES[type];
  if (!t) throw new Error(`Unknown content type: ${type}`);
  const issues = [];
  const add = (file, code, severity, message, fix) => issues.push({ file, code, severity, message, ...(fix && { fix }) });
  const maps = {};
  const pngs = files.filter((f) => /\.(png|jpe?g|tga|tif|tiff|bmp|psd)$/i.test(f.name));
  const meshes = files.filter((f) => hasExt(f.name, '.fbx'));
  for (const f of pngs) {
    const name = f.name;
    if (ILLEGAL.test(name) || /\s/.test(name)) {
      add(name, 'illegal-chars', 'error', 'Spaces or special characters in the name. Use letters, numbers and one underscore.');
    }
    if (!hasExt(name, '.png')) {
      add(name, 'not-png', 'error', 'Materials must be PNG files.');
      continue;
    }
    const p = parseName(name);
    if (!p) { add(name, 'no-type', 'error', 'Name is not descriptive / type is not declared (expected Set_x.png, like Body_d.png).'); continue; }
    const map = p.map;
    const wanted = map && t.set ? properName(type, map) : null;
    const rename = wanted && wanted !== name ? { kind: 'rename', to: wanted } : undefined;
    if (p.underscores > 1) add(name, 'extra-underscore', 'error', `Too many underscores (${name}). One underscore, then one letter.`, rename);
    if (!map) add(name, 'unknown-suffix', 'error', `"_${p.suffix}" is not one of _d _e _n _r _s _t.`);
    else if (p.suffix !== map) add(name, 'long-suffix', 'error', `Only one character after the underscore: "_${p.suffix}" should be "_${map}".`, rename);
    if (t.set && p.set !== t.set) add(name, 'custom-set', 'error', `The set name must be "${t.set}_" for a ${t.label.toLowerCase()}, not "${p.set}_" (no custom names).`, rename);
    if (map) {
      if (maps[map]) add(name, 'duplicate', 'error', `Two files for the ${MAPS[map]} map (${maps[map]} and ${name}).`);
      else maps[map] = name;
    }
    // Sizes, when the file's size is known and the guide sets one.
    const expected = map === 't' ? t.tint : map === 'e' ? t.emissive : map ? t.authored : null;
    if (expected && Number.isFinite(f.width) && Number.isFinite(f.height) && (f.width !== expected[0] || f.height !== expected[1])) {
      add(name, 'size', 'error', `${MAPS[map]} is ${sizeText([f.width, f.height])}; a ${t.label.toLowerCase()} ${map === 't' ? 'tint mask' : map === 'e' ? 'emissive' : 'map'} is authored at ${sizeText(expected)}.`,
        { kind: 'resize', width: expected[0], height: expected[1] });
    }
  }
  const sets = new Set(pngs.map((f) => parseName(f.name)?.set).filter(Boolean));
  if (sets.size > 1) add('*', 'mixed-sets', 'error', `The texture set name must be the same on every map (found ${[...sets].join(', ')}).`);
  const missing = MAP_KEYS.filter((k) => !maps[k]);
  if (pngs.length && missing.length) add('*', 'missing-maps', 'error', `Missing ${missing.map((k) => `_${k} (${MAPS[k]})`).join(', ')}. A set has exactly six maps.`);
  if (!pngs.length) add('*', 'no-textures', 'error', 'No texture files found.');
  for (const f of meshes) {
    if (ILLEGAL.test(f.name) || /\s/.test(f.name)) add(f.name, 'illegal-chars', 'error', 'Spaces or special characters in the mesh name.');
    const base = stem(f.name);
    if (t.set && base.toLowerCase() !== t.set.toLowerCase() && !base.toLowerCase().startsWith(t.set.toLowerCase())) {
      add(f.name, 'mesh-name', 'warn', `Mesh "${base}" does not match the texture set "${t.set}". Keep mesh and texture names consistent.`, { kind: 'rename', to: `${t.set}.fbx` });
    }
  }
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return { type, pass: errors === 0, errors, warnings, issues, maps, missing };
}

// The fixes the server can apply, deduplicated per file (a rename wins over nothing; a resize keeps the new name).
export function fixPlan(report) {
  const plan = [];
  for (const i of report.issues) {
    if (!i.fix || i.file === '*') continue;
    const same = plan.find((p) => p.file === i.file && p.kind === i.fix.kind);
    if (same) continue;
    plan.push({ file: i.file, ...i.fix });
  }
  // Two files renamed to the same name would clash: keep the first, drop the rest.
  const targets = new Set();
  return plan.filter((p) => {
    if (p.kind !== 'rename') return true;
    if (targets.has(p.to)) return false;
    targets.add(p.to);
    return true;
  });
}

// Guess the content type from the file names, or null.
export function guessType(files) {
  for (const f of files) {
    const set = parseName(f.name)?.set;
    const hit = Object.entries(CONTENT_TYPES).find(([, t]) => t.set && set && t.set.toLowerCase() === set.toLowerCase());
    if (hit) return hit[0];
  }
  return null;
}

export const EXPORT_MODES = { warn: 'Warn before export', block: 'Block the export', off: 'Off' };
