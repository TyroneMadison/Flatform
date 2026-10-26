// Client preview lock. The optional PIN that ends client preview mode is kept as a salted scrypt hash in
// preview.json in the library folder, never in plain text. Five wrong tries pause unlocking for 30 seconds.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export function hashPin(pin) {
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new Error('The PIN must be 4 to 8 digits');
  const salt = randomBytes(16);
  return { salt: salt.toString('hex'), hash: scryptSync(String(pin), salt, 32).toString('hex') };
}
export function pinMatches(rec, pin) {
  if (!rec) return true;
  const got = scryptSync(String(pin ?? ''), Buffer.from(rec.salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(rec.hash, 'hex'));
}

export function createPreviewLock({ file, now = Date.now, maxTries = 5, pauseMs = 30000 }) {
  let rec; let tries = 0; let pausedUntil = 0;
  const load = async () => { if (rec === undefined) rec = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'))?.pin ?? null; return rec; };
  const save = () => writeFile(file, JSON.stringify({ pin: rec }, null, 2));
  return {
    async view() { await load(); return { hasPin: Boolean(rec) }; },
    async unlock(pin) {
      await load();
      if (now() < pausedUntil) return { ok: false, error: `Too many tries. Wait ${Math.ceil((pausedUntil - now()) / 1000)} seconds.` };
      if (pinMatches(rec, pin)) { tries = 0; return { ok: true }; }
      if (++tries >= maxTries) { tries = 0; pausedUntil = now() + pauseMs; }
      return { ok: false, error: 'That PIN is not right' };
    },
    /** Set, change or clear (pin null) the PIN. Changing or clearing needs the current PIN. */
    async setPin(pin, current) {
      await load();
      if (rec && !pinMatches(rec, current)) throw new Error('Enter the current PIN first');
      rec = pin == null || pin === '' ? null : hashPin(pin);
      await save();
      return { hasPin: Boolean(rec) };
    },
  };
}
