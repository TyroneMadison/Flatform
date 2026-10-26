// TennoGen colour, material and texture-set rules (Warframe Steam Workshop texturing guide), as pure functions so
// the composer, the exporters, the Blender script's scene JSON and the tests all agree.
//
// Names and numbers follow the guide exactly:
// - Colour slots: Primary (Tint0), Secondary (Tint1), Tertiary (Tint2), Accents (Tint3), plus Emissive and Energy.
// - Tint mask (<Part>_t): R = Tint0, G = Tint1 (screened over R), B = Tint2 (over G), A = Tint3 (on top). Black in
//   every channel = untinted base diffuse. Lower layers are expanded under the edges of higher ones (no halos).
// - Texture set, PNG only: <Part>_d diffuse, _e emissive, _n normal, _r roughness, _s specular/metalness, _t tint mask.
//   d/n/r/s are 2048², t and e 1024² for warframe skins; alt helmets are authored 2048×1024.
// - Albedo: non-metals about 50 % luminance (128/255), metals about 80 % (186/255).

export const SLOTS = [
  { id: 'primary', label: 'Primary', tint: 'Tint0', channel: 0 },
  { id: 'secondary', label: 'Secondary', tint: 'Tint1', channel: 1 },
  { id: 'tertiary', label: 'Tertiary', tint: 'Tint2', channel: 2 },
  { id: 'accents', label: 'Accents', tint: 'Tint3', channel: 3 },
  { id: 'emissive', label: 'Emissive', tint: null, channel: null },
  { id: 'energy', label: 'Energy', tint: null, channel: null },
];
export const TINT_SLOTS = SLOTS.filter((s) => s.tint).map((s) => s.id); // primary … accents, in channel order
export const COLOR_KEYS = SLOTS.map((s) => s.id);
export const DEFAULT_COLORS = { primary: '#8c8f99', secondary: '#2b2f3a', tertiary: '#c9a35a', accents: '#e4e6ea', emissive: '#59c3ff', energy: '#59c3ff' };

// Armor sections (Flatform's grouping, the user may rename them or add more).
export const SECTIONS = [
  { id: 'helmet', name: 'Helmet' }, { id: 'chest', name: 'Chest' }, { id: 'back', name: 'Back' },
  { id: 'shoulderL', name: 'Left Shoulder' }, { id: 'shoulderR', name: 'Right Shoulder' },
  { id: 'armL', name: 'Left Arm' }, { id: 'armR', name: 'Right Arm' }, { id: 'legL', name: 'Left Leg' }, { id: 'legR', name: 'Right Leg' },
  { id: 'syandana', name: 'Syandana' }, { id: 'weapon', name: 'Weapon' }, { id: 'attachments', name: 'Attachments' },
];

// Texture set: part prefixes, suffixes and sizes. No custom names.
export const PARTS = ['Body', 'Helmet', 'Weapon', 'Syandana', 'Liset'];
export const MAPS = {
  d: { label: 'Diffuse / albedo', size: 2048 }, e: { label: 'Emissive', size: 1024 }, n: { label: 'Normal', size: 2048 },
  r: { label: 'Roughness', size: 2048 }, s: { label: 'Specular / metalness', size: 2048 }, t: { label: 'Tint mask', size: 1024 },
};
export const ALT_HELMET = { tris: 8000, width: 2048, height: 1024 };
export const ALBEDO = { nonMetal: 128, metal: 186, tolerance: 40 }; // target luminance /255 and how far off is a warning

export const textureName = (part, map) => {
  if (!PARTS.includes(part)) throw new Error(`Unknown part ${part}: use ${PARTS.join(', ')}`);
  if (!Object.hasOwn(MAPS, map)) throw new Error(`Unknown map _${map}`);
  return `${part}_${map}.png`;
};
// Width and height of a map for a part. Alt helmets are authored 2048×1024 (half-height for every map).
export const textureSize = (part, map, { altHelmet = false } = {}) => {
  const s = MAPS[map].size;
  return altHelmet && part === 'Helmet' ? { width: ALT_HELMET.width, height: ALT_HELMET.height } : { width: s, height: s };
};
export const textureSet = (part, opts) => Object.keys(MAPS).map((map) => ({ map, name: textureName(part, map), ...textureSize(part, map, opts) }));
// Checks exported file names against the rule: <Part>_<d|e|n|r|s|t>.png, nothing else.
export function checkTextureName(file) {
  const m = /^([A-Z][a-z]+)_([a-z])\.png$/.exec(file);
  if (!m) return { ok: false, reason: 'Name must be <Part>_<map>.png, e.g. Body_d.png' };
  if (!PARTS.includes(m[1])) return { ok: false, reason: `Part must be one of ${PARTS.join(', ')}` };
  if (!Object.hasOwn(MAPS, m[2])) return { ok: false, reason: `Map must be one of _${Object.keys(MAPS).join(' _')}` };
  return { ok: true, part: m[1], map: m[2] };
}

// ---- colours: Global > Section > Piece, lower levels override, unset keys inherit ----
// paint.colors = { global: {...}, sections: { [sectionId]: {...partial} } }; piece.colors is a partial too.
export function resolveColors(paint, piece) {
  const global = { ...DEFAULT_COLORS, ...paint?.colors?.global };
  const section = piece?.section ? paint?.colors?.sections?.[piece.section] || {} : {};
  const own = piece?.colors || {};
  const out = {};
  for (const k of COLOR_KEYS) out[k] = own[k] ?? section[k] ?? global[k];
  return out;
}
// Where each colour comes from: 'piece', 'section' or 'global'.
export function colorSources(paint, piece) {
  const section = piece?.section ? paint?.colors?.sections?.[piece.section] || {} : {};
  return Object.fromEntries(COLOR_KEYS.map((k) => [k, piece?.colors?.[k] != null ? 'piece' : section[k] != null ? 'section' : 'global']));
}
// Sets (or with value null resets to inherited) one colour at a level: 'global', a section id, or a piece key.
export function setColor(paint, level, key, value) {
  const p = { ...paint, colors: { global: { ...paint.colors?.global }, sections: { ...paint.colors?.sections } }, pieces: { ...paint.pieces } };
  if (!COLOR_KEYS.includes(key)) throw new Error(`Unknown colour ${key}`);
  const put = (obj) => { const o = { ...obj }; if (value == null) delete o[key]; else o[key] = value; return o; };
  if (level === 'global') p.colors.global = value == null ? put(p.colors.global) : { ...p.colors.global, [key]: value };
  else if (p.pieces[level]) p.pieces[level] = { ...p.pieces[level], colors: put(p.pieces[level].colors || {}) };
  else p.colors.sections[level] = put(p.colors.sections[level] || {});
  return p;
}

// ---- materials: a MeshPhysicalMaterial description per piece, with SSS for skin, cloth and infested flesh ----
export const MATERIAL_KEYS = ['color', 'metalness', 'roughness', 'clearcoat', 'clearcoatRoughness', 'sheen', 'sheenRoughness', 'sheenColor', 'transmission', 'ior', 'thickness',
  'emissive', 'emissiveIntensity', 'normalScale', 'sss', 'sssRadius', 'sssColor', 'opacity'];
export const DEFAULT_MATERIAL = {
  color: null, // null = the piece's own texture / resolved slot colour
  metalness: 0, roughness: 0.6, clearcoat: 0, clearcoatRoughness: 0.1, sheen: 0, sheenRoughness: 0.5, sheenColor: '#ffffff',
  transmission: 0, ior: 1.5, thickness: 0.01, emissive: '#000000', emissiveIntensity: 0, normalScale: 1,
  sss: 0, sssRadius: 1, sssColor: '#ff8866', opacity: 1,
};
// Presets. SSS (thickness/translucency in three, Subsurface Weight/Radius in Blender) on Skin, Cloth and Infested Flesh.
export const MATERIAL_PRESETS = {
  metal: { label: 'Metal', metalness: 1, roughness: 0.25 },
  brushedMetal: { label: 'Brushed Metal', metalness: 1, roughness: 0.45 },
  paintedMetal: { label: 'Painted Metal', metalness: 0.2, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 },
  cloth: { label: 'Cloth', metalness: 0, roughness: 0.9, sheen: 1, sheenRoughness: 0.6, sss: 0.35, sssRadius: 0.6, sssColor: '#c08a70' },
  leather: { label: 'Leather', metalness: 0, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.4 },
  rubber: { label: 'Rubber', metalness: 0, roughness: 0.9 },
  glass: { label: 'Glass', metalness: 0, roughness: 0.05, transmission: 1, ior: 1.5, thickness: 0.02 },
  skin: { label: 'Skin', metalness: 0, roughness: 0.5, sss: 0.7, sssRadius: 1.2, sssColor: '#ff7a5a' },
  infested: { label: 'Infested Flesh', metalness: 0, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.5, sss: 0.9, sssRadius: 2, sssColor: '#c23a7a' },
  plastic: { label: 'Plastic', metalness: 0, roughness: 0.3, clearcoat: 0.5, clearcoatRoughness: 0.15 },
  glow: { label: 'Glow', metalness: 0, roughness: 0.6, emissive: '#59c3ff', emissiveIntensity: 3 },
};
export const SSS_PRESETS = Object.entries(MATERIAL_PRESETS).filter(([, p]) => p.sss > 0).map(([k]) => k); // skin, cloth, infested
export const materialFromPreset = (id) => {
  if (!Object.hasOwn(MATERIAL_PRESETS, id)) throw new Error(`Unknown material preset ${id}`);
  const { label, ...values } = MATERIAL_PRESETS[id];
  return { ...DEFAULT_MATERIAL, ...values, preset: id };
};
// Saves only what differs from the defaults (plus the preset name), so project JSON stays small and forward compatible.
export function serializeMaterial(m) {
  const out = {};
  for (const k of MATERIAL_KEYS) if (m[k] !== undefined && JSON.stringify(m[k]) !== JSON.stringify(DEFAULT_MATERIAL[k])) out[k] = m[k];
  if (m.preset) out.preset = m.preset;
  return out;
}
export function deserializeMaterial(json) {
  const out = { ...DEFAULT_MATERIAL };
  if (!json || typeof json !== 'object') return out;
  for (const k of MATERIAL_KEYS) if (json[k] !== undefined) out[k] = json[k];
  if (json.preset && Object.hasOwn(MATERIAL_PRESETS, json.preset)) out.preset = json.preset;
  return out;
}
// What the Blender script needs for a piece: Principled BSDF inputs including Subsurface Weight/Radius/Color.
export function blenderMaterial(m, colors) {
  const base = m.color || colors?.primary || DEFAULT_COLORS.primary;
  return {
    base_color: base, metallic: m.metalness, roughness: m.roughness, coat_weight: m.clearcoat, coat_roughness: m.clearcoatRoughness,
    sheen_weight: m.sheen, sheen_roughness: m.sheenRoughness, sheen_tint: m.sheenColor, transmission_weight: m.transmission, ior: m.ior,
    emission_color: m.emissive, emission_strength: m.emissiveIntensity, normal_strength: m.normalScale, alpha: m.opacity,
    subsurface_weight: m.sss, subsurface_radius: [1, 0.2, 0.1].map((v) => v * m.sssRadius * 0.01), subsurface_color: m.sssColor, // radius in metres
  };
}

// ---- the paint project: pieces, sections, colours and materials saved with the scene ----
export const defaultPaint = () => ({ sections: SECTIONS.map((s) => ({ ...s })), pieces: {}, colors: { global: { ...DEFAULT_COLORS }, sections: {} }, recent: [] });
// A piece record: name, section, slot (primary … accents, emissive, or null = untinted), material, colours, region.
export const piece = (key, name, extra = {}) => ({ key, name, section: null, slot: null, material: null, colors: null, ...extra });
export const upsertPiece = (paint, key, patch) => ({ ...paint, pieces: { ...paint.pieces, [key]: { ...(paint.pieces[key] || piece(key, key)), ...patch } } });
export function recentColor(paint, hex) {
  const recent = [hex.toLowerCase(), ...(paint.recent || []).filter((c) => c !== hex.toLowerCase())].slice(0, 12);
  return { ...paint, recent };
}
// A Warframe-style palette grid: 6 hue columns × 5 shade rows plus greys, as hex.
export function paletteGrid() {
  const rows = [];
  for (const l of [0.82, 0.66, 0.5, 0.34, 0.18]) {
    const row = [];
    for (const h of [0, 30, 60, 120, 200, 260, 320]) row.push(hslHex(h, 0.7, l));
    row.push(hslHex(0, 0, l));
    rows.push(row);
  }
  return rows;
}
export function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
export const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgbHex = (r, g, b) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
export const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0-255 sRGB, as the guide means it

// ---- tint mask packing ----
// pieces: [{ slot, mask: Uint8Array(w*h) 0/1 }] in texture space. Returns RGBA bytes: each tint slot in its channel,
// with every lower layer expanded by `expand` pixels under the edges of the layers above it, so a tint edge never
// shows the untinted base through a seam. Pixels in no piece stay black everywhere (untinted base diffuse).
export function packTintMask(width, height, pieces, { expand = 2 } = {}) {
  const out = new Uint8ClampedArray(width * height * 4);
  const layers = TINT_SLOTS.map((slot) => {
    const m = new Uint8Array(width * height);
    for (const p of pieces) if (p.slot === slot && p.mask) for (let i = 0; i < m.length; i++) if (p.mask[i]) m[i] = 1;
    return m;
  });
  const used = layers.map((m) => m.some((v) => v));
  // Expand a lower layer into neighbouring pixels that belong to a higher layer (the higher layer screens over it).
  for (let c = 0; c < layers.length; c++) {
    const above = new Uint8Array(width * height);
    for (let d = c + 1; d < layers.length; d++) for (let i = 0; i < above.length; i++) if (layers[d][i]) above[i] = 1;
    layers[c] = grow(layers[c], width, height, expand, above);
  }
  for (let i = 0, p = 0; i < width * height; i++, p += 4) for (let c = 0; c < 4; c++) out[p + c] = layers[c][i] ? 255 : 0;
  return { data: out, used: Object.fromEntries(TINT_SLOTS.map((s, i) => [s, used[i]])) };
}
// Grows a mask by `n` pixels, but only into pixels where `into` is set (or anywhere when into is null).
export function grow(mask, width, height, n, into = null) {
  let cur = mask;
  for (let k = 0; k < n; k++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (cur[i] || (into && !into[i])) continue;
      if ((x > 0 && cur[i - 1]) || (x < width - 1 && cur[i + 1]) || (y > 0 && cur[i - width]) || (y < height - 1 && cur[i + width])) next[i] = 1;
    }
    cur = next;
  }
  return cur;
}
// The emissive mask (<Part>_e): white where emissive pieces are, black elsewhere, alpha 255 (the optional
// scrolling mask would go in the alpha; a plain export leaves it opaque).
export function packEmissiveMask(width, height, pieces) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const on = pieces.some((x) => x.slot === 'emissive' && x.mask?.[i]);
    out[p] = out[p + 1] = out[p + 2] = on ? 255 : 0;
    out[p + 3] = 255;
  }
  return out;
}
// Warnings before a TennoGen export: unused tint channels and albedo luminance out of the guide's range.
export function exportWarnings({ used, albedo }) {
  const warnings = [];
  for (const slot of TINT_SLOTS) if (used && !used[slot]) warnings.push(`Tint channel ${SLOTS.find((s) => s.id === slot).tint} (${slot}) is unused`);
  if (albedo) {
    const target = albedo.metal ? ALBEDO.metal : ALBEDO.nonMetal;
    if (Math.abs(albedo.luminance - target) > ALBEDO.tolerance) {
      warnings.push(`Albedo luminance ${Math.round(albedo.luminance)}/255 is outside the ${albedo.metal ? 'metal (~186)' : 'non-metal (~128)'} range`);
    }
  }
  return warnings;
}
// Mean luminance of the opaque pixels of RGBA bytes.
export function meanLuminance(data) {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < data.length; p += 4) if (data[p + 3] > 0) { sum += luminance(data[p], data[p + 1], data[p + 2]); n++; }
  return n ? sum / n : 0;
}
