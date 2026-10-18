// Update checks. The server asks GitHub for Flatform's latest release a few seconds after it starts and every 6 hours
// while updates.autoCheck is on; the page shows a banner when that release is newer. Nothing is downloaded or
// installed here: Download opens the installer's github.com link in the browser. Every failure is quiet (offline, a
// timeout, GitHub's rate limit, any odd reply): no release, no error.

export const LATEST_URL = 'https://api.github.com/repos/TyroneMadison/Flatform/releases/latest';
export const RELEASES_PAGE = 'https://github.com/TyroneMadison/Flatform/releases/latest';
const SIX_HOURS = 6 * 60 * 60 * 1000;

// "v0.4.1" or "1.0.0-beta.2" → { nums: [1, 0, 0], pre: ['beta', '2'] }; anything else → null.
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?(?:\+[\da-z.-]+)?$/i.exec(String(v ?? '').trim());
  return m && { nums: m.slice(1, 4).map(Number), pre: m[4] ? m[4].split('.') : null };
}

// Below 0 when a is older than b, 0 when the same, above 0 when newer, in semver order: a prerelease comes before
// its release. NaN when either isn't a version.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1; // alpha < alpha.1
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1; // beta.2 < beta.11
    if (pn || qn) return pn ? -1 : 1; // numbers before words
    return p < q ? -1 : 1;
  }
  return 0;
}

// The installer for this computer among a release's files: the Windows Setup .exe, or the Mac .dmg for its chip.
export function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const named = (test) => (Array.isArray(assets) ? assets : []).find((a) => typeof a?.name === 'string' && test(a.name.toLowerCase()));
  if (platform === 'win32') return named((n) => n.includes('setup') && n.endsWith('.exe'));
  if (platform === 'darwin' && arch === 'arm64') return named((n) => n.endsWith('-arm64.dmg'));
  if (platform === 'darwin') return named((n) => n.endsWith('.dmg') && !n.includes('arm64'));
  return undefined;
}

// The only links Flatform ever opens for an update: https pages and files of this repository on github.com
// (release pages, and installers under /releases/download/). Anything else → null.
export function releaseUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && u.host === 'github.com' && !u.username && !u.password && u.pathname.startsWith('/TyroneMadison/Flatform/')) return u.href;
  } catch { /* not a URL */ }
  return null;
}

// One line of release notes as plain text, or '' when nothing in it is worth reading.
function plain(line) {
  const text = line
    .replace(/<!--.*?-->|<[^>]*>/g, ' ') // HTML
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links: their text
    .replace(/\s*\bby @[\w-]+ in https?:\/\/\S+/g, '') // GitHub's generated "by @someone in <pull request>"
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?/, '') // quotes and list markers
    .replace(/[*`~]|\b_+|_+\b/g, '') // bold, italics, code, strikethrough (not snake_case)
    .replace(/\s+/g, ' ')
    .trim();
  return /[\p{L}\p{N}]/u.test(text) && !/^full changelog\b/i.test(text) ? text : '';
}

// The banner's note: the first paragraph of the release notes that isn't a heading, as plain text, cut to `max`.
export function shortNotes(body, max = 140) {
  let out = '';
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const text = /^\s*#/.test(line) ? '' : plain(line);
    if (!text) {
      if (out) break; // a blank line or heading ends the paragraph
      continue;
    }
    if (out) out += /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s/.test(line) ? ' · ' : ' '; // list items read "A · B"
    out += text;
  }
  return out.length > max ? `${out.slice(0, max - 1).replace(/[\s·]+\S*$/, '')}…` : out;
}

/**
 * Flatform's latest release from GitHub: { version, notes, pageUrl, downloadUrl }, or null when there's nothing to
 * offer or GitHub can't say right now (offline, timeout, rate limit, any status but 200, bad JSON, a draft or a
 * prerelease). Never throws. Unauthenticated: GitHub allows 60 of these an hour per IP address.
 * downloadUrl is the installer for this computer, or the release page when there isn't one.
 */
export async function getLatest({ url = LATEST_URL, current, fetchImpl = fetch, timeoutMs = 10000, platform, arch } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Flatform/${current} (+https://github.com/TyroneMadison/Flatform)` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return null;
    const release = await res.json();
    const v = parseVersion(release?.tag_name);
    if (!v || v.pre || release.draft || release.prerelease) return null;
    const pageUrl = releaseUrl(release.html_url) || RELEASES_PAGE;
    return {
      version: v.nums.join('.'),
      notes: shortNotes(release.body),
      pageUrl,
      downloadUrl: releaseUrl(pickAsset(release.assets, platform, arch)?.browser_download_url) || pageUrl,
    };
  } catch {
    return null;
  }
}

// FLATFORM_UPDATE_URL points the checks at a stand-in for GitHub (screenshots, tests): https anywhere, plain http on
// 127.0.0.1 only. FLATFORM_UPDATE_DELAY_MS sets the wait before the first check.
const standIn = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1');
  } catch { return false; }
};
export function updateOptions(env = {}) {
  const options = { updateUrl: LATEST_URL };
  if (env.FLATFORM_UPDATE_URL) {
    if (standIn(env.FLATFORM_UPDATE_URL)) options.updateUrl = env.FLATFORM_UPDATE_URL;
    else console.warn('FLATFORM_UPDATE_URL ignored: use https, or http on 127.0.0.1');
  }
  const delay = Number(env.FLATFORM_UPDATE_DELAY_MS);
  if (env.FLATFORM_UPDATE_DELAY_MS && delay >= 0) options.updateDelayMs = delay;
  return options;
}

/**
 * The checker the server runs. view() is what GET /api/update returns; check() asks GitHub now.
 * settings() → the saved { autoCheck, skippedVersion }. start() plans a check `delayMs` from now and one every
 * 6 hours after it, while autoCheck is on; call it again whenever autoCheck changes. Without a url (tests) GitHub is
 * never asked. now, timer and fetchImpl can be swapped for fakes.
 */
export function createUpdater({ current, url, settings, delayMs = 5000, fetchImpl, now = Date.now, timer = { set: setTimeout, clear: clearTimeout } }) {
  let latest = null; // the last release GitHub reported; kept when a later check fails
  let checkedAt = null; // when GitHub last answered
  let failed = false; // the last check got no answer
  let running = null;
  let wake = null;
  let stopped = false;

  function view() {
    const { skippedVersion } = settings();
    const newer = Boolean(latest) && compareVersions(latest.version, current) > 0;
    return {
      current, latest: latest?.version ?? null, newer,
      // Skip this version hides the banner for that version and older ones, never for a newer one.
      skipped: newer && Boolean(skippedVersion) && compareVersions(latest.version, skippedVersion) <= 0,
      notes: latest?.notes ?? '', downloadUrl: latest?.downloadUrl ?? null, pageUrl: latest?.pageUrl ?? RELEASES_PAGE,
      checkedAt, failed,
    };
  }

  // Overlapping checks (the schedule and a click) share one request.
  function check() {
    running ||= (async () => {
      const found = url ? await getLatest({ url, current, fetchImpl }) : null;
      if (found) {
        latest = found;
        checkedAt = new Date(now()).toISOString();
      }
      failed = !found;
      return view();
    })().finally(() => { running = null; });
    return running;
  }

  // Replaces the planned check with one `ms` from now, or none while automatic checks are off.
  function plan(ms) {
    if (wake) timer.clear(wake);
    wake = null;
    if (stopped || !settings().autoCheck) return;
    wake = timer.set(() => {
      wake = null;
      check().then(() => plan(SIX_HOURS));
    }, ms);
    wake?.unref?.(); // never keeps the process alive on its own
  }

  return {
    view,
    check,
    start: () => plan(delayMs),
    stop() { stopped = true; plan(); },
  };
}
