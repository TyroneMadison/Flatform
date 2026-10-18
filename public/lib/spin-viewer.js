/* Flatform spin viewer. MIT licensed, no dependencies.
   Turns a Flatform sprite sheet with drag, swipe or the arrow keys. 360 sheets loop, 180 sheets stop at both ends.
   The poster shows until the sheet has loaded.

     <div data-flatform-spin="web/transparent-sprite-360.json" data-size="256"></div>
     <script src="spin-viewer.js"></script>

   data-size picks the 512 or 256 sheet. data-flatform-spin can also hold the json itself (then data-base gives the
   folder its file names are relative to), which is how viewer.html works when opened straight from disk.
   From script: FlatformSpin.mount(element, urlOrManifest, { size, base }). */
(function () {
  function mount(el, src, opts) {
    opts = opts || {};
    var inline = typeof src === 'object' || /^\s*\{/.test(src);
    var base = new URL(inline ? opts.base || './' : src, document.baseURI);
    var load = inline ? Promise.resolve(typeof src === 'object' ? src : JSON.parse(src)) : fetch(base).then(function (r) { return r.json(); });
    return load.then(function (m) {
      var url = function (name) { return new URL(name, base).href; };
      var frame = 0;
      var ready = false;
      var dragX = null;
      var dragFrame = 0;
      el.tabIndex = 0;
      el.setAttribute('role', 'slider');
      el.setAttribute('aria-label', m.name + ', ' + (m.loop ? '360' : '180') + '° view. Drag or use the arrow keys to turn.');
      el.setAttribute('aria-valuemin', '0');
      el.setAttribute('aria-valuemax', String(m.frames - 1));
      el.style.aspectRatio = m.frameWidth + ' / ' + m.frameHeight;
      el.style.background = 'url("' + url(m.poster) + '") center / contain no-repeat';
      el.style.touchAction = 'pan-y';
      el.style.cursor = 'grab';
      el.style.userSelect = 'none';

      function show(f) {
        frame = m.loop ? ((f % m.frames) + m.frames) % m.frames : Math.max(0, Math.min(m.frames - 1, f));
        el.setAttribute('aria-valuenow', String(frame));
        el.setAttribute('aria-valuetext', frame * m.degreesPerFrame + '°');
        if (!ready) return;
        var col = frame % m.columns;
        var row = Math.floor(frame / m.columns);
        el.style.backgroundPosition = (m.columns > 1 ? (col / (m.columns - 1)) * 100 : 0) + '% ' + (m.rows > 1 ? (row / (m.rows - 1)) * 100 : 0) + '%';
      }

      var sheet = url((m.sheets && m.sheets[opts.size || 512]) || m.sheet);
      var img = new Image();
      img.onload = function () {
        ready = true;
        el.style.background = 'url("' + sheet + '") 0 0 / ' + m.columns * 100 + '% ' + m.rows * 100 + '% no-repeat';
        show(frame);
      };
      img.src = sheet;

      // Dragging across the whole viewer turns the car half way round.
      el.addEventListener('pointerdown', function (e) {
        dragX = e.clientX;
        dragFrame = frame;
        el.setPointerCapture(e.pointerId);
        el.style.cursor = 'grabbing';
      });
      el.addEventListener('pointermove', function (e) {
        if (dragX !== null) show(dragFrame - Math.round((e.clientX - dragX) / (el.clientWidth / 36)));
      });
      function end() { dragX = null; el.style.cursor = 'grab'; }
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('keydown', function (e) {
        var step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (step) show(frame + step);
        else if (e.key === 'Home') show(0);
        else if (e.key === 'End') show(m.frames - 1);
        else return;
        e.preventDefault();
      });
      show(0);
    });
  }

  window.FlatformSpin = { mount: mount };
  var nodes = document.querySelectorAll('[data-flatform-spin]');
  for (var i = 0; i < nodes.length; i++) {
    mount(nodes[i], nodes[i].getAttribute('data-flatform-spin'), { size: Number(nodes[i].getAttribute('data-size')) || 512, base: nodes[i].getAttribute('data-base') || './' });
  }
})();
