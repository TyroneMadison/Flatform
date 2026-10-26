// Compose, the paint and look half of the inspector: Parts (pieces, sections, slots, inferred regions), Color
// (All > Section > Piece with the picker), Material (per piece, presets, copy/paste), Scene (background, sky picture,
// light presets, corner shadows, colour style, reflections, quality, saved looks) and Export (3D file + Warframe pictures).
// compose.js owns the scene object and the studio; this module gets them through ctx and calls ctx.change().
import { $, $$, esc, state, api, send, toast, fileUrl, native, activeWorkspace } from '../app.js';
import { keyOf } from '../lib/shortcuts.js';
import { icon } from '../lib/icons.js';
import {
  SLOTS, SECTIONS, PARTS, MATERIAL_PRESETS, MATERIAL_KEYS, defaultPaint, upsertPiece, resolveColors, colorSources, setColor, pickColor, recentColor,
  materialFromPreset, deserializeMaterial, serializeMaterial, DEFAULT_COLORS, textureSet,
} from '../lib/tenno.js';
import { safeFileName, savesTo } from '../lib/save-place.js';
import { REGIONS } from '../lib/infer.js';
import { DEFAULT_LOOK, mergeLook, STUDIO_PRESETS, LIGHT_PRESETS, lightsFromPreset, HDRIS, TONE_MAPPINGS, QUALITIES, BACKGROUND_KINDS, isHdri, isBackgroundImage } from '../lib/look.js';
import { compareSet, lumaStats } from '../lib/compare.js';
import { ColorPicker } from '../lib/color-picker.js';
import { templatesFor, templateScene } from '../lib/templates.js';
import { normalizeDecals, FINISHES, FINISH_VALUES, finishOf, decalUrl } from '../lib/decals.js';
import { inferFromPhoto, revertInference, exportTennoGen, exportGlb, setTextureWorkspace, similarPieces } from '../lib/paint.js';

// Texture library (CC0 from ambientCG / Poly Haven, plus your own per workspace), loaded once per workspace.
let textures = null; // { items, sync }
let texturesFor = null;
const texWs = () => activeWorkspace()?.id || 'car';
async function loadTextures(force = false) {
  const w = texWs();
  setTextureWorkspace(w);
  if (textures && texturesFor === w && !force) return;
  texturesFor = w;
  try { textures = await api(`/api/textures?workspace=${encodeURIComponent(w)}`); } catch { textures = { items: [], sync: {} }; }
  ctx?.renderInspector();
  if (textures.sync?.running) setTimeout(() => loadTextures(true), 1000);
}
const thumb = (t) => `/api/textures/${encodeURIComponent(t.id)}/color?workspace=${encodeURIComponent(texWs())}`;
function textureGroup(mat) {
  if (!textures || texturesFor !== texWs()) { loadTextures(); return '<h3 style="margin-top:6px">Texture</h3><p class="fine keep">Loading textures…</p>'; }
  const s = textures.sync || {};
  const ready = textures.items.filter((t) => t.cached);
  const missing = textures.items.length - ready.length;
  const cur = mat.texture;
  return `<h3 style="margin-top:6px">Texture</h3>
    <div class="mg-row stack">
      ${missing ? `<button class="btn sm pri" type="button" data-act="tex-sync" title="Download free textures you can put on pieces" ${s.running ? 'disabled' : ''}>${s.running ? `Getting textures ${s.done}/${s.total}…` : `Get free textures (${missing})`}</button>` : ''}
      <button class="btn sm ghostbtn" type="button" data-act="tex-import" title="Use your own picture (PNG or JPG) as a texture">${icon('upload', 14)}<span>Add my own</span></button>
      ${cur ? '<button class="btn sm ghostbtn" type="button" data-act="tex-clear" title="Take the texture off this piece">No texture</button>' : ''}</div>
    ${Object.keys(s.errors || {}).length ? `<p class="fine keep">Some textures did not download. Check your connection and try again.</p>` : ''}
    <div class="texgrid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">${ready.map((t) => `<button type="button" class="texbtn" draggable="true" data-texture="${esc(t.id)}" title="${esc(t.name)} · ${esc(t.source)} · ${esc(t.license)}" aria-pressed="${cur?.id === t.id}" style="padding:0;border-radius:8px;overflow:hidden;border:2px solid ${cur?.id === t.id ? 'var(--accent, #d4a63a)' : 'transparent'};background:none;cursor:pointer"><img src="${thumb(t)}" alt="${esc(t.name)}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;display:block"><small style="display:block;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</small></button>`).join('')}</div>
    <p class="fine">Click a texture for this piece, or drag it onto any piece in the view.${ready.some((t) => t.kind !== 'custom') ? ' Free textures come from ambientCG and Poly Haven.' : ''}</p>
    ${cur ? `${sl('tex', 'scale', 'Texture size', 0.5, 32, 0.5, cur.scale, `${fixed(cur.scale, 1)}×`)}${sl('tex', 'rotation', 'Texture turn', -180, 180, 1, cur.rotation, `${cur.rotation}°`)}` : ''}
    <input type="file" id="texFile" accept="image/png,image/jpeg" hidden>`;
}
function applyTexture(key, id) {
  const prev = selected;
  selected = key;
  const cur = deserializeMaterial(rec(key).material).texture;
  updateMaterial({ texture: { id, scale: cur?.scale ?? 4, rotation: cur?.rotation ?? 0 } });
  selected = prev ?? key;
}
// ---- Templates: a whole starting scene in one click, plus your own saved ones ----
let myTemplates = null;
let myTemplatesFor = null;
async function loadMyTemplates(force = false) {
  const w = texWs();
  if (myTemplates && myTemplatesFor === w && !force) return;
  myTemplatesFor = w;
  try { myTemplates = await api(`/api/templates?workspace=${encodeURIComponent(w)}`); } catch { myTemplates = []; }
  ctx?.renderInspector();
}
const templateKind = () => ctx.model()?.workspace || activeWorkspace()?.kind || 'car';
function templateGroup() {
  if (!myTemplates || myTemplatesFor !== texWs()) loadMyTemplates();
  const card = (t, mine) => `<div class="tpl"><button class="btn" type="button" data-tpl="${esc(t.id)}" title="${esc(t.note || '')}"><b>${esc(t.name)}</b><span class="fine">${esc(t.note || '')}</span></button>${mine ? `<button class="btn ghost" type="button" data-tpl-del="${esc(t.id)}" aria-label="Delete ${esc(t.name)}" title="Delete this template">${icon('close', 13)}</button>` : ''}</div>`;
  return `<div class="grp" id="grp-templates"><h3>${icon('image', 14)} Templates</h3>
    <p class="fine">Pick one to set the lighting, camera and background in one go.</p>
    <div class="tpls">${templatesFor(templateKind()).map((t) => card(t, false)).join('')}</div>
    ${(myTemplates || []).length ? `<h3 style="margin-top:6px">Yours</h3><div class="tpls">${myTemplates.map((t) => card(t, true)).join('')}</div>` : ''}
    <div class="mg-row stack"><input class="inp" id="tplName" type="text" maxlength="60" placeholder="Template name" aria-label="Template name" title="A name for your template"><button class="btn sm sec" type="button" data-act="tpl-save" title="Save the lights, camera and background to use again">Save as template</button></div></div>`;
}
const findTemplate = (id) => templatesFor(templateKind()).find((t) => t.id === id) || (myTemplates || []).find((t) => t.id === id);

// ---- Decals: add a PNG/SVG, click the model to place it, then size, turn, nudge and finish it ----
let decalSel = null; // selected decal id
let placing = null; // { file, name, aspect } waiting for a click on the model, or { move: id }
const decalsOf = () => normalizeDecals(ctx.scene().decals);
const setDecals = (list, opts) => ctx.change({ decals: list }, opts);
const patchDecal = (id, patch, opts) => setDecals(decalsOf().map((d) => (d.id === id ? { ...d, ...patch } : d)), opts);
function decalGroup() {
  const list = decalsOf();
  const d = list.find((x) => x.id === decalSel);
  return `<div class="grp" id="grp-decals"><h3>${icon('image', 14)} Stickers</h3>
    <div class="mg-row"><button class="btn pri" type="button" data-act="decal-add" title="Add a logo or sticker from a PNG or SVG picture" ${ctx.studio()?.model ? '' : 'disabled'}>${icon('upload', 14)}<span>Add sticker</span></button></div>
    ${placing ? `<p class="fine keep"><b>Click the model where the sticker goes.</b> <button class="btn sm ghostbtn" type="button" data-act="decal-cancel" title="Stop placing the sticker">Cancel</button></p>` : ''}
    <input type="file" id="decalFile" accept="image/png,image/svg+xml,.svg" hidden>
    ${list.length ? `<div class="chips">${list.map((x) => `<button class="chip" type="button" data-decal="${esc(x.id)}" aria-pressed="${x.id === decalSel}" title="Pick this sticker to change it" style="display:inline-flex;gap:6px;align-items:center"><img src="${decalUrl(x.file)}" alt="" style="width:20px;height:20px;object-fit:contain">${esc(x.name)}${x.visible ? '' : ' (hidden)'}</button>`).join('')}</div>` : '<p class="fine">Logos, numbers and stickers. They bend over curves and show in pictures and 3D files.</p>'}
    ${d ? `
      <div class="chips" role="radiogroup" aria-label="Finish">${Object.entries(FINISHES).map(([k, l]) => `<button class="chip" type="button" role="radio" data-decal-finish="${k}" aria-checked="${finishOf(d) === k}" title="Give the sticker a ${esc(l.toLowerCase())} finish">${l}</button>`).join('')}</div>
      ${sl('decal', 'size', 'Size', 0.02, 3, 0.01, d.size, `${fixed(d.size)} m`)}${sl('decal', 'rotation', 'Turn', -180, 180, 1, d.rotation, `${d.rotation}°`)}
      ${sl('decal', 'offsetX', 'Move left/right', -0.5, 0.5, 0.005, d.offsetX, `${fixed(d.offsetX, 3)} m`)}${sl('decal', 'offsetY', 'Move up/down', -0.5, 0.5, 0.005, d.offsetY, `${fixed(d.offsetY, 3)} m`)}
      ${sl('decal', 'depth', 'Wrap depth', 0.02, 1, 0.01, d.depth, `${fixed(d.depth)} m`)}${sl('decal', 'gloss', 'Gloss', 0, 1, 0.01, d.gloss)}${sl('decal', 'metallic', 'Metal', 0, 1, 0.01, d.metallic)}${sl('decal', 'reflective', 'Mirror', 0, 1, 0.01, d.reflective)}${sl('decal', 'opacity', 'Solid', 0, 1, 0.01, d.opacity)}
      <div class="mg-row"><button class="btn sm sec" type="button" data-act="decal-move" title="Click the model again to move the sticker">Place again</button>
        <button class="btn sm ghostbtn" type="button" data-act="decal-hide" title="Hide or show this sticker">${d.visible ? 'Hide' : 'Show'}</button>
        <button class="btn sm ghostbtn" type="button" data-act="decal-del" title="Remove this sticker">Delete</button></div>` : ''}
  </div>`;
}
const DECAL_TEXT = { size: (v) => `${fixed(v)} m`, depth: (v) => `${fixed(v)} m`, rotation: (v) => `${v}°`, offsetX: (v) => `${fixed(v, 3)} m`, offsetY: (v) => `${fixed(v, 3)} m` };
// Compose calls this for a click on the canvas; true when the click placed a decal.
export function onDecalCanvasClick(x, y) {
  if (!placing) return false;
  const hit = ctx.studio()?.pickSurface(x, y);
  if (!hit) { toast('Click on the model itself'); return true; }
  if (placing.move) patchDecal(placing.move, { ...hit, offsetX: 0, offsetY: 0 });
  else {
    const id = `d${Date.now().toString(36)}`;
    setDecals([...decalsOf(), { id, file: placing.file, name: placing.name, aspect: placing.aspect, size: 0.3, ...hit, ...FINISH_VALUES.gloss }]);
    decalSel = id;
  }
  placing = null;
  ctx.renderInspector();
  return true;
}
const imageAspect = (file) => new Promise((ok) => {
  const img = new Image();
  img.onload = () => ok(img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1);
  img.onerror = () => ok(1);
  img.src = decalUrl(file);
});

// Drag a texture tile onto the 3D view: the piece under the drop point gets it.
export function onTextureDrop(id, key) { if (key) { applyTexture(key, id); selectPiece(key); } }

let ctx; // { root, model: () => m, scene: () => scene, studio: () => studio, change, draw, renderInspector }
let selected = null; // piece key
let colorLevel = 'piece'; // 'global' | 'section' | 'piece'
let colorKey = 'primary';
let clipboard = null; // a copied material
let picker = null;
// Export settings live in the scene (scene.exportSet), so they are saved per model and undoable like any edit.
const exportOf = () => ({ part: 'Body', altHelmet: false, ...ctx.scene().exportSet });
let busyText = '';
let lastWarnings = [];
let lastCompare = null; // TennoGen compare checklist for the last exported set

export function initPaint(c) { ctx = c; selected = null; picker = null; busyText = ''; lastWarnings = []; lastCompare = null; }
export const paintOf = () => ctx.scene().paint || defaultPaint();
export const lookOf = () => mergeLook(ctx.scene().look);
const pieces = () => ctx.studio()?.pieces() || [];
const rec = (key) => paintOf().pieces?.[key] || {};
export function selectPiece(key) { selected = key; colorLevel = 'piece'; ctx.renderInspector(); }
export const selectedPiece = () => selected;

const fixed = (n, d = 2) => Number(n).toFixed(d);
// Hover tips for the sliders, switches, menus and colour boxes the helpers below draw. Looked up by
// "attr.path", then attr, then the path's last part (so every light's Brightness shares one tip).
const TIPS = {
  'tex.scale': 'Make the texture pattern bigger or smaller', 'tex.rotation': 'Turn the texture pattern',
  'decal.size': 'Make the sticker bigger or smaller', 'decal.rotation': 'Turn the sticker', 'decal.offsetX': 'Slide the sticker left or right',
  'decal.offsetY': 'Slide the sticker up or down', 'decal.depth': 'How far the sticker bends around curves', 'decal.gloss': 'How glossy the sticker is',
  'decal.metallic': 'How much the sticker looks like metal', 'decal.reflective': 'How much the sticker mirrors what is around it', 'decal.opacity': 'Lower lets the surface show through the sticker',
  'piece-section': 'Put this piece in a section to colour them together', 'piece-slot': 'Which colour this piece takes',
  'mat-preset': 'Pick a ready-made material for this piece', 'piece-region': 'What this piece is, like paint, glass or tyre',
  'mat.textured': 'Keep the picture that came with the 3D file under this material', 'mat.metalness': 'How much it looks like metal',
  'mat.roughness': 'Low is smooth and shiny, high is dull', 'mat.clearcoat': 'A glossy top layer, like car paint', 'mat.clearcoatRoughness': 'Low is a shiny coat, high is a dull one',
  'mat.sheen': 'A soft shine like velvet or cloth', 'mat.transmission': 'Lets light through, like glass', 'mat.ior': 'How much the glass bends what is behind it',
  'mat.thickness': 'How thick the glass is', 'mat.emissive': 'The colour this piece glows', 'mat.emissiveIntensity': 'How bright the glow is',
  'mat.normalScale': 'How strong the small bumps look', 'mat.sss': 'How much light soaks into it, like skin or wax', 'mat.sssRadius': 'How deep the light soaks in',
  'mat.sssColor': 'The colour of the light inside', 'act.studio-preset': 'Pick a saved look for the whole scene',
  'look.background.color': 'The background colour', 'look.background.color2': 'The bottom colour of the fade',
  'look.hdri.file': 'A 360 photo around the model that lights it', 'look.hdri.rotation': 'Turn the sky picture around the model',
  'look.hdri.intensity': 'How much light the sky picture gives', 'look.hdri.background': 'Show the sky picture behind the model', 'look.hdri.blur': 'Blur the sky picture behind the model',
  'act.light-preset': 'Pick a ready-made light setup', on: 'Turn this light on or off', intensity: 'How bright this light is', color: 'The colour of this light',
  azimuth: 'Move this light around the model', elevation: 'Move this light higher or lower', 'look.lights.shadows': 'Let the lights cast shadows',
  'look.lights.softness': 'How soft the shadow edges are', 'look.quality': 'Higher looks better but needs a faster computer',
  'look.tone': 'How colours and bright spots are shown', 'look.exposure': 'Make the whole picture lighter or darker',
  'look.ao.on': 'Darken corners and gaps a little so shapes stand out', 'look.ao.strength': 'How dark the corner shadows are',
  'look.bloom.on': 'Glowing parts light up the air around them', 'look.bloom.strength': 'How big and bright the glow halo is',
  'look.aa': 'Smooths jagged edges on the model', 'look.ssr.on': 'Shiny parts mirror the scene around them', 'look.ssr.strength': 'How strong the reflections are',
  'look.pathTraced': 'A slow, very real preview that gets clearer as you wait', 'look.finalEngine': 'Which Blender engine makes the final pictures',
  'act.export-part': 'Which Warframe part these pictures are for', 'act.alt-helmet': 'Make pictures for a second helmet (half as tall)',
};
const BG_TIPS = { scene: 'Use the scene behind the model', solid: 'One flat colour behind the model', gradient: 'Two colours that fade into each other', image: 'Your own picture behind the model' };
const tipOf = (attr, path) => TIPS[`${attr}.${path}`] || TIPS[attr] || TIPS[path.split('.').pop()] || '';
const sl = (attr, path, label, min, max, step, value, text = fixed(value), disabled = false) => {
  const id = `${attr}-${path.replace(/\W/g, '-')}`;
  return `<div class="sl"><label for="${id}">${label}</label><input class="range" type="range" id="${id}" title="${tipOf(attr, path)}" data-${attr}="${path}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${((value - min) / (max - min)) * 100}%" ${disabled ? 'disabled' : ''}><span class="v" id="v-${id}">${text}</span></div>`;
};
const tg = (attr, path, label, small, checked, disabled = false) => `<label class="tg" title="${tipOf(attr, path)}"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input class="sw" type="checkbox" role="switch" data-${attr}="${path}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
const sel = (attr, path, options, value, label = '') => `<label class="row-sel" title="${tipOf(attr, path)}">${label ? `<span>${label}</span>` : ''}<select class="inp" data-${attr}="${path}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const col = (attr, path, label, value) => `<div class="sl"><label>${label}</label><input class="tint" type="color" title="${tipOf(attr, path)}" data-${attr}="${path}" value="${esc(value || '#000000')}"><span class="v">${esc(value || '')}</span></div>`;
const TEXT = { azimuth: (v) => `${Math.round(v)}°`, elevation: (v) => `${Math.round(v)}°`, rotation: (v) => `${Math.round(v)}°`, ior: (v) => fixed(v, 2), exposure: (v) => `${fixed(v, 2)}×` };
const textOf = (path, v) => (TEXT[path.split('.').pop()] || fixed)(v);

// ---- rendering ----
export function renderPaintGroups() {
  const studio = ctx.studio();
  const paint = paintOf();
  const look = lookOf();
  const list = pieces();
  const sections = paint.sections || SECTIONS;
  const m = ctx.model();
  const hasPhoto = Boolean(m.source);
  const inferNote = paint.inference ? `Last guess: ${paint.inference.source === 'vision' ? 'by AI' : 'by simple rules'}${paint.inference.note ? ` · ${esc(paint.inference.note)}` : ''}` : hasPhoto ? 'Looks at the photo and picks a material for each piece.' : 'No photo: guessing needs the photo the model was made from.';
  const slotOptions = [['', 'Untinted'], ...SLOTS.map((s) => [s.id, `${s.label}${s.tint ? ` (${s.tint})` : ''}`])];
  const parts = `
    <div class="grp" id="grp-parts"><h3>${icon('cube', 14)} Parts</h3><p class="fine keep">${list.length} piece${list.length === 1 ? '' : 's'} · click a piece in the view</p>
      ${list.length ? `<div class="parts">${list.map((p) => {
        const r = rec(p.key);
        const region = r.region ? `<span class="badge ${r.region.flagged ? 'warn' : ''}" title="${r.region.user ? 'Set by you' : `Guessed · ${Math.round(r.region.confidence * 100)} % sure`}">${esc(REGIONS[r.region.label]?.label || r.region.label)}${r.region.flagged ? ' · review' : ''}</span>` : '';
        return `<div class="part ${p.key === selected ? 'on' : ''}" data-piece="${esc(p.key)}">
          <button class="pname" type="button" data-select="${esc(p.key)}" title="${esc(p.key)}">${esc(r.name || p.name)}</button>${region}
          <button class="btn icon xs" type="button" data-rename="${esc(p.key)}" title="Rename" aria-label="Rename ${esc(r.name || p.name)}">✎</button>
          ${r.hidden ? `<button class="btn sm ghostbtn" type="button" data-unhide="${esc(p.key)}" title="This part is hidden. Show it again">Show</button>` : ''}
          ${sel('piece-section', p.key, [['', 'No section'], ...sections.map((s) => [s.id, s.name])], r.section || '')}
          ${sel('piece-slot', p.key, slotOptions, r.slot || '')}
        </div>`;
      }).join('')}</div>` : '<p class="fine keep">Load a model to see its pieces.</p>'}
      <details class="sections"><summary title="Name the groups of pieces you colour together">Armor sections</summary>
        ${sections.map((s) => `<div class="secrow"><input class="inp" data-section-name="${esc(s.id)}" value="${esc(s.name)}" aria-label="Section name" title="Rename this section"><button class="btn icon xs" type="button" data-section-del="${esc(s.id)}" aria-label="Remove ${esc(s.name)}" title="Remove this section">${icon('close', 12)}</button></div>`).join('')}
        <button class="btn sm ghostbtn" type="button" data-act="section-add" title="Add a new group of pieces">${icon('plus', 12)}<span>Add section</span></button>
      </details>
      <div class="mg-row stack">
        <button class="btn sm sec" type="button" data-act="infer" title="Look at the photo and guess what each piece is made of" ${hasPhoto && studio?.model && !busyText ? '' : 'disabled'}>${icon('search', 14)}<span>${paint.inference ? 'Guess again' : 'Guess materials from photo'}</span></button>
        <button class="btn sm ghostbtn" type="button" data-act="revert" title="Undo the guesses and use the photo's colours again" ${paint.inference || Object.values(paint.pieces || {}).some((p) => p.region) ? '' : 'disabled'}>${icon('retry', 14)}<span>Back to photo look</span></button>
      </div>
      <p class="fine keep">${busyText ? esc(busyText) : inferNote}${state.settings?.visionKey === 'none' ? ' · Add an Anthropic key in Settings for better guesses.' : ''}</p>
    </div>`;

  const piece = selected ? rec(selected) : null;
  if (!selected) colorLevel = 'global'; // nothing picked: a colour is for the whole model
  const target = colorLevel === 'global' ? 'global' : colorLevel === 'section' ? piece?.section || null : selected;
  const resolved = resolveColors(paint, piece || {});
  const sources = colorSources(paint, piece || {});
  const levels = [
    ['global', 'All', ''],
    ['section', 'Section', !selected ? 'Pick a piece first: Section colours every piece in its section' : !piece?.section ? 'This piece is in no section: give it one in Parts to colour by section' : ''],
    ['piece', 'Piece', selected ? '' : 'Pick a piece in Parts or click it in the view'],
  ];
  const hint = levels.filter(([, , why]) => why).map(([, label, why]) => `<b>${label}:</b> ${esc(why)}.`).join(' ');
  const levelValue = (k) => (colorLevel === 'global' ? { ...DEFAULT_COLORS, ...paint.colors?.global }[k] : colorLevel === 'section' ? paint.colors?.sections?.[piece?.section]?.[k] : piece?.colors?.[k]);
  const color = `
    <div class="grp" id="grp-color"><h3>${icon('scene', 14)} Color</h3>
      <div class="chips seg sm levels" role="radiogroup" aria-label="Colour level">${levels.map(([k, label, why]) => `
        <button class="chip" type="button" role="radio" data-level="${k}" aria-checked="${colorLevel === k}" ${why ? `aria-disabled="true" aria-describedby="levelHint"` : ''} title="${why || `Colour ${k === 'global' ? 'every piece' : k === 'section' ? 'every piece in this section' : 'this piece only'}`}">${label}</button>`).join('')}
      </div>
      ${hint ? `<p class="fine keep" id="levelHint">${hint}</p>` : ''}
      <div class="swatches" role="radiogroup" aria-label="Colour slot">${SLOTS.map((s) => {
        const own = levelValue(s.id) != null;
        const v = colorLevel === 'global' ? levelValue(s.id) : resolved[s.id];
        return `<button class="swatch ${colorKey === s.id ? 'on' : ''}" type="button" role="radio" aria-checked="${colorKey === s.id}" data-color-key="${s.id}" title="${s.label}${s.tint ? ` · ${s.tint}` : ''} · ${own ? 'set here' : `comes from ${sources[s.id]}`}"><i style="background:${v}"></i><span>${s.label}</span><small>${own || colorLevel === 'global' ? v : `← ${sources[s.id]}`}</small></button>`;
      }).join('')}</div>
      ${target ? `<div class="mg-row stack"><span class="fine">${colorLevel === 'global' ? 'All pieces' : colorLevel === 'section' ? `Section · ${esc(sections.find((s) => s.id === piece.section)?.name || '')}` : `Piece · ${esc(piece?.name || selected)}`} · ${SLOTS.find((s) => s.id === colorKey).label}</span>
        ${colorLevel !== 'global' ? `<button class="btn sm ghostbtn" type="button" data-act="color-reset" title="Go back to the colour from the level above" ${levelValue(colorKey) != null ? '' : 'disabled'}>Reset colour</button>` : ''}</div>
      <div id="picker"></div>` : '<p class="fine keep">Pick a piece to colour it, or switch to All.</p>'}
    </div>`;

  const mat = piece ? deserializeMaterial(piece.material) : null;
  const material = `
    <div class="grp" id="grp-material"><h3>${icon('light', 14)} Material</h3>${piece ? `<p class="fine keep wrap">${esc(piece.name || selected)}</p>` : ''}
      ${!piece ? '<p class="fine keep">Pick a piece in the Parts list or click it in the view.</p>' : `
      <div class="mg-row mat-acts">${sel('mat-preset', 'preset', [['', piece.material ? 'Custom' : 'Original'], ...Object.entries(MATERIAL_PRESETS).map(([k, p]) => [k, p.label])], mat.preset || '')}
        <button class="btn sm ghostbtn" type="button" data-act="mat-copy" title="Copy this piece's material" ${piece.material ? '' : 'disabled'}>Copy</button>
        <button class="btn sm ghostbtn" type="button" data-act="mat-paste" title="Put the copied material on this piece" ${clipboard ? '' : 'disabled'}>Paste</button>
        <button class="btn sm ghostbtn" type="button" data-act="mat-clear" title="Go back to the material the model came with" ${piece.material ? '' : 'disabled'}>Clear</button></div>
      ${piece.region ? `<div class="mg-row stack">${sel('piece-region', selected, Object.entries(REGIONS).map(([k, r]) => [k, r.label]), piece.region.label, 'What it is')}<span class="fine">${piece.region.user ? 'set by you' : `${Math.round(piece.region.confidence * 100)} % sure${piece.region.flagged ? ' · please review' : ''}`}</span></div>` : ''}
      <div class="sl"><label>Main colour</label><input class="tint" type="color" data-mat="color" title="Pick this piece's main colour" value="${esc(mat.color || resolved[piece.slot] || '#808080')}"><button class="btn icon xs" type="button" data-act="mat-color-clear" title="Use the slot colour / texture" ${mat.color ? '' : 'disabled'}>${icon('close', 12)}</button></div>
      ${tg('mat', 'textured', 'Keep texture', 'The picture from the 3D file stays under this', mat.textured !== false)}
      ${sl('mat', 'metalness', 'Metal', 0, 1, 0.01, mat.metalness)}${sl('mat', 'roughness', 'Rough', 0, 1, 0.01, mat.roughness)}
      ${sl('mat', 'clearcoat', 'Clear coat', 0, 1, 0.01, mat.clearcoat)}${sl('mat', 'clearcoatRoughness', 'Coat rough', 0, 1, 0.01, mat.clearcoatRoughness)}
      ${sl('mat', 'sheen', 'Cloth shine', 0, 1, 0.01, mat.sheen)}${sl('mat', 'transmission', 'See-through', 0, 1, 0.01, mat.transmission)}${sl('mat', 'ior', 'Glass bend', 1, 2.333, 0.001, mat.ior)}${sl('mat', 'thickness', 'Thickness', 0, 0.5, 0.005, mat.thickness, `${fixed(mat.thickness, 3)} m`)}
      ${col('mat', 'emissive', 'Glow colour', mat.emissive)}${sl('mat', 'emissiveIntensity', 'Glow strength', 0, 10, 0.1, mat.emissiveIntensity)}
      ${sl('mat', 'normalScale', 'Bumps', 0, 2, 0.01, mat.normalScale)}
      ${textureGroup(mat)}
      <h3 style="margin-top:6px">Light inside (skin, wax)</h3>
      ${sl('mat', 'sss', 'Amount', 0, 1, 0.01, mat.sss)}${sl('mat', 'sssRadius', 'Depth', 0.1, 4, 0.05, mat.sssRadius)}${col('mat', 'sssColor', 'Colour', mat.sssColor)}`}
    </div>`;

  const presets = { ...STUDIO_PRESETS, ...(state.settings?.studioPresets || {}) };
  const current = Object.entries(presets).find(([, l]) => JSON.stringify(l) === JSON.stringify(look))?.[0] || '';
  const lightRow = (k, label) => { const L = look.lights[k]; return `<div class="lightrow"><b>${label}</b>${tg('look', `lights.${k}.on`, 'On', '', L.on)}${sl('look', `lights.${k}.intensity`, 'Brightness', 0, 4, 0.05, L.intensity)}${col('look', `lights.${k}.color`, 'Colour', L.color)}${sl('look', `lights.${k}.azimuth`, 'Around', -180, 180, 1, L.azimuth, TEXT.azimuth(L.azimuth))}${sl('look', `lights.${k}.elevation`, 'Height', 1, 89, 1, L.elevation, TEXT.elevation(L.elevation))}</div>`; };
  const sceneGrp = `
    <div class="grp" id="grp-scene"><h3>${icon('scene', 14)} Light and look</h3>
      <div class="mg-row">${sel('act', 'studio-preset', [['', current ? `Look · ${current}` : 'Custom look'], ...Object.keys(presets).map((n) => [n, n])], current, 'Saved look')}
        <button class="btn sm ghostbtn" type="button" data-act="preset-save" title="Save these settings as a look you can pick again">Save as…</button>${current && !STUDIO_PRESETS[current] ? `<button class="btn sm ghostbtn" type="button" data-act="preset-del" data-name="${esc(current)}" title="Delete this saved look">Delete</button>` : ''}</div>
      <div class="presetsave" id="presetSave" hidden><input class="inp" id="presetName" placeholder="Look name" title="A name for this look" maxlength="60"><button class="btn sm pri" type="button" data-act="preset-save-ok" title="Save this look">Save</button></div>
      <h3>Background</h3>
      <div class="chips" role="radiogroup" aria-label="Background">${Object.entries(BACKGROUND_KINDS).map(([k, l]) => `<button class="chip" type="button" role="radio" data-bg="${k}" aria-checked="${look.background.kind === k}" title="${BG_TIPS[k]}">${l}</button>`).join('')}</div>
      ${look.background.kind === 'solid' ? col('look', 'background.color', 'Colour', look.background.color) : ''}
      ${look.background.kind === 'gradient' ? `${col('look', 'background.color', 'Top', look.background.color)}${col('look', 'background.color2', 'Bottom', look.background.color2)}` : ''}
      ${look.background.kind === 'image' ? `<div class="mg-row"><button class="btn sm ghostbtn" type="button" data-act="bg-image" title="Pick a picture to show behind the model (PNG, JPG or WebP)">${icon('upload', 14)}<span>${look.background.image ? 'Change picture' : 'Add picture'}</span></button><span class="fine">${esc(look.background.image || '')}</span></div>` : ''}
      <h3>Sky picture</h3>
      <div class="mg-row stack">${sel('look', 'hdri.file', [['', 'None'], ...Object.entries(HDRIS).map(([k, h]) => [`builtin:${k}`, `${h.label} · ${h.note}`]), ...(look.hdri.file && !look.hdri.file.startsWith('builtin:') ? [[look.hdri.file, look.hdri.file]] : [])], look.hdri.file || '')}
        <button class="btn sm ghostbtn" type="button" data-act="hdri-import" title="Use your own 360 photo (.hdr or .exr file)">${icon('upload', 14)}<span>Add my own</span></button></div>
      ${look.hdri.file ? `${sl('look', 'hdri.rotation', 'Turn', 0, 360, 1, look.hdri.rotation, TEXT.rotation(look.hdri.rotation))}${sl('look', 'hdri.intensity', 'Brightness', 0, 4, 0.05, look.hdri.intensity)}${tg('look', 'hdri.background', 'Show behind model', '', look.hdri.background)}${look.hdri.background ? sl('look', 'hdri.blur', 'Blur', 0, 1, 0.01, look.hdri.blur) : ''}` : ''}
      <h3>Lights</h3>
      ${sel('act', 'light-preset', Object.entries(LIGHT_PRESETS).map(([k, p]) => [k, p.label]), look.lights.preset, 'Style')}
      ${look.lights.preset === 'match' ? '<p class="fine">The lights follow the photo and the render lights below.</p>' : `${lightRow('key', 'Main light')}${lightRow('fill', 'Fill light')}${lightRow('rim', 'Back light')}
        ${tg('look', 'lights.shadows', 'Shadows', '', look.lights.shadows)}${sl('look', 'lights.softness', 'Softness', 0, 1, 0.01, look.lights.softness)}`}
      <h3>Picture quality</h3>
      ${sel('look', 'quality', Object.entries(QUALITIES), look.quality, 'Quality')}
      ${sel('look', 'tone', Object.entries(TONE_MAPPINGS), look.tone, 'Colour style')}${sl('look', 'exposure', 'Brightness', 0.25, 3, 0.01, look.exposure, TEXT.exposure(look.exposure))}
      ${tg('look', 'ao.on', 'Soft corner shadows', look.quality === 'low' ? 'Off on Low quality' : look.quality === 'medium' ? 'Better on High quality' : 'Darkens corners and gaps', look.ao.on)}${look.ao.on ? sl('look', 'ao.strength', 'Shadow strength', 0, 2, 0.05, look.ao.strength) : ''}
      ${tg('look', 'bloom.on', 'Glow halo', 'Glowing pieces light up the air around them', look.bloom.on)}${look.bloom.on ? sl('look', 'bloom.strength', 'Halo strength', 0, 2, 0.05, look.bloom.strength) : ''}
      ${sel('look', 'aa', [['msaa', 'Normal'], ['fxaa', 'Fast'], ['smaa', 'Best']], look.aa, 'Smooth edges')}
      ${tg('look', 'ssr.on', 'Shiny reflections', 'Needs High quality', look.ssr.on)}${look.ssr.on ? sl('look', 'ssr.strength', 'Reflection strength', 0, 1, 0.01, look.ssr.strength) : ''}
      ${tg('look', 'pathTraced', 'Best preview (slow)', `Gets clearer while you wait · needs Quality: Best${studio?.tracing ? ` · ${studio.samples} passes` : ''}`, look.pathTraced)}
      ${sel('look', 'finalEngine', [['cycles', 'Cycles (best, slower)'], ['eevee', 'Eevee (fast)']], look.finalEngine, 'Final render')}
    </div>`;

  const outDir = exportDir();
  const exportGrp = `
    <div class="grp" id="grp-export"><h3>${icon('download', 14)} Export</h3>
      ${sel('act', 'export-part', PARTS.map((p) => [p, p]), exportOf().part, 'Part')}
      ${tg('act', 'alt-helmet', 'Second helmet', 'Pictures are half as tall', exportOf().altHelmet)}
      <div class="mg-row">
        <button class="btn" type="button" data-act="export-tenno" title="Save the paint as the six Warframe picture files (colour, glow, bumps, shine, metal and tint)" ${studio?.model && outDir && !busyText ? '' : 'disabled'}>Pictures</button>
        <button class="btn" type="button" data-act="export-glb" title="Save the model with its colours as one 3D file (${keyOf('export')})" ${studio?.model && outDir && !busyText ? '' : 'disabled'}>3D file</button>
      </div>
      ${outDir ? `<p class="fine keep saveto" title="${esc(outDir)}">Saves to: <b>${esc(savesTo(outDir, 'tennogen', textureSet(exportOf().part).map((t) => t.name)))}</b><br>3D file: <b>${esc(savesTo(outDir, 'models', `${safeFileName(m.name, m.slug)}.glb`))}</b></p>
        ${native ? '<button class="btn" type="button" data-act="open-export" title="Open the folder these files go to">Open folder</button>' : ''}` : '<p class="fine keep">Choose a handoff folder in Render first.</p>'}
      ${lastCompare ? `<div class="checklist" role="group" aria-label="TennoGen compare"><p class="fine keep"><b>${lastCompare.pass ? 'Ready to submit' : 'Fix before submitting'}</b> · checked against Warframe's sample files</p><ul>${lastCompare.checks.map((c) => `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? 'Pass' : 'Fail'}: ${esc(c.label)}${!c.pass && c.got != null ? ` (got ${esc(String(c.got))})` : ''}</li>`).join('')}</ul></div>` : ''}
      ${lastWarnings.length ? `<ul class="warnlist">${lastWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
  return templateGroup() + parts + color + material + decalGroup() + sceneGrp + exportGrp;
}

// After the inspector HTML is in place: mount the picker.
export function afterRender() {
  const box = $('#picker', ctx.root);
  if (!box) { picker = null; return; }
  const paint = paintOf();
  const piece = selected ? rec(selected) : {};
  const value = colorLevel === 'global' ? { ...DEFAULT_COLORS, ...paint.colors?.global }[colorKey] : resolveColors(paint, piece)[colorKey];
  picker = new ColorPicker(box, { value, recent: paint.recent || [], onPick: applyColor, onPreview: previewColor });
}

// The paint with a colour picked in the Color panel: stored at its level, and the pieces it is for wear its slot
// (tenno.js pickColor), so it really shows. Null when there is nothing to colour.
function pickedPaint(hex) {
  const piece = selected ? rec(selected) : null;
  const level = colorLevel === 'global' ? 'global' : colorLevel === 'section' ? piece?.section : selected;
  if (!level) return null;
  const all = pieces();
  const targets = level === 'global' ? all.map((p) => p.key) : level === selected ? [selected] : all.filter((p) => rec(p.key).section === level).map((p) => p.key);
  return pickColor(paintOf(), { level, key: colorKey, hex, targets, names: Object.fromEntries(all.map((p) => [p.key, p.name])) });
}
// The slot swatch follows the wheel without a redraw of the panel.
function liveSwatch(hex) {
  const b = $(`[data-color-key="${colorKey}"]`, ctx.root);
  if (!b) return;
  b.querySelector('i').style.background = hex;
  const small = b.querySelector('small');
  if (small) small.textContent = hex;
}
// While the wheel is dragged: the model shows the colour, nothing is saved and there is no undo step yet.
function previewColor(hex) {
  const paint = pickedPaint(hex);
  if (!paint) return;
  ctx.studio()?.previewPaint(paint);
  ctx.draw();
  liveSwatch(hex);
}
// A colour is chosen (a drag ended, a swatch, the hex or RGB fields): one saved, undoable step.
function applyColor(hex) {
  const paint = pickedPaint(hex);
  if (!paint) return;
  ctx.change({ paint: recentColor(paint, hex) }, { inspector: false });
  picker?.setRecent(paintOf().recent);
  liveSwatch(hex);
}

const setPath = (obj, path, value) => {
  const out = JSON.parse(JSON.stringify(obj));
  const keys = path.split('.');
  let o = out;
  for (const k of keys.slice(0, -1)) o = o[k] ||= {};
  o[keys.at(-1)] = value;
  return out;
};
const updatePiece = (key, patch) => {
  const name = pieces().find((p) => p.key === key)?.name;
  ctx.change({ paint: upsertPiece(paintOf(), key, { ...(paintOf().pieces[key] ? {} : { name }), ...patch }) });
};
const updateMaterial = (patch, { inspector = true } = {}) => {
  const p = rec(selected);
  const mat = { ...deserializeMaterial(p.material), ...patch, user: true };
  const json = { ...serializeMaterial(mat), user: true, ...(p.material?.inferred && { inferred: true }) };
  const name = pieces().find((x) => x.key === selected)?.name;
  ctx.change({ paint: upsertPiece(paintOf(), selected, { ...(paintOf().pieces[selected] ? {} : { name }), material: json }) }, { inspector });
};

// ---- events (called from compose.js's listeners) ----
export function onPaintDragStart(e) {
  const id = e.target.closest?.('[data-texture]')?.dataset.texture;
  if (!id) return false;
  e.dataTransfer.setData('application/x-flatform-texture', id);
  e.dataTransfer.effectAllowed = 'copy';
  return true;
}

export async function onPaintClick(t) {
  const act = t.dataset.act;
  if (t.dataset.select) { selectPiece(t.dataset.select); return true; }
  if (t.dataset.tpl) {
    const tpl = findTemplate(t.dataset.tpl);
    if (tpl) { ctx.change(templateScene(tpl.scene)); toast(`${tpl.name} applied`); ctx.renderInspector(); }
    return true;
  }
  if (t.dataset.tplDel) {
    try { myTemplates = await api(`/api/templates/${encodeURIComponent(t.dataset.tplDel)}?workspace=${encodeURIComponent(texWs())}`, { method: 'DELETE' }); } catch (e) { toast(e.message); }
    ctx.renderInspector();
    return true;
  }
  if (act === 'tpl-save') {
    const name = $('#tplName', ctx.root)?.value.trim();
    if (!name) { toast('Give the template a name first'); return true; }
    try {
      await send(`/api/templates?workspace=${encodeURIComponent(texWs())}`, 'POST', { name, scene: templateScene(ctx.scene()) });
      await loadMyTemplates(true);
      toast(`Saved ${name}`);
    } catch (e) { toast(e.message); }
    return true;
  }
  if (t.dataset.rename) {
    const key = t.dataset.rename;
    const row = t.closest('.part');
    const name = rec(key).name || pieces().find((p) => p.key === key)?.name || '';
    row.querySelector('.pname').outerHTML = `<input class="inp pname-edit" data-rename-input="${esc(key)}" value="${esc(name)}" aria-label="Piece name">`;
    row.querySelector('.pname-edit').focus();
    return true;
  }
  if (t.dataset.decal) { decalSel = decalSel === t.dataset.decal ? null : t.dataset.decal; ctx.renderInspector(); return true; }
  if (t.dataset.decalFinish) { patchDecal(decalSel, FINISH_VALUES[t.dataset.decalFinish]); return true; }
  if (act === 'decal-add') { $('#decalFile', ctx.root)?.click(); return true; }
  if (act === 'decal-cancel') { placing = null; ctx.renderInspector(); return true; }
  if (act === 'decal-move') { placing = { move: decalSel }; ctx.renderInspector(); toast('Click the model where the sticker goes'); return true; }
  if (act === 'decal-hide') { const d = decalsOf().find((x) => x.id === decalSel); if (d) patchDecal(d.id, { visible: !d.visible }); return true; }
  if (act === 'decal-del') { setDecals(decalsOf().filter((x) => x.id !== decalSel)); decalSel = null; return true; }
  if (t.dataset.texture) { applyTexture(selected, t.dataset.texture); return true; }
  if (act === 'tex-clear') { updateMaterial({ texture: null }); return true; }
  if (act === 'tex-import') { $('#texFile', ctx.root)?.click(); return true; }
  if (act === 'tex-sync') {
    try { textures = await send(`/api/textures/sync?workspace=${encodeURIComponent(texWs())}`, 'POST', {}); } catch (e) { toast(e.message); }
    ctx.renderInspector();
    setTimeout(() => loadTextures(true), 1000);
    return true;
  }
  if (t.dataset.level) { if (t.getAttribute('aria-disabled') === 'true') return true; colorLevel = t.dataset.level; ctx.renderInspector(); return true; }
  if (t.dataset.colorKey) { colorKey = t.dataset.colorKey; ctx.renderInspector(); return true; }
  if (t.dataset.bg) { ctx.change({ look: setPath(lookOf(), 'background.kind', t.dataset.bg) }); return true; }
  if (act === 'color-reset') {
    const piece = rec(selected);
    const level = colorLevel === 'section' ? piece.section : selected;
    ctx.change({ paint: setColor(paintOf(), level, colorKey, null) });
    return true;
  }
  // The inspector card's Hide / Show and Select similar (compose.js draws the buttons).
  if (act === 'insp-hide' && selected) {
    const hide = !rec(selected).hidden;
    updatePiece(selected, { hidden: hide });
    return true;
  }
  if (t.dataset.unhide) { updatePiece(t.dataset.unhide, { hidden: false }); return true; }
  if (act === 'insp-similar' && selected) {
    const keys = similarPieces(pieces(), selected);
    if (keys.length < 2) { toast('No other parts look like this one.', 'info'); return true; }
    let paint = paintOf();
    const name = `Like ${rec(selected).name || pieces().find((p) => p.key === selected)?.name || 'this part'}`.slice(0, 60);
    const sections = paint.sections || SECTIONS;
    const id = sections.find((x) => x.name === name)?.id || `similar${Date.now().toString(36)}`;
    paint = { ...paint, sections: sections.some((x) => x.id === id) ? sections : [...sections, { id, name }] };
    for (const k of keys) paint = upsertPiece(paint, k, { ...(paint.pieces[k] ? {} : { name: pieces().find((p) => p.key === k)?.name }), section: id });
    colorLevel = 'section';
    ctx.change({ paint });
    toast(`Picked ${keys.length} parts like this one. Colour changes now go to all of them.`, 'info');
    return true;
  }
  if (act === 'section-add') {
    const paint = paintOf();
    const id = `section${Date.now().toString(36)}`;
    ctx.change({ paint: { ...paint, sections: [...(paint.sections || SECTIONS), { id, name: 'New section' }] } });
    return true;
  }
  if (t.dataset.sectionDel) {
    const paint = paintOf();
    const pcs = Object.fromEntries(Object.entries(paint.pieces).map(([k, p]) => [k, p.section === t.dataset.sectionDel ? { ...p, section: null } : p]));
    ctx.change({ paint: { ...paint, sections: (paint.sections || SECTIONS).filter((s) => s.id !== t.dataset.sectionDel), pieces: pcs } });
    return true;
  }
  if (act === 'mat-copy') { clipboard = rec(selected).material; ctx.renderInspector(); return true; }
  if (act === 'mat-paste' && clipboard) { updatePiece(selected, { material: { ...clipboard, user: true } }); return true; }
  if (act === 'mat-clear') { updatePiece(selected, { material: null }); return true; }
  if (act === 'mat-color-clear') { updateMaterial({ color: null }); return true; }
  if (act === 'preset-save') { $('#presetSave', ctx.root).hidden = false; $('#presetName', ctx.root).focus(); return true; }
  if (act === 'preset-save-ok') {
    const name = $('#presetName', ctx.root).value.trim();
    if (!name) return true;
    await saveSettings({ studioPresets: { ...(state.settings?.studioPresets || {}), [name]: lookOf() } });
    ctx.renderInspector();
    return true;
  }
  if (act === 'preset-del') {
    const presets = { ...(state.settings?.studioPresets || {}) };
    delete presets[t.dataset.name];
    await saveSettings({ studioPresets: presets });
    ctx.renderInspector();
    return true;
  }
  if (act === 'bg-image' || act === 'hdri-import') {
    const input = $('#lookFile', ctx.root);
    input.accept = act === 'bg-image' ? '.png,.jpg,.jpeg,.webp' : '.hdr,.exr';
    input.dataset.kind = act;
    input.click();
    return true;
  }
  if (act === 'infer') { await runInference(); return true; }
  if (act === 'revert') {
    const studio = ctx.studio();
    ctx.change({ paint: revertInference(studio.model, paintOf()) });
    return true;
  }
  if (act === 'export-tenno' || act === 'export-glb') { await runExport(act === 'export-glb'); return true; }
  if (act === 'open-export') { native?.openPath(exportDir()).catch(() => native.openPath(state.settings.outputRoot)).catch((e) => toast(e.message)); return true; }
  return false;
}

export function onPaintInput(t) {
  if (t.dataset.look && t.type === 'range') {
    const v = Number(t.value);
    t.style.setProperty('--p', `${((v - t.min) / (t.max - t.min)) * 100}%`);
    $(`#v-${t.id}`, ctx.root).textContent = textOf(t.dataset.look, v);
    ctx.change({ look: setPath(lookOf(), t.dataset.look, v) }, { inspector: false });
    return true;
  }
  if (t.dataset.look && t.type === 'color') { t.nextElementSibling.textContent = t.value; ctx.change({ look: setPath(lookOf(), t.dataset.look, t.value) }, { inspector: false }); return true; }
  if (t.dataset.mat && t.type === 'range') {
    const v = Number(t.value);
    t.style.setProperty('--p', `${((v - t.min) / (t.max - t.min)) * 100}%`);
    $(`#v-${t.id}`, ctx.root).textContent = t.dataset.mat === 'thickness' ? `${fixed(v, 3)} m` : textOf(t.dataset.mat, v);
    updateMaterial({ [t.dataset.mat]: v }, { inspector: false });
    return true;
  }
  if (t.dataset.decal && t.type === 'range') {
    const v = Number(t.value);
    t.style.setProperty('--p', `${((v - t.min) / (t.max - t.min)) * 100}%`);
    $(`#v-${t.id}`, ctx.root).textContent = (DECAL_TEXT[t.dataset.decal] || fixed)(v);
    patchDecal(decalSel, { [t.dataset.decal]: v }, { inspector: false });
    return true;
  }
  if (t.dataset.tex && t.type === 'range') {
    const v = Number(t.value);
    t.style.setProperty('--p', `${((v - t.min) / (t.max - t.min)) * 100}%`);
    $(`#v-${t.id}`, ctx.root).textContent = t.dataset.tex === 'scale' ? `${fixed(v, 1)}×` : `${v}°`;
    const cur = deserializeMaterial(rec(selected).material).texture;
    if (cur) updateMaterial({ texture: { ...cur, [t.dataset.tex]: v } }, { inspector: false });
    return true;
  }
  if (t.dataset.mat && t.type === 'color') { if (t.nextElementSibling?.classList.contains('v')) t.nextElementSibling.textContent = t.value; updateMaterial({ [t.dataset.mat]: t.value }, { inspector: false }); return true; }
  return false;
}

export async function onPaintChange(t) {
  const act = t.dataset.act;
  if (t.dataset.renameInput) { updatePiece(t.dataset.renameInput, { name: t.value.trim() || undefined }); return true; }
  if (t.dataset.sectionName) {
    const paint = paintOf();
    ctx.change({ paint: { ...paint, sections: (paint.sections || SECTIONS).map((s) => (s.id === t.dataset.sectionName ? { ...s, name: t.value.trim() || s.name } : s)) } });
    return true;
  }
  if (t.dataset.pieceSection !== undefined) { updatePiece(t.dataset.pieceSection, { section: t.value || null }); return true; }
  if (t.dataset.pieceSlot !== undefined) { updatePiece(t.dataset.pieceSlot, { slot: t.value || null, autoSlot: false }); return true; }
  if (t.dataset.pieceRegion !== undefined) {
    const { overrideRegion } = await import('../lib/infer.js');
    const { presetFor } = await import('../lib/infer.js');
    const paint = paintOf();
    const pcs = overrideRegion(paint.pieces, t.dataset.pieceRegion, t.value);
    const p = pcs[t.dataset.pieceRegion];
    if (!p.material?.user) pcs[t.dataset.pieceRegion] = { ...p, material: { ...presetFor(t.value, p.material?.color || null), textured: false, inferred: true } };
    ctx.change({ paint: { ...paint, pieces: pcs } });
    return true;
  }
  if (t.dataset.matPreset !== undefined) {
    if (!t.value) updatePiece(selected, { material: null });
    else updateMaterial({ ...materialFromPreset(t.value), color: deserializeMaterial(rec(selected).material).color });
    return true;
  }
  if (t.dataset.mat === 'textured') { updateMaterial({ textured: t.checked }); return true; }
  if (t.dataset.look !== undefined && (t.type === 'checkbox' || t.tagName === 'SELECT')) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.dataset.look === 'hdri.file' && v === '') v = null;
    ctx.change({ look: setPath(lookOf(), t.dataset.look, v) });
    return true;
  }
  if (act === 'studio-preset') {
    const presets = { ...STUDIO_PRESETS, ...(state.settings?.studioPresets || {}) };
    if (presets[t.value]) ctx.change({ look: presets[t.value] });
    return true;
  }
  if (act === 'light-preset') { ctx.change({ look: { ...lookOf(), lights: lightsFromPreset(t.value) } }); return true; }
  if (act === 'export-part') { ctx.change({ exportSet: { ...exportOf(), part: t.value } }); return true; }
  if (act === 'alt-helmet') { ctx.change({ exportSet: { ...exportOf(), altHelmet: t.checked } }); return true; }
  if (t.id === 'decalFile' && t.files[0]) {
    const file = t.files[0];
    t.value = '';
    try {
      const { file: stored } = await api('/api/decals', { method: 'POST', body: file });
      placing = { file: stored, name: file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'Sticker', aspect: await imageAspect(stored) };
      ctx.renderInspector();
      toast('Click the model where the sticker goes');
    } catch (e) { toast(e.message); }
    return true;
  }
  if (t.id === 'texFile' && t.files[0]) {
    const file = t.files[0];
    t.value = '';
    try {
      const item = await api(`/api/textures/import?workspace=${encodeURIComponent(texWs())}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      await loadTextures(true);
      if (selected) applyTexture(selected, item.id);
    } catch (e) { toast(e.message); }
    return true;
  }
  if (t.id === 'lookFile' && t.files[0]) {
    const file = t.files[0];
    const kind = t.dataset.kind;
    t.value = '';
    if (kind === 'hdri-import' && !isHdri(file.name)) return toast('Use a .hdr or .exr file'), true;
    if (kind === 'bg-image' && !isBackgroundImage(file.name)) return toast('Use a PNG, JPG or WebP image'), true;
    try {
      const backdrops = await api(`/api/backdrops?slot=custom&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      state.settings.backdrops = backdrops;
      const saved = backdrops.custom;
      ctx.change({ look: kind === 'hdri-import' ? setPath(lookOf(), 'hdri.file', saved) : setPath(lookOf(), 'background.image', saved) });
    } catch (e) { toast(e.message); }
    return true;
  }
  return false;
}

async function saveSettings(data) {
  try { state.settings = await send('/api/settings', 'POST', data); } catch (e) { toast(e.message); }
}

async function runInference() {
  const studio = ctx.studio();
  const m = ctx.model();
  if (!studio?.model || !m.source) return;
  busyText = 'Looking at the photo and guessing each piece…';
  ctx.renderInspector();
  try {
    const photo = new Image();
    photo.src = fileUrl(m, m.source);
    await photo.decode();
    const frame = studio.frame;
    studio.setFrame(0); // the photo was taken at the scene's turn (frame 000)
    const paint = await inferFromPhoto(studio.model, studio.camera, photo, paintOf(), (stats, image) => send('/api/infer', 'POST', { stats, image }));
    studio.setFrame(frame);
    busyText = '';
    await ctx.change({ paint });
  } catch (e) {
    busyText = '';
    toast(`Could not guess the materials: ${e.message}`);
    ctx.renderInspector();
  }
}

// Reads each exported texture back (size, channels, albedo luminance) and checks it against the template set.
async function compareFiles(files) {
  const info = [];
  for (const f of files) {
    const bmp = await createImageBitmap(f.blob);
    const c = new OffscreenCanvas(Math.min(256, bmp.width), Math.min(256, bmp.height));
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let alpha = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { alpha = true; break; }
    info.push({ name: f.name, width: bmp.width, height: bmp.height, channels: alpha ? 4 : 3, luma: /_d\.png$/i.test(f.name) ? lumaStats(data) : null });
    bmp.close();
  }
  return compareSet(info, exportOf());
}

// The model's handoff folder (outputRoot/slug), or '' before one is chosen.
function exportDir() {
  const s = state.settings, m = ctx.model();
  return s?.outputRoot ? `${s.outputRoot}${s.platform === 'win32' ? '\\' : '/'}${m.slug}` : '';
}

async function runExport(glb) {
  const studio = ctx.studio();
  const m = ctx.model();
  if (!studio?.model) return;
  if (!state.settings?.outputRoot) return toast('Choose a handoff folder in the render area below first');
  busyText = glb ? 'Saving the 3D file…' : 'Making the Warframe pictures…';
  ctx.renderInspector();
  try {
    const started = await send(`/api/renders/${m.id}/start`, 'POST', { looks: [], formats: [] });
    const put = async (rel, blob) => {
      const r = await fetch(`/api/renders/${m.id}/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not write ${rel}`);
    };
    if (glb) {
      await put(`models/${safeFileName(m.name, m.slug)}.glb`, await exportGlb(studio.model, paintOf(), studio.decals));
      lastWarnings = [];
      toast(`3D file saved to ${started.outDir}`, 'info');
    } else {
      const { files, warnings } = await exportTennoGen(studio.model, paintOf(), exportOf());
      for (const f of files) await put(`tennogen/${f.name}`, f.blob);
      lastWarnings = warnings;
      lastCompare = await compareFiles(files).catch(() => null);
      toast(`${files.length} pictures saved to ${started.outDir}${warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}`, warnings.length ? 'error' : 'info');
    }
    if (native && started.outDir) native.openPath(started.outDir).catch(() => {});
  } catch (e) { toast(e.message); }
  busyText = '';
  ctx.renderInspector();
}
