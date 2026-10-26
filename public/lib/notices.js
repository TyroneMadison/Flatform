// The two notices that used to be banners (v3: a toast plus a quiet top-bar marker). Pure, so node tests can check
// the words and when they show. app.js shows the toasts, the "Update ready" pill and the amber account dot.

/** A newer Flatform: { version, title, note } while it is newer and not skipped, else null. display: version → text. */
export function updateNotice(u, display = String) {
  if (!u?.newer || u.skipped) return null;
  const version = display(u.latest);
  return { version: u.latest, title: `Flatform ${version} is ready`, note: u.notes || 'A newer version is ready to download.', pill: `Update ${version}` };
}

/** The first service under its alert: { service, title, note, dot } or null. providers: { id: { name } }. */
export function lowNotice(spend, providers, fmt = String) {
  const low = Object.entries(spend?.services || {}).filter(([, s]) => s.low);
  if (!low.length) return null;
  const [service, s] = low[0];
  const name = providers[service]?.name || service;
  const note = [`${fmt(s.balance)} credits left, under your alert of ${fmt(s.threshold)}`,
    s.daysLeft != null && `about ${s.daysLeft} days at this pace`, low.length > 1 && `${providers[low[1][0]]?.name || low[1][0]} is low too`].filter(Boolean).join(' · ');
  return { service, title: `${name} balance is low`, note, dot: `${name}: ${fmt(s.balance)} credits left. Click to top up.` };
}
