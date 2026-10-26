// Credit prices, exactly as the providers publish them. Used for the cost line on the Generate setup screen and the
// credits stored with each version (3D AI Studio's status reply has no cost), and checked by test/pricing.test.mjs.
// Tripo direct: Tripo's image-to-model price list. 3D AI Studio: its API reference
// (https://www.3daistudio.com/Platform/API/Documentation), read 2026-10-18.

export const TRIPO_DIRECT = { untextured: 20, textured: 30, hd: 10, eightK: 20, ultra: 20, quad: 5, smartLowPoly: 10, parts: 20 };

export const THREE_D_AI = {
  // Tripo 3.0 / 3.1 / 3.2: a base per endpoint, then a surcharge for the texture by texture_quality.
  tripo: { image: 40, multiview: 40, texture: { fast: 20, standard: 20, detailed: 40, extreme: 60 }, detailedGeometry: 40, smartLowPoly: 20, parts: 40, quad: 10 },
  hunyuanPro: { base: 60, pbr: 20, multiview: 20 },
  // TRELLIS.2 by resolution: geometry only, or textured by texture size.
  trellis2: {
    geometry: { 512: 15, 1024: 20, 1536: 25 },
    textured: { 512: { 1024: 25, 2048: 25, 4096: 30 }, 1024: { 1024: 30, 2048: 30, 4096: 40 }, 1536: { 1024: 40, 2048: 40, 4096: 55 } },
    thumbnail: 2,
  },
  // Hitem3D 3.0: PBR, de-shading, face limit and the number of views don't change the price.
  hitem3d: { '2048quality': { geometry: 125, textured: 150 }, '2048master': { geometry: 625, textured: 650 } },
};

// Credits for a normalised setup (engines.js normalize): { credits, lines: [[what, credits], …] }.
export function estimate({ engine, mode, options: o }) {
  const lines = [];
  const add = (what, credits) => { if (credits) lines.push([what, credits]); };
  const textured = o.texture !== undefined && o.texture !== 'none';
  if (engine === 'local-trellis') {
    // Free: runs on the user's own graphics card. Nothing is added, so the total is 0.
  } else if (engine === 'tripo-direct') {
    const p = TRIPO_DIRECT;
    add(textured ? 'Textured model' : 'Untextured model', textured ? p.textured : p.untextured);
    if (textured && o.texture_quality === 'detailed') add('HD texture', p.hd);
    if (textured && o.texture_quality === 'extreme') add('8K texture', p.eightK);
    if (o.geometry_quality === 'detailed') add('Ultra geometry', p.ultra);
    if (o.quad) add('Quad mesh', p.quad);
    if (o.smart_low_poly) add('Smart low poly', p.smartLowPoly);
    if (o.generate_parts) add('Parts', p.parts);
  } else if (/^tripo-3\.\d$/.test(engine)) {
    const p = THREE_D_AI.tripo;
    add(mode === 'views' ? 'Multiview to 3D' : 'Image to 3D', mode === 'views' ? p.multiview : p.image);
    if (textured) add(`Texture (${o.texture_quality})`, p.texture[o.texture_quality]);
    if (o.geometry_quality === 'detailed') add('Detailed geometry', p.detailedGeometry);
    if (o.smart_low_poly) add('Smart low poly', p.smartLowPoly);
    if (o.generate_parts) add('Parts', p.parts);
    if (o.quad) add('Quad mesh', p.quad);
  } else if (engine === 'hunyuan-pro') {
    const p = THREE_D_AI.hunyuanPro;
    add('Hunyuan 3D Pro', p.base);
    if (o.enable_pbr) add('PBR', p.pbr); // never sent with generate_type Geometry
    if (mode === 'views') add('Multi-view', p.multiview);
  } else if (engine === 'trellis2') {
    const p = THREE_D_AI.trellis2;
    add(`TRELLIS.2 ${o.resolution}${o.textures ? ` · ${o.texture_size} texture` : ' · geometry'}`,
      o.textures ? p.textured[o.resolution][o.texture_size] : p.geometry[o.resolution]);
    if (o.generate_thumbnail) add('Thumbnail', p.thumbnail);
  } else if (engine === 'hitem3d') {
    const p = THREE_D_AI.hitem3d[o.resolution];
    add(`Hitem3D ${o.resolution}`, textured ? p.textured : p.geometry);
  } else {
    throw new Error(`No prices for ${engine}`);
  }
  return { credits: lines.reduce((sum, [, credits]) => sum + credits, 0), lines };
}
