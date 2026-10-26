// Render feedback in plain words: the ETA, the top-bar status light, the queue tray and the connection lights.
// Pure functions (no DOM) so node tests can check them; views/compose-render.js draws what they return.
import { LOOKS, stillName } from './pipeline.js';

// Seconds left, from how fast this phase has gone so far. null until there is enough to go on.
// t0/f0: when and at which frame the current phase started (the count resets when Blender moves on to sprites).
export function etaSeconds({ t0, f0 = 0, frame, total, now = Date.now() }) {
  const done = frame - f0;
  if (!total || !t0 || done < 1 || frame >= total || now <= t0) return null;
  return Math.max(1, Math.round(((total - frame) * (now - t0)) / done / 1000));
}

export function formatEta(sec) {
  if (sec == null) return 'working out time left';
  if (sec < 60) return 'less than a minute left';
  const min = Math.round(sec / 60);
  if (min < 60) return `about ${min} min left`;
  const h = Math.floor(min / 60);
  return `about ${h} h${min % 60 ? ` ${min % 60} min` : ''} left`;
}

// What the top-bar light shows for a job ({ model, frame, total, paused, done, error, cancelled, t0, f0 }) or null.
export function statusLight(job, waiting = 0, now = Date.now()) {
  const more = waiting ? ` · ${waiting} waiting` : '';
  if (!job) return { light: 'idle', pct: 0, text: 'Nothing rendering', tip: 'Renders you start in Compose show their progress here' };
  const name = job.model?.name || 'Render';
  if (job.done) {
    if (job.cancelled) return { light: 'idle', pct: 0, text: `${name}: stopped`, tip: 'The render was cancelled' };
    if (job.error) return { light: 'error', pct: 0, text: `${name}: did not finish`, tip: job.error };
    return { light: 'done', pct: 100, text: `${name}: done${more}`, tip: 'Finished. Click to see it in Compose' };
  }
  const pct = job.total ? Math.min(99, Math.round((job.frame / job.total) * 100)) : 0;
  if (job.paused) return { light: 'paused', pct, text: `${name}: paused at ${pct}%${more}`, tip: 'Click to go back and resume' };
  return { light: 'busy', pct, text: `${name}: ${pct}% · ${formatEta(etaSeconds({ ...job, now }))}${more}`, tip: job.phaseText || 'Rendering' };
}

// What the top-bar light shows while joints are being added (auto-rig) and nothing is rendering. waiting: renders of
// that model held back until the rig is done.
export function rigLight(name, waiting = 0) {
  return { light: 'busy', pct: 0, text: `${name || 'Model'}: Rigging…${waiting ? ` · ${waiting} render${waiting > 1 ? 's' : ''} waiting` : ''}`,
    tip: `Adding joints in Blender. ${waiting ? 'Renders of this model start when it is done' : 'You can keep working'}` };
}
/** A waiting render whose model is being rigged waits for the joints first. */
export const blockedByRig = (task, rigging) => task?.status === 'waiting' && rigging.has(task.model.id);

// One line for a queued render: "Still + 360° spin · My scene, See-through".
export function taskLabel(o) {
  const what = [o.still && 'Still', o.t360 && '360° spin', o.t180 && '180° half spin', o.models && 'Model files'].filter(Boolean);
  const looks = (o.still || o.t360 || o.t180) ? Object.keys(LOOKS).filter((l) => o[l]).map(lookName) : [];
  return `${what.join(' + ') || 'Nothing'}${looks.length ? ` · ${looks.join(', ')}` : ''}`;
}
export const lookName = (l) => ({ showroom: 'Showroom', studio: 'My scene', transparent: 'See-through' })[l] || l;

// The one file a finished render is best shown by, relative to its handoff folder: the drag-to-spin viewer for a
// turntable, else the still, else the model file.
export function resultFile({ slug, still, t360, t180, looks = [], yaw = 0 }) {
  if (t360 || t180) return 'viewer.html';
  if (still && looks.length) return `stills/${stillName(slug, looks[0], yaw)}`;
  return `${slug}.glb`;
}

// The queue tray: tasks run one at a time, in order. Pure helpers over a plain array.
export const nextTask = (queue) => queue.find((t) => t.status === 'waiting') || null;
export const waitingCount = (queue) => queue.filter((t) => t.status === 'waiting').length;
export const STATUS_TEXT = { rigging: 'Waits for joints', waiting: 'Waiting', running: 'Rendering', done: 'Done', failed: 'Did not finish', cancelled: 'Cancelled' };
// Keeps the tray short: everything still to do, plus the last few finished ones.
export function trimQueue(queue, keep = 5) {
  const finished = queue.filter((t) => !['waiting', 'running'].includes(t.status));
  const drop = new Set(finished.slice(0, Math.max(0, finished.length - keep)));
  return queue.filter((t) => !drop.has(t));
}

// The two connection lights in the top bar.
export function blenderLight(blender) {
  if (!blender) return { ok: null, text: 'Blender: checking', tip: 'Looking for Blender on this computer' };
  return blender.found ? { ok: true, text: 'Blender ready', tip: `${blenderStatus(blender)}. Renders can use it for more real light.` }
    : { ok: false, text: 'No Blender', tip: 'Blender is optional. Install Blender 4 or newer, or click Browse in Settings to show where it is.' };
}
/** The one-line Blender status in Settings. */
export const blenderStatus = (b) => (!b ? 'Looking for Blender...' : b.found ? `Blender found: ${b.version || 'ready'}` : 'Blender not found - click Browse');
export function accountLight(name, a) {
  if (!a) return { ok: null, text: `${name}: checking`, tip: `Connecting to ${name}` };
  if (a.error) return { ok: false, text: `${name} offline`, tip: `${name} can't be reached right now. Click to open settings.` };
  return a.hasKey ? { ok: true, text: `${name} connected`, tip: `${name} is connected. Click to open settings.` }
    : { ok: false, text: `${name}: no key`, tip: `Add your ${name} key in Settings to make models` };
}
