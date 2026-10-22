// Unit tests for the spend ledger math (ledger.mjs). Local times throughout, like the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../ledger.mjs';
import { estimate } from '../public/lib/pricing.js';
import { presetConfig } from '../public/lib/engines.js';

const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h).toISOString();
const NOW = new Date(2026, 9, 21, 15); // Wednesday 21 October 2026, 3 pm
const e = (ts, service, credits, model = 'm', extra = {}) => L.entry({ ts, service, task: 'image_to_model', model, credits, ...extra });

test('an entry has usd, delta and unlogged charges', () => {
  const x = L.entry({ service: 'tripo', task: 'image_to_model', model: 'v3.1', credits: 30, balanceBefore: 1000, balanceAfter: 960, taskId: 't1', modelId: 'm1' });
  assert.deepEqual([x.usd, x.delta, x.unlogged, x.taskId, x.modelId], [0.3, 40, 10, 't1', 'm1']);
  assert.match(x.ts, /^\d{4}-\d\d-\d\dT/);
  assert.equal(L.entry({ service: 'tripo', credits: 30, balanceBefore: 1000, balanceAfter: 980 }).unlogged, 0); // charged less: nothing unlogged
  const unknown = L.entry({ service: '3daistudio', credits: 40, balanceBefore: null, balanceAfter: 500 });
  assert.deepEqual([unknown.delta, unknown.unlogged], [null, null]);
});

test('parse skips torn and foreign lines', () => {
  const good = JSON.stringify(e(at(2026, 10, 21), 'tripo', 30));
  assert.equal(L.parse(`${good}\n{"broken\n${JSON.stringify({ service: 'other', ts: at(2026, 10, 21) })}\n\n${good}\n`).length, 2);
});

test('totals per service: today, week (from Monday), month and all time', () => {
  const list = [
    e(at(2026, 10, 21, 9), 'tripo', 30), // today
    e(at(2026, 10, 19, 0), 'tripo', 20), // Monday 00:00: this week
    e(at(2026, 10, 18, 23), 'tripo', 10), // Sunday 23:00: last week, this month
    e(at(2026, 10, 1, 0), 'tripo', 5), // first of the month
    e(at(2026, 9, 30, 23), 'tripo', 100), // last month
    e(at(2026, 10, 21), '3daistudio', 40, 'hitem3d', { balanceBefore: 500, balanceAfter: 445 }),
  ];
  const t = L.totals(list, NOW);
  assert.deepEqual([t.tripo.today.credits, t.tripo.week.credits, t.tripo.month.credits, t.tripo.all.credits], [30, 50, 65, 165]);
  assert.deepEqual([t.tripo.today.calls, t.tripo.all.usd], [1, 1.65]);
  assert.deepEqual([t['3daistudio'].today.credits, t['3daistudio'].unlogged, t.tripo.unlogged], [40, 15, 0]);
});

test('a Monday counts as the start of its own week; Sunday belongs to the week before', () => {
  const monday = new Date(2026, 9, 19, 8);
  const sunday = new Date(2026, 9, 25, 22);
  const list = [e(at(2026, 10, 19, 1), 'tripo', 7), e(at(2026, 10, 18, 22), 'tripo', 3)];
  assert.equal(L.totals(list, monday).tripo.week.credits, 7);
  assert.equal(L.totals(list, sunday).tripo.week.credits, 7);
});

test('daily series: 30 days oldest first, credits per service', () => {
  const rows = L.daily([e(at(2026, 10, 21, 1), 'tripo', 30), e(at(2026, 10, 21, 2), '3daistudio', 40), e(at(2026, 9, 22), 'tripo', 9), e(at(2026, 9, 21), 'tripo', 99)], NOW);
  assert.equal(rows.length, 30);
  assert.deepEqual(rows.at(-1), { day: '2026-10-21', tripo: 30, '3daistudio': 40, usd: 0.7 });
  assert.deepEqual([rows[0].day, rows[0].tripo], ['2026-09-22', 9]); // 30 days ago is out
});

test('cost per model, most spent first', () => {
  const rows = L.perModel([e(at(2026, 10, 21), 'tripo', 30, 'v3.1'), e(at(2026, 10, 20), 'tripo', 30, 'v3.1'), e(at(2026, 10, 20), '3daistudio', 150, 'hitem3d')]);
  assert.deepEqual(rows.map((r) => [r.service, r.model, r.calls, r.credits]), [['3daistudio', 'hitem3d', 1, 150], ['tripo', 'v3.1', 2, 60]]);
});

test('7-day burn and days left', () => {
  const list = [e(at(2026, 10, 21), 'tripo', 40), e(at(2026, 10, 15, 1), 'tripo', 30), e(at(2026, 10, 14, 23), 'tripo', 1000)];
  assert.equal(L.burn(list, 'tripo', NOW), 10); // 70 over the 7 days from the 15th
  assert.equal(L.daysLeft(95, 10), 9);
  assert.equal(L.daysLeft(95, 0), null);
  assert.equal(L.daysLeft(null, 10), null);
});

test('low-balance threshold defaults to ten default generations', () => {
  for (const s of L.SERVICES) assert.equal(L.defaultThreshold(s), 10 * estimate(presetConfig(s, 'balanced')).credits);
  const sum = L.summary([e(at(2026, 10, 21), 'tripo', 70)], { now: NOW, balances: { tripo: 50, '3daistudio': null }, thresholds: { tripo: 100 } });
  assert.deepEqual([sum.services.tripo.low, sum.services.tripo.daysLeft, sum.services.tripo.threshold], [true, 5, 100]);
  assert.deepEqual([sum.services['3daistudio'].low, sum.services['3daistudio'].threshold], [false, L.defaultThreshold('3daistudio')]);
  assert.equal(sum.daily.length, 30);
});
