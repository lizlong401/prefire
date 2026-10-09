"""Check console/extension import interoperability with macOS JavaScriptCore."""
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
checks = []
for name in ['prefire-console.js', 'extension/content.js']:
    source = (root / name).read_text()
    checks.append('new Function(' + json.dumps(source) + ');')
    if name == 'prefire-console.js':
        validators = source.split('  function validState', 1)[1].split("  let loadError", 1)[0]
        validators = 'function validState' + validators
    else:
        validators = 'function valid(' + source.split('  function valid(', 1)[1].split('  function status', 1)[0]
    parser = 'function parseSharedViews' + source.split('  function parseSharedViews', 1)[1]
    end = '  function go(view)' if name == 'prefire-console.js' else '  let draggedId'
    parser = parser.split(end, 1)[0]
    checks.append('(() => {\n' + validators + parser + r'''
      let serial = 0;
      const crypto = {randomUUID: () => 'new-' + (++serial)};
      function assert(ok) { if (!ok) throw new Error('Sharing assertion failed'); }
      const state = {tx: 100, ty: 200, scale: 0.5,
        viewport: {x: 0, y: 0, width: 1000, height: 800}};
      const data = {format: 'prefire-saved-views', version: 1,
        documentPath: '/boards/id/test', transition: 'gentle',
        views: [{id: 'a', name: 'Second', state}, {id: 'b', name: 'First', state}]};
      const imported = parseSharedViews(JSON.stringify(data), data.documentPath);
      assert(imported.views.map(v => v.name).join(',') === 'Second,First');
      assert(imported.transition === 'gentle');
      assert(imported.views[0].state.scale === 0.5);
      assert(imported.views[0].id !== data.views[0].id);
      assert(imported.views[0].id !== imported.views[1].id);
      for (const change of [
        {documentPath: '/boards/id/other'}, {version: 999},
        {views: []}, {transition: 'unknown'},
        {views: [{id: 'bad', name: 'Bad', state: {...state, scale: -1}}]}
      ]) {
        let rejected = false;
        try { parseSharedViews(JSON.stringify({...data, ...change}), data.documentPath); }
        catch { rejected = true; }
        assert(rejected);
      }
    })();''')

checks.append('"Sharing validation passed for console and extension."')
result = subprocess.run(['osascript', '-l', 'JavaScript', '-e', '\n'.join(checks)],
                        capture_output=True, text=True)
print(result.stdout or result.stderr, end='')
raise SystemExit(result.returncode)
