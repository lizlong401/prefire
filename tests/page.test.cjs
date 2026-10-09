const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(reduced = false) {
  const listeners = {};
  const frames = new Map();
  const replies = [];
  const writes = [];
  let frameId = 0;
  const camera = {
    connected: true, tx: 100, ty: 200, scale: 1,
    renderViewport: {x: 0, y: 0, width: 1000, height: 800},
    submitCanvasState(tx, ty, scale) {
      writes.push({tx, ty, scale}); Object.assign(this, {tx, ty, scale});
    }
  };
  const node = {_artboardSequenceStore: {_canvasStore: camera}};
  const location = {origin: 'https://firefly.adobe.com', pathname: '/boards/id/example'};
  const document = {
    hidden: false,
    querySelectorAll: () => [{shadowRoot: {querySelectorAll: () => [node]}}],
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  const window = {
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { replies.push(message); }
  };
  vm.runInNewContext(fs.readFileSync('extension/page.js', 'utf8'), {
    window, document, location, performance: {now: () => 0},
    matchMedia: () => ({matches: reduced}), setInterval: () => {},
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  function request(action, state, path = location.pathname) {
    listeners.message({source: window, origin: location.origin, data: {
      channel: 'prefire-camera-v1', direction: 'request', id: 'test', action, state, path
    }});
    return replies.at(-1);
  }
  function tick(time) {
    const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(time));
  }
  return {camera, request, tick, writes, listeners, location, document};
}
const target = {tx: 500, ty: 600, scale: 2,
  viewport: {x: 0, y: 0, width: 1000, height: 800}};

test('captures actual camera through an open shadow root', () => {
  const h = setup();
  assert.equal(h.request('capture').value.tx, 100);
});
test('animates to exact saved state and preserves center after viewport resize', () => {
  const h = setup(); h.camera.renderViewport.width = 1200;
  assert.equal(h.request('go', target).value, true);
  h.tick(350); assert.equal(h.camera.tx, 350);
  h.tick(700);
  assert.deepEqual(h.writes.at(-1), {tx: 600, ty: 600, scale: 2});
});
test('manual input cancels animation', () => {
  const h = setup(); h.request('go', target); h.tick(100);
  const count = h.writes.length;
  h.listeners.wheel(); h.tick(700);
  assert.equal(h.writes.length, count);
});
test('route changes prevent a queued camera write', () => {
  const h = setup(); h.request('go', target);
  h.location.pathname = '/boards/id/other'; h.tick(700);
  assert.equal(h.writes.length, 0);
});
test('reduced motion jumps in one frame', () => {
  const h = setup(true); h.request('go', target); h.tick(0);
  assert.deepEqual(h.writes, [{tx: 500, ty: 600, scale: 2}]);
});
test('rejects malformed state and stale document requests', () => {
  const h = setup();
  assert.match(h.request('go', {...target, scale: -1}).error, /Invalid/);
  assert.match(h.request('capture', undefined, '/boards/id/other').error, /Open/);
  assert.equal(h.writes.length, 0);
});
test('reports unavailable camera', () => {
  const h = setup(); h.camera.connected = false;
  assert.match(h.request('status').error, /Waiting/);
});
