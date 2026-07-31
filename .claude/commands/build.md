---
description: Rebuild the Clear Copy injected extractor bundle
allowed-tools: Bash(node:*), Bash(cd:*), Read, Edit
---

Rebuild the injected extractor bundle for Clear Copy.

Run:

```sh
cd .tools && node build.js
```

This regenerates `ClearCopy/src/extractor.bundle.js` by concatenating
`ClearCopy/src/debug.js`, `extract.js` and `blocks.js` into a classic
(non-module) script. `build.js` itself lives in `.tools/`, a sibling of
`ClearCopy/` — it resolves the extension's `src/` via `../ClearCopy/src`.

**Why it must exist:** `chrome.scripting.executeScript` injects a classic script,
and a dynamic `import()` inside it is evaluated against the *page's* CSP — strict
sites (Wikipedia, GitHub, most news sites) block it. The bundle sidesteps that.

**Run this after any edit to `src/extract.js` or `src/blocks.js`**, or the
extension will keep running the previous code. The other modules
(`render.js`, `export.js`, `collection.js`) are loaded directly by the preview
page and need no build step.

After building, report the bundle size and confirm it succeeded. If `build.js`
reports an error, read the failing source file and fix it rather than retrying
the command unchanged.

$ARGUMENTS
