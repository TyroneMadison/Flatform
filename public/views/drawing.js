// The drawing kit card: photos of the printed Flatform drawing template (Download template) are read in the page
// with lib/drawing-kit.js, then a quick check before any credits are spent: the views found, the sheet, the colors
// and anything to fix. Make my 3D model sends the FRONT plus up to 3 more views as one job; the cover's colors and
// the color map go with the model (scene.drawing) for Part colors. Opened from the Drop screen (Drawing kit) and by
// app.js addFiles when dropped photos are template pages.
import { $, esc, state, go, enqueue, savedSetup, costOf, setupLabel, takePhotos } from '../app.js';
import { icon } from '../lib/icons.js';
import { normalize } from '../lib/engines.js';
import { ROLES } from '../lib/roles.js';
import * as K from '../lib/drawing-kit.js';

export const TEMPLATE_URL = '/template/Flatform-Drawing-Template.pdf';
const VIEW_LABEL = { front: 'Front', back: 'Back', left: 'Left side', right: 'Right side' };
let libs = null, layout = null;
let scans = []; // [{ name, qr?, error?, content?, url? }]
let reading = null; // 'Reading page 2 of 5' while photos are read
let dialog = null;

const script = (src) => new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Could not load the page reader'));
  document.head.append(s);
});
// The marker and QR readers are classic scripts (they set window.AR and window.jsQR), loaded once.
async function load() {
  if (!libs) {
    for (const src of ['cv.js', 'aruco.js', 'dictionaries/aruco_4x4_1000.js']) await script(`/vendor/js-aruco2/src/${src}`);
    await script('/vendor/jsqr/src/jsQR.js');
    libs = { AR: window.AR, jsQR: window.jsQR };
  }
  layout ||= await (await fetch('/template/layout.json')).json();
}
// A photo's pixels, at most maxSide on its long side.
async function pixels(file, maxSide = 4000) {
  const bmp = await createImageBitmap(file);
  const f = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * f), Math.round(bmp.height * f));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return g.getImageData(0, 0, c.width, c.height);
}
const toBlob = (img) => {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c.convertToBlob({ type: 'image/png' });
};

/** True when one of the first few photos shows the template's 4 corner squares (a quick look, no QR). */
export async function hasDrawingPage(photos) {
  await load();
  for (const p of photos.slice(0, 7)) {
    if (p.type === 'image/heic') continue;
    try { if (K.outerCorners(K.findMarkers(await pixels(p.file, 1600), libs.AR)).corners) return true; } catch { /* not readable here */ }
  }
  return false;
}

/** Opens the card, reading `photos` ([{ file, name, type }] from takePhotos) first. No photos: the how-to. */
export async function openDrawing(photos = []) {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'drawDialog';
    dialog.className = 'drawdlg';
    dialog.setAttribute('aria-labelledby', 'drawTitle');
    dialog.innerHTML = `<input type="file" id="drawPick" accept="image/png,image/jpeg" multiple hidden><div id="drawBody"></div>`;
    document.body.append(dialog);
    dialog.addEventListener('click', onClick);
    $('#drawPick', dialog).addEventListener('change', (e) => { const list = takePhotos(e.target.files); e.target.value = ''; if (list.length) addPhotos(list); });
    dialog.addEventListener('close', () => { for (const s of scans) if (s.url) URL.revokeObjectURL(s.url); scans = []; });
  }
  if (!dialog.open) dialog.showModal();
  render();
  if (photos.length) await addPhotos(photos);
}

async function addPhotos(photos) {
  scans = scans.filter((s) => !s.error); // a new try: old errors go
  try { await load(); } catch (e) { reading = null; scans.push({ name: 'The page reader', error: e.message }); return render(); }
  for (const [i, p] of photos.entries()) {
    reading = photos.length > 1 ? `Reading photo ${i + 1} of ${photos.length}…` : 'Reading your photo…';
    render();
    await new Promise((r) => setTimeout(r, 30)); // let the card show the step
    const scan = { name: p.name };
    try {
      if (p.type === 'image/heic') throw new Error('we can not open this photo type here. Save it as JPEG and add it again.');
      const r = K.readPage(await pixels(p.file), layout, libs);
      if (r.error) scan.error = r.error;
      else {
        scan.qr = r.qr;
        scan.content = K.readContent(r.page, r.qr, layout);
        if (scan.content.image) { scan.blob = await toBlob(scan.content.image); scan.url = URL.createObjectURL(scan.blob); delete scan.content.image; }
        if (scan.content.crops) for (const [k, c] of Object.entries(scan.content.crops)) scan.content.crops[k] = c ? await toBlob(c) : null; // kept for colors
        // A new photo of a page replaces the old one.
        for (const old of scans.filter((s) => s.qr && s.qr.sheet === r.qr.sheet && s.qr.page === r.qr.page)) { if (old.url) URL.revokeObjectURL(old.url); scans.splice(scans.indexOf(old), 1); }
      }
    } catch (e) { scan.error = e.message; }
    scans.push(scan);
  }
  reading = null;
  render();
}

// The recipe this sends: the saved one, with all the views when its engine takes them.
function recipe(views) {
  const base = savedSetup();
  try { return normalize({ ...base, mode: views.length > 1 ? 'views' : 'single' }); } catch { return base; }
}
const photoOf = (scan, view, sheet) => ({ id: crypto.randomUUID(), file: new File([scan.blob], `${view}.png`, { type: 'image/png' }), type: 'image/png', name: `Drawing ${sheet}` });
function job(r) {
  const files = Object.fromEntries(r.views.map((v) => [v, photoOf(r.pages[v], v, r.sheet)]));
  const drawing = Object.keys(r.colors).length || r.map ? { sheet: r.sheet, colors: r.colors, ...(r.map && { map: r.map }) } : null;
  return { files, drawing };
}

function onClick(e) {
  const act = e.target.closest('[data-dk]')?.dataset.dk;
  if (!act) return;
  if (act === 'close') dialog.close();
  if (act === 'pick') $('#drawPick', dialog).click();
  if (act === 'make' || act === 'recipe') {
    const r = K.precheck(scans);
    if (r.blocker) return;
    const { files, drawing } = job(r);
    const name = `Drawing ${r.sheet}`;
    if (act === 'make') {
      const setup = recipe(r.views);
      enqueue({ name, setup, files: setup.mode === 'views' ? files : { front: files.front }, ...(drawing && { drawing }) }, true);
      dialog.close();
      go('#/generate');
    } else { // the setup screen with the views in place
      const many = r.views.length > 1;
      state.pending = { photos: many ? [] : [files.front], views: many ? files : {}, modelId: null, mode: many ? 'views' : 'single', setup: null, drawing };
      dialog.close();
      go('#/setup');
    }
  }
}

function render() {
  if (!dialog) return;
  const head = (title, kicker) => `<div class="dk-head"><div><p class="tt">${kicker}</p><h2 id="drawTitle">${title}</h2></div>
    <button class="btn icon ghostbtn dk-x" type="button" data-dk="close" title="Close the drawing kit (Esc)" aria-label="Close">${icon('close', 16)}</button></div>`;
  const download = `<a class="btn ghostbtn" href="${TEMPLATE_URL}" download="Flatform-Drawing-Template.pdf" title="Save the 7 page drawing template (PDF) to print on US Letter paper">${icon('download', 16)}<span>Download template</span></a>`;
  let html;
  if (reading) {
    html = `${head('Reading your drawing', 'Drawing kit')}<div class="dk-reading" role="status"><span class="dk-spin" aria-hidden="true"></span>${esc(reading)}</div>`;
  } else if (!scans.length) {
    html = `${head('Draw it, then add photos', 'Drawing kit')}
      <ol class="dk-steps">
        <li><b>Print the template</b><span>7 pages on US Letter, at 100%.</span></li>
        <li><b>Draw your character</b><span>Only the FRONT page is a must. Back and sides help a lot.</span></li>
        <li><b>Take a photo of each page</b><span>Flat, in good light, with the 4 corner squares in view.</span></li>
      </ol>
      <div class="dk-foot"><button class="btn pri" type="button" data-dk="pick" title="Pick photos of your drawing pages from this computer">${icon('upload', 16)}<span>Add page photos</span></button>${download}</div>`;
  } else {
    const r = K.precheck(scans);
    const setup = recipe(r.views);
    const ok = !r.blocker && !r.warnings.length;
    const banner = r.blocker ? `<div class="dk-banner bad" role="alert">${icon('close', 18)}<div><b>One thing to fix first</b><span>${esc(r.blocker)}</span></div></div>`
      : `<div class="dk-banner ${ok ? 'good' : 'warn'}" role="status">${icon('check', 18)}<div><b>Template found</b><span>${ok ? 'Pages lined up and read. All clear.' : 'Pages lined up and read. A few things to look at.'}</span></div></div>`;
    const slots = K.VIEW_PAGES.map((v) => {
      const s = r.pages[v], used = r.views.includes(v);
      return `<figure class="dk-view ${used ? 'on' : ''}" title="${used ? `${VIEW_LABEL[v]} view found` : v === 'front' ? 'The FRONT page is a must' : `No ${VIEW_LABEL[v].toLowerCase()} view. It is optional.`}">
        ${s?.url ? `<img src="${s.url}" alt="${VIEW_LABEL[v]} drawing">` : `<span class="dk-empty">${icon('image', 22)}</span>`}
        <figcaption>${VIEW_LABEL[v]}<em>${used ? 'Found' : v === 'front' ? 'Needed' : 'Not added'}</em></figcaption></figure>`;
    }).join('');
    const set = ROLES.filter((x) => r.colors[x.id]);
    const colors = set.length ? `<span class="dk-sw">${ROLES.map((x) => `<i style="background:${r.colors[x.id] || 'transparent'}" class="${r.colors[x.id] ? '' : 'none'}" title="${x.label}: ${r.colors[x.id] || 'not set, we will pick one'}"></i>`).join('')}</span>` : '<span class="muted">Not filled in, we will pick</span>';
    const rows = [
      ['Sheet', r.sheet ? `<span class="mono">${esc(r.sheet)}</span>` : '<span class="muted">Not found</span>'],
      ['Views', `${r.views.length} of 4`],
      ['Colors', colors],
      ['Color map', r.map ? '<span class="good">Found. It sets the part colors.</span>' : '<span class="muted">Not added (optional)</span>'],
      ['Close-ups', r.details ? `${r.details} drawn, kept for colors` : '<span class="muted">Not added (optional)</span>'],
    ].map(([k, v]) => `<div class="dk-row"><span>${k}</span><span>${v}</span></div>`).join('');
    const views = setup.mode === 'views' ? r.views.length : 1;
    const note = r.views.length > 1 && setup.mode !== 'views' ? `<p class="fine keep">This recipe reads the front page only. Change the recipe to use all ${r.views.length} views.</p>` : '';
    html = `${head('Check your drawing', 'Drawing kit')}${banner}
      <div class="dk-views">${slots}</div>
      <div class="dk-rows">${rows}</div>
      ${r.warnings.length ? `<ul class="dk-warn">${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <p class="dk-recipe">${esc(setupLabel(setup))} · ${views} view${views > 1 ? 's' : ''} · ${costOf(setup)} credits
        <button class="link" type="button" data-dk="recipe" title="Open the recipe screen with these views, to pick another engine or quality" ${r.blocker ? 'disabled' : ''}>Change recipe</button></p>${note}
      <div class="dk-foot">
        <button class="btn pri" type="button" data-dk="make" title="Send these views as one 3D model job. Nothing is paid for before this." ${r.blocker ? 'disabled' : ''}>Make my 3D model</button>
        <button class="btn ghostbtn" type="button" data-dk="pick" title="Add or retake page photos. A new photo of a page replaces the old one.">Fix photos</button>
        ${download}</div>`;
  }
  $('#drawBody', dialog).innerHTML = html;
}
