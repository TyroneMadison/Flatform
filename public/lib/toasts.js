// Toasts never stack the same words twice and never pile up: app.js toast() asks here what to do. Pure for tests.
export const MAX_TOASTS = 3;
/**
 * shown: the words of the toasts on screen, oldest first. Returns { same } (the index of a toast with these words:
 * refresh it, don't add one) or { drop } (how many of the oldest to take away before adding the new one).
 */
export function toastPlan(shown, msg, max = MAX_TOASTS) {
  const same = shown.indexOf(msg);
  return same >= 0 ? { same } : { drop: Math.max(0, shown.length + 1 - max) };
}
