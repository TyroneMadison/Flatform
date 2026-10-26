// Quick hover tips: every control's title shows in a small app-styled box after a short pause, instead of the slow
// grey browser one. The markup keeps title="…" (screen readers and tests read it); on hover it moves to data-tip.
export const TIP_DELAY = 250;
// A title anywhere, or a named control (an icon button's aria-label is its tip).
export const TIP_TARGETS = '[title], [data-tip], :is(button, a, input, select, textarea)[aria-label]';

/** Where the tip goes: above the control, or below it when there is no room; kept inside the window. */
export function placeTip(r, w, h, vw, gap = 8) {
  const above = r.top - h - gap >= 4;
  const top = above ? r.top - h - gap : r.bottom + gap;
  const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), vw - w - 4);
  return { top: Math.round(top), left: Math.round(left), above };
}

export function installTips(doc = document) {
  const box = doc.createElement('div');
  box.className = 'tip';
  box.setAttribute('role', 'tooltip');
  box.id = 'appTip';
  box.hidden = true;
  doc.body.append(box);
  let timer = 0, on = null;
  const hide = () => { clearTimeout(timer); box.hidden = true; on?.removeAttribute('aria-describedby'); on = null; };
  const take = (el) => { // title → data-tip, so the browser's own tip never shows as well
    if (el.hasAttribute('title')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
    return el.dataset.tip || el.getAttribute('aria-label');
  };
  const show = (el) => {
    const text = take(el);
    if (!text || !el.isConnected) return;
    on = el;
    box.textContent = text;
    box.classList.toggle('one', el.hasAttribute('data-tip-one')); // a tip that must stay on one line
    box.hidden = false;
    const p = placeTip(el.getBoundingClientRect(), box.offsetWidth, box.offsetHeight, doc.documentElement.clientWidth);
    box.style.top = `${p.top}px`;
    box.style.left = `${p.left}px`;
    el.setAttribute('aria-describedby', box.id);
  };
  const target = (e) => e.target.closest?.(TIP_TARGETS);
  doc.addEventListener('pointerover', (e) => {
    const el = target(e);
    if (!el || el === on) return;
    hide();
    take(el);
    timer = setTimeout(() => show(el), TIP_DELAY);
  });
  doc.addEventListener('pointerout', (e) => { const el = target(e); if (el && !el.contains(e.relatedTarget)) hide(); });
  doc.addEventListener('focusin', (e) => { const el = target(e); if (el?.matches(':focus-visible')) { hide(); show(el); } });
  doc.addEventListener('focusout', hide);
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'wheel']) doc.addEventListener(ev, hide, true);
  doc.defaultView?.addEventListener('hashchange', hide); // a new screen: the old control is gone
  return { hide };
}
