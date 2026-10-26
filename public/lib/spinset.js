// Spin set import rules, shared by the Spin set screen (sorting, previews, the frame panel) and the server (export).
// Pure functions only: no DOM, no fs. Frames are { name, time?, size?, hash? } plus whatever the caller carries.

export const SPIN_OPTIONS = {
  36: { frames: 36, step: 10, turn: 360, label: '360 · 36 frames' },
  72: { frames: 72, step: 5, turn: 360, label: '360 · 72 frames (default)' },
  180: { frames: 37, step: 5, turn: 180, label: '180 · 37 frames' },
};
export const DEFAULT_OPTION = 72;
export const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif|avif)$/i;

// The last run of digits in the file name (IMG_0042.jpg → 42, car-12-front.png → 12 is wrong, so prefer the last).
export function frameNumber(name) {
  const stem = String(name).replace(/\.[^.]+$/, '');
  const hits = stem.match(/\d+/g);
  return hits ? Number(hits.at(-1)) : null;
}

/** Angle order: by file-name number when every frame has one, else by capture time, else by name. Returns a copy. */
export function sortFrames(frames) {
  const list = [...frames];
  const numbered = list.every((f) => frameNumber(f.name) != null);
  const timed = !numbered && list.every((f) => Number.isFinite(f.time));
  const by = numbered ? (f) => frameNumber(f.name) : timed ? (f) => f.time : null;
  if (by) list.sort((a, b) => by(a) - by(b) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  else list.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  return { frames: list, order: numbered ? 'number' : timed ? 'time' : 'name' };
}

/** Numbers missing between the first and last file-name number: [{ after: name, missing: [n…] }]. */
export function findGaps(sorted) {
  const nums = sorted.map((f) => frameNumber(f.name));
  if (nums.some((n) => n == null)) return [];
  const out = [];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] - nums[i - 1] > 1) out.push({ after: sorted[i - 1].name, missing: Array.from({ length: nums[i] - nums[i - 1] - 1 }, (_, k) => nums[i - 1] + 1 + k) });
  }
  return out;
}

/** Frames with the same content (hash) or the same number: [[name, name…]] groups, each a duplicate set. */
export function findDuplicates(frames) {
  const groups = new Map();
  for (const f of frames) {
    const key = f.hash ? `h:${f.hash}` : frameNumber(f.name) != null ? `n:${frameNumber(f.name)}` : `s:${f.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f.name);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Frames that stay after dropping every duplicate but the first of each group. */
export function dedupe(frames) {
  const seen = new Set();
  const drop = new Set(findDuplicates(frames).flatMap((g) => g.slice(1)));
  return frames.filter((f) => !drop.has(f.name) && !seen.has(f.name) && seen.add(f.name));
}

/**
 * Maps `count` source frames (one full turn, evenly spaced) onto an output option. Each output frame is
 * { i, angle, from, to, t }: from/to are source indexes, t the blend (0 = exactly `from`). When the sources
 * are fewer than the output and interpolate is on, the in-between frames blend their two neighbours; otherwise
 * each output frame takes its nearest source.
 */
export function planSequence(count, option = DEFAULT_OPTION, { interpolate = false } = {}) {
  const o = SPIN_OPTIONS[option];
  if (!o) throw new Error(`Spin option must be ${Object.keys(SPIN_OPTIONS).join(', ')}`);
  if (!(count > 0)) return [];
  const out = [];
  for (let i = 0; i < o.frames; i++) {
    const angle = i * o.step;
    const pos = (angle / 360) * count; // position along the sources
    const from = Math.floor(pos) % count;
    const to = (from + 1) % count;
    const t = pos - Math.floor(pos);
    const blend = interpolate && count < o.frames && t > 1e-9;
    out.push({ i, angle, from: blend || t < 0.5 ? from : to, to: blend ? to : from, t: blend ? Math.round(t * 1000) / 1000 : 0 });
  }
  return out;
}

// ---- the frame panel: thumbnail strip with reorder, multi-select, reverse, start frame, delete ----
export function reorder(list, from, to) {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
export const reverse = (list) => [...list].reverse();
/** The frame at `start` becomes frame 000; the rest follow in a loop. */
export const setStart = (list, start) => [...list.slice(start), ...list.slice(0, start)];
export const removeAt = (list, indexes) => list.filter((_, i) => !indexes.includes(i));
/** Shift-click selects the run between the anchor and the click; ctrl-click toggles one. */
export function select(selected, i, { shift = false, toggle = false, anchor = null } = {}) {
  if (shift && anchor != null) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    return [...new Set([...selected, ...Array.from({ length: b - a + 1 }, (_, k) => a + k)])].sort((x, y) => x - y);
  }
  if (toggle) return selected.includes(i) ? selected.filter((x) => x !== i) : [...selected, i].sort((x, y) => x - y);
  return [i];
}

// ---- EXIF capture time (DateTimeOriginal 0x9003, or DateTime 0x0132) from a JPEG's bytes; null if none ----
// bytes: Uint8Array or Buffer. Returns a local-time timestamp in ms.
export function exifTime(bytes) {
  const b = bytes;
  if (!b || b.length < 12 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 < b.length && b[p] === 0xff) {
    const marker = b[p + 1];
    const len = (b[p + 2] << 8) | b[p + 3];
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(p + 4, p + 8)) === 'Exif') return readTiff(b, p + 10, Math.min(b.length, p + 2 + len));
    if (marker === 0xda) break; // image data: no EXIF after this
    p += 2 + len;
  }
  return null;
}
function readTiff(b, start, end) {
  const le = b[start] === 0x49;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const text = (o, n) => String.fromCharCode(...b.subarray(o, o + n)).replace(/\0.*$/s, '');
  let found = null;
  const ifd = (off, depth) => {
    if (depth > 2 || off + 2 > end) return;
    const n = u16(start + off);
    for (let i = 0; i < n; i++) {
      const e = start + off + 2 + i * 12;
      if (e + 12 > end) return;
      const tag = u16(e);
      const count = u32(e + 4);
      const valOff = count > 4 ? start + u32(e + 8) : e + 8;
      if (tag === 0x8769) ifd(u32(e + 8), depth + 1); // the Exif sub-IFD
      else if ((tag === 0x9003 || (tag === 0x0132 && !found)) && valOff + count <= end) {
        const t = parseExifDate(text(valOff, count));
        if (t != null && (tag === 0x9003 || !found)) found = t;
      }
    }
  };
  ifd(u32(start + 4), 0);
  return found;
}
// "2026:10:18 14:03:22" → ms (local time).
export function parseExifDate(s) {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(String(s));
  if (!m) return null;
  const t = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}
