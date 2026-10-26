// Compose · Render, the Export video panel (standalone, separate from Share): turns a rendered turntable's frames into an MP4
// or WebM in a folder you pick, with resolution, frame rate, length and quality. Encoding is local ffmpeg; nothing
// is uploaded. Also shows the batch variant queue (batch.mjs) with retry and cancel.
import { $, esc, api, send, toast, native } from '../app.js';
import { RESOLUTIONS, FORMATS, QUALITIES } from '../lib/turntable.js';

let root, model, ff = null, queue = null, track = (_m, _l, fn) => fn();
const opts = { look: 'studio', format: 'mp4', resolution: '1080p', fps: 30, quality: 'good', seconds: 0, outDir: '' };
const LOOK_LABEL = { showroom: 'Showroom', studio: 'My scene', transparent: 'See-through background' };
const TIP = { look: 'Which finished pictures to turn into a video', format: 'MP4 plays almost everywhere. WebM is smaller, for websites.', resolution: 'How big the video is', fps: 'Frames a second. More is smoother.', quality: 'Better looks make a bigger file', seconds: 'How long the video runs' };

export async function mountExport(el, m, h = {}) {
  root = el; model = m;
  if (h.track) track = h.track; // shows the export in the render queue tray
  const box = document.createElement('section');
  box.className = 'exportvideo';
  box.id = 'exportVideo';
  el.append(box);
  box.addEventListener('click', onClick);
  box.addEventListener('change', onChange);
  draw();
  try { ff = await api('/api/ffmpeg'); } catch { ff = { found: false }; }
  try { queue = await api('/api/batch'); } catch { queue = null; }
  draw();
}

const opt = (k, entries) => `<select class="inp" data-ev="${k}" aria-label="${k}" title="${TIP[k]}">${entries.map(([v, l]) => `<option value="${esc(v)}" ${String(opts[k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function draw() {
  const box = $('#exportVideo', root);
  if (!box) return;
  const looks = Object.keys(LOOK_LABEL).filter((l) => model.renders?.[`${l}360`] || model.renders?.[`${l}180`]);
  if (looks.length && !looks.includes(opts.look)) opts.look = looks[0];
  const jobs = queue?.jobs || [];
  box.innerHTML = `<div class="rowhead"><h2 class="label">Make a video</h2><span class="sub">Turns a finished spin into a video. It stays on this computer.</span></div>
    ${looks.length ? `<div class="mg-row">${opt('look', looks.map((l) => [l, LOOK_LABEL[l]]))}${opt('format', Object.entries(FORMATS).filter(([k]) => k !== 'png'))}${opt('resolution', Object.keys(RESOLUTIONS).map((k) => [k, k === '4k' ? '4K' : k[0].toUpperCase() + k.slice(1)]))}
      ${opt('fps', [[24, '24 a second'], [30, '30 a second'], [60, '60 a second']])}${opt('quality', Object.keys(QUALITIES).map((k) => [k, k[0].toUpperCase() + k.slice(1)]))}${opt('seconds', [[0, 'Full length'], [3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds']])}</div>
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-ev-act="folder" title="Pick the folder to save the video in">${opts.outDir ? esc(opts.outDir) : 'Choose folder'}</button>
      <button class="btn sm sec" type="button" data-ev-act="export" title="${opts.outDir ? 'Make the video now' : 'Choose a folder first'}" ${opts.outDir && ff?.found ? '' : 'disabled'}>Export ${opts.format === 'mp4' ? 'MP4' : 'WebM'}</button></div>
      <p class="fine keep">${ff == null ? 'Looking for the video maker (ffmpeg)…' : ff.found ? `Video maker: ${esc(ff.path)}` : 'The video maker (ffmpeg) is missing. Install it, or show where it is in Settings.'}</p>`
    : '<p class="fine keep">First make a full spin or a half spin. Then make a video of it here.</p>'}
    ${jobs.length ? `<div class="rowhead"><h2 class="label">Other versions</h2><span class="sub keep">${Object.entries(queue.counts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ')}</span></div>
      <ul class="batchlist">${jobs.map((j) => `<li><span>${esc(j.name)} · ${esc(j.output)}</span><span class="badge ${j.status === 'failed' ? 'warn' : ''}">${esc(j.status)}</span>${j.error ? `<small>${esc(j.error)}</small>` : ''}</li>`).join('')}</ul>
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-ev-act="retry" title="Try the ones that failed again" ${queue.counts.failed ? '' : 'disabled'}>Retry failed</button><button class="btn sm ghostbtn" type="button" data-ev-act="cancel" title="Stop every version still waiting" ${queue.counts.queued || queue.counts.running ? '' : 'disabled'}>Cancel all</button><button class="btn sm ghostbtn" type="button" data-ev-act="clear" title="Clear this list">Clear list</button></div>` : ''}`;
}

async function onClick(e) {
  const t = e.target.closest('button');
  const act = t?.dataset.evAct;
  if (!act) return;
  try {
    if (act === 'folder') {
      if (native) { const dir = await native.pickFolder(); if (dir) opts.outDir = dir; }
      else { const dir = prompt('Which folder should the video go in? Type the full folder path.'); if (dir) opts.outDir = dir.trim(); }
    }
    if (act === 'export') {
      t.disabled = true; t.textContent = 'Making video…';
      const r = await track(model, `Video · ${LOOK_LABEL[opts.look]} · ${opts.format.toUpperCase()}`, () => send('/api/video', 'POST', { modelId: model.id, frames: `frames/${opts.look}`, pattern: `${model.slug}_%03d.png`, name: `${model.slug}_${opts.look}`, outDir: opts.outDir, format: opts.format, resolution: opts.resolution, fps: Number(opts.fps), quality: opts.quality, seconds: Number(opts.seconds) }));
      toast(`Video saved: ${r.output}`, 'info', native ? [{ label: 'Show in folder', title: 'Show the video on this computer', run: () => native.showItemInFolder(r.output).catch((err) => toast(err.message)) }] : []);
    }
    if (act === 'retry') queue = await send('/api/batch/retry', 'POST', {});
    if (act === 'cancel') queue = await send('/api/batch/cancel', 'POST', {});
    if (act === 'clear') queue = await send('/api/batch', 'DELETE', {});
  } catch (err) { toast(err.message); }
  draw();
}
function onChange(e) { const k = e.target.dataset.ev; if (k) { opts[k] = e.target.value; draw(); } }
