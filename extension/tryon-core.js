(() => {
  'use strict';
  const image = value => typeof value === 'string' &&
    (/^https:\/\//.test(value) || /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value));
  function pack(state) {
    const assets = [], indices = new Map();
    const data = JSON.parse(JSON.stringify(state, (_key, value) => {
      if (typeof value !== 'string' || !(image(value) || value.startsWith('blob:https://firefly.adobe.com/'))) return value;
      if (!indices.has(value)) { indices.set(value, assets.length); assets.push(value); }
      return {$asset: indices.get(value)};
    }));
    return {version: 2, assets, data};
  }
  function restore(raw) {
    if (raw?.version === 2 && Array.isArray(raw.assets) && raw.assets.length <= 1000) {
      const assets = raw.assets;
      try {
        raw = JSON.parse(JSON.stringify(raw.data), (_key, value) => value && typeof value === 'object' &&
          Number.isInteger(value.$asset) ? assets[value.$asset] : value);
      } catch (_) { raw = null; }
    }
    if (!raw || raw.version !== 1) return {version: 1, model: '', modelId: '', items: [], jobs: []};
    return {
      version: 1, model: image(raw.model) ? raw.model : '', modelId: typeof raw.modelId === 'string' ? raw.modelId : '',
      items: Array.isArray(raw.items) ? raw.items.filter(i => i && typeof i.id === 'string' && typeof i.name === 'string' &&
        (image(i.url) || /^blob:https:\/\/firefly\.adobe\.com\//.test(i.url))).slice(0, 300).map(i => ({
          id: i.id, name: i.name.slice(0, 80), url: i.url, selected: i.selected !== false,
          category: ['auto', 'tops', 'bottoms', 'one-pieces'].includes(i.category) ? i.category : 'auto'
        })) : [],
      jobs: Array.isArray(raw.jobs) ? raw.jobs.filter(j => j && typeof j.id === 'string' && typeof j.itemId === 'string' &&
        typeof j.name === 'string' && image(j.garment) && image(j.model) &&
        ['queued', 'generating', 'completed', 'failed', 'cancelled'].includes(j.state)).slice(0, 300).map(j => ({
          id: j.id, itemId: j.itemId, name: j.name.slice(0, 80), garment: j.garment, model: j.model,
          category: ['auto', 'tops', 'bottoms', 'one-pieces'].includes(j.category) ? j.category : 'auto',
          state: j.state, output: image(j.output) ? j.output : '', error: typeof j.error === 'string' ? j.error : ''
        })) : []
    };
  }
  function batch(state, uuid) {
    if (!image(state.model)) throw new Error('Choose or upload a model reference first.');
    const selected = state.items.filter(i => i.selected && i.id !== state.modelId);
    if (!selected.length) throw new Error('Select at least one clothing image.');
    if (selected.some(i => !image(i.url))) throw new Error('Some selected images use private blob URLs. Upload those clothing images as files instead.');
    const jobs = selected.map(i => ({id: uuid(), itemId: i.id, name: i.name, garment: i.url,
      model: state.model, category: i.category || 'auto', state: 'queued', output: '', error: ''}));
    const encoded = JSON.stringify(pack({...state, jobs}));
    if (encoded.length > 7 * 1024 * 1024) throw new Error('Batch exceeds 7 MB. Use fewer uploaded images or public image URLs.');
    return jobs;
  }
  globalThis.PrefireTryonCore = {image, restore, batch, pack};
})();
