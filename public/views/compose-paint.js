// Compose, the paint and look half of the inspector: Parts (pieces, sections, slots, inferred regions), Color
// (Global > Section > Piece with the picker), Material (PBR + SSS per piece, presets, copy/paste), Scene (background,
// HDRI, light presets, AO, tone mapping, reflections, quality, studio presets) and Export (GLB + TennoGen set).
// compose.js owns the scene object and the studio; this module gets them through ctx and calls ctx.change().
import { $, $$, esc, state, api, send, toast, fileUrl, native, activeWorkspace } from '../app.js';
import { icon } from '../lib/icons.js';
import {
  SLOTS, SECTIONS, PARTS, MATERIAL_PRESETS, MATERIAL_KEYS, defaultPaint, upsertPiece, resolveColors, colorSources, setColor, recentColor,
  materialFromPreset, deserializeMaterial, serializeMaterial, DEFAULT_COLORS,
} from '../lib/tenno.js';
import { REGIONS } from '../lib/infer.js';
import { DEFAULT_LOOK, mergeLook, STUDIO_PRESETS, LIGHT_PRESETS, lightsFromPreset, HDRIS, TONE_MAPPINGS, QUALITIES, BACKGROUND_KINDS, isHdri, isBackgroundImage } from '../lib/look.js';
import { compareSet, lumaStats } from '../lib/compare.js';
import { ColorPicker } from '../lib/color-picker.js';
import { inferFromPhoto, revertInference, exportTennoGen, exportGlb, setTextureWorkspace } from '../lib/paint.js';

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
  if (!textures || texturesFor !== texWs()) { loadTextures(); return '<h3 style="margin-top:6px">Texture</h3><p class="fine">Loading textures…</p>'; }
  const s = textures.sync || {};
  const ready = textures.items.filter((t) => t.cached);
  const missing = textures.items.length - ready.length;
  const cur = mat.texture;
  return `<h3 style="margin-top:6px">Texture</h3>
    <div class="mg-row">
      ${missing ? `<button class="btn sm pri" type="button" data-act="tex-sync" ${s.running ? 'disabled' : ''}>${s.running ? `Getting textures ${s.done}/${s.total}…` : `Get free textures (${missing})`}</button>` : ''}
      <button class="btn sm ghostbtn" type="button" data-act="tex-import">${icon('upload', 14)}<span>Import my own</span></button>
      ${cur ? '<button class="btn sm ghostbtn" type="button" data-act="tex-clear">No texture</button>' : ''}</div>
    ${Object.keys(s.errors || {}).length ? `<p class="fine">Some textures did not download. Check your connection and try again.</p>` : ''}
    <div class="texgrid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">${ready.map((t) => `<button type="button" class="texbtn" draggable="true" data-texture="${esc(t.id)}" title="${esc(t.name)} · ${esc(t.source)} · ${esc(t.license)}" aria-pressed="${cur?.id === t.id}" style="padding:0;border-radius:8px;overflow:hidden;border:2px solid ${cur?.id === t.id ? 'var(--accent, #d4a63a)' : 'transparent'};background:none;cursor:pointer"><img src="${thumb(t)}" alt="${esc(t.name)}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;display:block"><small style="display:block;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</small></button>`).join('')}</div>
    <p class="fine">Click a texture for this piece, or drag it onto any piece in the view.${ready.some((t) => t.kind !== 'custom') ? ' Free textures are CC0 from ambientCG and Poly Haven.' : ''}</p>
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
// Drag a texture tile onto the 3D view: the piece under the drop point gets it.
export function onTextureDrop(id, key) { if (key) { applyTexture(key, id); selectPiece(key); } }

let ctx; // { root, model: () => m, scene: () => scene, studio: () => studio, change, draw, renderInspector }
let selected = null; // piece key
let colorLevel = 'piece'; // 'global' | 'section' | 'piece'
let colorKey = 'primary';
let clipboard = null; // a copied material
let picker = null;
let exportPart = 'Body';
let altHelmet = false;
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
const sl = (attr, path, label, min, max, step, value, text = fixed(value), disabled = false) => {
  const id = `${attr}-${path.replace(/\W/g, '-')}`;
  return `<div class="sl"><label for="${id}">${label}</label><input class="range" type="range" id="${id}" data-${attr}="${path}" min="${min}" max="${max}" step="${step}" value="${value}" style="--p:${((value - min) / (max - min)) * 100}%" ${disabled ? 'disabled' : ''}><span class="v" id="v-${id}">${text}</span></div>`;
};
const tg = (attr, path, label, small, checked, disabled = false) => `<label class="tg"><span>${label}${small ? `<small>${small}</small>` : ''}</span><input class="sw" type="checkbox" role="switch" data-${attr}="${path}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label>`;
const sel = (attr, path, options, value, label = '') => `<label class="row-sel">${label ? `<span>${label}</span>` : ''}<select class="inp" data-${attr}="${path}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const col = (attr, path, label, value) => `<div class="sl"><label>${label}</label><input class="tint" type="color" data-${attr}="${path}" value="${esc(value || '#000000')}"><span class="v">${esc(value || '')}</span></div>`;
const TEXT = { azimuth: (v) => `${Math.round(v)}°`, elevation: (v) => `${Math.round(v)}°`, rotation: (v) => `${Math.round(v)}°`, ior: (v) => fixed(v, 2), exposure: (v) => `${fixed(v, 2)} EV` };
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
  const inferNote = paint.inference ? `Last run: ${paint.inference.source === 'vision' ? 'vision model' : 'built-in rules'}${paint.inference.note ? ` · ${esc(paint.inference.note)}` : ''}` : hasPhoto ? 'Reads the source photo, labels its regions and assigns PBR presets to the pieces.' : 'No source photo: inference needs the photo the model was made from.';
  const slotOptions = [['', 'Untinted'], ...SLOTS.map((s) => [s.id, `${s.label}${s.tint ? ` (${s.tint})` : ''}`])];
  const parts = `
    <div class="grp" id="grp-parts"><h3>${icon('cube', 14)} Parts <span class="fine" style="margin:0 0 0 auto">${list.length} piece${list.length === 1 ? '' : 's'} · click a piece in the view</span></h3>
      ${list.length ? `<div class="parts">${list.map((p) => {
        const r = rec(p.key);
        const region = r.region ? `<span class="badge ${r.region.flagged ? 'warn' : ''}" title="${r.region.user ? 'Set by you' : `Inferred · ${Math.round(r.region.confidence * 100)} %`}">${esc(REGIONS[r.region.label]?.label || r.region.label)}${r.region.flagged ? ' · review' : ''}</span>` : '';
        return `<div class="part ${p.key === selected ? 'on' : ''}" data-piece="${esc(p.key)}">
          <button class="pname" type="button" data-select="${esc(p.key)}" title="${esc(p.key)}">${esc(r.name || p.name)}</button>${region}
          <button class="btn icon xs" type="button" data-rename="${esc(p.key)}" title="Rename" aria-label="Rename ${esc(r.name || p.name)}">✎</button>
          ${sel('piece-section', p.key, [['', 'No section'], ...sections.map((s) => [s.id, s.name])], r.section || '')}
          ${sel('piece-slot', p.key, slotOptions, r.slot || '')}
        </div>`;
      }).join('')}</div>` : '<p class="fine">Load a model to see its pieces.</p>'}
      <details class="sections"><summary>Armor sections</summary>
        ${sections.map((s) => `<div class="secrow"><input class="inp" data-section-name="${esc(s.id)}" value="${esc(s.name)}" aria-label="Section name"><button class="btn icon xs" type="button" data-section-del="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">${icon('close', 12)}</button></div>`).join('')}
        <button class="btn sm ghostbtn" type="button" data-act="section-add">${icon('plus', 12)}<span>Add section</span></button>
      </details>
      <div class="mg-row">
        <button class="btn sm sec" type="button" data-act="infer" ${hasPhoto && studio?.model && !busyText ? '' : 'disabled'}>${icon('search', 14)}<span>${paint.inference ? 'Re-run inference' : 'Infer car materials from photo'}</span></button>
        <button class="btn sm ghostbtn" type="button" data-act="revert" ${paint.inference || Object.values(paint.pieces || {}).some((p) => p.region) ? '' : 'disabled'}>${icon('retry', 14)}<span>Revert to photo texture</span></button>
      </div>
      <p class="fine">${busyText ? esc(busyText) : inferNote}${state.settings?.visionKey === 'none' ? ' · Add an Anthropic key in Settings for the vision model; without it the built-in rules label the photo.' : ''}</p>
    </div>`;

  const piece = selected ? rec(selected) : null;
  const target = colorLevel === 'global' ? 'global' : colorLevel === 'section' ? piece?.section || null : selected;
  const resolved = resolveColors(paint, piece || {});
  const sources = colorSources(paint, piece || {});
  const levelValue = (k) => (colorLevel === 'global' ? { ...DEFAULT_COLORS, ...paint.colors?.global }[k] : colorLevel === 'section' ? paint.colors?.sections?.[piece?.section]?.[k] : piece?.colors?.[k]);
  const color = `
    <div class="grp" id="grp-color"><h3>${icon('scene', 14)} Color</h3>
      <div class="chips seg sm" role="radiogroup" aria-label="Colour level">
        <button class="chip" type="button" role="radio" data-level="global" aria-checked="${colorLevel === 'global'}">Global</button>
        <button class="chip" type="button" role="radio" data-level="section" aria-checked="${colorLevel === 'section'}" ${piece?.section ? '' : 'disabled'} title="${piece?.section ? '' : 'Pick a piece in a section'}">Section</button>
        <button class="chip" type="button" role="radio" data-level="piece" aria-checked="${colorLevel === 'piece'}" ${selected ? '' : 'disabled'} title="${selected ? '' : 'Pick a piece'}">Piece</button>
      </div>
      <div class="swatches">${SLOTS.map((s) => {
        const own = levelValue(s.id) != null;
        const v = colorLevel === 'global' ? levelValue(s.id) : resolved[s.id];
        return `<button class="swatch ${colorKey === s.id ? 'on' : ''}" type="button" data-color-key="${s.id}" title="${s.label}${s.tint ? ` · ${s.tint}` : ''} · ${own ? 'set here' : `inherited from ${sources[s.id]}`}"><i style="background:${v}"></i><span>${s.label}</span><small>${own || colorLevel === 'global' ? v : `← ${sources[s.id]}`}</small></button>`;
      }).join('')}</div>
      ${target ? `<div class="mg-row"><span class="fine">${colorLevel === 'global' ? 'All pieces' : colorLevel === 'section' ? `Section · ${esc(sections.find((s) => s.id === piece.section)?.name || '')}` : `Piece · ${esc(piece?.name || selected)}`} · ${SLOTS.find((s) => s.id === colorKey).label}</span>
        ${colorLevel !== 'global' ? `<button class="btn sm ghostbtn" type="button" data-act="color-reset" ${levelValue(colorKey) != null ? '' : 'disabled'}>Reset to inherited</button>` : ''}</div>
      <div id="picker"></div>` : '<p class="fine">Pick a piece to colour it, or switch to Global.</p>'}
    </div>`;

  const mat = piece ? deserializeMaterial(piece.material) : null;
  const material = `
    <div class="grp" id="grp-material"><h3>${icon('light', 14)} Material ${piece ? `<span class="fine" style="margin-left:auto">${esc(piece.name || selected)}</span>` : ''}</h3>
      ${!piece ? '<p class="fine">Pick a piece in the Parts list or click it in the view.</p>' : `
      <div class="mg-row">${sel('mat-preset', 'preset', [['', piece.material ? 'Custom' : 'Original (as imported)'], ...Object.entries(MATERIAL_PRESETS).map(([k, p]) => [k, p.label])], mat.preset || '')}
        <button class="btn sm ghostbtn" type="button" data-act="mat-copy" ${piece.material ? '' : 'disabled'}>Copy</button>
        <button class="btn sm ghostbtn" type="button" data-act="mat-paste" ${clipboard ? '' : 'disabled'}>Paste</button>
        <button class="btn sm ghostbtn" type="button" data-act="mat-clear" ${piece.material ? '' : 'disabled'}>Clear</button></div>
      ${piece.region ? `<div class="mg-row">${sel('piece-region', selected, Object.entries(REGIONS).map(([k, r]) => [k, r.label]), piece.region.label, 'Region')}<span class="fine">${piece.region.user ? 'set by you' : `${Math.round(piece.region.confidence * 100)} % sure${piece.region.flagged ? ' · please review' : ''}`}</span></div>` : ''}
      <div class="sl"><label>Base colour</label><input class="tint" type="color" data-mat="color" value="${esc(mat.color || resolved[piece.slot] || '#808080')}"><button class="btn icon xs" type="button" data-act="mat-color-clear" title="Use the slot colour / texture" ${mat.color ? '' : 'disabled'}>${icon('close', 12)}</button></div>
      ${tg('mat', 'textured', 'Keep texture', 'The imported texture under this material', mat.textured !== false)}
      ${sl('mat', 'metalness', 'Metalness', 0, 1, 0.01, mat.metalness)}${sl('mat', 'roughness', 'Roughness', 0, 1, 0.01, mat.roughness)}
      ${sl('mat', 'clearcoat', 'Clearcoat', 0, 1, 0.01, mat.clearcoat)}${sl('mat', 'clearcoatRoughness', 'Coat rough.', 0, 1, 0.01, mat.clearcoatRoughness)}
      ${sl('mat', 'sheen', 'Sheen (cloth)', 0, 1, 0.01, mat.sheen)}${sl('mat', 'transmission', 'Transmission', 0, 1, 0.01, mat.transmission)}${sl('mat', 'ior', 'IOR', 1, 2.333, 0.001, mat.ior)}${sl('mat', 'thickness', 'Thickness', 0, 0.5, 0.005, mat.thickness, `${fixed(mat.thickness, 3)} m`)}
      ${col('mat', 'emissive', 'Emissive', mat.emissive)}${sl('mat', 'emissiveIntensity', 'Glow', 0, 10, 0.1, mat.emissiveIntensity)}
      ${sl('mat', 'normalScale', 'Normal strength', 0, 2, 0.01, mat.normalScale)}
      ${textureGroup(mat)}
      <h3 style="margin-top:6px">Subsurface scattering</h3>
      ${sl('mat', 'sss', 'Amount', 0, 1, 0.01, mat.sss)}${sl('mat', 'sssRadius', 'Radius', 0.1, 4, 0.05, mat.sssRadius)}${col('mat', 'sssColor', 'Colour', mat.sssColor)}`}
    </div>`;

  const presets = { ...STUDIO_PRESETS, ...(state.settings?.studioPresets || {}) };
  const current = Object.entries(presets).find(([, l]) => JSON.stringify(l) === JSON.stringify(look))?.[0] || '';
  const lightRow = (k, label) => { const L = look.lights[k]; return `<div class="lightrow"><b>${label}</b>${tg('look', `lights.${k}.on`, 'On', '', L.on)}${sl('look', `lights.${k}.intensity`, 'Intensity', 0, 4, 0.05, L.intensity)}${col('look', `lights.${k}.color`, 'Colour', L.color)}${sl('look', `lights.${k}.azimuth`, 'Azimuth', -180, 180, 1, L.azimuth, TEXT.azimuth(L.azimuth))}${sl('look', `lights.${k}.elevation`, 'Elevation', 1, 89, 1, L.elevation, TEXT.elevation(L.elevation))}</div>`; };
  const sceneGrp = `
    <div class="grp" id="grp-scene"><h3>${icon('scene', 14)} Scene look</h3>
      <div class="mg-row">${sel('act', 'studio-preset', [['', current ? `Preset · ${current}` : 'Custom look'], ...Object.keys(presets).map((n) => [n, n])], current, 'Studio preset')}
        <button class="btn sm ghostbtn" type="button" data-act="preset-save">Save as…</button>${current && !STUDIO_PRESETS[current] ? `<button class="btn sm ghostbtn" type="button" data-act="preset-del" data-name="${esc(current)}">Delete</button>` : ''}</div>
      <div class="presetsave" id="presetSave" hidden><input class="inp" id="presetName" placeholder="Preset name" maxlength="60"><button class="btn sm pri" type="button" data-act="preset-save-ok">Save</button></div>
      <h3>Background</h3>
      <div class="chips" role="radiogroup" aria-label="Background">${Object.entries(BACKGROUND_KINDS).map(([k, l]) => `<button class="chip" type="button" role="radio" data-bg="${k}" aria-checked="${look.background.kind === k}">${l}</button>`).join('')}</div>
      ${look.background.kind === 'solid' ? col('look', 'background.color', 'Colour', look.background.color) : ''}
      ${look.background.kind === 'gradient' ? `${col('look', 'background.color', 'Top', look.background.color)}${col('look', 'background.color2', 'Bottom', look.background.color2)}` : ''}
      ${look.background.kind === 'image' ? `<div class="mg-row"><button class="btn sm ghostbtn" type="button" data-act="bg-image">${icon('upload', 14)}<span>${look.background.image ? 'Replace image' : 'Import image (PNG, JPG, WebP)'}</span></button><span class="fine">${esc(look.background.image || '')}</span></div>` : ''}
      <h3>HDRI environment</h3>
      <div class="mg-row">${sel('look', 'hdri.file', [['', 'None (scene lighting)'], ...Object.entries(HDRIS).map(([k, h]) => [`builtin:${k}`, `${h.label} · ${h.note}`]), ...(look.hdri.file && !look.hdri.file.startsWith('builtin:') ? [[look.hdri.file, look.hdri.file]] : [])], look.hdri.file || '')}
        <button class="btn sm ghostbtn" type="button" data-act="hdri-import">${icon('upload', 14)}<span>Import .hdr / .exr</span></button></div>
      ${look.hdri.file ? `${sl('look', 'hdri.rotation', 'Rotation', 0, 360, 1, look.hdri.rotation, TEXT.rotation(look.hdri.rotation))}${sl('look', 'hdri.intensity', 'Intensity', 0, 4, 0.05, look.hdri.intensity)}${tg('look', 'hdri.background', 'Show as background', '', look.hdri.background)}${look.hdri.background ? sl('look', 'hdri.blur', 'Blur', 0, 1, 0.01, look.hdri.blur) : ''}` : ''}
      <h3>Lighting</h3>
      ${sel('act', 'light-preset', Object.entries(LIGHT_PRESETS).map(([k, p]) => [k, p.label]), look.lights.preset, 'Preset')}
      ${look.lights.preset === 'match' ? '<p class="fine">Key, fill and rim follow the scene (and the Render step rig), as always.</p>' : `${lightRow('key', 'Key')}${lightRow('fill', 'Fill')}${lightRow('rim', 'Rim')}
        ${tg('look', 'lights.shadows', 'Shadows', '', look.lights.shadows)}${sl('look', 'lights.softness', 'Softness', 0, 1, 0.01, look.lights.softness)}`}
      <h3>Render</h3>
      ${sel('look', 'quality', Object.entries(QUALITIES), look.quality, 'Quality')}
      ${sel('look', 'tone', Object.entries(TONE_MAPPINGS), look.tone, 'Tone mapping')}${sl('look', 'exposure', 'Exposure', 0.25, 3, 0.01, look.exposure, TEXT.exposure(look.exposure))}
      ${tg('look', 'ao.on', 'Ambient occlusion', look.quality === 'low' ? 'Off on Low quality' : look.quality === 'medium' ? 'SSAO on Medium, GTAO on High' : 'GTAO', look.ao.on)}${look.ao.on ? sl('look', 'ao.strength', 'AO strength', 0, 2, 0.05, look.ao.strength) : ''}
      ${tg('look', 'bloom.on', 'Bloom', 'Glow from emissive pieces', look.bloom.on)}${look.bloom.on ? sl('look', 'bloom.strength', 'Bloom', 0, 2, 0.05, look.bloom.strength) : ''}
      ${sel('look', 'aa', [['msaa', 'MSAA (renderer)'], ['fxaa', 'FXAA'], ['smaa', 'SMAA']], look.aa, 'Anti-aliasing')}
      ${tg('look', 'ssr.on', 'Screen-space reflections', 'Realtime reflections · High quality', look.ssr.on)}${look.ssr.on ? sl('look', 'ssr.strength', 'SSR strength', 0, 1, 0.01, look.ssr.strength) : ''}
      ${tg('look', 'pathTraced', 'Path traced preview', `Progressive, stops while you interact · needs Quality: Path traced${studio?.tracing ? ` · ${studio.samples} samples` : ''}`, look.pathTraced)}
      ${sel('look', 'finalEngine', [['cycles', 'Cycles (path traced: reflections, SSS, HDRI)'], ['eevee', 'Eevee (fast)']], look.finalEngine, 'Blender final')}
    </div>`;

  const outDir = state.settings?.outputRoot ? `${state.settings.outputRoot}${state.settings.platform === 'win32' ? '\\' : '/'}${m.slug}` : '';
  const exportGrp = `
    <div class="grp" id="grp-export"><h3>${icon('download', 14)} Export</h3>
      <div class="mg-row">${sel('act', 'export-part', PARTS.map((p) => [p, p]), exportPart, 'Part')}${tg('act', 'alt-helmet', 'Alt helmet', '2048 × 1024 maps', altHelmet)}</div>
      <div class="mg-row">
        <button class="btn sm sec" type="button" data-act="export-tenno" ${studio?.model && outDir && !busyText ? '' : 'disabled'}>${icon('image', 14)}<span>TennoGen texture set</span></button>
        <button class="btn sm sec" type="button" data-act="export-glb" ${studio?.model && outDir && !busyText ? '' : 'disabled'}>${icon('cube', 14)}<span>GLB with named materials</span></button>
      </div>
      <p class="fine">${outDir ? `${esc(exportPart)}_d/_e/_n/_r/_s/_t.png (2048², tint and emissive 1024²) go to <code>${esc(outDir)}${state.settings.platform === 'win32' ? '\\' : '/'}tennogen</code>; the GLB to <code>models</code>.` : 'Choose an output folder on the Render step first.'}</p>
      ${lastCompare ? `<div class="checklist" role="group" aria-label="TennoGen compare"><p class="fine"><b>${lastCompare.pass ? 'Ready to submit' : 'Fix before submitting'}</b> · checked against the TennoGen template set</p><ul>${lastCompare.checks.map((c) => `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? 'Pass' : 'Fail'}: ${esc(c.label)}${!c.pass && c.got != null ? ` (got ${esc(String(c.got))})` : ''}</li>`).join('')}</ul></div>` : ''}
      ${lastWarnings.length ? `<ul class="warnlist">${lastWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
  return parts + color + material + sceneGrp + exportGrp;
}

// After the inspector HTML is in place: mount the picker.
export function afterRender() {
  const box = $('#picker', ctx.root);
  if (!box) { picker = null; return; }
  const paint = paintOf();
  const piece = selected ? rec(selected) : {};
  const value = colorLevel === 'global' ? { ...DEFAULT_COLORS, ...paint.colors?.global }[colorKey] : resolveColors(paint, piece)[colorKey];
  picker = new ColorPicker(box, { value, recent: paint.recent || [], onPick: (hex) => applyColor(hex) });
}

let colorTimer;
function applyColor(hex) {
  const piece = selected ? rec(selected) : null;
  const level = colorLevel === 'global' ? 'global' : colorLevel === 'section' ? piece?.section : selected;
  if (!level) return;
  let paint = paintOf();
  if (level !== 'global' && colorLevel === 'piece' && !paint.pieces[selected]) paint = upsertPiece(paint, selected, { name: pieces().find((p) => p.key === selected)?.name });
  paint = setColor(paint, level, colorKey, hex);
  clearTimeout(colorTimer);
  colorTimer = setTimeout(() => { ctx.change({ paint: recentColor(paintOf(), hex) }, { inspector: false }); picker?.setRecent(paintOf().recent); }, 600);
  ctx.change({ paint }, { inspector: false });
  // Live swatch update without a full redraw.
  const sw = $(`[data-color-key="${colorKey}"] i`, ctx.root);
  if (sw) sw.style.background = hex;
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
  if (t.dataset.rename) {
    const key = t.dataset.rename;
    const row = t.closest('.part');
    const name = rec(key).name || pieces().find((p) => p.key === key)?.name || '';
    row.querySelector('.pname').outerHTML = `<input class="inp pname-edit" data-rename-input="${esc(key)}" value="${esc(name)}" aria-label="Piece name">`;
    row.querySelector('.pname-edit').focus();
    return true;
  }
  if (t.dataset.texture) { applyTexture(selected, t.dataset.texture); return true; }
  if (act === 'tex-clear') { updateMaterial({ texture: null }); return true; }
  if (act === 'tex-import') { $('#texFile', ctx.root)?.click(); return true; }
  if (act === 'tex-sync') {
    try { textures = await send(`/api/textures/sync?workspace=${encodeURIComponent(texWs())}`, 'POST', {}); } catch (e) { toast(e.message); }
    ctx.renderInspector();
    setTimeout(() => loadTextures(true), 1000);
    return true;
  }
  if (t.dataset.level) { colorLevel = t.dataset.level; ctx.renderInspector(); return true; }
  if (t.dataset.colorKey) { colorKey = t.dataset.colorKey; ctx.renderInspector(); return true; }
  if (t.dataset.bg) { ctx.change({ look: setPath(lookOf(), 'background.kind', t.dataset.bg) }); return true; }
  if (act === 'color-reset') {
    const piece = rec(selected);
    const level = colorLevel === 'section' ? piece.section : selected;
    ctx.change({ paint: setColor(paintOf(), level, colorKey, null) });
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
  if (t.dataset.pieceSlot !== undefined) { updatePiece(t.dataset.pieceSlot, { slot: t.value || null }); return true; }
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
  if (act === 'export-part') { exportPart = t.value; ctx.renderInspector(); return true; }
  if (act === 'alt-helmet') { altHelmet = t.checked; return true; }
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
  busyText = 'Reading the photo and projecting it onto the model…';
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
    toast(`Inference failed: ${e.message}`);
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
  return compareSet(info, { part: exportPart, altHelmet });
}

async function runExport(glb) {
  const studio = ctx.studio();
  const m = ctx.model();
  if (!studio?.model) return;
  if (!state.settings?.outputRoot) return toast('Choose an output folder on the Render step first');
  busyText = glb ? 'Writing the GLB…' : 'Baking the TennoGen texture set…';
  ctx.renderInspector();
  try {
    const started = await send(`/api/renders/${m.id}/start`, 'POST', { looks: [], formats: [] });
    const put = async (rel, blob) => {
      const r = await fetch(`/api/renders/${m.id}/file?path=${encodeURIComponent(rel)}`, { method: 'PUT', body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Could not write ${rel}`);
    };
    if (glb) {
      await put(`models/${m.slug}-tennogen.glb`, await exportGlb(studio.model, paintOf()));
      lastWarnings = [];
      toast(`GLB saved to ${started.outDir}`, 'info');
    } else {
      const { files, warnings } = await exportTennoGen(studio.model, paintOf(), { part: exportPart, altHelmet });
      for (const f of files) await put(`tennogen/${f.name}`, f.blob);
      lastWarnings = warnings;
      lastCompare = await compareFiles(files).catch(() => null);
      toast(`${files.length} textures saved to ${started.outDir}${warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? 's' : ''}` : ''}`, warnings.length ? 'error' : 'info');
    }
    if (native && started.outDir) native.openPath(started.outDir).catch(() => {});
  } catch (e) { toast(e.message); }
  busyText = '';
  ctx.renderInspector();
}
