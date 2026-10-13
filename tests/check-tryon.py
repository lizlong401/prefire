"""Run JavaScript syntax and queue/inventory behavior checks using macOS JavaScriptCore."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
checks = ['new Function(' + json.dumps(p.read_text()) + ');' for p in (root / 'extension').glob('*.js')]
checks.append('var globalThis = this;')
checks.append((root / 'extension/tryon-core.js').read_text())
checks.append(r'''
function assert(value, message) { if (!value) throw new Error(message); }
var core = globalThis.PrefireTryonCore;
assert(core.restore({version:2, assets:[]}).items.length === 0, 'Recover corrupt asset storage');
assert(core.restore({version:1, items:[null], jobs:[null]}).jobs.length === 0, 'Discard corrupt rows');
var state = core.restore();
state.model = 'https://example.com/model.png';
state.modelId = 'model';
state.items = [
  {id: 'model', name: 'Person', url: state.model, selected: true},
  {id: 'top', name: 'Top', url: 'https://example.com/top.png', selected: true, category: 'tops'},
  {id: 'skip', name: 'Skip', url: 'https://example.com/skip.png', selected: false}
];
var serial = 0;
state.jobs = core.batch(state, function() { return 'job-' + ++serial; });
assert(state.jobs.length === 1, 'Exclude model and unchecked items');
assert(state.jobs[0].category === 'tops', 'Capture category');
state.model = 'https://example.com/new-person.png';
assert(state.jobs[0].model !== state.model, 'Snapshot model for the batch');
state.jobs[0].state = 'generating';
var restored = core.restore(core.pack(state));
assert(restored.jobs[0].state === 'generating', 'Keep in-flight job on reload');
assert(restored.jobs[0].id === 'job-1', 'Preserve ID for idempotent resume');
assert(restored.jobs[0].model === 'https://example.com/model.png', 'Restore snapshotted model');
assert(restored.items[1].url === 'https://example.com/top.png', 'Restore image assets');
state.items[1].url = 'blob:https://firefly.adobe.com/private';
var rejected = false;
try { core.batch(state, function() { return 'new'; }); } catch (_) { rejected = true; }
assert(rejected, 'Reject private images before submit');
assert(core.restore({version: 1, jobs: [{id:'evil', itemId:'a', name:'bad', garment:'javascript:bad', model:state.model, state:'completed'}]}).jobs.length === 0, 'Discard invalid stored jobs');
''')
# Inventory must walk offscreen store data, deduplicate, skip getters, and bound cycles.
checks.append(r'''
var handler, reply;
var store = {items: [{name: 'Offscreen top', imageUrl: 'https://example.com/top.png'},
  {name: 'Duplicate', imageUrl: 'https://example.com/top.png'}]};
store.self = store;
Object.defineProperty(store, 'danger', {get: function() { throw new Error('Getter executed'); }});
var document = {querySelectorAll: function() { return [{_artboardSequenceStore: store}]; }};
var location = {origin: 'https://firefly.adobe.com', pathname: '/boards/id/test'};
var window = {addEventListener: function(type, fn) { handler = fn; }, postMessage: function(data) { reply = data; }};
''')
checks.append((root / 'extension/inventory.js').read_text())
checks.append(r'''
handler({source:window, origin:location.origin, data:{channel:'prefire-inventory-v1',direction:'request',action:'scan',id:'test',path:location.pathname}});
assert(!reply.error, 'Scan succeeded');
assert(reply.value.items.length === 1, 'Deduplicate images');
assert(reply.value.items[0].name === 'Offscreen top', 'Read images from store, not viewport');
'JavaScript syntax, batch persistence, and inventory checks passed.';
''')
result = subprocess.run(['osascript', '-l', 'JavaScript', '-e', '\n'.join(checks)], capture_output=True, text=True)
print(result.stdout or result.stderr, end='')
raise SystemExit(result.returncode)
