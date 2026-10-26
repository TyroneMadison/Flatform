// Compose, the "Lighting studio" group (Sadie half): one-click environments (garage, desert dusk, white
// cyclorama and the studio ones) and a compare strip that shows the current model under each one.
// Swapping only replaces the environment; the stage is not rebuilt (look.js lookNeedsRebuild).
import { esc } from '../app.js';
import { LIGHTING_PRESETS, applyLightingPreset, lightingPresetOf } from '../lib/look.js';
import { Studio } from '../lib/studio.js';

let ctx; // { scene, studio, change, renderInspector, modelUrl }
let thumbs = {}, thumbKey = '', busy = false;
export function initLighting(c) { ctx = c; thumbs = {}; thumbKey = ''; busy = false; }

export function renderLightingGroup() {
  const on = lightingPresetOf(ctx.scene().look);
  return `<div class="grp" id="grp-lighting"><h3>Lighting studio</h3>
    <p class="fine">Pick a place to light your model. One click swaps the light and the background.</p>
    <div class="lightgrid" role="radiogroup" aria-label="Lighting">${Object.entries(LIGHTING_PRESETS).map(([k, p]) => `<button class="lightcard" type="button" role="radio" aria-checked="${on === k}" data-light="${k}">${thumbs[k] ? `<img src="${thumbs[k]}" alt="">` : '<span class="ph"></span>'}<span>${esc(p.label)}</span></button>`).join('')}</div>
    <button class="btn big sec" type="button" data-light-compare ${busy ? 'disabled' : ''}>${busy ? 'Making previews…' : Object.keys(thumbs).length ? 'Update the previews' : 'Show my model in each one'}</button>
  </div>`;
}

// Renders the model under every preset in a small offscreen studio (its own canvas, thrown away after).
async function makeThumbs() {
  const url = ctx.modelUrl();
  if (!url || busy) return;
  busy = true; ctx.renderInspector();
  const canvas = document.createElement('canvas');
  let s;
  try {
    s = new Studio(canvas, { preserveDrawingBuffer: true });
    s.resize(192, 144, 1);
    const scene = ctx.scene();
    await s.setState({ ...scene, look: applyLightingPreset(scene.look, Object.keys(LIGHTING_PRESETS)[0]) });
    await s.load(url);
    for (const k of Object.keys(LIGHTING_PRESETS)) {
      await s.setState({ ...scene, look: applyLightingPreset(scene.look, k) });
      s.render();
      thumbs[k] = canvas.toDataURL('image/jpeg', 0.8);
      ctx.renderInspector();
    }
    thumbKey = url;
  } catch { /* previews are optional; the buttons still work */ } finally {
    try { s?.dispose(); } catch { /* already gone */ }
    busy = false; ctx.renderInspector();
  }
}

export async function onLightingClick(t) {
  if (t.dataset.light) { await ctx.change({ look: applyLightingPreset(ctx.scene().look, t.dataset.light) }); return true; }
  if (t.dataset.lightCompare !== undefined) { makeThumbs(); return true; }
  return false;
}
