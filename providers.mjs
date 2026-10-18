// 3D AI Studio client and the rate limiter every call to it goes through. The API allows 3 requests a minute per
// key (429 "rate_limited" beyond that), counting job submissions, status polls and wallet checks alike.

/**
 * Starts at most `limit` calls in any `windowMs` (a sliding window), however many are waiting. Waiting calls run
 * highest priority first, then in order. `now` and `timer` can be swapped for a fake clock.
 */
export function createLimiter({ limit = 3, windowMs = 62000, now = Date.now, timer = { set: setTimeout, clear: clearTimeout } } = {}) {
  const started = []; // start times still inside the window
  const queue = [];
  let wake = null;
  let pausedUntil = 0;
  function pump() {
    if (wake) timer.clear(wake);
    wake = null;
    while (queue.length) {
      const t = now();
      while (started.length && started[0] + windowMs <= t) started.shift();
      if (started.length >= limit || t < pausedUntil) {
        const at = Math.max(pausedUntil, started.length >= limit ? started[0] + windowMs : 0);
        wake = timer.set(pump, at - t);
        wake?.unref?.(); // a waiting call never keeps the process alive on its own
        return;
      }
      const job = queue.shift();
      started.push(t);
      Promise.resolve().then(job.fn).then(job.resolve, job.reject);
    }
  }
  return {
    windowMs,
    run(fn, priority = 0) {
      return new Promise((resolve, reject) => {
        const job = { fn, priority, resolve, reject };
        const i = queue.findIndex((q) => q.priority < priority);
        if (i < 0) queue.push(job);
        else queue.splice(i, 0, job);
        pump();
      });
    },
    // After a 429: someone else is using the key too, so wait a whole window.
    pause(ms = windowMs) { pausedUntil = Math.max(pausedUntil, now() + ms); pump(); },
    // The account may have a lower limit than 3; never a higher one.
    setLimit(n) { if (Number.isInteger(n) && n > 0) { limit = Math.min(limit, n); pump(); } },
    get waiting() { return queue.length; },
  };
}

export class ProviderError extends Error {
  constructor(status, message, upstream) { super(message); this.status = status; this.upstream = upstream; }
}

// Error bodies come as { error_code, errors: { field: [messages] } }, { message } or { detail }.
function errorText(out, status) {
  const fields = out.errors && typeof out.errors === 'object' ? Object.entries(out.errors).map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`).join('; ') : '';
  return String(out.message || out.detail || (typeof out.error === 'string' ? out.error : out.error?.message) || fields || out.error_code || `HTTP ${status}`).slice(0, 300);
}

export const THREE_D_AI_BASE = 'https://api.3daistudio.com';
export const LOW = 0; // status polls and balance refreshes
export const HIGH = 1; // something the user just clicked

/** key(): the current API key or undefined. */
export function threeDAIStudio({ base = THREE_D_AI_BASE, key, limiter = createLimiter() }) {
  async function call(route, { json, priority = LOW, apiKey = key() } = {}) {
    if (!apiKey) throw new ProviderError(401, 'Add your 3D AI Studio API key first');
    for (let attempt = 0; ; attempt++) {
      const res = await limiter.run(() => fetch(base + route, {
        method: json ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, ...(json && { 'Content-Type': 'application/json' }) },
        body: json ? JSON.stringify(json) : undefined,
      }), priority);
      const out = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt < 2) { limiter.pause(); continue; } // nothing was charged; try again after a window
      if (!res.ok) {
        const status = { 400: 400, 401: 401, 402: 402, 404: 404, 410: 410, 429: 429 }[res.status] || 502;
        const text = { 401: 'the API key was not accepted', 402: 'not enough credits', 429: 'too many requests, try again in a minute' }[res.status] || errorText(out, res.status);
        throw new ProviderError(status, `3D AI Studio: ${text}`, res.status);
      }
      return out;
    }
  }
  return {
    limiter,
    submit: (path, body) => call(path, { json: body, priority: HIGH }), // → { task_id, created_at }
    status: (id) => call(`/v1/generation-request/${encodeURIComponent(id)}/status/`), // → { status, progress, failure_reason, results }
    async wallet({ apiKey, priority = LOW } = {}) {
      const out = await call('/account/user/wallet/', { apiKey, priority });
      const balance = Number(out.balance);
      if (!Number.isFinite(balance)) throw new ProviderError(502, '3D AI Studio: unexpected balance reply');
      const rateLimit = Number.isInteger(out.rate_limit) && out.rate_limit > 0 ? out.rate_limit : null;
      if (rateLimit && !apiKey) limiter.setLimit(rateLimit);
      return { balance, rateLimit };
    },
    // Result files are on a storage host; only calls to the API host itself count towards the limit.
    fetchAsset: (url) => (new URL(url).origin === new URL(base).origin ? limiter.run(() => fetch(url)) : fetch(url)),
  };
}
