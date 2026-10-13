(() => {
  'use strict';
  const core = globalThis.PrefireTryonCore;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function service(action, data) {
    const response = await chrome.runtime.sendMessage({channel: 'prefire-tryon', action,
      ...(action === 'submit' ? {data} : {id: data})});
    if (!response || response.error) throw new Error(response?.error || 'Try-on service did not respond.');
    return response.data;
  }
  function scan(path) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', listener); };
      const listener = event => {
        const m = event.data;
        if (event.source !== window || event.origin !== location.origin || m?.channel !== 'prefire-inventory-v1' ||
            m.direction !== 'response' || m.id !== id) return;
        cleanup(); m.error ? reject(new Error(m.error)) : resolve(m.value);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Board scan unavailable. Upload clothing images instead.')); }, 10000);
      window.addEventListener('message', listener);
      window.postMessage({channel: 'prefire-inventory-v1', direction: 'request', id, path, action: 'scan'}, location.origin);
    });
  }
  async function readImage(file) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 15 * 1024 * 1024) {
      throw new Error('Use PNG, JPEG or WebP images under 15 MB.');
    }
    const bitmap = await createImageBitmap(file);
    try {
      const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', .85);
      if (url.length > 1024 * 1024) throw new Error('Image is too complex. Resize it before uploading (maximum 1 MB after compression).');
      return url;
    } finally { bitmap.close(); }
  }
  function mount(container, path) {
    const storageKey = 'prefire:tryon:v1:' + path;
    let state = core.restore(), disposed = false, running = false, editing = false, paused = true, loaded = false;
    let writeChain = Promise.resolve();
    const current = () => !disposed && location.pathname === path;
    container.innerHTML = `
      <style>
        .tryon{border-top:1px solid #45474b;margin-top:14px;padding-top:12px}
        .tryon summary{cursor:pointer;font-weight:600;padding:6px 0}
        .tryon label{display:block;margin:8px 0}.tryon input[type=checkbox]{width:auto;margin:0 6px 0 0}
        .tryon input[type=file]{font-size:11px;width:100%;padding:6px}
        .tryon-grid{max-height:280px;overflow:auto}.tryon-card{padding:8px 0;border-top:1px solid #45474b;overflow-wrap:anywhere}
        .tryon-card img,.tryon-model{width:68px;height:84px;object-fit:contain;background:#161719;border-radius:6px;margin:4px}
        .tryon-card a{color:#a8c7fa;display:inline-block;padding:6px}.tryon-card select{font-size:12px}
        .tryon .primary{width:100%;background:#a8c7fa;color:#14233b;margin-top:8px}
      </style>
      <details class="tryon"><summary>Try-on · Batch generation</summary>
        <p>One try-on per clothing image, using the same person. Tops, bottoms and one-piece outfits are supported.</p>
        <details><summary>Service settings</summary>
          <p>Start the local service using the README instructions. Your fal API key stays on that service.</p>
          <label>Local service token<input class="token" type="password" autocomplete="off" placeholder="Token printed by local service"></label>
          <button class="connect" type="button">Save token &amp; connect</button>
        </details>
        <label>Model reference from board<select class="model-select" aria-label="Model reference"><option value="">Upload or choose a reference</option></select></label>
        <label>Or upload model photo<input class="model-file" type="file" accept="image/png,image/jpeg,image/webp"></label>
        <img class="tryon-model" alt="Chosen model reference" hidden>
        <div class="sharing"><button class="scan" type="button">Scan board</button><button class="select-all" type="button">Select all clothing</button></div>
        <label>Add missing clothing images<input class="garment-files" type="file" multiple accept="image/png,image/jpeg,image/webp"></label>
        <p class="inventory-note">Scan results are best effort. Verify the list includes every item you want, including offscreen items. Exclude model photos and non-clothing images.</p>
        <div class="tryon-grid items"></div>
        <p>Generate sends your model photo and selected clothing images to fal.ai / FASHN and uses paid fal credits, separate from Adobe credits. Results appear here for download and manual import into your board.</p>
        <button class="start primary" type="button">Generate selected try-ons</button>
        <div class="sharing"><button class="resume" type="button">Resume batch</button><button class="pause" type="button">Pause after current</button></div>
        <button class="cancel" type="button">Cancel remaining items</button>
        <p class="tryon-status" role="status" aria-live="polite">Loading Try-on…</p>
        <div class="tryon-grid results"></div>
      </details>`;
    const $ = selector => container.querySelector(selector);
    function note(message) { if (current()) $('.tryon-status').textContent = message; }
    function save() {
      const snapshot = JSON.stringify(core.pack(state));
      if (snapshot.length > 7 * 1024 * 1024) return Promise.reject(new Error('Try-on data exceeds 7 MB. Remove uploaded items or use smaller images.'));
      writeChain = writeChain.catch(() => {}).then(() => chrome.storage.local.set({[storageKey]: JSON.parse(snapshot)}));
      return writeChain;
    }
    function action(label, fn) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.onclick = () => guard(fn); return button;
    }
    async function guard(fn) {
      if (!current() || editing || !loaded) return;
      editing = true; render();
      try { await fn(); } catch (error) { note(error.message); }
      finally { editing = false; if (current()) render(); }
    }
    function render() {
      if (!current()) return;
      const locked = running || editing || !loaded;
      ['.scan', '.select-all', '.model-file', '.model-select', '.garment-files', '.start', '.connect', '.token'].forEach(s => { $(s).disabled = locked; });
      $('.resume').disabled = locked || !state.jobs.some(j => ['queued', 'generating'].includes(j.state));
      $('.pause').disabled = !running || paused;
      $('.cancel').disabled = editing || !loaded || !state.jobs.some(j => j.state === 'queued');
      const modelSelect = $('.model-select'); modelSelect.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Uploaded reference / choose an image';
      modelSelect.append(placeholder);
      state.items.filter(i => core.image(i.url)).forEach(i => {
        const option = document.createElement('option'); option.value = i.id; option.textContent = i.name; modelSelect.append(option);
      });
      modelSelect.value = state.modelId;
      const preview = $('.tryon-model'); preview.hidden = !state.model;
      if (state.model) { preview.src = state.model; preview.referrerPolicy = 'no-referrer'; }
      else preview.removeAttribute('src');
      const items = $('.items'); items.replaceChildren();
      state.items.forEach(item => {
        const row = document.createElement('div'); row.className = 'tryon-card';
        const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox';
        check.checked = item.selected && item.id !== state.modelId; check.disabled = locked || item.id === state.modelId;
        check.onchange = () => guard(async () => { item.selected = check.checked; await save(); });
        label.append(check, document.createTextNode(item.name + (item.id === state.modelId ? ' (model reference)' : '')));
        const thumbnail = document.createElement('img'); thumbnail.src = item.url; thumbnail.alt = item.name; thumbnail.loading = 'lazy'; thumbnail.referrerPolicy = 'no-referrer';
        const category = document.createElement('select'); category.setAttribute('aria-label', 'Garment category for ' + item.name);
        for (const [value, text] of [['auto', 'Auto category'], ['tops', 'Top'], ['bottoms', 'Bottom'], ['one-pieces', 'One-piece']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; category.append(option);
        }
        category.value = item.category || 'auto'; category.disabled = locked;
        category.onchange = () => guard(async () => { item.category = category.value; await save(); });
        const remove = action('Remove', async () => { state.items = state.items.filter(i => i.id !== item.id); if (state.modelId === item.id) state.modelId = ''; await save(); });
        remove.disabled = locked;
        row.append(label, thumbnail, category, remove); items.append(row);
      });
      const count = state.items.filter(i => i.selected && i.id !== state.modelId).length;
      $('.start').textContent = `Generate ${count} try-on${count === 1 ? '' : 's'}`;
      $('.start').disabled = locked || !count || !state.model || state.jobs.some(j => ['queued', 'generating'].includes(j.state));
      const results = $('.results'); results.replaceChildren();
      state.jobs.forEach(job => {
        const row = document.createElement('div'); row.className = 'tryon-card';
        const text = document.createElement('p'); text.textContent = job.name + ' · ' + job.state + (job.error ? ': ' + job.error : ''); row.append(text);
        if (job.output) {
          const img = document.createElement('img'); img.src = job.output; img.alt = 'Try-on result for ' + job.name; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
          const link = document.createElement('a'); link.href = job.output; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; link.textContent = 'Open / download result';
          row.append(img, link);
        }
        if (job.state === 'failed') {
          const retry = action('Retry this item', async () => {
            if (!confirm('Submit another paid generation for ' + job.name + '? If submission was uncertain, check fal history first.')) return;
            job.id = crypto.randomUUID(); job.state = 'queued'; job.error = ''; await save();
            paused = false; void run();
          }); retry.disabled = locked; row.append(retry);
        }
        results.append(row);
      });
    }
    async function run() {
      if (running || !current()) return;
      running = true; render();
      try {
        while (current() && !paused) {
          const job = state.jobs.find(j => ['generating', 'queued'].includes(j.state));
          if (!job) break;
          if (job.state === 'queued') {
            // Mark and save before network I/O; resuming uses the same idempotency ID.
            job.state = 'generating'; await save();
          }
          note('Generating ' + job.name + '…'); render();
          // Always replay submit with the SAME ID. The service deduplicates even after refresh.
          await service('submit', {id: job.id, model: job.model, garment: job.garment, category: job.category});
          if (!current()) break;
          const deadline = Date.now() + 15 * 60 * 1000;
          while (current()) {
            const result = await service('status', job.id);
            if (!current()) break;
            if (result.state === 'completed') {
              if (!core.image(result.image)) throw new Error('Provider returned an invalid image URL.');
              job.state = 'completed'; job.output = result.image; job.error = ''; await save(); break;
            }
            if (result.state === 'failed') {
              job.state = 'failed'; job.error = result.error || 'Generation failed.';
              if (/Submission/i.test(job.error)) paused = true;
              await save(); break;
            }
            if (Date.now() > deadline) throw new Error('This generation is taking longer than expected. Resume later to check the same job.');
            await delay(2500);
          }
          if (current()) { render(); note(`${state.jobs.filter(j => j.state === 'completed').length} of ${state.jobs.length} completed${paused ? ' · Paused' : ''}.`); }
        }
      } catch (error) { paused = true; note(error.message + ' Batch paused; Resume checks the existing job without submitting it twice.'); }
      finally { running = false; if (current()) render(); }
    }
    $('.connect').onclick = () => guard(async () => {
      const token = $('.token').value.trim();
      if (token) await chrome.storage.local.set({tryonToken: token});
      $('.token').value = '';
      const health = await service('health');
      note(health.ready ? 'Connected to ' + health.provider + '.' : 'Service is running, but FAL_KEY is missing. Restart it with your fal API key.');
    });
    $('.scan').onclick = () => guard(async () => {
      const result = await scan(path); if (!current()) return;
      const previous = new Map(state.items.map(i => [i.id, i]));
      const outputs = new Set(state.jobs.map(j => j.output).filter(Boolean));
      result.items.forEach(i => { if (!previous.has(i.id) && !outputs.has(i.url)) previous.set(i.id, {...i, selected: false, category: 'auto'}); });
      if (previous.size > 300) throw new Error('Maximum 300 images. Remove items before scanning again.');
      state.items = [...previous.values()]; await save();
      $('.inventory-note').textContent = result.message + (result.limited ? ' Scan reached its limit.' : '');
      note(`Found ${result.items.length} candidate images. Review and select clothing; uploaded items and existing selections are preserved.`);
    });
    $('.select-all').onclick = () => guard(async () => {
      state.items.forEach(i => { i.selected = i.id !== state.modelId; }); await save();
    });
    $('.model-select').onchange = event => {
      const selected = event.target.value;
      void guard(async () => {
      const item = state.items.find(i => i.id === selected);
      state.modelId = item?.id || ''; state.model = item?.url || ''; await save();
      });
    };
    $('.model-file').onchange = event => {
      const file = event.target.files[0]; event.target.value = '';
      if (file) void guard(async () => { const url = await readImage(file); if (!current()) return; state.model = url; state.modelId = ''; await save(); });
    };
    $('.garment-files').onchange = event => {
      const files = [...event.target.files]; event.target.value = '';
      if (files.length) void guard(async () => {
        if (state.items.length + files.length > 300) throw new Error('Maximum 300 images.');
        const added = [];
        for (const file of files) {
          const url = await readImage(file); if (!current()) return;
          added.push({id: crypto.randomUUID(), url, name: file.name.slice(0, 80), selected: true, category: 'auto'});
        }
        const next = {...state, items: [...state.items, ...added]};
        if (JSON.stringify(core.pack(next)).length > 7 * 1024 * 1024) throw new Error('Uploads exceed 7 MB. Add fewer or smaller images.');
        state = next; await save(); note('Clothing images added.');
      });
    };
    $('.start').onclick = () => guard(async () => {
      const jobs = core.batch(state, () => crypto.randomUUID());
      const health = await service('health'); if (!health.ready) throw new Error('Set FAL_KEY on the local service first.');
      if (!current()) return;
      if (state.jobs.length && !confirm('Replace the previous results gallery with this new batch? Download any results you want to keep first.')) return;
      state.jobs = jobs; await save(); paused = false; void run();
    });
    $('.resume').onclick = () => { if (!editing && loaded) { paused = false; void run(); } };
    $('.cancel').onclick = () => guard(async () => {
      paused = true; state.jobs.forEach(job => { if (job.state === 'queued') job.state = 'cancelled'; });
      await save(); note('Remaining items cancelled. Any in-flight generation finishes and can still use credits.');
    });
    $('.pause').onclick = () => { paused = true; note('Pausing after the current generation. It may still use provider credits.'); render(); };
    chrome.storage.local.get(storageKey).then(saved => {
      if (!current()) return;
      state = core.restore(saved[storageKey]); loaded = true; render();
      note(state.jobs.some(j => ['queued', 'generating'].includes(j.state)) ? 'Saved batch paused. Resume to continue with the same jobs.' : 'Choose a model photo and clothing images to begin.');
    }).catch(error => note('Could not load Try-on data: ' + error.message));
    render();
    return () => { disposed = true; paused = true; };
  }
  globalThis.PrefireTryon = {mount};
})();
