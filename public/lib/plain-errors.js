// Turns a provider or network error into one short, plain sentence. The full text stays available under Details.
const RULES = [
  [/face_limit|face limit/i, (m) => (/smart_low_poly|low poly/i.test(m)
    ? 'The detail level was too high for game-ready low detail. Pick 10,000 pieces or less and try again.'
    : 'The detail level was outside what this engine allows. Pick a lower one and try again.')],
  [/insufficient|not enough credit|balance|402\b|payment/i, () => 'Not enough credits. Top up, then try again.'],
  [/\b401\b|unauthori[sz]ed|invalid (api )?key|api key|forbidden|\b403\b/i, () => 'The key was not accepted. Check it in Settings.'],
  [/\b429\b|rate limit|too many requests/i, () => 'Too many requests at once. Wait a minute and try again.'],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|offline/i, () => 'Could not reach the service. Check your internet and try again.'],
  [/timed? ?out|timeout/i, () => 'It took too long. Try again.'],
  [/expired|kept 24|no longer/i, () => 'The result expired before it was saved. Try again.'],
  [/image|photo/i, (m) => (/too (large|big)|size/i.test(m) ? 'The photo is too big. Use one under 20 MB.' : '')],
];

/** One plain sentence for an error message (max about 100 characters). */
export function plainError(message) {
  const m = String(message ?? '').trim();
  if (!m) return 'Something went wrong. Try again.';
  for (const [re, say] of RULES) if (re.test(m)) { const s = say(m); if (s) return s; }
  const first = m.replace(/^(Error|Tripo|3D AI Studio|Local engine):\s*/i, '').split(/(?<=[.!?])\s/)[0];
  return first.length > 100 ? `${first.slice(0, 97).trimEnd()}…` : first;
}
