(() => {
  'use strict';
  const CHANNEL = 'prefire-inventory-v1';
  const validImage = value => typeof value === 'string' && value.length < 10000 &&
    (/^https:\/\//.test(value) || /^blob:https:\/\/firefly\.adobe\.com\//.test(value));
  function scan() {
    const stores = [];
    function discover(root) {
      for (const node of root.querySelectorAll('*')) {
        const store = Object.getOwnPropertyDescriptor(node, '_artboardSequenceStore')?.value;
        if (store) stores.push(store);
        if (node.shadowRoot) discover(node.shadowRoot);
      }
    }
    discover(document);
    const images = new Map(), seen = new WeakSet();
    let visited = 0, limited = false;
    function walk(value, depth, label = '') {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      if (depth > 12 || ++visited > 25000) { limited = true; return; }
      seen.add(value);
      if (value instanceof Map || value instanceof Set) {
        for (const entry of value.values()) walk(entry, depth + 1, label);
        return;
      }
      // Read data descriptors only; do not execute Adobe getters or call mutation methods.
      const fields = Object.getOwnPropertyDescriptors(value);
      const ownName = fields.name?.value || fields.title?.value || fields.label?.value;
      const name = typeof ownName === 'string' ? ownName.slice(0, 80) : label;
      for (const [key, descriptor] of Object.entries(fields)) {
        if (!Object.hasOwn(descriptor, 'value')) continue;
        const entry = descriptor.value;
        if (validImage(entry) && (/image|thumbnail|src/i.test(key) ||
            (/url|uri/i.test(key) && /\.(png|jpe?g|webp|avif)(\?|$)/i.test(entry)))) {
          if (!images.has(entry)) images.set(entry, {id: entry, url: entry, name: name || 'Board image ' + (images.size + 1)});
        } else if (typeof entry === 'object' && entry && !/camera|canvas|parent|window|document/i.test(key)) {
          walk(entry, depth + 1, name);
        }
        if (images.size >= 300) { limited = true; return; }
      }
    }
    stores.forEach(store => walk(store, 0));
    return {items: [...images.values()].slice(0, 300), limited, storesFound: stores.length,
      message: 'Best-effort scan of Firefly board data. Verify the item list; private fields, offscreen assets, and thumbnails may be missed or duplicated. Upload missing clothing images.'};
  }
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== CHANNEL ||
        m.direction !== 'request' || m.action !== 'scan' || typeof m.id !== 'string' || m.id.length > 100) return;
    let value, error;
    try {
      if (m.path !== location.pathname || !/^\/boards\/id\/[^/]+\/?$/.test(location.pathname)) throw new Error('Open the original board.');
      value = scan();
    } catch (_) { error = 'Board scan unavailable. Upload clothing images instead.'; }
    window.postMessage({channel: CHANNEL, direction: 'response', id: m.id, value, error}, location.origin);
  });
})();
