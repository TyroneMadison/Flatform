import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planJobs, createQueue, safeFolder } from '../batch.mjs';

test('batch: N presets x outputs makes the right job count, one folder per preset', () => {
  const jobs = planJobs({ modelId: 'm', variants: [{ id: 'a', name: 'Orokin Gold' }, { id: 'b', name: 'Night/Ops' }, { id: 'c' }], outputs: ['still', 'glb', 'glb', 'bogus'] });
  assert.equal(jobs.length, 6);
  assert.equal(jobs[0].folder, 'Orokin Gold');
  assert.equal(safeFolder('Night/Ops'), 'Night-Ops');
  assert.throws(() => planJobs({ variants: [], outputs: ['still'] }));
  assert.throws(() => planJobs({ variants: [{ id: 'a' }], outputs: [] }));
});

test('batch: status transitions, retry, cancel and reload after a crash', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'batch.json');
  const q = createQueue({ file });
  await q.start({ modelId: 'm', variants: [{ id: 'a' }, { id: 'b' }], outputs: ['still'] });
  await assert.rejects(q.start({ modelId: 'm', variants: [{ id: 'a' }], outputs: ['still'] }), /already running/);
  const [a, b] = q.view().jobs;
  await q.set(a.id, 'running');
  await q.set(a.id, 'failed', 'GPU lost');
  assert.equal(q.view().counts.failed, 1);
  await assert.rejects(q.set(a.id, 'done'), /Can't go/);
  await q.retryFailed();
  assert.equal(q.view().jobs[0].status, 'queued');
  await q.set(b.id, 'running');
  // crash: a new queue reads the file and puts the running job back in the queue
  const q2 = createQueue({ file });
  const v = await q2.load();
  assert.equal(v.jobs.length, 2);
  assert.ok(v.jobs.every((j) => j.status === 'queued'));
  assert.equal(v.jobs[1].tries, 1);
  await q2.cancelAll();
  assert.equal(q2.view().counts.cancelled, 2);
  await q2.clear();
  assert.equal(q2.view().jobs.length, 0);
});
