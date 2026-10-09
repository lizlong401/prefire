(() => {
  'use strict';
  const CHANNEL = 'prefire-camera-v1';
  let frame = 0;
  let generation = 0;
  let route = location.pathname;
  const boardRoute = () => /^\/boards\/id\/[^/]+\/?$/.test(location.pathname);
  function stop() { generation++; cancelAnimationFrame(frame); }
  function discover(root) {
    for (const el of root.querySelectorAll('*')) {
      const store = Object.getOwnPropertyDescriptor(el, '_artboardSequenceStore')?.value;
      const camera = store && Object.getOwnPropertyDescriptor(store, '_canvasStore')?.value;
      if (camera && typeof camera.submitCanvasState === 'function' && camera.connected) return camera;
      if (el.shadowRoot) { const found = discover(el.shadowRoot); if (found) return found; }
    }
    return null;
  }
  function capture(camera) {
    const v = camera.renderViewport;
    const state = {tx: camera.tx, ty: camera.ty, scale: camera.scale,
      viewport: {x: v?.x, y: v?.y, width: v?.width, height: v?.height}};
    if (!valid(state)) throw new Error('Camera state is unavailable.');
    return state;
  }
  function valid(s) {
    return s && [s.tx, s.ty, s.scale, s.viewport?.x, s.viewport?.y,
      s.viewport?.width, s.viewport?.height].every(Number.isFinite) &&
      s.scale > 0 && s.viewport.width > 0 && s.viewport.height > 0;
  }
  function go(camera, target, preset = 'smooth') {
    if (!valid(target)) throw new Error('Invalid saved view.');
    stop();
    const run = generation;
    const path = location.pathname;
    const from = capture(camera);
    const tx = target.tx + from.viewport.x + from.viewport.width / 2 - target.viewport.x - target.viewport.width / 2;
    const ty = target.ty + from.viewport.y + from.viewport.height / 2 - target.viewport.y - target.viewport.height / 2;
    const durations = {smooth: 700, gentle: 1400, snappy: 350, instant: 0};
    const selectedDuration = Object.hasOwn(durations, preset) ? durations[preset] : 700;
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : selectedDuration;
    const start = performance.now();
    function tick(now) {
      if (run !== generation || path !== location.pathname || document.hidden || !camera.connected) return stop();
      const t = duration ? Math.min((now - start) / duration, 1) : 1;
      const e = preset === 'gentle'
        ? t * t * t * (t * (6 * t - 15) + 10)
        : preset === 'snappy' ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t);
      try {
        camera.submitCanvasState(from.tx + (tx - from.tx) * e,
          from.ty + (ty - from.ty) * e, from.scale + (target.scale - from.scale) * e);
      } catch { stop(); return; }
      if (t < 1) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== CHANNEL ||
        m.direction !== 'request' || typeof m.id !== 'string' || m.id.length > 100) return;
    if (!['status', 'capture', 'go', 'stop'].includes(m.action)) return;
    let value, error;
    try {
      if (!boardRoute() || m.path !== location.pathname) throw new Error('Open a Firefly board.');
      if (m.action === 'stop') { stop(); value = true; }
      else {
        const camera = discover(document);
        if (!camera) throw new Error('Waiting for Firefly camera. If this persists, Firefly may have changed.');
        if (m.action === 'go') { go(camera, m.state, m.transition); value = true; }
        else value = capture(camera);
      }
    } catch (e) { error = e.message; }
    window.postMessage({channel: CHANNEL, direction: 'response', id: m.id, value, error}, location.origin);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') stop(); }, true);
  document.addEventListener('wheel', stop, {capture: true, passive: true});
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('visibilitychange', stop);
  setInterval(() => { if (route !== location.pathname) { route = location.pathname; stop(); } }, 250);
})();
