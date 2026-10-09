# Prefire — Saved Views

A small Chrome extension for saving camera views in Adobe Firefly Boards and moving smoothly between them. No Hammerspoon, account, build step, or backend.

## Console script
For a pilot without installing an extension, copy all of [prefire-console.js](prefire-console.js) into Firefly's DevTools Console and run it with a board open. Rerun after refreshing. It saves views per document in Firefly page localStorage, separately from the extension; clearing site data removes them. Share this one file with colleagues. It uses the same private camera integration and still needs live browser verification.

## Install for testing
1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension` folder.
3. Reload your Firefly tab and open a board. The Prefire panel appears at the upper right.
4. Frame a board, name the view, and save. Repeat for another board; click a saved name to navigate.

Drag the ⠿ handle to reorder views; the blue line marks the insertion position. Arrow buttons also reorder views. Rename, update the current camera view, or delete from each view's controls. Collapse the panel with the minus button. Escape, scrolling, or pointer input stops movement. Reduced-motion preferences disable the transition.

Views persist per Firefly document in local extension storage and are shared between tabs in the same Chrome profile. Uninstalling the extension removes its storage. Saved views do not track artboards that move. Views saved by the earlier console prototype are not imported.

## Distribution
Run `python3 scripts/package.py` to create `dist/prefire-0.1.0.zip`, with the manifest at its root. For testers, unzip and load the extracted folder using the instructions above. A ZIP alone is not a one-click Chrome installer; public installation requires a Chrome Web Store submission and review.

See [SPEC.md](SPEC.md) for scope and acceptance criteria and [PRIVACY.md](PRIVACY.md) for data handling.

## Validation
Run `node --test tests/page.test.cjs`. JavaScript syntax checks: `node --check extension/page.js` and `node --check extension/content.js`.

Manual release check: save two views at different zoom levels, navigate, refresh, rename/update/reorder/delete, switch documents, resize the browser, test reduced motion and cancellation. Verify on a real Firefly session before publication. Automated tests use a mock camera and cannot prove compatibility with a live Adobe release.

## Technical notes
Manifest V3; minimum Chrome 111. The isolated content script owns the panel and `chrome.storage.local`; a MAIN-world adapter accesses Firefly's private camera via open shadow roots. Only Firefly pages receive scripts; the panel is restricted to board document routes. No native helper or network requests.

Firefly's private `_artboardSequenceStore._canvasStore` integration can change. A persistent connecting message means the document has not loaded or the integration needs updating. The page bridge is not a security boundary against Firefly page scripts; it exposes only camera operations and never accepts storage writes. Not affiliated with or endorsed by Adobe.
# prefire
