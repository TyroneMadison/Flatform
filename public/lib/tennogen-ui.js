// The "TennoGen check" card (Compose's render area) and the before-export gate. Pure rules live in tennogen.js; this talks to
// POST /api/tennogen/check and /fix, keeps the folder and content type on the model (m.tennogen) and the
// before-export mode in settings.tennogenCheck.
import { $, esc, state, api, send, toast, native, upsert, confirmDialog } from '../app.js';
import { icon } from './icons.js';
import { CONTENT_TYPES, EXPORT_MODES } from './tennogen.js';

const reports = new Map(); // model id → last report
let busy = false;
const MODE_TIPS = { warn: 'Check the files and ask before exporting', block: 'Do not export while the files have problems', off: 'Export without checking the files' };

export const tennogenApplies = (m) => m.workspace === 'warframe' || Boolean(m.tennogen);

export async function runCheck(m, fix = false) {
  if (!m.tennogen) return null;
  busy = true;
  try {
    const r = await send(`/api/tennogen/${fix ? 'fix' : 'check'}`, 'POST', m.tennogen);
    reports.set(m.id, r);
    return r;
  } catch (e) {
    toast(e.message);
    return null;
  } finally { busy = false; }
}

export function tennogenCard(m, disabled = false) {
  const r = reports.get(m.id);
  const mode = state.settings?.tennogenCheck || 'warn';
  const current = m.tennogen?.type || state.tennogenType || 'warframe'; // the Warframe home's template picks a type
  const types = Object.entries(CONTENT_TYPES).map(([k, t]) => `<option value="${k}" ${current === k ? 'selected' : ''}>${t.label}</option>`).join('');
  const verdict = !m.tennogen ? '<p class="fine">Pick the folder with your six Warframe pictures (and the 3D file). We check their names and sizes.</p>'
    : !r ? `<button class="pick wide" type="button" data-tg="check" title="Check the names and sizes against the TennoGen rules" ${busy || disabled ? 'disabled' : ''}>Check my files</button>`
      : r.pass ? `<button class="pick wide ok" type="button" data-tg="check" title="Check the files again" ${busy || disabled ? 'disabled' : ''}>✓ All names look good${r.warnings ? ` · ${r.warnings} note${r.warnings > 1 ? 's' : ''}` : ''}</button>`
        : `<button class="pick wide bad" type="button" data-tg="fix" title="Rename and resize the files so they pass" ${busy || disabled ? 'disabled' : ''}>⚠ ${r.errors} problem${r.errors > 1 ? 's' : ''}. Fix it for me</button>`;
  const list = r && r.issues.length ? `<ul class="issues">${r.issues.map((i) => `<li class="${i.severity}">${i.file === '*' ? '' : `<code>${esc(i.file)}</code> · `}${esc(i.message)}${i.fix ? ` <em>→ ${i.fix.kind === 'rename' ? `rename to ${esc(i.fix.to)}` : `resize to ${i.fix.width} × ${i.fix.height}`}</em>` : ''}</li>`).join('')}</ul>` : '';
  const applied = r?.applied?.length ? `<p class="fine keep">${r.applied.filter((a) => a.ok).length} fixed${r.applied.some((a) => !a.ok) ? ` · ${r.applied.filter((a) => !a.ok).map((a) => `${esc(a.file)}: ${esc(a.error)}`).join('; ')}` : ''}. The old pictures are in tennogen-original/.</p>` : '';
  return `<div class="grp tennogen" id="grp-tennogen"><h3>${icon('check', 14)} Check Warframe files</h3>
    ${verdict}${list}${applied}
    <div class="field"><label class="flabel" for="tgType">What it is</label>
      <select class="inp" id="tgType" data-tg="type" title="What you made: each kind has its own sizes" ${disabled ? 'disabled' : ''}>${types}</select></div>
    <div class="field"><span class="flabel">Picture folder</span>
      <div class="inp mono" title="${esc(m.tennogen?.dir || '')}">${m.tennogen?.dir ? esc(m.tennogen.dir) : '<span class="muted">Not chosen</span>'}</div>
      <button class="btn sm ghostbtn" type="button" data-tg="folder" title="Pick the folder with your Warframe pictures" ${disabled ? 'disabled' : ''}>${icon('folder', 14)}<span>${m.tennogen ? 'Change' : 'Choose'}</span></button></div>
    <form class="field pathform" id="tgFolderForm" hidden><label for="tgFolderIn">Folder</label><input class="inp mono" id="tgFolderIn" title="Type or paste the folder's full path" value="${esc(m.tennogen?.dir || '')}" spellcheck="false"><button class="btn ghostbtn" type="submit" title="Use this folder">Save</button></form>
    <div class="field"><span class="flabel">Before export</span>
      <div class="chips seg sm" role="radiogroup" aria-label="Before export">${Object.entries(EXPORT_MODES).map(([k, label]) => `<button class="chip" type="button" role="radio" data-tg="mode" data-value="${k}" aria-checked="${mode === k}" title="${MODE_TIPS[k]}" ${disabled ? 'disabled' : ''}>${label}</button>`).join('')}</div></div>
  </div>`;
}

// Handles clicks, changes and submits inside the card. Returns true when it took the event. redraw() repaints the panel.
export async function onTennogen(e, m, redraw) {
  const t = e.target.closest('[data-tg]');
  if (!t) return false;
  const act = t.dataset.tg;
  if (e.type === 'click') {
    if (act === 'check' || act === 'fix') { redraw(); await runCheck(m, act === 'fix'); redraw(); }
    if (act === 'folder') {
      if (native) {
        const dir = await native.pickFolder();
        if (dir) await setFolder(m, dir, $('#tgType').value, redraw);
      } else { $('#tgFolderForm').hidden = false; $('#tgFolderIn').focus(); }
    }
    if (act === 'mode') {
      try { state.settings = await send('/api/settings', 'POST', { tennogenCheck: t.dataset.value }); } catch (err) { toast(err.message); }
      redraw();
    }
    return true;
  }
  if (e.type === 'change' && act === 'type' && m.tennogen) { await setFolder(m, m.tennogen.dir, t.value, redraw); return true; }
  return false;
}
export async function onTennogenSubmit(e, m, redraw) {
  if (e.target.id !== 'tgFolderForm') return false;
  e.preventDefault();
  await setFolder(m, $('#tgFolderIn').value.trim(), $('#tgType').value, redraw);
  return true;
}
async function setFolder(m, dir, type, redraw) {
  try {
    upsert(await send(`/api/models/${m.id}`, 'PATCH', { tennogen: { dir, type }, workspace: 'warframe' }));
    reports.delete(m.id);
  } catch (err) { return toast(err.message); }
  redraw();
  await runCheck({ ...m, tennogen: { dir, type } });
  redraw();
}

// Before an export: true to go ahead. Fresh check each time; "block" stops on errors, "warn" asks, "off" skips.
export async function tennogenGate(m) {
  const mode = state.settings?.tennogenCheck || 'warn';
  if (mode === 'off' || !m.tennogen) return true;
  const r = await runCheck(m);
  if (!r) return mode !== 'block';
  if (r.pass) return true;
  const text = `${r.errors} problem${r.errors > 1 ? 's' : ''} in the Warframe files in ${m.tennogen.dir}: ${r.issues.filter((i) => i.severity === 'error').slice(0, 3).map((i) => i.message).join(' ')}`;
  if (mode === 'block') { toast(`Export stopped. ${text}`); return false; }
  return confirmDialog({ title: 'Problems in the Warframe files', text: `${text} Export anyway?`, ok: 'Export anyway' });
}
