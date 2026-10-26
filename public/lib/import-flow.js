// The shared picture-import flow for the home screens (Warframe home, Car home): drop pictures anywhere on the
// screen (a highlighted overlay appears), or press "Add new picture" for the native file picker. Both paths go
// through the same place: classifyFiles() then app.js addFiles(), which sends photos to the setup screen and 3D
// files straight into Compose. Usage in a screen:
//   const off = attachImportFlow(el, { workspace: 'warframe' }); … export function unmount() { off(); }
import { $, state, addFiles, openPicker, toast } from '../app.js';
import { classifyFiles, dragHasFiles } from './import-rules.js';

// Accepts a list of File objects: the good ones go in, each bad one gets a toast.
export function importFiles(files, { workspace } = {}) {
  if (workspace) state.workspace = workspace; // stamped on everything created or imported from now on
  const { photos, models, rejected } = classifyFiles([...files]);
  for (const r of rejected) toast(`${r.file.name}: ${r.reason}`);
  if (photos.length || models.length) addFiles([...models, ...photos]);
  return { photos: photos.length, models: models.length, rejected: rejected.length };
}

export const dropOverlayHtml = (text = 'Drop pictures here') => `<div class="dropover" id="dropover" hidden><b>${text}</b></div>`;

/**
 * Whole-window drop target for a screen, plus the picker button(s). el: the screen's root; any element in it with
 * data-import="pick" opens the file picker, data-import="zone" is the visible drop zone (gets .hot while hovering).
 * Returns a function that removes the window listeners (call it from unmount).
 */
export function attachImportFlow(el, { workspace, text } = {}) {
  if (workspace) state.workspace = workspace;
  let over = $('#dropover');
  if (!over) { document.body.insertAdjacentHTML('beforeend', dropOverlayHtml(text)); over = $('#dropover'); }
  else if (text) over.querySelector('b').textContent = text;
  let depth = 0;
  const show = (on) => {
    over.hidden = !on;
    $('[data-import=zone]', el)?.classList.toggle('hot', on);
  };
  const enter = (e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); depth++; show(true); };
  const overH = (e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
  const leave = () => { if (--depth <= 0) { depth = 0; show(false); } };
  const drop = (e) => {
    depth = 0;
    show(false);
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    importFiles(e.dataTransfer.files, { workspace });
  };
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragover', overH);
  window.addEventListener('dragleave', leave);
  window.addEventListener('drop', drop);
  const click = (e) => { if (e.target.closest('[data-import=pick]')) openPicker(); };
  el.addEventListener('click', click);
  return () => {
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragover', overH);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('drop', drop);
    el.removeEventListener('click', click);
    show(false);
  };
}
