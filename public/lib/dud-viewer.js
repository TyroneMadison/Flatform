/* spin-viewer.js: drag to turn a car sprite sheet. Plain JavaScript, no libraries.
 *
 * Markup (the sheet files sit next to the json):
 *   <div data-spin="/cars/corvette-z06/transparent/sprite-360.json" data-size="512" data-autoplay="12"></div>
 * Or from code, with the json already loaded:
 *   SpinViewer.mount(element, spriteJson, { base: '/cars/corvette-z06/transparent/', size: '256', autoplay: 0 })
 *
 * 360 sheets loop. 180 sheets stop at each end. The poster shows until the sheet loads.
 * Pointer events cover mouse, pen and touch. Left and right arrow keys step one frame.
 */
(function () {
  'use strict';

  function mount(el, s, opt) {
    opt = opt || {};
    var base = opt.base || '';
    var f = s.files[opt.size || '512'] || s.files['512'];
    var sheetUrl = base + (f.webp || f.png);
    var n = s.frameCount, cols = s.columns, rows = s.rows, loop = s.loop;
    var perWidth = 180 / s.degreesPerFrame; // one full-width drag turns the car 180 degrees
    var frame = 0, ready = false, timer = null, touched = false;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    el.classList.add('spin-viewer');
    var st = el.style;
    st.aspectRatio = s.frameWidth + ' / ' + s.frameHeight;
    st.backgroundImage = 'url("' + base + s.poster.webp + '")';
    st.backgroundSize = '100% 100%';
    st.backgroundRepeat = 'no-repeat';
    st.touchAction = 'pan-y'; // phones still scroll the page up and down
    st.userSelect = 'none';
    st.cursor = 'grab';
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', (s.carName || 'Car') + ', ' + s.turn + ' degree view');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', String((n - 1) * s.degreesPerFrame));

    function draw() {
      el.setAttribute('aria-valuenow', String(frame * s.degreesPerFrame));
      el.setAttribute('aria-valuetext', frame * s.degreesPerFrame + ' degrees');
      if (!ready) return;
      var c = frame % cols, r = Math.floor(frame / cols);
      st.backgroundPosition = (cols > 1 ? c / (cols - 1) * 100 : 0) + '% ' + (rows > 1 ? r / (rows - 1) * 100 : 0) + '%';
    }
    function go(i) {
      frame = loop ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
      draw();
    }
    function play() {
      if (loop && opt.autoplay && !reduce && !touched && !timer) {
        timer = setInterval(function () { go(frame + 1); }, 1000 / opt.autoplay);
      }
    }
    function stop() { clearInterval(timer); timer = null; }
    function user() { touched = true; stop(); }

    var img = new Image();
    img.onload = function () {
      ready = true;
      st.backgroundImage = 'url("' + sheetUrl + '")';
      st.backgroundSize = cols * 100 + '% ' + rows * 100 + '%';
      draw();
    };
    img.src = sheetUrl;

    var dragging = false, startX = 0, startFrame = 0;
    el.addEventListener('pointerdown', function (e) {
      user();
      dragging = true;
      startX = e.clientX;
      startFrame = frame;
      el.setPointerCapture(e.pointerId);
      st.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', function (e) {
      if (dragging) go(startFrame + Math.round((e.clientX - startX) / (el.clientWidth / perWidth)));
    });
    function end() { dragging = false; st.cursor = 'grab'; }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { user(); go(frame + d); e.preventDefault(); }
    });

    if (opt.autoplay && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es[0].isIntersecting ? play() : stop(); }).observe(el);
    } else {
      play();
    }
    draw();
    return { go: go, play: play, stop: stop };
  }

  function auto() {
    var els = document.querySelectorAll('[data-spin]');
    Array.prototype.forEach.call(els, function (el) {
      var url = el.getAttribute('data-spin');
      fetch(url).then(function (r) { return r.json(); }).then(function (s) {
        mount(el, s, {
          base: url.slice(0, url.lastIndexOf('/') + 1),
          size: el.getAttribute('data-size') || '512',
          autoplay: Number(el.getAttribute('data-autoplay')) || 0
        });
      });
    });
  }

  window.SpinViewer = { mount: mount };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})();
