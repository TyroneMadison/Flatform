// Compose · auto-save: a snapshot of the scene to the app's data folder every few minutes while you edit, sooner
// after a big change, and when you leave. The newest few are kept; after a crash the app offers to restore the last.
// It also feeds "Pick up where you left off" (recents) and the small "Saved" note at the top.
import { $, send, state } from '../app.js';
import { snapshotDue } from '../lib/session.js';

let ctx; // { root, model(), scene(), frame() }
let dirty = false;
let big = false;
let lastAt = 0;
let timer;

export function initSession(c) {
  ctx = c;
  dirty = big = false;
  lastAt = Date.now();
  clearInterval(timer);
  timer = setInterval(() => tick(), 15_000);
}

/** An edit happened. significant: a new undo step (not the middle of a slider drag). */
export function noteEdit(significant = false) {
  dirty = true;
  big ||= significant;
  tick();
}

function tick(force = false) {
  if (force ? !dirty : !snapshotDue({ now: Date.now(), lastAt, dirty, significant: big })) return;
  dirty = big = false;
  lastAt = Date.now();
  send('/api/session/snapshots', 'POST', { modelId: ctx.model().id, scene: ctx.scene(), frame: ctx.frame() })
    .then((r) => { state.recents = r.recents; markSaved(); })
    .catch(() => { dirty = true; }); // try again on the next tick
}

/** Leaving Compose: save what is not saved yet. */
export function stopSession() {
  clearInterval(timer);
  if (ctx) tick(true);
}

/** The subtle "Saved" note next to the Render button. */
export function markSaved() {
  const el = ctx?.root && $('#savedNote', ctx.root);
  if (!el) return;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.textContent = 'Saved';
  el.title = `Saved at ${time}. Flatform saves your scene by itself as you work and keeps a few backups.`;
  el.classList.remove('on');
  void el.offsetWidth; // restart the fade
  el.classList.add('on');
}
