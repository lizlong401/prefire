(() => {
  'use strict';
  const CHANNEL = 'prefire-camera-v1';
  const pending = new Map();
  let path = '', host, root, views = [], ready = false, busy = false, epoch = 0;
  const key = p => 'prefire:v1:' + p;
  function request(action, state, transition) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Firefly camera did not respond. Reload the tab.')); }, 2500);
      pending.set(id, {resolve, reject, timer});
      window.postMessage({channel: CHANNEL, direction: 'request', id, path, action, state, transition}, location.origin);
    });
  }
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || event.origin !== location.origin || m?.channel !== CHANNEL || m.direction !== 'response') return;
    const job = pending.get(m.id);
    if (!job) return;
    clearTimeout(job.timer); pending.delete(m.id);
    m.error ? job.reject(new Error(m.error)) : job.resolve(m.value);
  });
  function valid(v) {
    const s = v?.state;
    return typeof v?.id === 'string' && typeof v.name === 'string' && v.name.length <= 80 &&
      s && [s.tx, s.ty, s.scale, s.viewport?.x, s.viewport?.y, s.viewport?.width, s.viewport?.height].every(Number.isFinite) &&
      s.scale > 0 && s.viewport.width > 0 && s.viewport.height > 0;
  }
  function status(text) { if (root) root.querySelector('#status').textContent = text; }
  function button(label, handler, title = label) {
    const b = document.createElement('button');
    b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
    b.onclick = () => perform(handler); return b;
  }
  async function perform(handler) {
    if (busy) return;
    const current = epoch;
    busy = true; render();
    try { await handler(); }
    catch (e) { if (current === epoch) status(e.message); }
    finally { if (current === epoch) { busy = false; render(); } }
  }
  async function commit(next) {
    const current = epoch;
    const storageKey = key(path);
    await chrome.storage.local.set({[storageKey]: next});
    if (current === epoch) { views = next; status('Saved on this device.'); }
  }
  async function capture() {
    await request('stop');
    return request('capture');
  }
  let draggedId = null;
  function makeDraggable(item, handle, view) {
    handle.draggable = true;
    handle.title = 'Drag to reorder ' + view.name;
    handle.setAttribute('aria-label', handle.title);
    handle.addEventListener('dragstart', event => {
      if (!event.dataTransfer) return;
      draggedId = view.id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', view.id);
      event.dataTransfer.setDragImage(item, 20, 20);
      item.classList.add('dragging');
    });
    function clearMarkers() {
      root?.querySelectorAll('.drop-before, .drop-after').forEach(el => {
        el.classList.remove('drop-before', 'drop-after');
      });
    }
    item.addEventListener('dragover', event => {
      if (!draggedId || draggedId === view.id) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      clearMarkers();
      const rect = item.getBoundingClientRect();
      item.classList.add(event.clientY < rect.top + rect.height / 2
        ? 'drop-before' : 'drop-after');
    });
    item.addEventListener('drop', event => {
      if (!draggedId) return;
      event.preventDefault();
      const sourceId = draggedId;
      draggedId = null;
      const rect = item.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      clearMarkers();
      if (sourceId === view.id) return;
      perform(async () => {
        const source = views.find(v => v.id === sourceId);
        const next = views.filter(v => v.id !== sourceId);
        const target = next.findIndex(v => v.id === view.id);
        if (!source || target < 0) return;
        next.splice(target + (after ? 1 : 0), 0, source);
        await commit(next);
      });
    });
    handle.addEventListener('dragend', () => {
      draggedId = null;
      item.classList.remove('dragging');
      clearMarkers();
      render();
    });
  }
  function render() {
    if (draggedId) return;
    if (!root) return;
    root.querySelector('#save').disabled = !ready || busy;
    const list = root.querySelector('#list'); list.replaceChildren();
    root.querySelector('#empty').hidden = views.length > 0;
    views.forEach((v, index) => {
      const item = document.createElement('div'); item.className = 'item';
      const go = button(v.name, async () => {
        await request('go', v.state, root.querySelector('#transition').value); status('Moving to ' + v.name);
      });
      go.className = 'go'; go.disabled = !ready || busy;
      const handle = button('⠿', () => {}, 'Drag to reorder');
      handle.className = 'drag-handle';
      handle.disabled = busy;
      makeDraggable(item, handle, v);
      const actions = document.createElement('div'); actions.className = 'actions';
      const rename = button('Rename', async () => {
        const name = prompt('View name', v.name)?.trim().slice(0, 80);
        if (name) await commit(views.map(x => x.id === v.id ? {...x, name} : x));
      });
      const update = button('Update', async () => {
        const current = epoch;
        const state = await capture();
        if (current === epoch) await commit(views.map(x => x.id === v.id ? {...x, state} : x));
      }, 'Replace with current camera view');
      update.disabled = !ready || busy;
      const move = direction => async () => {
        const next = [...views];
        [next[index], next[index + direction]] = [next[index + direction], next[index]];
        await commit(next);
      };
      const up = button('↑', move(-1), 'Move ' + v.name + ' up');
      const down = button('↓', move(1), 'Move ' + v.name + ' down');
      up.disabled = index === 0 || busy; down.disabled = index === views.length - 1 || busy;
      const remove = button('Delete', async () => {
        if (confirm('Delete saved view “' + v.name + '”?')) await commit(views.filter(x => x.id !== v.id));
      });
      rename.disabled = remove.disabled = busy;
      actions.append(handle, rename, update, up, down, remove);
      item.append(go, actions); list.append(item);
    });
  }
  function mount() {
    host = document.createElement('div');
    Object.assign(host.style, {position: 'fixed', top: '110px', right: '16px', zIndex: '2147483647'});
    root = host.attachShadow({mode: 'closed'});
    root.innerHTML = `
      <style>
        :host{all:initial;color-scheme:dark} *{box-sizing:border-box}
        .panel{width:284px;background:#202124;color:#f1f3f4;border:1px solid #45474b;border-radius:14px;box-shadow:0 8px 32px #0005;font:13px system-ui}
        header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px}
        strong{font-size:14px} #body{padding:0 14px 14px}
        input,button,select{font:inherit;border:1px solid #53565c;border-radius:7px;padding:8px;background:#303238;color:inherit}
        button{cursor:pointer}button:hover{background:#41444b}button:disabled{opacity:.45;cursor:default}
        button:focus-visible,input:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px}
        select{width:100%;margin:6px 0}.transition-label{display:block;margin-top:12px;color:#b5b8bf}input{width:100%;margin:8px 0}#save{width:100%;background:#a8c7fa;color:#14233b;border:0}
        #list{max-height:45vh;overflow:auto;margin-top:12px}.item{border-top:1px solid #414349;padding:10px 0}
        .go{width:100%;text-align:left;overflow-wrap:anywhere}.drag-handle{cursor:grab!important}.drag-handle:active{cursor:grabbing!important}.dragging{opacity:.45}.drop-before{box-shadow:inset 0 3px #a8c7fa}.drop-after{box-shadow:inset 0 -3px #a8c7fa}.actions{display:flex;gap:4px;margin-top:6px}.actions button{font-size:11px;padding:5px}
        p{color:#b5b8bf;font-size:12px;line-height:1.5;margin:8px 0}#status{min-height:18px}#stop{width:100%;margin-top:8px}[hidden]{display:none!important}
      </style>
      <section class="panel" aria-label="Prefire saved views">
        <header><strong>Prefire · Saved views</strong><button id="collapse" aria-expanded="true" aria-controls="body" aria-label="Collapse panel">−</button></header>
        <div id="body"><p>Frame a board, then save its position and zoom.</p>
          <form><input id="name" maxlength="80" placeholder="Name this view" aria-label="View name" required><button id="save" type="submit">Save current view</button></form>
          <label class="transition-label" for="transition">Transition</label>
          <select id="transition" aria-label="Transition style">
            <option value="smooth">Smooth · 0.7s</option>
            <option value="gentle">Gentle · 1.4s</option>
            <option value="snappy">Snappy · 0.35s</option>
            <option value="instant">Instant</option>
          </select>
          <p id="status" role="status" aria-live="polite">Connecting to Firefly…</p>
          <p id="empty">Your saved views will appear here.</p><div id="list"></div>
          <button id="stop">Stop movement</button><p>Esc or canvas input stops movement. Views stay on this device.</p>
        </div>
      </section>`;
    root.querySelector('form').onsubmit = event => {
      event.preventDefault();
      const input = root.querySelector('#name');
      const name = input.value.trim();
      if (!name || !ready) return;
      perform(async () => {
        const current = epoch;
        const state = await capture();
        if (current !== epoch) return;
        await commit([...views, {id: crypto.randomUUID(), name, state}]);
        if (current === epoch) input.value = '';
      });
    };
    root.querySelector('#stop').onclick = () => request('stop').catch(e => status(e.message));
    root.querySelector('#collapse').onclick = event => {
      const body = root.querySelector('#body'); body.hidden = !body.hidden;
      event.currentTarget.textContent = body.hidden ? '+' : '−';
      event.currentTarget.setAttribute('aria-expanded', String(!body.hidden));
      event.currentTarget.setAttribute('aria-label', body.hidden ? 'Expand panel' : 'Collapse panel');
    };
    document.body.append(host); render();
  }
  async function routeCheck() {
    if (path === location.pathname) return;
    draggedId = null;
    epoch++; path = location.pathname; ready = false; busy = false; views = [];
    host?.remove(); host = root = null;
    if (!/^\/boards\/id\/[^/]+\/?$/.test(path)) return;
    mount();
    const current = epoch;
    try {
      const storageKey = key(path);
      const saved = (await chrome.storage.local.get(storageKey))[storageKey];
      if (current !== epoch) return;
      views = Array.isArray(saved) ? saved.filter(valid) : [];
      render();
    } catch (e) { if (current === epoch) status('Could not load saved views: ' + e.message); }
  }
  async function probe() {
    if (!root) return;
    const current = epoch;
    try {
      await request('status');
      if (current !== epoch) return;
      if (!ready) status('Ready.');
      ready = true;
    } catch (e) {
      if (current !== epoch) return;
      ready = false; status(e.message);
    }
    render();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !root || !changes[key(path)]) return;
    const saved = changes[key(path)].newValue;
    views = Array.isArray(saved) ? saved.filter(valid) : [];
    render();
  });
  // Keep canvas shortcuts from consuming editing keys in our name field.
  // Native input editing still runs because we do not prevent its default action.
  function protectNameInput(event) {
    if (!host || !root || !event.composedPath().includes(host) ||
        !['input', 'select'].includes(root.activeElement?.localName)) return;
    event.stopImmediatePropagation();
    if (event.type === 'keydown' && event.key === 'Enter' && !event.isComposing && root.activeElement?.localName === 'input') {
      event.preventDefault();
      root.querySelector('form').requestSubmit();
    }
    if (event.type === 'keydown' && event.key === 'Escape') {
      request('stop').catch(e => status(e.message));
    }
  }
  window.addEventListener('keydown', protectNameInput, true);
  window.addEventListener('keyup', protectNameInput, true);
  window.addEventListener('keypress', protectNameInput, true);
  routeCheck().then(probe);
  setInterval(routeCheck, 500);
  setInterval(probe, 3000);
})();
