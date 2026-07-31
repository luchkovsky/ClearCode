---
description: Validate Clear Copy — manifest, syntax, bundle freshness, and behaviour in real Chrome
allowed-tools: Bash(node:*), Bash(cd:*), Read, Edit, Grep
---

Validate the Clear Copy extension.

Run:

```sh
cd .tools && node validate.js
```

Use `node validate.js --static` to skip the browser tests when Chrome is
unavailable or you only need a fast check.

`validate.js` and its `test/` fixtures live in `.tools/`, a sibling of
`ClearCopy/` — the extension it validates. It resolves `ClearCopy/`'s own
files (manifest, background.js, popup.js, preview.js, `src/`) via a `ROOT`
pointing at `../ClearCopy`, and its own fixtures via a separate `TEST_ROOT`
pointing at itself.

## What it covers

1. **Manifest** — parses, is v3, every referenced file exists, required
   permissions (`scripting`, `storage`, `downloads`, `debugger`) are declared.
2. **Syntax** — every JS file parses, ES modules checked as modules.
3. **Bundle freshness** — fails if `ClearCopy/src/extractor.bundle.js` is older
   than `extract.js`/`blocks.js`, and asserts the bundle contains no `import`
   statements and exposes its two entry points.
4. **Behaviour** — launches headless Chrome, injects the real bundle into
   `test/fixture.html`, and asserts on the Markdown produced: heading levels,
   inline styles (bold/italic/code/strike/mark/sup/sub), nested and ordered
   lists, task checkboxes, tables (headers, escaped pipes, ragged rows),
   fenced code, nested blockquotes, images and captions, escaping rules,
   advertising removal, and significant-image filtering.

## Interpreting failures

- **"bundle is newer than its sources"** → run `/build`; the bundle is stale.
- **A behavioural check fails** → a real regression. Read the named assertion in
  `validate.js`, reproduce it against `test/fixture.html`, and fix the source in
  `ClearCopy/src/` — never weaken the assertion to make it pass.
- **"Chrome not found"** → install Chrome, or rerun with `--static`.

Exit code is non-zero when anything fails.

After running, summarise which checks failed and why. If everything passes, say
so plainly with the count. Do not describe the extension as working if the
behavioural tests were skipped — say that they were skipped.

$ARGUMENTS
