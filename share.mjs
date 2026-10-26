// Share links. Flatform keeps the list (shares.json in the library folder); the page itself is served by the
// Cloudflare Worker in share-worker/ once Tyrone deploys it. Until settings.share.baseUrl is set, links are mock links
// (mock: true) so the app works end to end without any account. Nothing here uploads or deploys anything.
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

export function createShares({ file, baseUrl = () => null, now = Date.now }) {
  let list = null;
  const load = async () => (list ??= JSON.parse(await readFile(file, 'utf8').catch(() => '[]')));
  const save = () => writeFile(file, JSON.stringify(list, null, 2));
  const view = (s) => ({ ...s, url: `${(baseUrl() || MOCK_BASE).replace(/\/$/, '')}/${s.id}`, mock: !baseUrl(), expired: isExpired(s, now()) });
  return {
    async list() { return (await load()).map(view); },
    async create({ modelId, title, video, poster = null, expiresInDays = null }) {
      if (!modelId || !video) throw new Error('Render a video first, then share it');
      if (expiresInDays != null && !(Number(expiresInDays) > 0)) throw new Error('Expiry must be a number of days');
      await load();
      const s = { id: shareId(), modelId, title: String(title || 'Flatform render').slice(0, 120), video, poster, createdAt: new Date(now()).toISOString(), expiresAt: expiryFrom(expiresInDays, now()) };
      list.push(s); await save();
      return view(s);
    },
    async setExpiry(id, days) {
      const s = (await load()).find((x) => x.id === id); if (!s) return null;
      s.expiresAt = expiryFrom(days, now()); await save(); return view(s);
    },
    async remove(id) { await load(); const n = list.length; list = list.filter((x) => x.id !== id); await save(); return list.length < n; },
  };
}
