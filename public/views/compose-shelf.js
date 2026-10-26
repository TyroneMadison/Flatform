// Compose, the asset shelf ("Add things" beside Places): people and cars from the Library and the bundled props.
// Drag one onto the 3D view to put it on the floor there, or click it to put it next to the model. What is in the
// scene is listed below, each with Take out. Undo works too: it is part of the scene (scene.extras).
import { $, esc, state, toast, fileUrl, thumbOf, announce } from '../app.js';
import { icon } from '../lib/icons.js';
import { FILTERS, shelfItems, filterItems, placeExtra, besideSpot } from '../lib/shelf.js';

const TYPE = 'application/x-flatform-asset';
let ctx;
let q = '';
let group = 'all';

/** ctx: { root, model(), scene(), studio(), change(next) } */
export function initShelf(c) { ctx = c; q = ''; group = 'all'; }

const items = () => shelfItems(state.models, { exclude: ctx.model().id, fileUrl, thumbOf });
const find = (id) => items().find((i) => i.id === id);

function gridHtml() {
  const list = filterItems(items(), { q, group });
  const none = q ? `Nothing called "${esc(q)}". Try another word.` : group === 'characters' || group === 'cars' ? 'Your other models show up here once you make them.' : 'Nothing here yet.';
  return list.map((i) => `<li><button class="shelf-it" type="button" draggable="true" data-shelf="${esc(i.id)}" title="Drag onto the picture, or click to add">
      <span class="shelf-th">${i.thumb ? `<img src="${esc(i.thumb)}" alt="">` : icon(i.group === 'props' ? 'cube' : i.group === 'cars' ? 'scene' : 'eye', 26)}</span>
      <span class="shelf-name">${esc(i.label)}</span></button></li>`).join('') || `<li class="fine shelf-none">${none}</li>`;
}

export function renderShelf() {
  const placed = ctx.scene().extras || [];
  return `<p class="fine">Drag a thing onto the picture to put it there, or click it to put it next to your model.</p>
    <label class="flabel" for="shelfQ">Search</label>
    <input class="inp" id="shelfQ" type="search" value="${esc(q)}" placeholder="Bench, lamp, car…" autocomplete="off" spellcheck="false">
    <div class="chips seg sm shelf-f" role="radiogroup" aria-label="Show">${Object.entries(FILTERS).map(([k, l]) => `<button class="chip" type="button" role="radio" data-shelf-f="${k}" aria-checked="${group === k}">${l}</button>`).join('')}</div>
    <ul class="shelf-grid" id="shelfGrid" aria-label="Things you can add">${gridHtml()}</ul>
    ${placed.length ? `<h3 class="label">In your scene</h3><ul class="shelf-placed">${placed.map((x) => `<li><span>${esc(x.label)}</span>
      <button class="btn ghostbtn sm" type="button" data-shelf-out="${esc(x.id)}" aria-label="Take out ${esc(x.label)}">Take out</button></li>`).join('')}</ul>` : ''}`;
}

function add(item, at) {
  try {
    ctx.change({ extras: placeExtra(ctx.scene().extras, item, at) });
    announce(`${item.label} added to the scene`);
  } catch (e) { toast(e.message, 'warn'); }
}

export function onShelfClick(e) {
  const f = e.target.closest('[data-shelf-f]');
  if (f) { group = f.dataset.shelfF; ctx.redraw(); return true; }
  const out = e.target.closest('[data-shelf-out]');
  if (out) { ctx.change({ extras: (ctx.scene().extras || []).filter((x) => x.id !== out.dataset.shelfOut) }); return true; }
  const b = e.target.closest('[data-shelf]');
  if (!b) return false;
  const item = find(b.dataset.shelf);
  if (item) add(item, besideSpot((ctx.scene().extras || []).length));
  return true;
}

export function onShelfInput(e) {
  if (e.target.id !== 'shelfQ') return false;
  q = e.target.value;
  $('#shelfGrid', ctx.root).innerHTML = gridHtml(); // the grid only, so the search box keeps its focus
  return true;
}

export function onShelfDragStart(e) {
  const b = e.target.closest?.('[data-shelf]');
  if (!b) return false;
  e.dataTransfer.setData(TYPE, b.dataset.shelf);
  e.dataTransfer.effectAllowed = 'copy';
  ctx.root.querySelector('#vp')?.classList.add('dropping');
  b.addEventListener('dragend', () => ctx.root.querySelector('#vp')?.classList.remove('dropping'), { once: true });
  return true;
}

export const isShelfDrag = (e) => e.dataTransfer?.types.includes(TYPE);

/** A shelf item dropped on the canvas: placed on the floor under the pointer. */
export function onShelfDrop(e, canvas) {
  const item = find(e.dataTransfer.getData(TYPE));
  if (!item) return;
  const r = canvas.getBoundingClientRect();
  const at = ctx.studio()?.floorPoint(e.clientX - r.left, e.clientY - r.top);
  if (!at) return toast('Drop it on the floor in the picture.', 'warn');
  add(item, at);
}
