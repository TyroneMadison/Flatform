// Spend ledger: one JSON line per paid call (spend.jsonl in the library folder), with the provider balance just before
// and just after it, and the math for Settings → Spend. Everything here is pure except append(); times are local.
import { appendFile } from 'node:fs/promises';
import { estimate } from './public/lib/pricing.js';
import { presetConfig } from './public/lib/engines.js';

export const SERVICES = ['tripo', '3daistudio'];
// ponytail: USD per credit is guessed from the providers' top-up packs (about 100 credits per US dollar for both);
// neither API reports it. Fix here if a pack price changes.
export const USD_PER_CREDIT = { tripo: 0.01, '3daistudio': 0.01 };
// ponytail: Tripo's format conversion price is not in pricing.js or Tripo's price list we copied; 5 is a guess. The
// balance snapshots catch the difference as "unlogged" if it is wrong.
export const CONVERT_CREDITS = 5;
const ALERT_GENERATIONS = 10; // the default low-balance alert: about this many default generations

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
const round = (n) => Math.round(n * 100) / 100;
export const usdOf = (service, credits) => (num(credits) == null ? null : round(credits * (USD_PER_CREDIT[service] ?? 0)));

/** A ledger line. delta = balanceBefore - balanceAfter; unlogged = what the balance lost beyond credits (0 if nothing, null if unknown). */
export function entry({ ts = new Date().toISOString(), service, task, model, credits = null, balanceBefore = null, balanceAfter = null, taskId = null, modelId = null }) {
  const before = num(balanceBefore);
  const after = num(balanceAfter);
  const delta = before != null && after != null ? round(before - after) : null;
  const unlogged = delta == null || num(credits) == null ? null : Math.max(0, round(delta - credits));
  return { ts, service, task, model, credits: num(credits), usd: usdOf(service, credits), balanceBefore: before, balanceAfter: after, delta, unlogged, taskId, modelId };
}

export const append = (file, e) => appendFile(file, JSON.stringify(e) + '\n');

// A torn or hand-edited line is skipped, never fatal.
export function parse(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    try { const e = JSON.parse(line); if (e && SERVICES.includes(e.service) && !Number.isNaN(Date.parse(e.ts))) out.push(e); } catch { /* skip */ }
  }
  return out;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// What a call really cost: the balance drop when both snapshots exist, else the estimate.
export const actualOf = (e) => (num(e.delta) != null && e.delta >= 0 ? e.delta : num(e.credits) || 0);

function sum(list, service) {
  const credits = round(list.reduce((s, e) => s + (num(e.credits) || 0), 0));
  const actualCredits = round(list.reduce((s, e) => s + actualOf(e), 0));
  return { credits, usd: usdOf(service, credits), actualCredits, actualUsd: usdOf(service, actualCredits), calls: list.length };
}

/** Per service: { today, week, month, all } of { credits, usd, calls }, plus unlogged credits over all time. */
export function totals(entries, now = new Date()) {
  const out = {};
  for (const service of SERVICES) {
    const mine = entries.filter((e) => e.service === service);
    const since = (from) => mine.filter((e) => new Date(e.ts) >= from);
    out[service] = {
      today: sum(since(startOfDay(now)), service), week: sum(since(startOfWeek(now)), service),
      month: sum(since(startOfMonth(now)), service), all: sum(mine, service),
      unlogged: round(mine.reduce((s, e) => s + (num(e.unlogged) || 0), 0)),
    };
  }
  return out;
}

/** The last `days` days, oldest first: [{ day, tripo, 3daistudio, usd }] in credits per service. */
export function daily(entries, now = new Date(), days = 30) {
  const rows = Array.from({ length: days }, (_, i) => ({ day: dayKey(addDays(now, i - days + 1)), ...Object.fromEntries(SERVICES.map((s) => [s, 0])), usd: 0 }));
  const byDay = new Map(rows.map((r) => [r.day, r]));
  for (const e of entries) {
    const r = byDay.get(dayKey(new Date(e.ts)));
    if (!r) continue;
    r[e.service] = round(r[e.service] + (num(e.credits) || 0));
    r.usd = round(r.usd + (num(e.usd) || 0));
  }
  return rows;
}

/** [{ service, model, calls, credits, usd }], most spent first. */
export function perModel(entries) {
  const groups = new Map();
  for (const e of entries) {
    const k = `${e.service}\0${e.model}`;
    if (!groups.has(k)) groups.set(k, { service: e.service, model: e.model ?? 'unknown', list: [] });
    groups.get(k).list.push(e);
  }
  return [...groups.values()].map(({ service, model, list }) => ({ service, model, ...sum(list, service) })).sort((a, b) => b.credits - a.credits);
}

/** Average credits a day over the last 7 days (today included). */
export function burn(entries, service, now = new Date(), days = 7) {
  const from = addDays(startOfDay(now), 1 - days);
  return round(entries.filter((e) => e.service === service && new Date(e.ts) >= from).reduce((s, e) => s + (num(e.credits) || 0), 0) / days);
}

export const daysLeft = (balance, perDay) => (num(balance) != null && perDay > 0 ? Math.floor(balance / perDay) : null);

/** Default low-balance alert: ten generations with the provider's default (Balanced) setup. */
export const defaultThreshold = (service) => ALERT_GENERATIONS * estimate(presetConfig(service, 'balanced')).credits;
export const defaultThresholds = () => Object.fromEntries(SERVICES.map((s) => [s, defaultThreshold(s)]));
export const isLow = (balance, threshold) => num(balance) != null && num(threshold) != null && balance < threshold;

/** Everything Settings → Spend and the low-balance banner show. balances, thresholds: per service (null when unknown). */
export function summary(entries, { now = new Date(), balances = {}, thresholds = {} } = {}) {
  const t = totals(entries, now);
  const services = {};
  for (const s of SERVICES) {
    const balance = num(balances[s]);
    const threshold = num(thresholds[s]) ?? defaultThreshold(s);
    const perDay = burn(entries, s, now);
    services[s] = { ...t[s], balance, threshold, burn: perDay, daysLeft: daysLeft(balance, perDay), low: isLow(balance, threshold) };
  }
  return { services, daily: daily(entries, now), models: perModel(entries), usdPerCredit: USD_PER_CREDIT };
}
