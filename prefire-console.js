;(() => {
  'use strict';
  window.prefire?.destroy();

  function findCamera(root) {
    for (const el of root.querySelectorAll('*')) {
      const sequence = Object.getOwnPropertyDescriptor(el, '_artboardSequenceStore')?.value;
      const camera = sequence && Object.getOwnPropertyDescriptor(sequence, '_canvasStore')?.value;
      if (camera?.connected && typeof camera.submitCanvasState === 'function') return camera;
      if (el.shadowRoot) {
        const found = findCamera(el.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }

  if (!/^\/boards\/id\/[^/]+\/?$/.test(location.pathname)) {
    alert('Open a Firefly board first.'); return;
  }
  if (!findCamera(document)) {
    alert('Camera not found. Wait for Firefly to finish loading and retry.'); return;
  }

  const documentPath = location.pathname;
  const storageKey = 'prefire-console:v1:' + documentPath;
  let views = [], frame = 0, generation = 0, destroyed = false;
  function validState(s) {
    return s && [s.tx, s.ty, s.scale, s.viewport?.x, s.viewport?.y,
      s.viewport?.width, s.viewport?.height].every(Number.isFinite) &&
      s.scale > 0 && s.viewport.width > 0 && s.viewport.height > 0;
  }
  function validView(v) {
    return typeof v?.id === 'string' && typeof v.name === 'string' && validState(v.state);
  }
  let loadError = '';
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) views = saved.filter(validView);
  } catch { loadError = 'Could not read saved views.'; }

  function stop() { generation++; cancelAnimationFrame(frame); }
  function getCamera() {
    if (destroyed || location.pathname !== documentPath) throw new Error('Document changed. Rerun the script.');
    const camera = findCamera(document);
    if (!camera) throw new Error('Firefly camera is unavailable.');
    return camera;
  }
  function capture(camera = getCamera()) {
    const v = camera.renderViewport;
    const state = {tx: camera.tx, ty: camera.ty, scale: camera.scale,
      viewport: {x: v?.x, y: v?.y, width: v?.width, height: v?.height}};
    if (!validState(state)) throw new Error('Firefly camera state is unavailable.');
    return state;
  }

  const host = document.createElement('div');
  Object.assign(host.style, {position: 'fixed', top: '110px', right: '16px', zIndex: '2147483647'});
  const root = host.attachShadow({mode: 'closed'});
  root.innerHTML = `
    <style>
      :host{all:initial;color-scheme:dark}*{box-sizing:border-box}
      .panel{width:280px;background:#202124;color:#f1f3f4;border:1px solid #45474b;border-radius:14px;box-shadow:0 8px 32px #0005;font:13px system-ui}
      header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px}#body{padding:0 14px 14px}
      input,button,select{font:inherit;border:1px solid #53565c;border-radius:7px;padding:8px;background:#303238;color:inherit}
      button{cursor:pointer}button:hover{background:#41444b}button:disabled{opacity:.4;cursor:default}
      button:focus-visible,input:focus-visible{outline:2px solid #a8c7fa;outline-offset:2px}
      select{width:100%;margin:6px 0}.transition-label{display:block;margin-top:12px;color:#b5b8bf}input{width:100%;margin:8px 0}#save{width:100%;background:#a8c7fa;color:#14233b;border:0}
      #list{max-height:45vh;overflow:auto;margin-top:12px}.item{border-top:1px solid #414349;padding:10px 0}
      .go{width:100%;text-align:left;overflow-wrap:anywhere}.drag-handle{cursor:grab!important}.drag-handle:active{cursor:grabbing!important}.dragging{opacity:.45}.drop-before{box-shadow:inset 0 3px #a8c7fa}.drop-after{box-shadow:inset 0 -3px #a8c7fa}.actions{display:flex;gap:4px;margin-top:6px}.actions button{font-size:11px;padding:5px}
      p{color:#b5b8bf;font-size:12px;line-height:1.5;margin:8px 0}#stop{width:100%;margin-top:8px}[hidden]{display:none!important}
    </style>
    <section class="panel" aria-label="Prefire saved views">
      <header><strong>Prefire · Saved views</strong><button id="collapse" aria-label="Collapse panel" aria-expanded="true" aria-controls="body">−</button></header>
      <div id="body"><p>Frame a board, then save its position and zoom.</p>
        <form><input id="name" maxlength="80" placeholder="Name this view" aria-label="View name" required><button id="save" type="submit">Save current view</button></form>
          <label class="transition-label" for="transition">Transition</label>
          <select id="transition" aria-label="Transition style">
            <option value="smooth">Smooth · 0.7s</option>
            <option value="gentle">Gentle · 1.4s</option>
            <option value="snappy">Snappy · 0.35s</option>
            <option value="instant">Instant</option>
          </select>
        <p id="status" role="status" aria-live="polite"></p><p id="empty">No saved views yet.</p>
        <div id="list"></div><button id="stop">Stop movement</button>
        <p>Esc or canvas input stops movement. Views stay in this browser.</p>
      </div>
    </section>`;
  const status = text => { root.querySelector('#status').textContent = text; };
  function safely(action) {
    try { action(); } catch (error) { stop(); status(error.message); }
  }
  function commit(next) {
    localStorage.setItem(storageKey, JSON.stringify(next));
    views = next; render(); status('Saved in this browser.');
  }
  function go(view) {
    stop();
    const camera = getCamera(), from = capture(camera), target = view.state, run = generation;
    const tx = target.tx + from.viewport.x + from.viewport.width / 2 - target.viewport.x - target.viewport.width / 2;
    const ty = target.ty + from.viewport.y + from.viewport.height / 2 - target.viewport.y - target.viewport.height / 2;
    const preset = root.querySelector('#transition').value;
    const durations = {smooth: 700, gentle: 1400, snappy: 350, instant: 0};
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : durations[preset] ?? 700;
    const start = performance.now();
    status('Moving to ' + view.name);
    function tick(now) {
      if (run !== generation) return;
      if (destroyed || document.hidden || location.pathname !== documentPath || !camera.connected) { stop(); return; }
      const t = duration ? Math.min((now - start) / duration, 1) : 1;
      const eased = preset === 'gentle'
        ? t * t * t * (t * (6 * t - 15) + 10)
        : preset === 'snappy' ? 1 - (1 - t) ** 3 : t * t * (3 - 2 * t);
      try {
        camera.submitCanvasState(from.tx + (tx - from.tx) * eased,
          from.ty + (ty - from.ty) * eased, from.scale + (target.scale - from.scale) * eased);
      } catch (error) { stop(); status(error.message); return; }
      if (t < 1) frame = requestAnimationFrame(tick);
      else status(view.name);
    }
    frame = requestAnimationFrame(tick);
  }
  function button(label, action, title = label) {
    const el = document.createElement('button');
    el.textContent = label; el.title = title; el.setAttribute('aria-label', title);
    el.onclick = () => safely(action); return el;
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
      root.querySelectorAll('.drop-before, .drop-after').forEach(el => {
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
      safely(() => {
        const source = views.find(v => v.id === sourceId);
        const next = views.filter(v => v.id !== sourceId);
        const target = next.findIndex(v => v.id === view.id);
        if (!source || target < 0) return;
        next.splice(target + (after ? 1 : 0), 0, source);
        commit(next);
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
    const list = root.querySelector('#list'); list.replaceChildren();
    root.querySelector('#empty').hidden = views.length > 0;
    views.forEach((view, index) => {
      const item = document.createElement('div'); item.className = 'item';
      const navigate = button(view.name, () => go(view)); navigate.className = 'go';
      const handle = button('⠿', () => {}, 'Drag to reorder');
      handle.className = 'drag-handle';
      makeDraggable(item, handle, view);
      const actions = document.createElement('div'); actions.className = 'actions';
      const rename = button('Rename', () => {
        const name = prompt('View name', view.name)?.trim().slice(0, 80);
        if (name) commit(views.map(v => v.id === view.id ? {...v, name} : v));
      });
      const update = button('Update', () => {
        stop(); const state = capture();
        commit(views.map(v => v.id === view.id ? {...v, state} : v));
      }, 'Replace with current view');
      function reorder(direction) {
        const next = [...views];
        [next[index], next[index + direction]] = [next[index + direction], next[index]];
        commit(next);
      }
      const up = button('↑', () => reorder(-1), 'Move view up');
      const down = button('↓', () => reorder(1), 'Move view down');
      up.disabled = index === 0; down.disabled = index === views.length - 1;
      const remove = button('Delete', () => {
        if (confirm('Delete saved view “' + view.name + '”?')) commit(views.filter(v => v.id !== view.id));
      });
      actions.append(handle, rename, update, up, down, remove); item.append(navigate, actions); list.append(item);
    });
  }
  root.querySelector('form').onsubmit = event => {
    event.preventDefault();
    safely(() => {
      stop(); const input = root.querySelector('#name'), name = input.value.trim();
      if (!name) return;
      commit([...views, {id: crypto.randomUUID(), name, state: capture()}]); input.value = '';
    });
  };
  root.querySelector('#stop').onclick = () => { stop(); status('Movement stopped.'); };
  root.querySelector('#collapse').onclick = event => {
    const body = root.querySelector('#body'); body.hidden = !body.hidden;
    event.currentTarget.textContent = body.hidden ? '+' : '−';
    event.currentTarget.setAttribute('aria-expanded', String(!body.hidden));
    event.currentTarget.setAttribute('aria-label', body.hidden ? 'Expand panel' : 'Collapse panel');
  };
  function onKey(event) { if (event.key === 'Escape') stop(); }
  function onStorage(event) {
    if (event.key !== storageKey && event.key !== null) return;
    safely(() => {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      views = Array.isArray(saved) ? saved.filter(validView) : []; render();
    });
  }
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
      stop();
    }
  }
  window.addEventListener('keydown', protectNameInput, true);
  window.addEventListener('keyup', protectNameInput, true);
  window.addEventListener('keypress', protectNameInput, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('wheel', stop, {capture: true, passive: true});
  document.addEventListener('pointerdown', stop, true);
  document.addEventListener('visibilitychange', stop);
  window.addEventListener('storage', onStorage);
  const routeTimer = setInterval(() => {
    if (location.pathname !== documentPath) window.prefire?.destroy();
  }, 500);
  window.prefire = {
    destroy() {
      destroyed = true; stop(); clearInterval(routeTimer); host.remove();
      window.removeEventListener('keydown', protectNameInput, true);
      window.removeEventListener('keyup', protectNameInput, true);
      window.removeEventListener('keypress', protectNameInput, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', stop, true);
      document.removeEventListener('pointerdown', stop, true);
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('storage', onStorage);
    }
  };
  document.body.append(host); render(); status(loadError || 'Ready.');
})();
