// Share links. Flatform keeps the list (shares.json in the library folder); the page itself is served by the
// Cloudflare Worker in share-worker/ once it is deployed (SHARE-DEPLOY.md). remote() gives its address and password
// ({ url, token }) once sharing is set up in Flatform; then a new link uploads its picture (and video) to the Worker
// and turning a link off deletes it there. Until then links are mock links (mock: true) that only live in the app.
// Nothing here deploys anything or creates any account.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const MOCK_BASE = 'https://share.flatform.invalid';

/** Unguessable base62 id from crypto bytes (rejection sampling, so no modulo bias). */
export function shareId(len = 12) {
  let out = '';
  while (out.length < len) for (const b of randomBytes(len * 2)) if (b < 248 && out.length < len) out += B62[b % 62];
  return out;
}

export const isExpired = (s, now = Date.now()) => s.expiresAt != null && Date.parse(s.expiresAt) <= now;
export const expiryFrom = (days, now = Date.now()) => (days == null || days === '' ? null : new Date(now + Number(days) * 864e5).toISOString());
export const IMAGE_TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
const typeOf = (name) => IMAGE_TYPES[String(name).split('.').pop().toLowerCase()] || 'image/jpeg';

/** The share page's address as typed in Settings: https only (http for this computer, for testing), no trailing slash. */
export function cleanShareUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch { throw new Error('That is not a web address. It looks like https://flatform-share.yourname.workers.dev'); }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('The share page address must start with https://');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * remote(): { url, token } when sharing is set up, else null. files(share) → { poster?: Buffer, video?: Buffer }.
 * baseUrl(): an address for links without uploading (older setups and tests).
 */
export function createShares({ file, baseUrl = () => null, remote = () => null, files = async () => ({}), fetch = globalThis.fetch, now = Date.now }) {
  let list = null;
  const load = async () => (list ??= JSON.parse(await readFile(file, 'utf8').catch(() => '[]')));
  const save = () => writeFile(file, JSON.stringify(list, null, 2));
  const base = (s) => s.base || baseUrl() || null; // a link made before sharing was set up stays a practice link
  const view = (s) => ({ ...s, url: `${(base(s) || MOCK_BASE).replace(/\/$/, '')}/${s.id}`, mock: !base(s), expired: isExpired(s, now()) });
  async function call(r, method, path, body, type) {
    const res = await fetch(`${r.url}/${path}`, { method, headers: { authorization: `Bearer ${r.token}`, ...(type && { 'content-type': type }) }, body });
    if (res.status === 403) throw new Error('The share page did not accept the share password. Check it in Settings, Sharing.');
    if (!res.ok) throw new Error(`The share page answered ${res.status}`);
  }
  const meta = (s) => JSON.stringify({ title: s.title, video: Boolean(s.video), poster: Boolean(s.poster), posterType: s.poster ? typeOf(s.poster) : null, expiresAt: s.expiresAt });
  return {
    ready: () => Boolean(remote()),
    async list() { return (await load()).map(view); },
    async create({ modelId, title, video, poster = null, expiresInDays = null }) {
      if (!modelId || !(video || poster)) throw new Error('Render a video or a picture first, then share it');
      if (expiresInDays != null && !(Number(expiresInDays) > 0)) throw new Error('Expiry must be a number of days');
      await load();
      const s = { id: shareId(), modelId, title: String(title || 'Flatform render').slice(0, 120), video, poster, createdAt: new Date(now()).toISOString(), expiresAt: expiryFrom(expiresInDays, now()) };
      const r = remote();
      if (r) { // the picture and video go up first; the link exists only once the page can show it
        try {
          const f = await files(s);
          if (s.video && f.video) await call(r, 'POST', `${s.id}/video.mp4`, f.video, 'video/mp4');
          if (s.poster && f.poster) await call(r, 'POST', `${s.id}/poster.jpg`, f.poster, typeOf(s.poster));
          await call(r, 'POST', `${s.id}/meta`, meta(s), 'application/json');
        } catch (e) {
          await call(r, 'DELETE', s.id).catch(() => {});
          throw new Error(`Could not make the link: ${e.message.replace(/^fetch failed$/, 'the share page could not be reached')}`);
        }
        s.base = r.url;
      }
      list.push(s); await save();
      return view(s);
    },
    async setExpiry(id, days) {
      const s = (await load()).find((x) => x.id === id); if (!s) return null;
      const before = s.expiresAt;
      s.expiresAt = expiryFrom(days, now());
      const r = remote();
      if (s.base && r) await call(r, 'POST', `${s.id}/meta`, meta(s), 'application/json').catch((e) => { s.expiresAt = before; throw e; });
      await save(); return view(s);
    },
    async remove(id) {
      await load();
      const s = list.find((x) => x.id === id);
      const r = remote();
      if (s?.base && r) await call(r, 'DELETE', id);
      const n = list.length; list = list.filter((x) => x.id !== id); await save(); return list.length < n;
    },
  };
}
