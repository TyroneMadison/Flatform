// Export file names and the short "Saves to" line under Export. Pure, so node tests can check them.

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i; // names Windows will not use for a file

/** A model name made safe for a file name: no slashes or other odd characters, never empty. */
export function safeFileName(name, fallback = 'model') {
  const clean = (x) => String(x ?? '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^\.+|\.+$/g, '').slice(0, 80).trim();
  const s = clean(name) || clean(fallback) || 'model';
  return RESERVED.test(s) ? `${s}_` : s;
}

/** The last folder of a full path ("E:\\Renders\\car" → "car"). */
export const lastFolder = (dir) => String(dir || '').split(/[\\/]+/).filter(Boolean).at(-1) || '';

/**
 * The short "Saves to" text: the handoff folder's own name, then the inside folder and the file, joined by ›.
 * files: one name, or a list (then "Weapon_d.png and 5 more").
 */
export function savesTo(outDir, sub, files) {
  const list = [files].flat().filter(Boolean);
  const file = list.length > 1 ? `${list[0]} and ${list.length - 1} more` : list[0] || '';
  return [lastFolder(outDir), sub, file].filter(Boolean).join(' › ');
}
