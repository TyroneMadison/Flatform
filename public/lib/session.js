// Auto-save, Reset scene and Recents: the plain rules, shared by the page and the server (session.mjs keeps the files).
export const KEEP = 5; // rotating auto-save snapshots kept on disk
export const RECENTS = 3; // items under "Pick up where you left off"
export const AUTOSAVE_MS = 150_000; // every 2.5 minutes while something changed
export const MIN_GAP_MS = 20_000; // a big edit saves sooner, but never more often than this

// Names sort by time, so the newest snapshot is the last name in a sorted list.
export const snapName = (at) => `snap-${String(Math.floor(at)).padStart(15, '0')}.json`;
export const SNAP = /^snap-\d{15}\.json$/;
/** The snapshot files to delete so only the newest `keep` stay. */
export function prunable(names, keep = KEEP) {
  const snaps = names.filter((n) => SNAP.test(n)).sort();
  return snaps.slice(0, Math.max(0, snaps.length - keep));
}

/** Should Compose write a snapshot now? Only when something changed: right away-ish for a big edit, else every 2.5 min. */
export function snapshotDue({ now, lastAt = 0, dirty, significant = false }) {
  if (!dirty) return false;
  return now - lastAt >= AUTOSAVE_MS || (significant && now - lastAt >= MIN_GAP_MS);
}

/** Same scene, frame and model as the last snapshot (its time aside): no point writing it again. */
export const sameSnapshot = (a, b) => Boolean(a && b) && JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

/** Newest first, one entry per item, at most `max`. */
export function bumpRecent(list, item, max = RECENTS) {
  return [item, ...(Array.isArray(list) ? list : []).filter((r) => r?.id !== item.id)].slice(0, max);
}

// Fixes to the model itself (which way is up, where its middle is), not the look of the scene: Reset scene keeps them.
export const MODEL_FIXES = ['autoOrient', 'center', 'flip'];
/** The scene back to how a new one starts: background, lights, colours, materials, camera, pose and moves. */
export function resetScene(scene, defaults) {
  const keep = Object.fromEntries(MODEL_FIXES.filter((k) => scene && k in scene).map((k) => [k, scene[k]]));
  return structuredClone({ ...defaults, ...keep });
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Mar". */
export function timeAgo(at, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
