// The 3D AI Studio rate limiter (on a fake clock) and the per-provider key store, including the move of a key
// saved by v0.3 (test/fixtures/v03-userdata/tripo-key.bin). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLimiter } from '../providers.mjs';
import { createKeyStore } from '../keys.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const flush = () => new Promise((ok) => setImmediate(ok));

// A clock that only moves when the test says so.
function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    timer: { set: (fn, ms) => { const t = { at: now + ms, fn }; timers.add(t); return t; }, clear: (t) => timers.delete(t) },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        timers.delete(next);
        now = next.at;
        next.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

test('limiter: never more than 3 calls in any minute, however many wait', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ limit: 3, windowMs: 60000, now: clock.now, timer: clock.timer });
  const starts = [];
  const calls = Array.from({ length: 10 }, (_, i) => limiter.run(async () => { starts.push(clock.now()); return i; }));
  await flush();
  assert.deepEqual(starts, [0, 0, 0]);
  assert.equal(limiter.waiting, 7);
  await clock.advance(59999);
  assert.equal(starts.length, 3); // not a millisecond early
  await clock.advance(1);
  assert.equal(starts.length, 6);
  await clock.advance(5 * 60000);
  assert.deepEqual(await Promise.all(calls), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (let i = 3; i < starts.length; i++) assert.ok(starts[i] - starts[i - 3] >= 60000, `call ${i}`);
});

test('limiter: user actions jump the queue, a 429 pauses everything, failures still count', async () => {
  const clock = fakeClock();
  const limiter = createLimiter({ limit: 3, windowMs: 60000, now: clock.now, timer: clock.timer });
  const order = [];
  const job = (name, priority) => limiter.run(async () => { order.push(name); if (name === 'boom') throw new Error('boom'); }, priority);
  const all = [job('poll1'), job('poll2'), job('boom'), job('poll3'), job('poll4'), job('submit', 1)];
  const failed = assert.rejects(all[2], /boom/);
  await flush();
  assert.deepEqual(order, ['poll1', 'poll2', 'boom']);
  await failed;
  limiter.pause(120000); // the server said 429
  await clock.advance(119999);
  assert.equal(order.length, 3);
  await clock.advance(1);
  assert.deepEqual(order, ['poll1', 'poll2', 'boom', 'submit', 'poll3', 'poll4']);
  limiter.setLimit(10); // never raised above 3
  const more = [job('a'), job('b'), job('c'), job('d'), job('e')];
  await flush();
  assert.equal(order.length, 6); // this window is full
  await clock.advance(60000);
  assert.equal(order.length, 9);
  limiter.setLimit(1); // lowered when the account says so
  await clock.advance(60000);
  assert.equal(order.length, 10);
  await clock.advance(60000);
  await Promise.all(more);
  assert.deepEqual(order.slice(6), ['a', 'b', 'c', 'd', 'e']);
});

// Stand-ins for Electron's safeStorage.encryptString / decryptString.
const encrypt = (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`);
const decrypt = (buf) => {
  const s = buf.toString();
  if (!s.startsWith('enc:')) throw new Error('cannot decrypt');
  return Buffer.from(s.slice(4), 'base64').toString();
};

test('key store: the Tripo key saved by v0.3 moves into the new store and is never lost', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flatform-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(path.join(FIXTURES, 'v03-userdata'), dir, { recursive: true });
  const legacy = await readFile(path.join(dir, 'tripo-key.bin'));

  const store = createKeyStore({ dir, encrypt, decrypt });
  assert.equal(store.get('tripo'), 'tsk_saved_in_v03_0042');
  assert.equal(store.source('tripo'), 'saved');
  assert.equal(decrypt(await readFile(path.join(dir, 'keys', 'tripo.bin'))), 'tsk_saved_in_v03_0042'); // written to the new place
  assert.deepEqual(await readFile(path.join(dir, 'tripo-key.bin')), legacy); // the old file is kept as it was
  assert.equal((await readFile(path.join(dir, 'keys', 'tripo.bin'), 'utf8')).includes('tsk_'), false); // encrypted on disk

  // Next launch reads the new store; replacing the key writes it there.
  const again = createKeyStore({ dir, encrypt, decrypt });
  assert.equal(again.get('tripo'), 'tsk_saved_in_v03_0042');
  again.set('tripo', 'tsk_replaced_key_0099');
  assert.equal(createKeyStore({ dir, encrypt, decrypt }).get('tripo'), 'tsk_replaced_key_0099');

  // If the new file can't be written, the old location is still read.
  const fallback = await mkdtemp(path.join(tmpdir(), 'flatform-keys-'));
  t.after(() => rm(fallback, { recursive: true, force: true }));
  await cp(path.join(FIXTURES, 'v03-userdata'), fallback, { recursive: true });
  const locked = createKeyStore({ dir: fallback, encrypt, decrypt, canEncrypt: () => false });
  assert.equal(locked.get('tripo'), 'tsk_saved_in_v03_0042');
  assert.equal(existsSync(path.join(fallback, 'keys', 'tripo.bin')), false);
  assert.throws(() => locked.set('tripo', 'tsk_new_key_0001'), /securely/);

  // Remove deletes both files, so the old key can't come back.
  again.remove('tripo');
  assert.equal(again.get('tripo'), undefined);
  assert.equal(existsSync(path.join(dir, 'tripo-key.bin')), false);
  assert.equal(createKeyStore({ dir, encrypt, decrypt }).source('tripo'), 'none');
});

test('key store: 3D AI Studio key, environment fallback, unreadable files, memory only', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'flatform-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { THREE_D_AI_STUDIO_KEY: 'env-3das-key-0001', TRIPO_API_KEY: '' };
  const store = createKeyStore({ dir, encrypt, decrypt, env });
  assert.deepEqual([store.source('3daistudio'), store.get('3daistudio')], ['env', 'env-3das-key-0001']);
  assert.deepEqual([store.source('tripo'), store.get('tripo')], ['none', undefined]);
  store.set('3daistudio', 'saved-3das-key-0002');
  assert.deepEqual([store.source('3daistudio'), store.get('3daistudio')], ['saved', 'saved-3das-key-0002']);
  assert.equal(createKeyStore({ dir, encrypt, decrypt }).get('3daistudio'), 'saved-3das-key-0002');
  store.remove('3daistudio');
  assert.equal(store.source('3daistudio'), 'env');
  assert.throws(() => store.get('constructor'), /Unknown provider/);

  // A key encrypted by another user or machine is treated as missing, not a crash.
  store.set('tripo', 'tsk_will_break_0003');
  const broken = createKeyStore({ dir, encrypt, decrypt: () => { throw new Error('nope'); } });
  assert.equal(broken.source('tripo'), 'none');

  const memory = createKeyStore({ env });
  memory.set('tripo', 'tsk_memory_key_0004');
  assert.equal(memory.get('tripo'), 'tsk_memory_key_0004');
  assert.equal(memory.source('3daistudio'), 'env');
});
