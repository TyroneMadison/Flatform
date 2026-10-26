// Compose, the "Camera move and sky" group (Sadie half): build a camera move from saved camera spots, preview
// it, save it by name, and turn or switch the sky over the clip. The in-app turntable render follows both.
import { esc, toast, api, send } from '../app.js';
import { EASINGS, normalizePath, pathFromBookmarks, normalizeSky } from '../lib/camera-path.js';
import { HDRIS } from '../lib/look.js';
import { STEP } from '../lib/pipeline.js';

let ctx; // { scene, studio, change, draw, renderInspector }
let presets = { 'camera-paths': null, skies: null };
let playing = 0;
export function initPath(c) { ctx = c; stop(); load('camera-paths'); load('skies'); }
async function load(kind) {
  try { presets[kind] = await api(`/api/presets/${kind}`); } catch { presets[kind] = []; }
  ctx?.renderInspector();
}

export function renderPathGroup() {
  const s = ctx.scene();
  const p = normalizePath(s.cameraPath);
  const sky = normalizeSky(s.sky);
  const marks = s.bookmarks || [];
  const hdris = Object.entries(HDRIS).map(([k, v]) => [`builtin:${k}`, v.label]);
  const pp = presets['camera-paths'] || [], sp = presets.skies || [];
  return `<div class="grp" id="grp-path"><h3>Camera move and sky</h3>
    <h4 class="fine">Camera move</h4>
    ${marks.length < 2 ? '<p class="fine">Save at least two camera spots in Tools. The move goes from spot to spot.</p>'
      : `<button class="btn big ${p.on ? 'sec' : ''}" type="button" data-path="make">${p.on ? 'Rebuild from my spots' : 'Make a move from my spots'}</button>`}
    ${p.on ? `<p class="fine">${p.stops.length} stops: ${p.stops.map((x) => esc(x.name || 'spot')).join(' → ')}</p>
      <div class="chips seg" role="radiogroup" aria-label="How it moves">${Object.entries(EASINGS).map(([k, l]) => `<button class="chip" type="button" role="radio" data-path-ease="${k}" aria-checked="${p.easing === k}">${l}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" data-path-spin ${p.spin ? 'checked' : ''}> <span>Turn the model too</span></label>
      <div class="mg-row"><button class="btn big" type="button" data-path="play">${playing ? 'Stop' : 'Play it'}</button><button class="btn big sec" type="button" data-path="off">Turn off</button></div>
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-path="save">Save this move</button></div>` : ''}
    ${pp.length ? `<div class="chips" role="group" aria-label="Saved moves">${pp.map((x) => `<span class="chipset"><button class="chip" type="button" data-path-load="${esc(x.name)}">${esc(x.name)}</button><button class="chip sm" type="button" data-path-del="${esc(x.name)}" title="Delete">✕</button></span>`).join('')}</div>` : ''}
    <h4 class="fine">Sky</h4>
    <label class="check"><input type="checkbox" data-sky-on ${sky.on ? 'checked' : ''}> <span>Move the sky during the turn</span></label>
    ${sky.on ? `<label class="check"><span>Turn the sky by <b>${sky.spin}°</b></span><input class="inp" type="range" min="-360" max="360" step="15" value="${sky.spin}" data-sky-spin></label>
      <p class="fine">Switch skies (optional). Each one starts at a point in the clip.</p>
      ${sky.playlist.map((e, i) => `<div class="skyrow"><select class="inp" data-sky-file="${i}">${hdris.map(([k, l]) => `<option value="${k}" ${k === e.file ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><input class="inp" type="number" min="0" max="100" step="5" value="${Math.round(e.at * 100)}" data-sky-at="${i}" aria-label="Starts at percent"><span>%</span><button class="chip sm" type="button" data-sky-del="${i}" title="Remove">✕</button></div>`).join('')}
      ${sky.playlist.length < 8 ? '<button class="btn sm ghostbtn" type="button" data-sky="add">Add a sky</button>' : ''}
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-sky="save">Save this sky</button></div>` : ''}
    ${sp.length ? `<div class="chips" role="group" aria-label="Saved skies">${sp.map((x) => `<span class="chipset"><button class="chip" type="button" data-sky-load="${esc(x.name)}">${esc(x.name)}</button><button class="chip sm" type="button" data-sky-del-preset="${esc(x.name)}" title="Delete">✕</button></span>`).join('')}</div>` : ''}
  </div>`;
}

function stop() {
  if (!playing) return;
  cancelAnimationFrame(playing);
  playing = 0;
  const studio = ctx?.studio();
  if (studio) { studio.setFrame(0); studio.applyCamera(); ctx.draw(); }
}
function play() {
  const studio = ctx.studio();
  if (!studio) return;
  const frames = 360 / STEP, t0 = performance.now();
  const tick = async (now) => {
    const i = Math.floor(((now - t0) / 1000) * 24) % frames;
    studio.setFrame(i);
    await studio.applySkyFrame();
    ctx.draw();
    if (playing) playing = requestAnimationFrame(tick);
  };
  playing = requestAnimationFrame(tick);
}
const ask = (msg, def) => (window.prompt(msg, def) || '').trim();
async function savePreset(kind, data) {
  const name = ask('Name it', kind === 'skies' ? 'My sky' : 'My move');
  if (!name) return;
  try { presets[kind] = await send(`/api/presets/${kind}`, 'POST', { name, data }); toast(`Saved ${name}`, 'info'); } catch (e) { toast(e.message, 'error'); }
  ctx.renderInspector();
}
async function delPreset(kind, name) {
  try { presets[kind] = await send(`/api/presets/${kind}`, 'POST', { name, remove: true }); } catch (e) { toast(e.message, 'error'); }
  ctx.renderInspector();
}

export async function onPathClick(t) {
  const s = ctx.scene();
  const d = t.dataset;
  if (d.path === 'make') { await ctx.change({ cameraPath: pathFromBookmarks(s.bookmarks, { easing: s.cameraPath?.easing, spin: s.cameraPath?.spin }) }); return true; }
  if (d.path === 'off') { stop(); await ctx.change({ cameraPath: { ...s.cameraPath, on: false } }); return true; }
  if (d.path === 'play') { if (playing) stop(); else play(); ctx.renderInspector(); return true; }
  if (d.path === 'save') { await savePreset('camera-paths', normalizePath(s.cameraPath)); return true; }
  if (d.pathEase) { await ctx.change({ cameraPath: { ...normalizePath(s.cameraPath), easing: d.pathEase } }); return true; }
  if (d.pathLoad) { const x = (presets['camera-paths'] || []).find((p) => p.name === d.pathLoad); if (x) await ctx.change({ cameraPath: normalizePath({ ...x.data, on: true }) }); return true; }
  if (d.pathDel) { await delPreset('camera-paths', d.pathDel); return true; }
  const sky = normalizeSky(s.sky);
  if (d.sky === 'add') { await ctx.change({ sky: { ...sky, playlist: [...sky.playlist, { file: 'builtin:studio_small_03', at: sky.playlist.length ? 0.5 : 0 }] } }); return true; }
  if (d.sky === 'save') { await savePreset('skies', sky); return true; }
  if (d.skyDel !== undefined) { await ctx.change({ sky: { ...sky, playlist: sky.playlist.filter((_, i) => i !== Number(d.skyDel)) } }); return true; }
  if (d.skyLoad) { const x = (presets.skies || []).find((p) => p.name === d.skyLoad); if (x) await ctx.change({ sky: normalizeSky({ ...x.data, on: true }) }); return true; }
  if (d.skyDelPreset) { await delPreset('skies', d.skyDelPreset); return true; }
  return false;
}
export function onPathChange(t) {
  const s = ctx.scene();
  const sky = normalizeSky(s.sky);
  const d = t.dataset;
  if (d.pathSpin !== undefined) { ctx.change({ cameraPath: { ...normalizePath(s.cameraPath), spin: t.checked } }); return true; }
  if (d.skyOn !== undefined) { ctx.change({ sky: { ...sky, on: t.checked } }); return true; }
  if (d.skySpin !== undefined) { ctx.change({ sky: { ...sky, spin: Number(t.value) } }); return true; }
  if (d.skyFile !== undefined) { const pl = sky.playlist.slice(); pl[Number(d.skyFile)] = { ...pl[Number(d.skyFile)], file: t.value }; ctx.change({ sky: { ...sky, playlist: pl } }); return true; }
  if (d.skyAt !== undefined) { const pl = sky.playlist.slice(); pl[Number(d.skyAt)] = { ...pl[Number(d.skyAt)], at: Number(t.value) / 100 }; ctx.change({ sky: { ...sky, playlist: pl } }); return true; }
  return false;
}
export const stopPath = stop;
