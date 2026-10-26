// Extra Settings sections: Shortcuts, Backup, Plugins. They keep their own data and listeners; settings.js only
// lists them and asks for their HTML.
import { esc, api, send, toast, refresh, confirmDialog } from '../app.js';
import { ACTIONS, loadKeys, saveKeys, validCombo, comboOf, conflicts } from '../lib/hotkeys.js';
import { SHORTCUTS, TAKEN } from '../lib/shortcuts.js';

export const EXTRA = [['shortcuts', 'Shortcuts'], ['backup', 'Backup'], ['plugins', 'Plugins']];
let backup = null, plugins = null, code = 'flatform.log("Parts in the scene:", Object.keys(scene).length);\nflatform.setResult({ ok: true });', run = null, busy = false;
const load = async (what) => {
  try { if (what === 'backup') backup = await api('/api/backup'); else plugins = await api('/api/plugins'); } catch (e) { toast(e.message); }
  refresh();
};
const toggle = (x, on, label, help, tip) => `<label class="toggle big" title="${tip}"><input type="checkbox" data-x="${x}" ${on ? 'checked' : ''}><span>${label}</span></label>${help ? `<p class="fine">${help}</p>` : ''}`;

export function shortcutsHtml() {
  const k = loadKeys(); const clash = conflicts(k.keys);
  return `<div class="grp"><h3>Shortcuts</h3>
    ${toggle('hkshow', k.show, 'Show the keys when I hold Ctrl', 'Press ? to see the keys for this screen. With this on, holding Ctrl shows them too.', 'Hold Ctrl for a moment to see the shortcut keys')}
    <div class="hk-edit">${Object.entries(ACTIONS).map(([a, d]) => `<div class="field"><label for="hk-${a}">${esc(d.label)}</label>
      <input id="hk-${a}" class="hk-in" data-x="hk" data-action="${a}" value="${esc(k.keys[a])}" readonly aria-describedby="hkHelp" title="Click, then press the new keys"></div>`).join('')}</div>
    <p class="fine" id="hkHelp">Click a box, then press the new keys (Ctrl or Alt plus a letter, number or F-key).</p>
    ${clash.length ? `<p class="warn-text" role="alert">Two actions use the same keys: ${clash.map(([a, b]) => `${esc(ACTIONS[a].label)} and ${esc(ACTIONS[b].label)}`).join('; ')}.</p>` : ''}
    <button class="btn sec" type="button" data-x="hkreset" title="Put every shortcut back to how it came">Reset keys</button></div>`;
}

export function backupHtml() {
  if (!backup) { load('backup'); return `<div class="grp"><h3>Backup</h3><p class="sub keep">Loading…</p></div>`; }
  return `<div class="grp"><h3>Backup</h3>
    ${toggle('bkon', backup.enabled, 'Back up to GitHub on its own', 'Off until you turn it on. Saves to a separate backup copy, never your main one.', 'Now and then, save a copy of your project to GitHub')}
    <p class="fine keep">${backup.lastRun ? `Last backup: ${esc(new Date(backup.lastRun).toLocaleString())}` : 'No backup yet.'}${backup.lastError ? ` <span class="warn-text">Last try failed: ${esc(backup.lastError)}</span>` : ''}</p>
    <button class="btn pri" type="button" data-x="bkrun" title="Save a copy to GitHub right now" ${backup.enabled && !busy ? '' : 'disabled'}>${busy ? 'Backing up…' : 'Back up now'}</button>
    <details class="adjust"><summary>Adjust (more options)</summary>
      <form data-x="bkform"><div class="field"><label for="bkRemote">GitHub address</label><input id="bkRemote" name="remote" title="The GitHub address to back up to" value="${esc(backup.remote)}"></div>
      <div class="field"><label for="bkBranch">Backup name</label><input id="bkBranch" name="branch" title="The name of the backup copy" value="${esc(backup.branch)}"><p class="fine">It cannot be main or master.</p></div>
      <button class="btn sec" title="Save these backup options">Save</button></form>
    </details></div>`;
}

export function pluginsHtml() {
  if (!plugins) load('plugins');
  return `<div class="grp"><h3>Plugins</h3>
    <p class="sub"><b>Try a plugin safely.</b> Plugins run in a safe box. They cannot break Flatform, see your files or go online.</p>
    <label class="label" for="plCode">Plugin code</label>
    <textarea id="plCode" class="pl-code" data-x="plcode" title="Type or paste the plugin code here" rows="10" spellcheck="false">${esc(code)}</textarea>
    <div class="row"><button class="btn pri" type="button" data-x="plrun" title="Run this plugin in the safe box" ${busy ? 'disabled' : ''}>${busy ? 'Running…' : 'Try it'}</button></div>
    ${run ? `<div class="pl-out ${run.ok ? 'ok' : 'bad'}" role="status"><b>${run.ok ? 'It worked.' : 'It stopped with a problem.'}</b>
      <pre>${esc([...(run.logs || []), run.ok ? (run.result !== undefined ? `Result: ${JSON.stringify(run.result)}` : '') : run.error].filter(Boolean).join('\n'))}</pre></div>` : ''}
    ${run?.ok ? `<form data-x="plinstall" class="row"><label class="sr-only" for="plName">Plugin name</label><input id="plName" name="name" placeholder="Name it, for example tidy-names" title="A short name for this plugin" required><button class="btn sec" title="Save this plugin to use again">Keep this plugin</button></form>` : ''}
    <h3 class="label">Saved plugins</h3>
    ${plugins?.length ? `<ul class="pl-list">${plugins.map((p) => `<li><span>${esc(p)}</span><button class="btn ghostbtn sm" type="button" data-x="plrm" data-name="${esc(p)}" title="Delete this plugin">Remove</button></li>`).join('')}</ul>` : `<p class="fine">None yet.</p>`}</div>`;
}

export const EXTRA_HTML = { shortcuts: shortcutsHtml, backup: backupHtml, plugins: pluginsHtml };

export function wireExtra(el) {
  el.addEventListener('keydown', (e) => {
    const t = e.target; if (t.dataset?.x !== 'hk') return;
    if (e.key === 'Tab') return;
    e.preventDefault(); e.stopPropagation();
    const c = comboOf(e); if (!c) return;
    if (!validCombo(c)) { toast('Use Ctrl or Alt plus a letter, number or F-key.'); return; }
    const used = SHORTCUTS.find((s) => !s.editable && [s.keys, ...(s.also || [])].includes(c));
    if (used || TAKEN.includes(c)) { toast(`${c} is already used${used ? ` for ${used.label}` : ''}. Pick other keys.`); return; }
    const k = loadKeys(); k.keys[t.dataset.action] = c; saveKeys(k); refresh();
  }, true);
  el.addEventListener('input', (e) => { if (e.target.dataset?.x === 'plcode') code = e.target.value; });
  el.addEventListener('change', async (e) => {
    const x = e.target.dataset?.x;
    if (x === 'hkshow') { const k = loadKeys(); k.show = e.target.checked; saveKeys(k); refresh(); }
    if (x === 'bkon') {
      if (e.target.checked && !(await confirmDialog({ title: 'Turn on GitHub backup?', text: 'Flatform will send copies of your project files to GitHub, kept apart from your main copy.', ok: 'Turn on' }))) { e.target.checked = false; return; }
      try { backup = await send('/api/backup', 'PUT', { enabled: e.target.checked }); } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
      refresh();
    }
  });
  el.addEventListener('submit', async (e) => {
    const x = e.target.dataset?.x; if (!x) return;
    e.preventDefault(); e.stopPropagation();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (x === 'bkform') { backup = await send('/api/backup', 'PUT', f); toast('Saved.', 'ok'); }
      if (x === 'plinstall') { await send('/api/plugins/install', 'POST', { name: f.name, code }); toast('Plugin kept.', 'ok'); run = null; await load('plugins'); }
    } catch (err) { toast(err.message); }
    refresh();
  }, true);
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]'); if (!b || b.tagName === 'INPUT' || b.tagName === 'TEXTAREA') return;
    const x = b.dataset.x;
    if (x === 'hkreset') { const k = loadKeys(); saveKeys({ show: k.show, keys: {} }); refresh(); }
    if (x === 'bkrun') { busy = true; refresh(); try { backup = await send('/api/backup/run', 'POST'); toast(backup.lastError ? backup.lastError : 'Backed up.', backup.lastError ? 'bad' : 'ok'); } catch (err) { toast(err.message); } busy = false; refresh(); }
    if (x === 'plrun') { busy = true; refresh(); try { run = await send('/api/plugins/run', 'POST', { code, scene: {} }); } catch (err) { run = { ok: false, error: err.message }; } busy = false; refresh(); }
    if (x === 'plrm') { try { await send(`/api/plugins/${encodeURIComponent(b.dataset.name)}`, 'DELETE'); } catch (err) { toast(err.message); } await load('plugins'); }
  });
}
