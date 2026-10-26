// Render, the Export video panel (standalone, separate from Share): turns a rendered turntable's frames into an MP4
// or WebM in a folder you pick, with resolution, frame rate, length and quality. Encoding is local ffmpeg; nothing
// is uploaded. Also shows the batch variant queue (batch.mjs) with retry and cancel.
import { $, esc, api, send, toast, native } from '../app.js';
import { RESOLUTIONS, FORMATS, QUALITIES } from '../lib/turntable.js';

let root, model, ff = null, queue = null;
const opts = { look: 'studio', format: 'mp4', resolution: '1080p', fps: 30, quality: 'good', seconds: 0, outDir: '' };
const LOOK_LABEL = { showroom: 'Showroom', studio: 'Scene', transparent: 'Transparent' };

export async function mountExport(el, m) {
  root = el; model = m;
  const box = document.createElement('section');
  box.className = 'glass exportvideo';
  box.id = 'exportVideo';
  el.append(box);
  box.addEventListener('click', onClick);
  box.addEventListener('change', onChange);
  draw();
  try { ff = await api('/api/ffmpeg'); } catch { ff = { found: false }; }
  try { queue = await api('/api/batch'); } catch { queue = null; }
  draw();
}

const opt = (k, entries) => `<select class="inp" data-ev="${k}" aria-label="${k}">${entries.map(([v, l]) => `<option value="${esc(v)}" ${String(opts[k]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function draw() {
  const box = $('#exportVideo', root);
  if (!box) return;
  const looks = Object.keys(LOOK_LABEL).filter((l) => model.renders?.[`${l}360`] || model.renders?.[`${l}180`]);
  if (looks.length && !looks.includes(opts.look)) opts.look = looks[0];
  const jobs = queue?.jobs || [];
  box.innerHTML = `<div class="rowhead"><h2 class="label">Export video</h2><span class="sub">Saved on this computer only, never uploaded</span></div>
    ${looks.length ? `<div class="mg-row">${opt('look', looks.map((l) => [l, LOOK_LABEL[l]]))}${opt('format', Object.entries(FORMATS).filter(([k]) => k !== 'png'))}${opt('resolution', Object.keys(RESOLUTIONS).map((k) => [k, k === '4k' ? '4K' : k[0].toUpperCase() + k.slice(1)]))}
      ${opt('fps', [[24, '24 fps'], [30, '30 fps'], [60, '60 fps']])}${opt('quality', Object.keys(QUALITIES).map((k) => [k, k[0].toUpperCase() + k.slice(1)]))}${opt('seconds', [[0, 'Full length'], [3, '3 s'], [5, '5 s'], [10, '10 s']])}</div>
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-ev-act="folder">${opts.outDir ? esc(opts.outDir) : 'Choose folder'}</button>
      <button class="btn sm sec" type="button" data-ev-act="export" ${opts.outDir && ff?.found ? '' : 'disabled'}>Export ${opts.format === 'mp4' ? 'MP4' : 'WebM'}</button></div>
      <p class="fine">${ff == null ? 'Looking for ffmpeg...' : ff.found ? `ffmpeg: ${esc(ff.path)}` : 'ffmpeg not found. Install it or set its path in Settings.'}</p>`
    : '<p class="fine">Render a turntable first, then export it as a video here.</p>'}
    ${jobs.length ? `<div class="rowhead"><h2 class="label">Batch variants</h2><span class="sub">${Object.entries(queue.counts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ')}</span></div>
      <ul class="batchlist">${jobs.map((j) => `<li><span>${esc(j.name)} · ${esc(j.output)}</span><span class="badge ${j.status === 'failed' ? 'warn' : ''}">${esc(j.status)}</span>${j.error ? `<small>${esc(j.error)}</small>` : ''}</li>`).join('')}</ul>
      <div class="mg-row"><button class="btn sm ghostbtn" type="button" data-ev-act="retry" ${queue.counts.failed ? '' : 'disabled'}>Retry failed</button><button class="btn sm ghostbtn" type="button" data-ev-act="cancel" ${queue.counts.queued || queue.counts.running ? '' : 'disabled'}>Cancel all</button><button class="btn sm ghostbtn" type="button" data-ev-act="clear">Clear list</button></div>` : ''}`;
}

async function onClick(e) {
  const t = e.target.closest('button');
  const act = t?.dataset.evAct;
  if (!act) return;
  try {
    if (act === 'folder') {
      if (native) { const dir = await native.pickFolder(); if (dir) opts.outDir = dir; }
      else { const dir = prompt('Folder to save the video in (full path)'); if (dir) opts.outDir = dir.trim(); }
    }
    if (act === 'export') {
      t.disabled = true; t.textContent = 'Encoding...';
      const r = await send('/api/video', 'POST', { modelId: model.id, frames: `frames/${opts.look}`, pattern: `${model.slug}_%03d.png`, name: `${model.slug}_${opts.look}`, outDir: opts.outDir, format: opts.format, resolution: opts.resolution, fps: Number(opts.fps), quality: opts.quality, seconds: Number(opts.seconds) });
      toast(`Saved ${r.output}`, 'info');
      native?.showItemInFolder?.(r.output).catch(() => {});
    }
    if (act === 'retry') queue = await send('/api/batch/retry', 'POST', {});
    if (act === 'cancel') queue = await send('/api/batch/cancel', 'POST', {});
    if (act === 'clear') queue = await send('/api/batch', 'DELETE', {});
  } catch (err) { toast(err.message); }
  draw();
}
function onChange(e) { const k = e.target.dataset.ev; if (k) { opts[k] = e.target.value; draw(); } }
