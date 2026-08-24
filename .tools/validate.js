#!/usr/bin/env node
// Validates Clear Copy: static checks, then behavioural tests in real Chrome.
//
//   node validate.js          static checks + browser tests
//   node validate.js --static skip the browser (fast, no Chrome needed)
//
// Browser tests drive the actual extractor bundle against test/fixture.html and
// assert on the Markdown it produces, so regressions in extraction, ad
// stripping, image filtering or Markdown fidelity fail here.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// This script lives in .tools/, a sibling of ClearCopy/ — the extension it
// validates. ROOT points at the extension itself (manifest, source, popup,
// etc.); test fixtures stay local to .tools/test/, so they keep their own root.
const ROOT = path.join(__dirname, '..', 'ClearCopy');
const TEST_ROOT = __dirname;
const staticOnly = process.argv.includes('--static');

let failures = 0;
let checks = 0;

const pass = (msg) => { checks++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); };
const fail = (msg, detail) => {
  checks++; failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
};
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const assert = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

section('Manifest');

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  pass('manifest.json parses');
} catch (err) {
  fail('manifest.json parses', err.message);
  process.exit(1);
}

assert(manifest.manifest_version === 3, 'manifest v3');

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
].filter(Boolean);

for (const rel of [...new Set(referenced)]) {
  assert(fs.existsSync(path.join(ROOT, rel)), `manifest reference exists: ${rel}`);
}

// Permissions the code actually relies on.
for (const perm of ['scripting', 'storage', 'downloads', 'debugger']) {
  assert(manifest.permissions?.includes(perm), `permission declared: ${perm}`);
}

section('Icons');

// Existence is not enough: the icons shipped for months as 70-byte files with a
// corrupt header ("IODR" instead of "IHDR"), which Chrome could not decode at
// all. Parse the PNG header and check the real dimensions.
function readPngSize(abs) {
  const buf = fs.readFileSync(abs);
  if (buf.length < 24) return { error: 'too short to be a PNG' };
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { error: 'missing PNG signature' };
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') return { error: `first chunk is "${chunkType}", expected IHDR` };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const iconEntries = Object.entries({
  ...(manifest.action?.default_icon || {}),
  ...(manifest.icons || {}),
});

for (const [declared, rel] of iconEntries) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    fail(`icon ${rel} exists`);
    continue;
  }
  const { width, height, error } = readPngSize(abs);
  if (error) {
    fail(`icon ${rel} is a valid PNG`, error);
    continue;
  }
  const want = Number(declared);
  assert(width === want && height === want,
    `icon ${rel} is ${want}x${want}`,
    width === want && height === want ? '' : `actually ${width}x${height}`);
}

section('Commands & options page');

// Keyboard shortcuts are declared in the manifest; the worker listens for them
// by name, so a rename in one place without the other silently does nothing.
const declaredCommands = Object.keys(manifest.commands || {});
for (const cmd of ['add-page', 'add-selection', 'open-preview']) {
  assert(declaredCommands.includes(cmd), `command declared: ${cmd}`);
}

const backgroundSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
for (const cmd of declaredCommands) {
  assert(backgroundSrc.includes(`'${cmd}'`), `background.js handles command: ${cmd}`);
}

// Chrome caps extensions at four suggested shortcuts.
assert(declaredCommands.length <= 4,
  'at most 4 suggested shortcuts', `declared ${declaredCommands.length}`);

assert(manifest.permissions?.includes('contextMenus'),
  'contextMenus permission declared (menu entries need it)');

const optionsPage = manifest.options_ui?.page;
assert(!!optionsPage, 'options page declared');
if (optionsPage) {
  assert(fs.existsSync(path.join(ROOT, optionsPage)), `options page exists: ${optionsPage}`);
}

// Every control the options script reads must exist in the markup, or settings
// silently fail to load or save.
//
// Ids reach the DOM two ways: literal `$('id')` calls, and the CHECKBOXES /
// SELECTS arrays that are looked up in a loop. Checking only the literals
// misses exactly the fields most likely to be mistyped.
if (optionsPage && fs.existsSync(path.join(ROOT, 'options.js'))) {
  const optionsHtml = fs.readFileSync(path.join(ROOT, optionsPage), 'utf8');
  const optionsJs = fs.readFileSync(path.join(ROOT, 'options.js'), 'utf8');

  const referenced = new Set(
    [...optionsJs.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));

  for (const arrayName of ['CHECKBOXES', 'SELECTS']) {
    const block = optionsJs.match(new RegExp(`const ${arrayName} = \\[([^\\]]*)\\]`, 's'));
    if (!block) continue;
    [...block[1].matchAll(/'([\w-]+)'/g)].forEach((m) => referenced.add(m[1]));
  }

  const missing = [...referenced].filter((id) => !optionsHtml.includes(`id="${id}"`));
  assert(missing.length === 0, 'every element options.js reads exists in options.html',
    missing.length ? `missing: ${missing.join(', ')}` : '');

  // Settings the options page must actually expose, or they become unreachable.
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'src', 'settings.js'), 'utf8');
  const defaults = settingsSrc.match(/DEFAULT_SETTINGS = \{(.*?)\n\};/s);
  if (defaults) {
    const keys = [...defaults[1].matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    const unexposed = keys.filter((k) => !optionsHtml.includes(`id="${k}"`));
    assert(unexposed.length === 0, 'every setting has a control on the options page',
      unexposed.length ? `no control for: ${unexposed.join(', ')}` : '');
  }
}

section('Syntax');

// Extension files (ROOT) and this project's own build/test tooling
// (TEST_ROOT, where build.js/validate.js actually live now) get checked from
// their real locations rather than assuming everything is one directory.
const jsFiles = [
  ...['background.js', 'popup.js', 'preview.js'].map((rel) => ({ rel, root: ROOT })),
  ...['build.js', 'validate.js'].map((rel) => ({ rel, root: TEST_ROOT })),
  ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'))
    .map((f) => ({ rel: `src/${f}`, root: ROOT })),
];

for (const { rel, root } of jsFiles) {
  const abs = path.join(root, rel);
  const source = fs.readFileSync(abs, 'utf8');
  const isModule = /^\s*(import|export)\s/m.test(source);
  try {
    if (isModule) {
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source, stdio: 'pipe' });
    } else {
      execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    }
    pass(`parses: ${rel}`);
  } catch (err) {
    fail(`parses: ${rel}`, (err.stderr || err.stdout || err).toString().split('\n').slice(0, 3).join('\n'));
  }
}

section('Bundle freshness');

const bundlePath = path.join(ROOT, 'src', 'extractor.bundle.js');
if (!fs.existsSync(bundlePath)) {
  fail('extractor.bundle.js exists — run `node build.js`');
} else {
  const bundleTime = fs.statSync(bundlePath).mtimeMs;
  // Sources that build.js concatenates.
  const stale = ['src/extract.js', 'src/blocks.js']
    .filter((rel) => fs.statSync(path.join(ROOT, rel)).mtimeMs > bundleTime);
  assert(stale.length === 0,
    'bundle is newer than its sources',
    stale.length ? `stale: ${stale.join(', ')} — run \`node build.js\`` : '');

  const bundle = fs.readFileSync(bundlePath, 'utf8');
  assert(!/^\s*import\s/m.test(bundle), 'bundle has no import statements (page CSP would block them)');
  assert(bundle.includes('window.__clearCopyExtract'), 'bundle exposes __clearCopyExtract');
  assert(bundle.includes('window.__clearCopyToMarkdown'), 'bundle exposes __clearCopyToMarkdown');
  // The popup and the worker both call these for selection capture.
  assert(bundle.includes('window.__clearCopySelection'), 'bundle exposes __clearCopySelection');
  assert(bundle.includes('window.__clearCopyHasSelection'), 'bundle exposes __clearCopyHasSelection');
}

section('Multi-frame selection');

// selectContentFrames operates on chrome.scripting.executeScript's per-frame
// results array, an API that only exists inside a loaded extension — a raw-
// CDP browser test (like the rest of validate.js) cannot drive it directly.
// Tested here in isolation instead, with plain fake frame data, against the
// real module (not a re-derived copy of its logic).
{
  const collectionSrc = fs.readFileSync(path.join(ROOT, 'src', 'collection.js'), 'utf8');
  const collectionPath = path.join(ROOT, 'src', 'collection.js');
  const tmpCjs = collectionPath.replace(/\.js$/, '.selftest.cjs');
  // Node's require() cannot load an ES module directly; write a throwaway
  // CommonJS transform (export -> module.exports) rather than adding a real
  // require() shim to the shipped source.
  fs.writeFileSync(tmpCjs, collectionSrc
    .replace(/^export (async function|function|const) /gm, '$1 ')
    .concat('\nmodule.exports = { selectContentFrames, OTHER_FRAME_MIN_WORDS, mergeCollection };'));

  try {
    const { selectContentFrames, OTHER_FRAME_MIN_WORDS } = require(tmpCjs);

    const frame = (wordCount) => ({ wordCount, metadata: { title: `frame-${wordCount}` } });

    const single = selectContentFrames([frame(400)]);
    assert(single.length === 1, 'a single content frame is returned alone');

    const mainPlusWidget = selectContentFrames([frame(651), frame(40), frame(9), frame(0)]);
    assert(mainPlusWidget.length === 2,
      'a second substantial frame is included alongside the richest',
      `got ${mainPlusWidget.length} frame(s)`);
    assert(mainPlusWidget.length === 2 && mainPlusWidget[0].wordCount === 651 && mainPlusWidget[1].wordCount === 40,
      'richest frame first, then the other substantial frame');

    const plumbingOnly = selectContentFrames([frame(651), frame(9), frame(9), frame(9)]);
    assert(plumbingOnly.length === 1,
      'SCORM-plumbing-sized frames (below the threshold) are not merged in as bogus sections',
      `got ${plumbingOnly.length} frame(s)`);

    const allSubstantial = selectContentFrames([frame(200), frame(175), frame(40)]);
    assert(allSubstantial.length === 3, 'every frame above the threshold is kept, not just two');

    assert(OTHER_FRAME_MIN_WORDS >= 20 && OTHER_FRAME_MIN_WORDS <= 50,
      'the merge threshold is in a sane range (catches an accidental 0 or huge value)',
      `OTHER_FRAME_MIN_WORDS=${OTHER_FRAME_MIN_WORDS}`);
  } finally {
    fs.unlinkSync(tmpCjs);
  }
}

if (staticOnly) {
  report();
}

// ---------------------------------------------------------------------------
// Behavioural tests (real Chrome)
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((p) => fs.existsSync(p));
}

// Frames loaded from file:// are opaque origins, so the player fixture (a
// lesson inside a same-origin iframe) can only be exercised over HTTP.
function startFixtureServer(root) {
  const http = require('http');
  const url = require('url');
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(url.parse(req.url).pathname).replace(/^\/+/, '');
    const abs = path.join(root, rel);
    if (!abs.startsWith(root) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(abs)] || 'application/octet-stream' });
    res.end(fs.readFileSync(abs));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function runBrowserTests() {
  section('Behaviour (Chrome)');

  const chrome = findChrome();
  if (!chrome) {
    fail('Chrome not found — install Chrome or run with --static');
    return;
  }

  const fixture = path.join(TEST_ROOT, 'test', 'fixture.html');
  if (!fs.existsSync(fixture)) {
    fail(`fixture missing: ${path.relative(ROOT, fixture)}`);
    return;
  }

  const os = require('os');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'clearcopy-'));
  const port = 9222 + Math.floor(Math.random() * 500);

  const { spawn } = require('child_process');
  const proc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--allow-file-access-from-files',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { proc.kill(); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  };

  try {
    const target = await waitForTarget(port);
    assertMarkdown(await extractViaCdp(target, fixture));

    const prelaunchFixture = path.join(TEST_ROOT, 'test', 'prelaunch-fixture.html');
    if (fs.existsSync(prelaunchFixture)) {
      assertPrelaunchGuard(await extractViaCdp(await waitForTarget(port), prelaunchFixture, false, 'current'));
    } else {
      fail('prelaunch fixture missing: test/prelaunch-fixture.html');
    }

    const lmsFixture = path.join(TEST_ROOT, 'test', 'lms-fixture.html');
    if (fs.existsSync(lmsFixture)) {
      assertLms(await extractViaCdp(await waitForTarget(port), lmsFixture));
      assertArticleReadsHiddenContent(
        await extractViaCdp(await waitForTarget(port), lmsFixture, false, 'current'));
    } else {
      fail('lms fixture missing: test/lms-fixture.html');
    }

    const tabsFixture = path.join(TEST_ROOT, 'test', 'tabs-fixture.html');
    if (fs.existsSync(tabsFixture)) {
      assertTabs(await extractViaCdp(await waitForTarget(port), tabsFixture));
    } else {
      fail('tabs fixture missing: test/tabs-fixture.html');
    }

    const svgSliderFixture = path.join(TEST_ROOT, 'test', 'svg-slider-fixture.html');
    if (fs.existsSync(svgSliderFixture)) {
      assertSvgSlider(await extractViaCdp(await waitForTarget(port), svgSliderFixture));
      assertSvgSliderInArticle(
        await extractViaCdp(await waitForTarget(port), svgSliderFixture, false, 'current'));
    } else {
      fail('svg slider fixture missing: test/svg-slider-fixture.html');
    }

    const articulateBgFixture = path.join(TEST_ROOT, 'test', 'articulate-background-fixture.html');
    if (fs.existsSync(articulateBgFixture)) {
      assertArticulateBackgroundStripped(await extractViaCdp(await waitForTarget(port), articulateBgFixture));
    } else {
      fail('articulate background fixture missing: test/articulate-background-fixture.html');
    }

    const spaFixture = path.join(TEST_ROOT, 'test', 'spa-fixture.html');
    if (fs.existsSync(spaFixture)) {
      assertSpa(await extractAutoResult(await waitForTarget(port), spaFixture));
    } else {
      fail('spa fixture missing: test/spa-fixture.html');
    }

    const imagesFixture = path.join(TEST_ROOT, 'test', 'images-fixture.html');
    if (fs.existsSync(imagesFixture)) {
      assertImages(await extractViaCdp(await waitForTarget(port), imagesFixture));
    } else {
      fail('images fixture missing: test/images-fixture.html');
    }

    assertSelection(await extractSelectionViaCdp(
      await waitForTarget(port), path.join(TEST_ROOT, 'test', 'fixture.html')));

    const carouselFixture = path.join(TEST_ROOT, 'test', 'carousel-fixture.html');
    if (fs.existsSync(carouselFixture)) {
      assertCarousel(await extractViaCdp(await waitForTarget(port), carouselFixture));
      assertInteractiveModes(await compareInteractiveModes(
        await waitForTarget(port), carouselFixture));
    } else {
      fail('carousel fixture missing: test/carousel-fixture.html');
    }

    const hiddenInertFixture = path.join(TEST_ROOT, 'test', 'hidden-inert-carousel-fixture.html');
    if (fs.existsSync(hiddenInertFixture)) {
      assertHiddenInertCarousel(
        await extractViaCdp(await waitForTarget(port), hiddenInertFixture, false, 'expand'),
        await extractViaCdp(await waitForTarget(port), hiddenInertFixture, false, 'current'));
    } else {
      fail('hidden+inert carousel fixture missing: test/hidden-inert-carousel-fixture.html');
    }

    const inertOpacityFixture = path.join(TEST_ROOT, 'test', 'inert-opacity-fixture.html');
    if (fs.existsSync(inertOpacityFixture)) {
      assertInertOpacityBlocks(
        await extractViaCdp(await waitForTarget(port), inertOpacityFixture, false, 'expand'),
        await extractViaCdp(await waitForTarget(port), inertOpacityFixture, false, 'current'));
    } else {
      fail('inert+opacity fixture missing: test/inert-opacity-fixture.html');
    }

    const formPayloadFixture = path.join(TEST_ROOT, 'test', 'form-payload-fixture.html');
    if (fs.existsSync(formPayloadFixture)) {
      assertFormPayload(
        await extractViaCdp(await waitForTarget(port), formPayloadFixture, false, 'expand'),
        await extractViaCdp(await waitForTarget(port), formPayloadFixture, false, 'current'),
        await extractViaCdp(await waitForTarget(port), formPayloadFixture, false, 'expand', false));
    } else {
      fail('form payload fixture missing: test/form-payload-fixture.html');
    }

    const emptyBlockFixture = path.join(TEST_ROOT, 'test', 'compact-fixture.html');
    if (fs.existsSync(emptyBlockFixture)) {
      assertEmptyBlocks(await extractViaCdp(await waitForTarget(port), emptyBlockFixture, false, 'current'));
    } else {
      fail('empty-block fixture missing: test/compact-fixture.html');
    }

    const lessonTreeFixture = path.join(TEST_ROOT, 'test', 'lesson-tree-fixture.html');
    if (fs.existsSync(lessonTreeFixture)) {
      assertCourseTreeWalk(await walkCourseViaCdp(await waitForTarget(port), lessonTreeFixture));
    } else {
      fail('lesson tree fixture missing: test/lesson-tree-fixture.html');
    }

    const screenReaderFixture = path.join(TEST_ROOT, 'test', 'screen-reader-fixture.html');
    if (fs.existsSync(screenReaderFixture)) {
      assertScreenReaderOnlyStripped(await extractViaCdp(await waitForTarget(port), screenReaderFixture));
    } else {
      fail('screen-reader fixture missing: test/screen-reader-fixture.html');
    }

    const courseNavFixture = path.join(TEST_ROOT, 'test', 'course-nav-fixture.html');
    if (fs.existsSync(courseNavFixture)) {
      assertCourseNavDiscovery(await discoverLinksViaCdp(await waitForTarget(port), courseNavFixture));
    } else {
      fail('course nav fixture missing: test/course-nav-fixture.html');
    }

    const shellFixture = path.join(TEST_ROOT, 'test', 'shell-fixture.html');
    if (fs.existsSync(shellFixture)) {
      assertShell(await extractViaCdp(await waitForTarget(port), shellFixture));
    } else {
      fail('shell fixture missing: test/shell-fixture.html');
    }

    const playerFixture = path.join(TEST_ROOT, 'test', 'player-fixture.html');
    if (fs.existsSync(playerFixture)) {
      const { server, port: httpPort } = await startFixtureServer(TEST_ROOT);
      try {
        assertPlayer(await extractViaHttp(
          await waitForTarget(port), `http://127.0.0.1:${httpPort}/test/player-fixture.html`));
      } finally {
        server.close();
      }
    } else {
      fail('player fixture missing: test/player-fixture.html');
    }

    const protectedFixture = path.join(TEST_ROOT, 'test', 'protected-fixture.html');
    if (fs.existsSync(protectedFixture)) {
      assertProtected(await extractViaCdp(await waitForTarget(port), protectedFixture, true));
    } else {
      fail('protected fixture missing: test/protected-fixture.html');
    }
  } catch (err) {
    fail('browser run', err.message);
  } finally {
    cleanup();
  }
}

async function waitForTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await res.json();
      const page = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome did not expose a debug target on port ${port}`);
}

// Minimal CDP client over the built-in WebSocket (Node 22+).
async function extractViaCdp(wsUrl, fixturePath, checkRestore = false, interactive = 'expand', readFormPayload = true) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `file://${fixturePath}` });
    await new Promise((r) => setTimeout(r, 1200));

    // Inject the real bundle, exactly as the extension does.
    const bundle = fs.readFileSync(path.join(ROOT, 'src', 'extractor.bundle.js'), 'utf8');
    await evaluate(bundle);

    return await evaluate(`
      (async () => {
        const before = ${checkRestore} ? {
          shield: document.querySelector('.shield') && getComputedStyle(document.querySelector('.shield')).display,
          select: document.querySelector('.no-copy') && getComputedStyle(document.querySelector('.no-copy')).userSelect,
        } : null;

        const c = await window.__clearCopyExtract({ keepImages: true, onlySignificantImages: true, interactive: '${interactive}', readFormPayload: ${readFormPayload} });

        const after = ${checkRestore} ? {
          shield: document.querySelector('.shield') && getComputedStyle(document.querySelector('.shield')).display,
          select: document.querySelector('.no-copy') && getComputedStyle(document.querySelector('.no-copy')).userSelect,
          header: !!document.querySelector('.real-header'),
        } : null;

        return JSON.stringify({
          md: window.__clearCopyToMarkdown(c),
          html: c.html,
          images: c.images,
          words: c.wordCount,
          title: c.metadata.title,
          blockedFrames: c.blockedFrames?.length ?? 0,
          before, after,
        });
      })()
    `);
  } finally {
    try { ws.close(); } catch {}
  }
}

// Navigates to fixturePath and calls __clearCopyDiscoverLessonLinks directly,
// bypassing extraction entirely — this is the whole-course walk's link
// discovery in isolation, the same helper Book mode calls before navigating
// the tab anywhere.
// Drives a whole-course walk against a fixture whose left menu is an ARIA
// tree with client-side routing. Returns the merged book plus a trace of what
// the walk visited, so the assertions can check both the document and the
// navigation behaviour that produced it.
async function walkCourseViaCdp(wsUrl, fixturePath) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `file://${fixturePath}` });
    await new Promise((r) => setTimeout(r, 500));

    const bundle = fs.readFileSync(path.join(ROOT, 'src', 'extractor.bundle.js'), 'utf8');
    await evaluate(bundle);

    // Detect a page reload during the walk: a client-side route must never
    // unload the document, and a reload here would mean the real player would
    // have raised Chrome's unsaved-changes prompt instead.
    await evaluate(`window.__ccWalkProbe = 'alive';
      window.__ccUnloadFired = false;
      addEventListener('beforeunload', () => { window.__ccUnloadFired = true; });`);

    // Drive the walk one lesson per call, exactly as the preview does: a real
    // course returns far too much HTML to come back in a single executeScript
    // result, so the loop lives in the caller.
    const walked = await evaluate(`(async () => {
      const summary = window.__clearCopyLessonTree();
      const pages = [], visited = [];
      for (let i = 0; i < summary.titles.length; i++) {
        const opened = await window.__clearCopyOpenLesson(i);
        if (!opened || !opened.ok) continue;
        const content = await window.__clearCopyExtract({ keepImages: false, interactive: 'current' });
        if (!content || !(content.text || '').trim()) continue;
        pages.push({ ...content, title: summary.titles[i], order: i });
        visited.push(summary.titles[i]);
      }
      let restored = false;
      if (summary.openIndex >= 0) {
        const back = await window.__clearCopyOpenLesson(summary.openIndex);
        restored = !!(back && back.ok);
      }
      return JSON.stringify({ pages, visited, restored, courseTitle: summary.courseTitle });
    })()`);

    // The walk returns per-lesson results; the preview merges them with
    // collection.js. That module needs a DOM, so merge in the page.
    const collectionSrc = fs.readFileSync(path.join(ROOT, 'src', 'collection.js'), 'utf8')
      .replace(/^\s*import\s+[^;]*?;\s*$/gm, '')
      .replace(/^export\s+(async\s+function|function|class|const|let|var)/gm, '$1');
    await evaluate(`(() => { ${collectionSrc}\n window.__ccMerge = mergeCollection; })()`);

    const merged = JSON.parse(await evaluate(`(() => {
      const w = ${walked};
      const book = window.__ccMerge(
        w.pages.map((p, i) => ({ ...p, order: p.order ?? i })),
        { includeContents: true, pageBreaks: true, title: w.courseTitle || 'Course' });
      return JSON.stringify({
        visited: w.visited,
        restored: w.restored,
        html: book.html,
        md: window.__clearCopyToMarkdown({ html: book.html, metadata: { title: w.courseTitle || 'Course' } }),
      });
    })()`));

    const probe = await evaluate(`JSON.stringify({
      survived: window.__ccWalkProbe === 'alive',
      unloadFired: !!window.__ccUnloadFired,
      finalUrl: location.href,
    })`);

    return JSON.stringify({ walked: merged, probe: JSON.parse(probe) });
  } finally {
    try { ws.close(); } catch {}
  }
}

async function discoverLinksViaCdp(wsUrl, fixturePath) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `file://${fixturePath}` });
    await new Promise((r) => setTimeout(r, 500));

    const bundle = fs.readFileSync(path.join(ROOT, 'src', 'extractor.bundle.js'), 'utf8');
    await evaluate(bundle);

    return await evaluate(`JSON.stringify(window.__clearCopyDiscoverLessonLinks())`);
  } finally {
    try { ws.close(); } catch {}
  }
}

// Course-navigation link discovery must skip anything that isn't a real
// lesson: unsafe actions ("Save and exit" — following one during a whole-
// course walk can end an enrollment, unlike clicking it in place) and known
// non-reading page types (quizzes, labs) that would only yield an empty or
// meaningless section if visited.
function assertCourseNavDiscovery(raw) {
  const links = JSON.parse(raw);
  const titles = links.map((l) => l.title);

  section('Behaviour — course navigation link discovery');

  ['Introduction', 'Securing Kong Gateway Runtime', 'Rate Limiting'].forEach((t) => {
    assert(titles.includes(t), `real lesson link kept: "${t}"`,
      !titles.includes(t) ? `discovered titles: ${titles.join(' | ')}` : '');
  });

  assert(!titles.includes('Knowledge Check'), 'Knowledge Check skipped (non-reading page)');
  assert(!titles.includes('Virtual Lab'), 'Virtual Lab skipped (non-reading page)');
  assert(!titles.some((t) => /save.*exit/i.test(t)), 'Save and exit skipped (unsafe action)');
  assert(!titles.includes('External resource'), 'cross-origin link excluded');
}

function assertMarkdown(raw) {
  const { md, images } = JSON.parse(raw);

  // Structure
  assert(/^# /m.test(md), 'has an H1 title');
  assert((md.match(/^## /gm) || []).length >= 3, 'has H2 sections');
  assert(/^###### /m.test(md), 'preserves all heading levels (h1–h6)');

  // Inline styles
  assert(md.includes('**bold**'), 'bold');
  assert(md.includes('*italic*'), 'italic');
  assert(md.includes('`code()`'), 'inline code');
  assert(md.includes('~~strike~~'), 'strikethrough');
  assert(/\[a link\]\(https:\/\/example\.com\/page\)/.test(md), 'links with href');
  assert(md.includes('==marked=='), 'mark → ==highlight==');
  assert(md.includes('H~2~O'), 'subscript');
  assert(md.includes('x^2^'), 'superscript');

  // Lists
  assert(/^- Plain item$/m.test(md), 'unordered list');
  assert(/^ {2}- Nested level two$/m.test(md), 'nested list indentation');
  assert(/^ {4}- Nested level three$/m.test(md), 'three-level nesting');
  assert(/^1\. First$/m.test(md) && /^2\. Second$/m.test(md), 'ordered list numbering');
  assert(/^ {2}1\. Nested ordered a$/m.test(md) && /^ {2}2\. Nested ordered b$/m.test(md),
    'nested ordered lists increment independently');
  assert(md.includes('- [x] Done task'), 'checked task item');
  assert(md.includes('- [ ] Pending task'), 'unchecked task item');

  // Tables
  assert(/\| Column A \| Column B \| Numeric \|/.test(md), 'table header row');
  assert(/\| --- \| --- \| --- \|/.test(md), 'table delimiter row');
  assert(md.includes('**bold cell**'), 'inline formatting inside cells');
  assert(md.includes('pipe \\| inside'), 'pipes escaped in cells');
  assert(/\| only one \|  \|  \|/.test(md), 'ragged rows padded to width');
  assert(!/\|  \|  \|\n\| --- \| --- \|\n\| r1c1/.test(md), 'header-less table promotes first row');

  // Code and quotes
  assert(md.includes('```python'), 'fenced code with language');
  assert(/```\nplain code/.test(md), 'fenced code without language');
  assert(/^> First quoted paragraph\.$/m.test(md), 'blockquote');
  assert(/^> > Nested quote\.$/m.test(md), 'nested blockquote');

  // Media
  assert(/!\[Alt text here\]\(https:\/\/example\.com\/pic\.png\)/.test(md), 'image with alt');
  assert(md.includes('*The caption*'), 'figure caption');

  // Escaping — must protect syntax without mangling prose.
  assert(md.includes('\\*not emphasis\\*'), 'escapes literal asterisks');
  assert(!/\w\\\.\s/.test(md), 'does not escape ordinary sentence periods');

  // Advertising
  const adMarkers = ['ADVERT:', 'adsbygoogle', 'taboola recommendations', 'outbrain widget',
                     'We use cookies', 'Subscribe to our newsletter'];
  const leaked = adMarkers.filter((m) => md.includes(m));
  assert(leaked.length === 0, 'advertising stripped', leaked.length ? `leaked: ${leaked.join(', ')}` : '');
  assert(md.includes('academic sense'), 'legitimate text mentioning "advertising" survives');

  // Boilerplate
  assert(!md.includes('SPONSORED'), 'sponsored banner removed');
  assert(!md.includes('All rights reserved'), 'footer removed');

  // Images
  assert(images.kept > 0, 'keeps meaningful images', `kept ${images.kept}/${images.total}`);
  assert(images.kept < images.total, 'drops decorative images', `kept ${images.kept}/${images.total}`);
  assert(!md.includes('icon-star'), 'icon dropped');
  assert(!md.includes('avatar-user'), 'avatar dropped');
  assert(!md.includes('big-decoration'), 'role=presentation image dropped');
  assert(md.includes('A meaningful chart'), 'captioned figure kept');
}

// Learning platforms (LearnUpon, SCORM players, Docebo…) wrap lessons in custom
// elements and show one segment at a time. Regressions here silently export a
// fraction of the course, so each of these is a real failure mode.
function assertLms(raw) {
  const { md, words } = JSON.parse(raw);

  section('Behaviour — LMS course page');

  assert(/^# Services and Routes$/m.test(md), 'title from the lesson heading, not the tab title');
  assert(md.includes('abstraction of an upstream'), 'visible lesson segment captured');
  assert(md.includes('Verifying the Configuration'),
    'hidden lesson segment captured (display:none is a segment switch, not deletion)');
  assert(md.includes('proxy port to confirm'), 'hidden segment body text captured');
  assert(md.includes('curl -X POST'), 'code block inside custom element');
  assert(/\| Field \| Description \|/.test(md), 'table inside custom element');
  assert(md.includes('- Routes match on paths'), 'list inside custom element');

  assert(!md.includes('Exit Course'), 'course chrome (exit button) removed');
  assert(!/^- \[One\]/m.test(md) && !md.includes('Modules'), 'course navigation removed');
  assert(!md.includes('All rights reserved'), 'footer removed');

  assert(md.includes('Troubleshooting Common Errors'), 'third hidden segment captured');

  // The whole point: every segment, not just the on-screen one.
  assert(words > 150, 'captures the full lesson, not only the current segment', `got ${words} words`);
}

// Interactive tab widgets reuse ONE panel: clicking a tab replaces its text, so
// the other panels do not exist in the DOM at any one moment. The extractor must
// click each tab and harvest what appears. Without this only the open tab is
// exported and the rest of the lesson silently disappears.
function assertTabs(raw) {
  const { md } = JSON.parse(raw);

  section('Behaviour — interactive tab widget');

  const tabs = [
    'Authentication', 'Bot Detection', 'Data encryption', 'IP Restriction',
    'Threat detection', 'DDOS Prevention', 'Interception prevention', 'Rate Limiting',
  ];
  const missingTabs = tabs.filter((t) => !md.includes(t));
  assert(missingTabs.length === 0, 'every tab label present as a section',
    missingTabs.length ? `missing: ${missingTabs.join(', ')}` : '');

  // Labels alone are worthless — the panel body behind each tab is the content.
  const bodies = [
    ['Authentication', 'verifying the identity'],
    ['Bot Detection', 'automated (bot) traffic'],
    ['Data encryption', 'only authorised parties'],
    ['IP Restriction', 'client IP address'],
    ['Threat detection', 'malicious payloads'],
    ['DDOS Prevention', 'denial of service'],
    ['Interception prevention', 'reading or modifying traffic'],
    ['Rate Limiting', 'requests a consumer may make'],
  ];
  const missingBodies = bodies.filter(([, body]) => !md.includes(body)).map(([tab]) => tab);
  assert(missingBodies.length === 0, 'panel body captured for every tab',
    missingBodies.length ? `missing body: ${missingBodies.join(', ')}` : '');

  // Rendered as sequential sections, in tab order.
  assert(/### Authentication/.test(md), 'tabs become headed sections');
  const order = tabs.map((t) => md.indexOf(t)).filter((i) => i >= 0);
  assert(order.every((v, i, a) => i === 0 || a[i - 1] < v), 'sections appear in tab order');

  // Surrounding lesson content must survive the splice.
  assert(md.includes('two categories'), 'text before the widget kept');
  assert(md.includes('Kong Support for securing Runtime'), 'text after the widget kept');

  // Safety: synthetic clicks must never hit destructive controls. On a real
  // logged-in course page these submit quizzes, exit, or mark progress.
  assert(!md.includes('DESTRUCTIVE_ACTION_FIRED'),
    'destructive controls (submit/exit/complete) are never clicked');
  assert(!md.includes('Submit Quiz') && !md.includes('Mark Complete'),
    'destructive controls are not emitted as sections');
}

// Articulate Storyline/Rise course players draw glossary-style widgets as SVG
// shapes, not HTML tabs: each term is a role="button" shape with an
// aria-label, and clicking it reveals a sibling "Frame" holding the
// definition as more SVG text. Confirmed against the real DOM of a Kong
// Academy lesson that exported as almost nothing before this fix.
//
// Unconditional (Article too): unlike the hidden+inert carousel, a term's
// definition here genuinely does not exist until clicked — there is nothing
// "already free" to show. Article still clicks through it, on the reasoning
// that a widget left un-clicked renders as a visibly empty box with no way
// to read it at all; the alternative (Article never clicks) would export a
// misleading empty shell instead.
function assertSvgSlider(raw) {
  const { md } = JSON.parse(raw);

  section('Behaviour — Articulate SVG slider widget');

  const terms = [
    ['Bot Detection', 'automated bot traffic'],
    ['Data encryption', 'only authorised parties'],
    ['IP Restriction', 'client IP address'],
  ];
  const missingLabels = terms.filter(([label]) => !md.includes(label)).map(([label]) => label);
  assert(missingLabels.length === 0, 'every slider term label present',
    missingLabels.length ? `missing: ${missingLabels.join(', ')}` : '');

  const missingBodies = terms.filter(([, body]) => !md.includes(body)).map(([label]) => label);
  assert(missingBodies.length === 0, 'definition revealed for every slider term',
    missingBodies.length ? `missing definition: ${missingBodies.join(', ')}` : '');

  assert(/### Bot Detection/.test(md), 'slider terms become headed sections');
  const order = terms.map(([label]) => md.indexOf(label)).filter((i) => i >= 0);
  assert(order.every((v, i, a) => i === 0 || a[i - 1] < v), 'sections appear in slider order');
}

function assertSvgSliderInArticle(raw) {
  const { md } = JSON.parse(raw);

  section('Behaviour — Articulate SVG slider widget (Article mode)');

  assert(md.includes('Bot Detection') && md.includes('automated bot traffic'),
    'Article clicks through the SVG slider too (definitions do not exist until clicked)');
}

// Articulate Storyline draws every slide's background as a full-canvas SVG
// (gradient rect + inner-shadow filter, sized to the whole slide) — large
// enough to pass the plain "big enough to be a real illustration" size
// check, but it depicts nothing. A real large SVG with actual text must
// still survive the same pass.
function assertArticulateBackgroundStripped(raw) {
  const { html, md } = JSON.parse(raw);

  section('Behaviour — Articulate slide-background SVG excluded');

  assert(!/data-commandset-id/.test(html), 'decorative background-fill SVG removed from HTML');
  assert(/<svg/i.test(html), 'a genuine large SVG diagram survives the same pass',
    !/<svg/i.test(html) ? 'no <svg> at all in the output — over-broadened' : '');
  assert(md.includes('Real content genuinely worth reading'), 'text before the background survives');
  assert(md.includes('Closing paragraph after the real diagram'), 'text after the real diagram survives');
}

// Pages that discourage copying (user-select:none, copy handlers, transparent
// overlays) still hold ordinary DOM text the reader can already see. Extraction
// must reach it — and must put the live page back exactly as it found it.
function assertProtected(raw) {
  const { md, words, before, after } = JSON.parse(raw);

  section('Behaviour — copy-protected page');

  assert(md.includes('user-select disabled'), 'text under a selection lock captured');
  assert(md.includes('second protected paragraph'), 'later protected paragraph captured');
  assert(md.includes('Protected list item one'), 'list under protection captured');
  assert(md.includes('protected_code_sample'), 'code block under protection captured');
  assert(/\| Term \| Meaning \|/.test(md), 'table under protection captured');
  assert(words > 50, 'full protected article captured', `got ${words} words`);

  // The live tab is the user's, not ours.
  assert(after && before && after.shield === before.shield,
    'overlay restored after extraction', `before=${before?.shield} after=${after?.shield}`);
  assert(after && before && after.select === before.select,
    'user-select restored after extraction', `before=${before?.select} after=${after?.select}`);
  assert(after?.header === true, 'legitimate fixed header left alone');
}

// A lesson buried inside an app shell, next to a link-heavy sidebar, with nav
// icons as inline SVG. Three real failures seen on a live course page:
// the page-type label won the title, scoring settled on a fragment so most of
// the lesson vanished, and a nav icon rendered as a full-page line drawing.
function assertShell(raw) {
  const { md, html, words } = JSON.parse(raw);

  section('Behaviour — lesson inside an app shell');

  // Title: the lesson heading, not the shell's page-type label.
  assert(/^# Introduction$/m.test(md), 'title comes from the lesson heading',
    'expected "Introduction", not the <title> "Theory Lesson"');
  assert(!/^# Theory Lesson$/m.test(md), 'generic page-type label rejected as title');

  // Completeness: every section of the lesson body.
  assert(md.includes('comprehensive overview'), 'Overview section captured');
  assert(md.includes('Securing API Services'), 'Course Agenda captured');
  assert(md.includes('hardening measures'), 'Learning Objectives captured');
  assert(words > 90, 'full lesson captured, not a fragment', `got ${words} words`);

  // Chrome must stay out.
  assert(!md.includes('100% COMPLETE'), 'course sidebar excluded');
  assert(!md.includes('Save and exit'), 'shell controls excluded');

  // Inline icons must not become content: with no intrinsic size an SVG
  // expands to fill the column and swamps the page. This is a PDF-side defect,
  // so it must be asserted on the HTML — the Markdown serializer drops unknown
  // elements and would pass regardless.
  assert(!/<svg/i.test(html), 'decorative inline SVG icons removed from the document HTML',
    `found ${(html.match(/<svg/gi) || []).length} svg element(s)`);
  assert(md.includes('Kong Academy'), 'real content image kept');
}

// The SPA fixture starts extraction itself, the instant the bundle loads and
// before the framework renders. That is the real race: a live course page ships
// an HTML shell whose content elements are empty, so extracting too early
// captures the static "no content" placeholder and the modal machinery.
function assertSpa(raw) {
  const { md, html, words, title } = JSON.parse(raw);

  section('Behaviour — single-page app shell');

  assert(words > 90, 'waits for client-rendered content before extracting',
    `got ${words} words — extraction ran before the framework rendered`);
  assert(title === 'Introduction', 'title from the rendered lesson heading',
    `got "${title}"`);
  assert(md.includes('comprehensive overview'), 'Overview captured after render');
  assert(md.includes('Securing API Services'), 'Course Agenda captured after render');
  assert(md.includes('hardening measures'), 'Learning Objectives captured after render');

  // Shell machinery present in the served HTML must never reach the document.
  assert(!md.includes('This page has no content'), 'shell placeholder removed');
  assert(!md.includes('Save and exit'), 'modal launcher controls removed');
  assert(!md.includes('Got it!'), 'shell notice dismissal removed');
  assert(!md.includes('correctly close/save'), 'SCORM progress notice removed');
  assert(!/\{\{/.test(md) && !/\{\{/.test(html), 'unrendered template bindings removed');
}

// Reads the fixture's own self-run extraction, which races the render.
async function extractAutoResult(wsUrl, fixturePath) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `file://${fixturePath}` });

    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(async () => {
        for (let i = 0; i < 100 && !window.__autoExtract; i++) {
          await new Promise(r => setTimeout(r, 50));
        }
        return JSON.stringify(await window.__autoExtract);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return result.value;
  } finally {
    try { ws.close(); } catch {}
  }
}

// Publishing platforms defeat naive image filtering in four ways, each of which
// silently dropped real article images. Losing a picture is far worse than
// keeping a doubtful one, so intent signals outrank geometry here.
function assertImages(raw) {
  const { md, images } = JSON.parse(raw);
  const has = (s) => md.includes(s);

  section('Behaviour — article image selection');

  // Kept: real content, each defeated by a different filter rule.
  assert(has('article-hero-banner'),
    'wide hero banner kept (intent outranks the sliver aspect check)');
  assert(has('knowledge-layer-diagram'),
    'lazy-loaded diagram kept (never decoded, so geometry is unknown)');
  assert(has('adoption-curve'),
    'captioned figure kept despite role="presentation"');
  assert(has('layer-comparison-chart'),
    'image inside a role="button" edit wrapper kept');

  // Dropped: genuine furniture.
  assert(!has('divider-rule'), 'sliver divider dropped');
  assert(!has('pixel.gif'), 'tracking pixel dropped');
  assert(!has('bullet-icon'), 'small icon dropped');
  assert(!has('profile-photo'), 'author avatar dropped');
  assert(!has('logo-icon') && !has('footer-logo'), 'header/footer logos dropped');

  assert(images.kept === 4, 'exactly the four content images kept',
    `kept ${images.kept} of ${images.total}`);
}

// A course player that loads the lesson into a same-origin iframe — the shape
// LearnUpon uses behind its "Relaunch" button. The URL never changes, and the
// host page holds nothing but a title and that button, so everything that
// matters lives in the frame.
function assertPlayer(raw) {
  const { md, words } = JSON.parse(raw);
  const has = (s) => md.includes(s);

  section('Behaviour — lesson inside a course player frame');

  assert(words > 200, 'lesson read from inside the player frame',
    `got ${words} words — the frame's content was not reached`);
  assert(/^# Rate Limiting$/m.test(md), 'title from the framed lesson, not the host shell');
  assert(has('mechanism that controls how many requests'), 'lesson body captured');
  assert(has('| Mode | Strategy'), 'table inside the frame captured');

  // Widgets live in the frame's document, so the harvester must run there too.
  assert(has('Distributed Denial of Service'), 'first flashcard captured');
  assert(has('Examples of API abuse'), 'second flashcard captured');
  assert(has('Cost control'), 'third flashcard captured');

  // Sequential steppers ("1 of 6" + Start/next arrow) have no control per
  // panel, so they must be clicked repeatedly. Getting this wrong leaves the
  // section in the export as a bare counter and an empty placeholder.
  const steps = [
    'client sends a request', 'increments the counter',
    'compared against the configured limit', '429 response',
    'counters reset at the end',
  ];
  const missingSteps = steps.filter((s) => !has(s));
  assert(missingSteps.length === 0, 'every step of the Start/next stepper captured',
    missingSteps.length ? `missing: ${missingSteps.join(' | ')}` : '');

  const considerations = [
    'choose a counter storage policy', 'size the window against',
    'decide the behaviour when the datastore', 'communicate limits to consumers',
  ];
  const missingConsiderations = considerations.filter((s) => !has(s));
  assert(missingConsiderations.length === 0, 'every step of the next-only stepper captured',
    missingConsiderations.length ? `missing: ${missingConsiderations.join(' | ')}` : '');

  // Instructions for clicking the live widget are meaningless once its panels
  // are laid out in sequence.
  assert(!has("Click on 'Start' button"), 'stepper instruction prompt removed');
  assert(!has('then the (&gt;) to see') && !has('then the (>) to see'),
    'multi-control instruction prompt removed');
  assert(!has('Click on the flashcards'), 'flashcard instruction prompt removed');

  // The player container must be kept (it holds the lesson) while its chrome
  // is dropped — deleting #scorm-content wholesale threw the lesson away.
  assert(!has('Save and exit') && !has('Got it!'), 'player chrome excluded');
  assert(!has('correctly close/save'), 'player progress notice excluded');
}

// Same as extractViaCdp but for an http:// URL, so iframes are same-origin.
async function extractViaHttp(wsUrl, pageUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: pageUrl });
    await new Promise((r) => setTimeout(r, 1500)); // let the player frame load

    const bundle = fs.readFileSync(path.join(ROOT, 'src', 'extractor.bundle.js'), 'utf8');
    const { exceptionDetails: injectErr } = await send('Runtime.evaluate', {
      expression: bundle, returnByValue: true,
    });
    if (injectErr) throw new Error('bundle injection failed');

    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(async () => {
        const c = await window.__clearCopyExtract({ keepImages: true, onlySignificantImages: true });
        return JSON.stringify({ md: window.__clearCopyToMarkdown(c), words: c.wordCount });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return result.value;
  } finally {
    try { ws.close(); } catch {}
  }
}

// Capturing a selection is a different path from capturing a page: it must
// preserve structure (headings, lists), title itself sensibly, and refuse
// politely when nothing is selected.
function assertSelection(raw) {
  const r = JSON.parse(raw);

  section('Behaviour — selection capture');

  assert(r.emptyIsNull, 'returns null when nothing is selected',
    'a collapsed selection must not produce an empty document');
  assert(r.hasSelectionFalse === false, 'hasSelection is false with no selection');
  assert(r.hasSelectionTrue === true, 'hasSelection is true once text is selected');

  assert(r.headingLed?.isSelection === true, 'result is flagged as a selection');
  assert(!!r.headingLed?.hasSourceUrl, 'selection records the page it came from');
  assert(r.headingLed?.title === 'Unordered List', 'titled from the leading heading',
    `got "${r.headingLed?.title}"`);
  // Structure must survive: cloneContents keeps elements, toString would not.
  assert(r.headingLed?.listItems >= 4, 'list structure preserved in the selection',
    `found ${r.headingLed?.listItems} list items`);
  // The heading becomes the title, so printing it again in the body is noise.
  assert(r.headingLed?.titleInBody === false, 'leading heading not duplicated in the body');

  assert(!!r.proseOnly?.titleEndsWithEllipsis,
    'prose-only selection is titled by its opening words');
  assert(r.proseOnly?.words > 0, 'prose-only selection captures its text');
}

async function extractSelectionViaCdp(wsUrl, fixturePath) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `file://${fixturePath}` });
    await new Promise((r) => setTimeout(r, 900));

    const bundle = fs.readFileSync(path.join(ROOT, 'src', 'extractor.bundle.js'), 'utf8');
    await send('Runtime.evaluate', { expression: bundle, returnByValue: true });

    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = {};
        out.emptyIsNull = window.__clearCopySelection({}) === null;
        out.hasSelectionFalse = window.__clearCopyHasSelection();

        const h2 = [...document.querySelectorAll('h2')]
          .find(h => h.textContent.includes('Unordered List'));
        const range = document.createRange();
        range.setStartBefore(h2);
        range.setEndAfter(h2.nextElementSibling);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        out.hasSelectionTrue = window.__clearCopyHasSelection();
        const a = window.__clearCopySelection({ keepImages: true });
        out.headingLed = a && {
          title: a.metadata.title,
          isSelection: a.isSelection,
          hasSourceUrl: !!a.sourceUrl,
          listItems: (a.html.match(/<li/g) || []).length,
          titleInBody: a.html.includes('Unordered List'),
        };

        const p = [...document.querySelectorAll('p')].find(x => x.textContent.length > 60);
        const r2 = document.createRange();
        r2.selectNodeContents(p);
        sel.removeAllRanges();
        sel.addRange(r2);
        const b = window.__clearCopySelection({ keepImages: true });
        out.proseOnly = b && {
          titleEndsWithEllipsis: b.metadata.title.endsWith('\\u2026'),
          words: b.wordCount,
        };

        sel.removeAllRanges();
        return JSON.stringify(out);
      })()`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return result.value;
  } finally {
    try { ws.close(); } catch {}
  }
}

// A carousel driven by numbered pagination ("1 2 3 4") and icon-only arrows —
// the shape used by course authoring tools. Neither control type is detectable
// the usual way: the dots often carry no meaningful class name, and an arrow
// that is only an SVG has no text content at all. Getting this wrong leaves the
// section in the export as a bare "Step 1" and an empty panel.
function assertCarousel(raw) {
  const { md } = JSON.parse(raw);
  const has = (s) => md.includes(s);

  section('Behaviour — numbered carousel');

  // Note: assert against prose, not identifiers — Markdown escapes `limit_by`
  // to `limit\_by`, which a naive substring check would miss.
  const steps = [
    'identifier like consumer id',
    'running count is compared',
    'rate limit headers',
    'HTTP 429',
  ];
  const missing = steps.filter((s) => !has(s));
  assert(missing.length === 0, 'every carousel step captured',
    missing.length ? `missing: ${missing.join(' | ')}` : '');

  const titles = ['Request counting', 'Limit comparison', 'Decision and headers', 'Rejection and reset'];
  const missingTitles = titles.filter((t) => !has(t));
  assert(missingTitles.length === 0, 'every step title captured',
    missingTitles.length ? `missing: ${missingTitles.join(' | ')}` : '');

  // The visible failure the user reported: a heading with nothing under it.
  assert(!/### \d\s*\n\s*\n\s*### /.test(md), 'no empty step sections');
  assert(has('protects upstream services'), 'text after the carousel kept');

  // Pagination bullets whose numbers come from CSS have no text, and exported
  // as a run of bare "- " lines above the carousel content.
  const bareBullets = (md.match(/^-\s*$/gm) || []).length;
  assert(bareBullets === 0, 'textless pagination bullets removed',
    bareBullets ? `${bareBullets} empty bullet(s) in the output` : '');
}

// Some carousel frameworks (Rise 360's block-process-card among them) hide
// inactive slides with the `hidden`/`inert` HTML attributes instead of
// display:none, and every slide's text is already in the DOM — no click is
// needed to make it exist, only to unhide it. Confirmed against the real DOM
// of a Kong Academy lesson that exported with only the first slide's text.
//
// Unlike a tab or stepper — which needs a simulated click before its other
// panels' text exists at all, and so is Book-only — every slide here already
// exists at zero cost, the same as scrolling. That makes this reveal
// unconditional: Article shows every slide too, not just the one currently
// on screen.
function assertHiddenInertCarousel(bookRaw, articleRaw) {
  const book = JSON.parse(bookRaw);
  const article = JSON.parse(articleRaw);

  section('Behaviour — carousel hidden via hidden+inert attributes');

  const slides = [
    'Key Measures for Securing Kong',
    'Enable Health Checks for Data Plane',
    'Manage mTLS Certificates Effectively',
    'Secure Keys in a Vault',
  ];
  const missingInBook = slides.filter((s) => !book.md.includes(s));
  assert(missingInBook.length === 0, 'Book reveals every hidden+inert slide',
    missingInBook.length ? `missing: ${missingInBook.join(' | ')}` : '');

  const missingInArticle = slides.filter((s) => !article.md.includes(s));
  assert(missingInArticle.length === 0, 'Article reveals every hidden+inert slide too (already free to read)',
    missingInArticle.length ? `missing: ${missingInArticle.join(' | ')}` : '');

  assert(book.md.includes('security measures to consider') && book.md.includes('disabling debug headers'),
    'text before and after the carousel survives in Book mode');
  assert(article.md.includes('security measures to consider') && article.md.includes('disabling debug headers'),
    'text before and after the carousel survives in Article mode');
}

// A virtualised question feed (Typeform and friends) keeps a rolling window of
// blocks mounted and fades the off-screen neighbours out with `inert` +
// opacity:0 — no `hidden` attribute, and each block an only child of its own
// wrapper. The older hidden+inert carousel pass misses this twice over (its
// selector needs both attributes, its shape test needs same-class siblings),
// so a real form exported as one question out of the three sitting in the DOM.
// The text costs nothing to read, so Article must keep all of it.
function assertInertOpacityBlocks(bookRaw, articleRaw) {
  const book = JSON.parse(bookRaw);
  const article = JSON.parse(articleRaw);

  section('Behaviour — blocks hidden via inert + opacity:0');

  const blocks = [
    'Our first set of questions are about AI',
    'Do you use AI for any of the following API-related tasks?',
    'Does your organisation provide you with any of the following guidance?',
  ];

  const missingInArticle = blocks.filter((b) => !article.md.includes(b));
  assert(missingInArticle.length === 0,
    'Article keeps every inert+opacity:0 block (already free to read)',
    missingInArticle.length ? `missing: ${missingInArticle.join(' | ')}` : '');

  const missingInBook = blocks.filter((b) => !book.md.includes(b));
  assert(missingInBook.length === 0, 'Book keeps every inert+opacity:0 block',
    missingInBook.length ? `missing: ${missingInBook.join(' | ')}` : '');

  // The answer options are the part a reader actually wants, and the renderer
  // emits each one as a <button role="checkbox">. STRIP_TAGS removes every
  // <button> as interactive UI, so a real form exported as a question with no
  // answers under it — "Choose as many as you like" and then nothing.
  const options = [
    'Writing OpenAPI, Async or other API descriptions',
    'Generating API documentation and reference material',
    'API design review such as an AI linter checking for risks',
  ];
  const missingOptions = options.filter((o) => !article.md.includes(o));
  assert(missingOptions.length === 0,
    'answer options marked up as <button role="checkbox"> survive',
    missingOptions.length ? `missing: ${missingOptions.join(' | ')}` : '');

  assert(article.md.includes('How to assess security risks with AI usage'),
    'options inside a faded block survive in Article mode');

  // Keeping answer buttons must not degrade into keeping every button: a
  // plain navigation control is still page furniture.
  assert(!article.md.includes('Continue to the next question'),
    'a plain navigation button is still stripped');

  // NOTE: the announcement-only "Key" prefix on each answer's letter badge
  // (SCREEN_READER_ONLY's `key-hint` term) is deliberately NOT asserted here.
  // The badge is dropped from this fixture's output before the hint can ever
  // reach the Markdown, so any assertion on it passes with the fix reverted —
  // i.e. it would test nothing. The leak was confirmed by hand against the
  // live renderer ("KeyAWriting OpenAPI…" → "AWriting OpenAPI…"); reproducing
  // it here needs a fixture that keeps the badge, which is worth adding when
  // the letter-badge shape itself is next touched.

  assert(article.md.includes('anonymous and will be used in research reports'),
    'text after the block feed survives in Article mode');

  // The real cost of scoring zero for <legend>/<div> content: the only
  // prose-bearing heading on the page belongs to the help sidebar, so it wins
  // the content-root contest and the document is titled after the chrome
  // instead of the form. The form's own title must win.
  assert(!/^title:.*Frequently asked questions/m.test(article.md),
    'document is not titled after the help sidebar',
    `title line: ${(article.md.match(/^title:.*$/m) || ['(none)'])[0]}`);

  assert(/^title:.*State of the Market Report/m.test(article.md),
    'document takes its title from the form, not the surrounding chrome',
    `title line: ${(article.md.match(/^title:.*$/m) || ['(none)'])[0]}`);

  // Electing <body> as the root (the `best || explicit || doc.body` fallback)
  // drags in every scrap of page furniture alongside the form.
  assert(!article.md.includes('Cookies'),
    'inert site chrome is not dragged in when the root falls back to body');
}

// A virtualised form renderer mounts only a rolling window of questions and
// keeps the rest in the form-definition payload it shipped to the browser.
// Nothing in the DOM reaches those questions — not a reveal, not a click — so
// Book reads the payload instead. Clicking is not merely unnecessary here but
// unsafe: advancing the widget submits a real answer, which TAB_UNSAFE
// forbids. Article stays a snapshot of what is mounted.
function assertFormPayload(bookRaw, articleRaw, disabledRaw) {
  const book = JSON.parse(bookRaw);
  const article = JSON.parse(articleRaw);
  const disabled = JSON.parse(disabledRaw);

  section('Behaviour — questions held only in a form payload');

  // Mounted in the DOM: both modes must have these.
  const mounted = [
    'Do you use AI for any of the following API-related tasks?',
    'How reliable are you finding the results from AI in your work?',
  ];
  const missingMounted = mounted.filter((q) => !article.md.includes(q));
  assert(missingMounted.length === 0, 'Article keeps the questions mounted in the DOM',
    missingMounted.length ? `missing: ${missingMounted.join(' | ')}` : '');

  // The options belonging to a mounted question are on screen, so Article
  // keeps them — the earlier <button role="checkbox"> fix, still holding on a
  // form page.
  assert(article.md.includes('Writing OpenAPI, Async or other API descriptions'),
    'Article keeps the answer options of a mounted question');

  // Present ONLY in the payload: Book must recover these, and they are the
  // whole point — a DOM walk finds two questions and loses three.
  const payloadOnly = [
    'Our first set of questions are about AI',
    'Does your organisation provide you with any of the following guidance?',
    'What is your role?',
  ];
  const missingInBook = payloadOnly.filter((q) => !book.md.includes(q));
  assert(missingInBook.length === 0, 'Book recovers questions that exist only in the payload',
    missingInBook.length ? `missing: ${missingInBook.join(' | ')}` : '');

  // Answer choices come with them, including ones whose question never mounted.
  const choices = [
    'API design review such as an AI linter checking for risks',
    'How to assess security risks with AI usage',
    'Solution architect or team leader',
  ];
  const missingChoices = choices.filter((c) => !book.md.includes(c));
  assert(missingChoices.length === 0, 'Book recovers the answer choices from the payload',
    missingChoices.length ? `missing: ${missingChoices.join(' | ')}` : '');

  // `allow_other_choice` is a sibling flag, not a member of `choices`: reading
  // the array alone silently drops a real option from most questions.
  assert(/(^|\n).*Other\s*$/m.test(book.md),
    'an allow_other_choice question gains its "Other" option');

  // Field descriptions are a separate key from the title; a parser that reads
  // only titles loses the clarifying line under each question.
  assert(book.md.includes('If you are unsure, just answer for you'),
    'field descriptions survive alongside their question');

  // Article must NOT recover them. That the payload is free to read does not
  // make it part of the current page: these are questions the reader has not
  // reached and the renderer has never shown, so including them would make an
  // Article capture a different document from the one on screen.
  const leaked = payloadOnly.filter((q) => article.md.includes(q));
  assert(leaked.length === 0, 'Article does not pull in unmounted payload questions',
    leaked.length ? `leaked: ${leaked.join(' | ')}` : '');

  // …and the two modes therefore differ on a form page. If these ever converge
  // the gating has been lost, whichever direction it broke in.
  assert(book.md.length > article.md.length * 1.2,
    'Book captures materially more of a form than Article',
    `article ${article.md.length} vs book ${book.md.length} chars`);

  // The payload is a data island, never prose: none of its plumbing may reach
  // the document.
  assert(!book.md.includes('__FORM_BOOTSTRAP__') && !/"ref"\s*:/.test(book.md),
    'payload plumbing (refs, ids, bootstrap name) never reaches the document');

  // readFormPayload:false must genuinely turn the pass off, or the setting is
  // decorative. The capture falls back to what the renderer mounted.
  const stillThere = payloadOnly.filter((q) => disabled.md.includes(q));
  assert(stillThere.length === 0, 'readFormPayload:false falls back to the mounted DOM',
    stillThere.length ? `still present: ${stillThere.join(' | ')}` : '');

  assert(disabled.md.includes('Do you use AI for any of the following API-related tasks?'),
    'readFormPayload:false still captures the mounted questions');
}

// Blocks that render as nothing but still occupy a slot in the document. The
// Markdown side already came out clean — blocks.js drops these on its own —
// but the HTML the PDF is printed from kept an empty <h2> (a gap where a
// title should be) and an emptied <tr> (a blank stripe across the table),
// because the sweep in buildCleanTree skips headings and rows.
//
// Asserted on `html`, not `md`: this is a PDF-side defect, and asserting it
// on the Markdown would pass while testing nothing.
function assertEmptyBlocks(raw) {
  const { md, html } = JSON.parse(raw);

  section('Behaviour — empty blocks dropped from the printed tree');

  // Real content is never at risk.
  const keep = [
    'A real opening paragraph that must always survive',
    'A second real paragraph, after the empty blocks',
    'A closing paragraph that must survive in both modes',
    'First genuine option in the list',
    'Second genuine option in the list',
  ];
  const missing = keep.filter((t) => !md.includes(t));
  assert(missing.length === 0, 'every real block survives',
    missing.length ? `missing: ${missing.join(' | ')}` : '');

  assert(md.includes('EMEA') && md.includes('62%'),
    'a table with real rows survives');

  // The two real defects.
  assert(!/<h[1-6][^>]*>\s*<\/h[1-6]>/.test(html),
    'an empty heading is dropped from the printed tree',
    (html.match(/<h[1-6][^>]*>\s*<\/h[1-6]>/) || [''])[0]);

  assert(!/<tr[^>]*>\s*<\/tr>/.test(html),
    'a row left with no cells is dropped from the printed tree',
    (html.match(/<tr[^>]*>\s*<\/tr>/) || [''])[0]);

  // A header row plus one body row: the blank third row must be gone without
  // taking a real one with it.
  const rows = (html.match(/<tr[^>]*>/g) || []).length;
  assert(rows === 2, 'exactly the two real table rows remain', `rows: ${rows}`);

  // Markdown-side guards, so a regression on either path is caught.
  assert(!/^-\s*$/m.test(md), 'no bare "- " bullet in the Markdown');
  assert(!/^#{1,6}\s*$/m.test(md), 'no empty heading in the Markdown');
}

// A course whose left menu is an ARIA tree, walked lesson by lesson into one
// book. This is the shape the old collectWholeCourse could not handle and the
// reason it was reverted does not apply to: navigation here is client-side, so
// no beforeunload fires and Chrome never raises its unsaved-changes prompt.
//
// Two things are load-bearing and easy to lose:
//   * only LEAF treeitems are lessons — a group row contains other treeitems
//     and walking it would capture the same page twice;
//   * TAB_UNSAFE still applies. "Save and exit course" sits in the same tree
//     wearing the same markup, and following it during a walk can end an
//     enrollment rather than merely navigating.
function assertCourseTreeWalk(raw) {
  const { walked, probe } = JSON.parse(raw);
  const md = walked.md || '';
  const visited = walked.visited || [];

  section('Behaviour — whole-course walk over an ARIA lesson tree');

  // Every leaf lesson reached, in menu order.
  const lessons = ['Introduction', "What you'll learn", 'Assess use-case quality', 'Summary'];
  const missing = lessons.filter((t) => !visited.includes(t));
  assert(missing.length === 0, 'every leaf lesson in the tree is visited',
    missing.length ? `missing: ${missing.join(' | ')}` : `visited: ${visited.join(' | ')}`);

  assert(visited.length === lessons.length,
    'group rows are not walked as lessons',
    `visited ${visited.length}: ${visited.join(' | ')}`);

  // The unsafe row must never be followed.
  assert(!visited.some((t) => /exit/i.test(t)),
    'an unsafe "Save and exit" row is never followed',
    `visited: ${visited.join(' | ')}`);
  assert(!md.includes('Enrollment ended'),
    'the exit page never reaches the book');

  // The book holds each lesson's body, not just its title.
  const bodies = [
    'activation-ready use cases are designed',
    'evaluate business value and activation readiness',
    'measurable outcomes, data availability',
    'checklist you will reuse',
  ];
  const missingBodies = bodies.filter((b) => !md.includes(b));
  assert(missingBodies.length === 0, 'each lesson contributes its own body text',
    missingBodies.length ? `missing: ${missingBodies.join(' | ')}` : '');

  // It is a book: a table of contents, and the lessons in menu order.
  assert(/Contents/.test(walked.html || ''), 'the merged document has a table of contents');
  const order = lessons.map((t) => md.indexOf(t));
  assert(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])),
    'lessons appear in menu order', `offsets: ${order.join(', ')}`);

  // The walk must be a client-side route, never a reload — a reload is what
  // raised the browser prompt that killed this feature the first time.
  assert(probe.survived && !probe.unloadFired,
    'walking the tree never unloads the document (no browser prompt)',
    `survived=${probe.survived} unloadFired=${probe.unloadFired}`);

  // The learner is put back where they started.
  assert(walked.restored === true, 'the originally open lesson is restored afterwards');
}

// "Visually hidden" accessibility text (position:absolute + clip, not
// display:none) is left in textContent for screen readers to announce, but
// has no place in an exported document — a real bug report showed a stray
// "Numbered divider1" leaking into an export with no visible source on the
// page it came from.
function assertScreenReaderOnlyStripped(raw) {
  const { md } = JSON.parse(raw);

  section('Behaviour — screen-reader-only text excluded');

  assert(!md.includes('Numbered divider1'), 'visually-hidden divider caption excluded');
  assert(md.includes('security measures to consider'), 'real text before the hidden caption kept');
  assert(md.includes('disabling debug headers'), 'real text after the hidden caption kept');
}

// Article and Book differ in *what is captured*, not just page geometry:
// Article takes the page as it stands, Book walks every interactive panel.
function assertInteractiveModes(raw) {
  const { article, book, widgetRestored } = JSON.parse(raw);

  section('Behaviour — Article vs Book capture');

  assert(book.steps === 4, 'Book expands every carousel step',
    `captured ${book.steps} of 4`);
  assert(book.expandedPanels > 0, 'Book reports how many panels it expanded',
    `expandedPanels = ${book.expandedPanels}`);

  assert(article.steps === 1, 'Article captures only the open step',
    `captured ${article.steps} of 4 — Article must not walk the widget`);
  assert(article.expandedPanels === 0, 'Article expands nothing');
  assert(book.words > article.words * 1.5, 'Book captures materially more than Article',
    `book ${book.words} words vs article ${article.words}`);

  // Either mode must leave the live page as it found it.
  assert(widgetRestored, 'the widget is left on its original step');
}

// Article must still return the whole lesson, not the player shell.
//
// Scope note: this fixture keeps its hidden segments in the DOM, so cloning
// picks them up whether or not the reveal ran — it therefore does NOT prove
// the reveal gating is correct, only that Article returns a full lesson rather
// than the shell. The gating itself is covered by
// `assertInteractiveModes`, where Article and Book genuinely differ.
function assertArticleReadsHiddenContent(raw) {
  const { md, words, title } = JSON.parse(raw);

  section('Behaviour — Article returns the lesson, not the shell');

  assert(title === 'Services and Routes', 'lesson title, not the shell label',
    `got "${title}"`);
  assert(md.includes('abstraction of an upstream'), 'visible segment captured');
  assert(md.includes('proxy port to confirm'), 'later segment captured');
  assert(md.includes('404 from the proxy port'), 'third segment captured');
  assert(words > 150, 'Article captures the whole lesson, not just the shell',
    `got ${words} words`);
  assert(!md.includes('100% COMPLETE'), 'course navigation still excluded');
}

// Loads the fixture twice — once per interactive mode — so the two can be
// compared directly. Article must run on a freshly loaded page, since Book
// leaves the widget advanced.
async function compareInteractiveModes(wsUrl, fixturePath) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const bundle = fs.readFileSync(path.join(ROOT, 'src', 'extractor.bundle.js'), 'utf8');

  const runMode = async (mode) => {
    await send('Page.navigate', { url: `file://${fixturePath}` });
    await new Promise((r) => setTimeout(r, 700));
    await send('Runtime.evaluate', { expression: bundle, returnByValue: true });

    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression: `(async () => {
        const steps = ['identifier like consumer id', 'running count is compared',
                       'rate limit headers', 'HTTP 429'];
        const c = await window.__clearCopyExtract({ keepImages: true, interactive: '${mode}' });
        const md = window.__clearCopyToMarkdown(c);
        return JSON.stringify({
          words: c.wordCount,
          steps: steps.filter(s => md.includes(s)).length,
          expandedPanels: c.expandedPanels,
          panelNow: document.getElementById('stepTitle').textContent,
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || 'evaluate failed');
    return JSON.parse(result.value);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    const book = await runMode('expand');
    const article = await runMode('current');
    return JSON.stringify({
      book,
      article,
      // Both modes restore the widget, so it should still read step 1.
      widgetRestored: article.panelNow === 'Request counting',
    });
  } finally {
    try { ws.close(); } catch {}
  }
}

// Real bug reported against a live course page: the learner had not clicked
// Launch, so the lesson genuinely did not exist in the DOM yet — no iframe, no
// cross-origin frame, no hidden segment holding it. Only "Theory Lesson" (2
// words) was extractable. The guard in preview.js/popup.js is supposed to
// refuse to export this silently; it originally required blockedFrames.length,
// which is 0 here, so it let a near-empty document through unexplained.
function assertPrelaunchGuard(raw) {
  const { words, blockedFrames } = JSON.parse(raw);

  section('Behaviour — pre-launch page (no frame, almost no content)');

  assert(words <= 5, 'fixture genuinely has almost no content (sanity check)',
    `got ${words} words`);
  assert(blockedFrames === 0,
    'no blocked frame is involved — the low-content guard must not depend on one',
    `blockedFrames=${blockedFrames}`);

  // The guard formula is duplicated in preview.js and popup.js (no shared
  // module to call instead). Assert both files actually contain the
  // unconditional low-content check, so this test cannot pass merely because
  // its own re-derivation agrees with itself while the real files regress.
  for (const file of ['preview.js', 'popup.js']) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const hasBareGuard = /if \(best\.wordCount < 25\) \{/.test(src);
    const hasOldBuggyGuard = /if \(best\.wordCount < 25 && best\.blockedFrames\?\.length\) \{/.test(src);
    assert(hasBareGuard && !hasOldBuggyGuard,
      `${file} guards low content without requiring a blocked frame`,
      !hasBareGuard ? 'unconditional guard not found' : 'still requires blockedFrames.length');
  }

  const wouldWarn = words < 25;
  assert(wouldWarn, 'the low-content guard fires without needing a blocked frame');
}

function report() {
  console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${checks - failures}/${checks} checks passed\x1b[0m`);
  process.exit(failures ? 1 : 0);
}

runBrowserTests().then(report).catch((err) => {
  fail('validation run', err.message);
  report();
});
