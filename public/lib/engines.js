// The two providers, their engines and every option the Generate setup screen offers. Shared by the setup screen,
// the server (it normalises what the page sends and builds the request bodies from it) and the tests.
// Prices are in pricing.js. 3D AI Studio options are exactly the documented ones (design/api-controls-v2).
import { TRIPO_DIRECT as TD, THREE_D_AI as AI } from './pricing.js';

export const PROVIDERS = {
  tripo: {
    name: 'Tripo', sub: 'direct', host: 'openapi.tripo3d.ai', env: 'TRIPO_API_KEY',
    keyUrl: 'https://developers.tripo3d.com/en/keys', keyHint: 'tsk_…',
  },
  '3daistudio': {
    name: '3D AI Studio', sub: '6 engines', host: 'api.3daistudio.com', env: 'THREE_D_AI_STUDIO_KEY',
    keyUrl: 'https://www.3daistudio.com/Platform/API/Documentation', keyHint: '',
  },
};
export const VIEWS = ['front', 'left', 'back', 'right'];
export const GROUPS = ['quality', 'input', 'mesh', 'seeds', 'output'];
export const groupName = (group, provider) => (group === 'quality' ? (provider === 'tripo' ? 'Model & quality' : 'Engine & quality')
  : { input: 'Input', mesh: 'Mesh', seeds: 'Seeds', output: 'Output' }[group]);

export const TRIPO_MODELS = ['v3.1-20260211', 'v3.0-20250812'];
const MAX_SEED = 2 ** 31 - 1;
const n = (x) => Math.round(x).toLocaleString('en-US');
const textured = (o) => o.texture !== 'none';
const plus = (credits) => (credits ? ` +${credits}` : '');

// Option specs. type: seg | select | toggle | slider | seed. values: [value, label, extra credits?, show?].
// show(o, c) hides an option (o = the options resolved so far, c = { mode, engine }); a hidden option is never sent.
// off(o) disables one and says why (shown as its info tooltip). brief(v, o) is its part of the group's one-line summary.
const TEXTURE = {
  key: 'texture', group: 'quality', label: 'Texture', type: 'seg', default: 'pbr',
  values: [['none', 'None'], ['color', 'Color'], ['pbr', 'PBR']],
  brief: (v) => ({ none: 'no texture', color: 'color texture', pbr: 'PBR' })[v],
};
const ALIGNMENT = {
  key: 'texture_alignment', group: 'quality', label: 'Alignment', type: 'seg', default: 'original_image', show: textured,
  values: [['original_image', 'Match photo'], ['geometry', 'Match shape']], brief: (v) => (v === 'geometry' ? 'texture matches shape' : ''),
};
const AUTOFIX = {
  key: 'enable_image_autofix', group: 'input', label: 'Fix the photo first', type: 'toggle', default: false,
  show: (o, c) => c.mode === 'single', brief: (v) => `autofix ${v ? 'on' : 'off'}`,
};
// Tripo face limits: 500–1.5M (3.0: 1M), 2M with detailed geometry, 150k with quad, 20k with smart low poly.
const tripoFaces = (top) => ({
  key: 'face_limit', group: 'mesh', label: 'Face limit', type: 'slider', default: null, auto: 'Adaptive', log: true,
  range: (o) => [500, o.smart_low_poly ? 20000 : o.quad ? 150000 : o.geometry_quality === 'detailed' ? 2000000 : top],
  brief: (v) => (v == null ? 'adaptive faces' : `${n(v)} faces`), format: n,
});
const SIZE = { key: 'auto_size', group: 'mesh', label: 'Real-world size', type: 'toggle', default: false, brief: (v) => (v ? 'real-world size' : '') };
const seed = (key, label, show) => ({ key, group: 'seeds', label, type: 'seed', default: null, show, brief: (v) => (v == null ? '' : `${label.toLowerCase()} ${v}`) });

function tripoOptions(direct, version) {
  const p = direct ? TD : AI.tripo;
  const fastOk = (o) => (direct ? o.texture_model === '3.5' : version === '3.2');
  return [
    direct && {
      key: 'model', group: 'quality', label: 'Model', type: 'select', default: TRIPO_MODELS[0], free: /^v\d[\w.-]{0,62}$/,
      values: TRIPO_MODELS.map((m) => [m, m]), brief: (v) => v.split('-')[0],
    },
    {
      key: 'geometry_quality', group: 'quality', label: 'Geometry', type: 'seg', default: 'standard',
      values: [['standard', 'Standard'], ['detailed', direct ? 'Ultra' : 'Detailed', direct ? p.ultra : p.detailedGeometry]],
      brief: (v) => (v === 'detailed' ? (direct ? 'Ultra geometry' : 'detailed geometry') : 'standard geometry'),
    },
    TEXTURE,
    {
      key: 'texture_quality', group: 'quality', label: 'Texture quality', type: 'seg', default: 'standard', show: textured,
      info: direct ? 'A <b>Fast</b> tier and <b>Remove baked lighting</b> appear when Texture model is set to v3.5.'
        : version === '3.2' ? '' : 'The <b>Fast</b> tier and <b>Remove baked lighting</b> are Tripo 3.2 only.',
      values: direct
        ? [['fast', 'Fast', 0, fastOk], ['standard', 'Standard'], ['detailed', 'HD', p.hd], ['extreme', '8K', p.eightK]]
        : [['fast', 'Fast', 0, fastOk], ['standard', 'Standard'], ['detailed', 'Detailed', p.texture.detailed - p.texture.standard],
          ['extreme', 'Extreme', p.texture.extreme - p.texture.standard]],
      brief: (v) => (direct ? { fast: 'fast texture', standard: 'standard texture', detailed: 'HD', extreme: '8K' } : { fast: 'fast texture', standard: 'standard texture', detailed: 'detailed texture', extreme: 'extreme texture' })[v],
    },
    direct && {
      key: 'texture_model', group: 'quality', label: 'Texture model', type: 'select', default: 'auto', show: textured,
      values: [['auto', 'Auto · v3.0-20250812'], ['3.5', 'v3.5']], brief: (v) => (v === '3.5' ? 'texture v3.5' : ''),
    },
    {
      key: 'lighting_removal', group: 'quality', label: 'Remove baked lighting', type: 'toggle', default: true,
      show: (o) => textured(o) && fastOk(o), brief: () => '',
    },
    ALIGNMENT,
    AUTOFIX,
    tripoFaces(version === '3.0' ? 1000000 : 1500000),
    {
      key: 'quad', group: 'mesh', label: 'Quad mesh', type: 'toggle', default: false, plus: p.quad,
      off: (o) => o.generate_parts && 'Not with Parts.', brief: (v) => (v ? 'quads' : ''),
    },
    { key: 'smart_low_poly', group: 'mesh', label: 'Smart low poly', type: 'toggle', default: false, plus: p.smartLowPoly, brief: (v) => (v ? 'smart low poly' : '') },
    {
      key: 'generate_parts', group: 'mesh', label: 'Parts', type: 'toggle', default: false, plus: p.parts,
      off: (o) => (textured(o) ? 'Parts needs Texture set to None.' : o.quad && 'Not with Quad mesh.'), brief: (v) => (v ? 'parts' : ''),
    },
    SIZE,
    !direct && { key: 'export_uv', group: 'mesh', label: 'UV coordinates', type: 'toggle', default: true, brief: (v) => (v ? '' : 'no UVs') },
    direct && seed('model_seed', 'Model seed'),
    seed('texture_seed', 'Texture seed', textured),
    !direct && { key: 'compress', group: 'output', label: 'Compress geometry', type: 'toggle', default: false, brief: (v) => (v ? 'compressed' : '') },
  ].filter(Boolean);
}

const engineRow = { key: 'engine', group: 'quality', label: 'Engine', type: 'engine' }; // drawn by the screen, not an option

export const ENGINES = {
  'tripo-direct': { provider: 'tripo', label: 'Tripo', views: false, options: tripoOptions(true) },
  'tripo-3.2': { provider: '3daistudio', label: 'Tripo 3.2', views: true, version: '3.2', options: tripoOptions(false, '3.2') },
  'tripo-3.1': { provider: '3daistudio', label: 'Tripo 3.1', views: true, version: '3.1', options: tripoOptions(false, '3.1') },
  'tripo-3.0': { provider: '3daistudio', label: 'Tripo 3.0', views: true, version: '3.0', options: tripoOptions(false, '3.0') },
  'hunyuan-pro': {
    provider: '3daistudio', label: 'Hunyuan 3D Pro', views: true, viewsPlus: AI.hunyuanPro.multiview,
    options: [
      { key: 'model', group: 'quality', label: 'Model', type: 'seg', default: '3.1', values: [['3.0', '3.0'], ['3.1', '3.1']], brief: (v) => `Hunyuan ${v}` },
      {
        key: 'generate_type', group: 'quality', label: 'Output', type: 'seg', default: 'Normal', info: 'Low poly is not available on model 3.1.',
        values: [['Normal', 'Textured'], ['LowPoly', 'Low poly', 0, (o) => o.model === '3.0'], ['Geometry', 'Geometry']],
        brief: (v) => ({ Normal: 'textured', LowPoly: 'low poly', Geometry: 'geometry only' })[v],
      },
      { key: 'enable_pbr', group: 'quality', label: 'PBR materials', type: 'toggle', default: false, plus: AI.hunyuanPro.pbr, show: (o) => o.generate_type !== 'Geometry', brief: (v) => (v ? 'PBR' : '') },
      {
        key: 'polygon_type', group: 'quality', label: 'Polygons', type: 'seg', default: 'triangle', show: (o) => o.generate_type === 'LowPoly',
        values: [['triangle', 'Triangles'], ['quadrilateral', 'Quads']], brief: (v) => (v === 'quadrilateral' ? 'quads' : ''),
      },
      { key: 'face_count', group: 'mesh', label: 'Face count', type: 'slider', default: 500000, log: true, range: () => [40000, 1500000], format: n, brief: (v) => `${n(v)} faces` },
    ],
  },
  trellis2: {
    provider: '3daistudio', label: 'TRELLIS.2', views: false,
    options: [
      { key: 'resolution', group: 'quality', label: 'Resolution', type: 'seg', default: '1024', values: [['512', '512'], ['1024', '1024'], ['1536', '1536']], brief: (v) => v },
      { key: 'textures', group: 'quality', label: 'Textures', type: 'toggle', default: false, brief: (v) => (v ? 'textured' : 'geometry only') },
      {
        key: 'texture_size', group: 'quality', label: 'Texture size', type: 'seg', default: 2048, show: (o) => o.textures,
        values: [[1024, '1024'], [2048, '2048'], [4096, '4096']], brief: (v) => `${v} px`,
      },
      { key: 'steps', group: 'quality', label: 'Steps', type: 'slider', default: 12, range: () => [1, 50], step: 1, format: String, brief: (v) => (v === 12 ? '' : `${v} steps`) },
      { key: 'decimation_target', group: 'mesh', label: 'Decimation target', type: 'slider', default: 1000000, log: true, range: () => [1000, 16000000], format: n, brief: (v) => `${n(v)} faces` },
      seed('seed', 'Seed'),
      { key: 'generate_thumbnail', group: 'output', label: 'Thumbnail', type: 'toggle', default: false, plus: AI.trellis2.thumbnail, brief: (v) => (v ? 'thumbnail' : '') },
    ],
  },
  hitem3d: {
    provider: '3daistudio', label: 'Hitem3D 3.0', views: true,
    options: [
      {
        key: 'resolution', group: 'quality', label: 'Resolution', type: 'seg', default: '2048quality',
        values: [['2048quality', '2048 quality'], ['2048master', '2048 master']],
        info: `Quality: ${AI.hitem3d['2048quality'].geometry} credits, ${AI.hitem3d['2048quality'].textured} textured, about 2 minutes. Master: ${AI.hitem3d['2048master'].geometry}, or ${AI.hitem3d['2048master'].textured} textured, up to 20 minutes.`,
        brief: (v) => (v === '2048master' ? '2048 master' : '2048 quality'),
      },
      TEXTURE,
      { key: 'shading', group: 'quality', label: 'Remove lighting', type: 'slider', default: 0.5, range: () => [0, 1], step: 0.1, format: (v) => v.toFixed(1), show: textured, brief: () => '' },
      {
        key: 'face_limit', group: 'quality', label: 'Face limit', type: 'slider', default: 2000000, log: true, range: () => [100000, 5000000], format: n,
        info: 'Recommended: 2,000,000 for 2048 quality, 5,000,000 for 2048 master.', brief: () => '',
      },
    ],
  },
};
for (const e of Object.values(ENGINES)) if (e.provider === '3daistudio') e.options.unshift(engineRow);

export const engineList = (provider) => Object.entries(ENGINES).filter(([, e]) => e.provider === provider).map(([id]) => id);
export const optionSpecs = (engine) => ENGINES[engine].options.filter((s) => s.type !== 'engine');
const valuesOf = (spec, o) => spec.values.filter(([, , , show]) => !show || show(o));

// One-click starting points. Each is completed with the engine's defaults; prices come from pricing.js.
export const PRESETS = {
  tripo: [
    { id: 'fast', name: 'Fast draft', desc: 'Quick look, fast texture', engine: 'tripo-direct', options: { texture: 'color', texture_model: '3.5', texture_quality: 'fast' } },
    { id: 'balanced', name: 'Balanced', desc: 'PBR · HD texture', engine: 'tripo-direct', options: { texture: 'pbr', texture_quality: 'detailed' } },
    { id: 'max', name: 'Max quality', desc: 'Ultra geometry · 8K', engine: 'tripo-direct', options: { geometry_quality: 'detailed', texture: 'pbr', texture_quality: 'extreme' } },
  ],
  '3daistudio': [
    { id: 'draft', name: 'Draft', desc: 'TRELLIS.2 · 1024 · textured', engine: 'trellis2', options: { resolution: '1024', textures: true, texture_size: 2048 } },
    { id: 'balanced', name: 'Balanced', desc: 'Tripo 3.2 · PBR', engine: 'tripo-3.2', options: { texture: 'pbr', texture_quality: 'standard' } },
    { id: 'max', name: 'Max quality', desc: 'Hitem3D · 2048 quality', engine: 'hitem3d', options: { resolution: '2048quality', texture: 'pbr' } },
  ],
};

function clean(spec, v, o) {
  if (spec.type === 'toggle') return typeof v === 'boolean' ? v : spec.default;
  if (spec.type === 'seed') return Number.isInteger(v) && v >= 0 && v <= MAX_SEED ? v : null;
  if (spec.type === 'slider') {
    if (v == null && spec.auto) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) return spec.default;
    const [min, max] = spec.range(o);
    const step = spec.step || 1;
    const decimals = (String(step).split('.')[1] || '').length;
    return Math.min(max, Math.max(min, Number((Math.round(v / step) * step).toFixed(decimals))));
  }
  const values = valuesOf(spec, o);
  if (values.some(([x]) => x === v)) return v;
  if (typeof v === 'string' && spec.free?.test(v)) return v; // a Tripo model version that isn't in the list yet
  return values.some(([x]) => x === spec.default) ? spec.default : values[0][0];
}

/**
 * Completes and repairs a setup: { provider, engine, mode, options } → the same with only the options that apply,
 * each one valid. The page, the server and the price all use the result, so they always agree. Throws on an unknown
 * provider or engine.
 */
export function normalize(input) {
  const e = ENGINES[input?.engine];
  if (!e || e.provider !== input.provider) throw new Error('Unknown provider or engine');
  const mode = input.mode === 'views' && e.views ? 'views' : 'single';
  const given = input.options && typeof input.options === 'object' ? input.options : {};
  const c = { mode, engine: input.engine };
  const specs = optionSpecs(input.engine);
  let o = {};
  for (let pass = 0; pass < 2; pass++) { // twice: an option's choices can depend on one listed after it
    const before = o;
    o = {};
    for (const spec of specs) {
      const seen = { ...before, ...o };
      if (spec.show && !spec.show(seen, c)) continue;
      o[spec.key] = clean(spec, Object.hasOwn(given, spec.key) ? given[spec.key] : spec.default, seen);
    }
  }
  for (const spec of specs) if (spec.key in o && spec.off?.(o)) o[spec.key] = spec.default; // e.g. parts with a texture
  for (const spec of specs) if (spec.type === 'slider' && spec.key in o) o[spec.key] = clean(spec, o[spec.key], o); // quad caps faces
  return { provider: input.provider, engine: input.engine, mode, options: o };
}

export function presetConfig(provider, id, mode = 'single') {
  const p = PRESETS[provider].find((x) => x.id === id) || PRESETS[provider][1];
  return normalize({ provider, engine: p.engine, mode, options: p.options });
}

// The preset a setup equals, or 'custom'.
export function matchPreset(config) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hit = PRESETS[config.provider].find((p) => p.engine === config.engine && same(presetConfig(config.provider, p.id, config.mode).options, config.options));
  return hit?.id || 'custom';
}

// The one-line summary of a collapsed group.
export function summary(config, group) {
  const { engine, mode, options: o } = config;
  const e = ENGINES[engine];
  const parts = optionSpecs(engine).filter((s) => s.group === group && s.key in o).map((s) => s.brief?.(o[s.key], o)).filter(Boolean);
  if (group === 'quality' && e.provider === '3daistudio') parts.unshift(e.label);
  if (group === 'input') {
    const photos = mode === 'views' ? 'Front + up to 3 views' : e.views ? 'Single photo or 2–4 views' : 'Single photo';
    parts.unshift(e.views && mode === 'single' && e.provider === '3daistudio' ? `${photos}${e.viewsPlus ? `, views +${e.viewsPlus}` : ', same price'}` : photos);
  }
  if (group === 'output') parts.unshift(e.provider === '3daistudio' ? 'GLB · kept 24 h, Flatform saves it at once' : 'GLB');
  if (group === 'seeds' && !parts.length) parts.push('Random each run');
  if (group === 'mesh' && !parts.length) parts.push('Engine defaults');
  return parts.join(' · ');
}

// Label of a value, with its surcharge.
export const valueLabel = (spec, [value, label, extra]) => `${label}${plus(extra)}`;
export { valuesOf };

// ---- request bodies ----

/**
 * Tripo direct (POST /v3/generation/image-to-model). input, model, texture and pbr are what v0.3 sent to the live
 * API. The other names mirror Tripo's own task parameters as 3D AI Studio's Tripo proxy documents them; Flatform has
 * no Tripo v3 reference for them, so they are only sent when they differ from Tripo's defaults.
 */
export function tripoDirectBody(o, input) {
  const t = textured(o);
  const body = { input, model: o.model, texture: t, pbr: o.texture === 'pbr' };
  const set = (k, v, skip) => { if (v !== undefined && v !== null && v !== skip) body[k] = v; };
  set('geometry_quality', o.geometry_quality, 'standard');
  if (t) {
    set('texture_quality', o.texture_quality, 'standard');
    if (o.texture_model === '3.5') Object.assign(body, { texture_model: '3.5', lighting_removal: o.lighting_removal });
    set('texture_alignment', o.texture_alignment, 'original_image');
    set('texture_seed', o.texture_seed);
  }
  set('enable_image_autofix', o.enable_image_autofix, false);
  set('face_limit', o.face_limit);
  for (const k of ['quad', 'smart_low_poly', 'generate_parts', 'auto_size']) set(k, o[k], false);
  set('model_seed', o.model_seed);
  return body;
}

/**
 * 3D AI Studio: the endpoint and JSON body for a normalised setup. images: { front, left, back, right } as
 * base64 data URIs (single mode uses front only).
 */
export function threeDAIRequest({ engine, mode, options: o }, images) {
  const views = VIEWS.filter((v) => images[v]);
  const multi = mode === 'views';
  const pick = (keys) => Object.fromEntries(keys.filter((k) => k in o && o[k] !== null).map((k) => [k, o[k]]));
  if (engine.startsWith('tripo-')) {
    const t = textured(o);
    return {
      path: `/v1/3d-models/tripo/${multi ? 'multiview-to-3d' : 'image-to-3d'}/${ENGINES[engine].version}/`,
      body: {
        ...(multi ? { images: views.map((v) => ({ image: images[v] })) } : { image: images.front }), // front, left, back, right
        texture: t, pbr: o.texture === 'pbr',
        ...pick(['texture_quality', 'lighting_removal', 'texture_alignment', 'texture_seed', 'geometry_quality', 'face_limit', 'enable_image_autofix', 'export_uv', 'auto_size']),
        ...Object.fromEntries(['quad', 'smart_low_poly', 'generate_parts'].filter((k) => o[k]).map((k) => [k, true])),
        ...(o.compress && { compress: 'geometry' }),
      },
    };
  }
  if (engine === 'hunyuan-pro') {
    return {
      path: '/v1/3d-models/tencent/generate/pro/',
      body: {
        ...(multi ? { multi_view_images: views.map((v) => ({ view_type: v, view_image: images[v] })) } : { image: images.front }),
        ...pick(['model', 'generate_type', 'enable_pbr', 'polygon_type', 'face_count']),
      },
    };
  }
  if (engine === 'trellis2') {
    return {
      path: '/v1/3d-models/trellis2/generate/',
      body: { image: images.front, ...pick(['resolution', 'steps', 'textures', 'texture_size', 'decimation_target', 'seed', 'generate_thumbnail']) },
    };
  }
  if (engine === 'hitem3d') {
    return {
      path: `/v1/3d-models/hitem3d/${multi ? 'multiview-to-3d' : 'image-to-3d'}/`,
      body: {
        ...(multi ? { views: Object.fromEntries(views.map((v) => [v, { image: images[v] }])) } : { image: images.front }),
        resolution: o.resolution, texture: textured(o), pbr: o.texture === 'pbr', ...pick(['shading', 'face_limit']),
      },
    };
  }
  throw new Error(`No request for ${engine}`);
}
