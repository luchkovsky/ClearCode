// Preview controller: extracts once, then re-renders locally as options change.
// Re-extraction only happens when an option changes what we pull from the page
// (currently just keepImages), so format tweaks stay instant.

import {
  PAPER, MARGINS, THEMES, FONTS, DEFAULT_OPTIONS,
  buildStylesheet, buildDocumentHtml, paperSize, marginBox,
} from './src/render.js';
import { htmlToBlocks, toMarkdown, estimateReadingTime } from './src/blocks.js';
import { exportPdf, safeFilename, downloadBlob } from './src/export.js';
import {
  loadCollection, mergeCollection, addToCollection,
  removeFromCollection, clearCollection, selectContentFrames,
} from './src/collection.js';
import { loadSettings } from './src/settings.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'clearcopy:options';

const DOC_TYPE_HINTS = {
  article: 'The page as it stands now — only the open tab or carousel step. One continuous page, no breaks.',
  book: 'Everything opened out — every tab, carousel step and collapsed section, on paginated sheets.',
};
const STYLE_HINTS = {
  reader: 'Rebuilt with clean typography. Best for reading and Markdown parity.',
  faithful: "Keeps the source page's own layout and colours, minus the clutter.",
};

const state = {
  options: { ...DEFAULT_OPTIONS },
  content: null,     // { metadata, html, text, wordCount }
  blocks: null,
  sourceTabId: null,
  source: 'page',        // page | collection
  collection: [],
  isCollection: false,
  collectionSize: 0,
  zoom: 1,
  autoFit: true,
  session: 'default',   // which collection bucket this window reads and writes
  hasLessonTree: false,  // a course menu the whole-course walk could follow
};

// ---------------------------------------------------------------------------
// Option persistence
// ---------------------------------------------------------------------------

async function loadOptions() {
  // Extension settings supply the starting point; anything the user has since
  // adjusted in the preview overrides it.
  try {
    const settings = await loadSettings();
    state.options.docType = settings.defaultDocType;
    state.options.style = settings.defaultStyle;
    state.options.keepImages = settings.keepImages;
    state.options.onlySignificantImages = settings.onlySignificantImages;
    state.options.keepInteractionPrompts = settings.keepInteractionPrompts;
    state.options.readFormPayload = settings.readFormPayload;
  } catch {}

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY]) Object.assign(state.options, stored[STORAGE_KEY]);
  } catch {}
}

let saveTimer;
function saveOptions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ [STORAGE_KEY]: state.options }).catch(() => {});
  }, 250);
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function setLoading(text) {
  const loading = $('loading');
  // A failed boot replaces the spinner markup, so rebuild it when re-entering.
  if (!$('loadingText')) {
    loading.innerHTML = '<div class="spinner"></div><p id="loadingText"></p>';
  }
  $('loadingText').textContent = text;
  loading.hidden = false;
  $('paperWrap').hidden = true;
}

function clearLoading() {
  $('loading').hidden = true;
  $('paperWrap').hidden = false;
}

async function loadFromCollection() {
  setLoading('Merging collected pages…');
  const items = await loadCollection(state.session);
  if (!items.length) {
    throw new Error('Your collection is empty. Use “Add this page” on each lesson first.');
  }
  state.collectionSize = items.length;
  return mergeCollection(items, {
    style: state.options.style,
    pageBreaks: state.options.docType !== 'article',
  });
}

// Walk every lesson in a course's left-hand tree and merge them into one book.
//
// Top frame only, deliberately: the lesson tree is the player's own navigation
// and lives in the host page, while `readPageFromTab` fans out to every frame
// because the *content* may be elsewhere. Each lesson's extraction still goes
// through the normal all-frames path once the walk has navigated to it.
//
// This is the whole-course capture that was removed once before. It is safe to
// bring back only for tree-shaped menus that route client-side: the walk stops
// the moment a navigation actually unloads the page, which is the condition
// that made the old version demand a manual click per lesson.
async function walkCourseFromSourceTab(onStep) {
  const tabId = state.sourceTabId;
  if (!Number.isFinite(tabId)) {
    throw new Error('No page to read. Open Clear Copy from the course you want to export.');
  }

  const inject = () => chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/extractor.bundle.js'],
  }).catch(() => {});

  await inject();

  const run = async (func, args = []) => {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, args, func });
    return res?.result;
  };

  const summary = await run(() => (window.__clearCopyLessonTree
    ? window.__clearCopyLessonTree() : null));
  if (!summary || !summary.titles?.length) {
    throw new Error('No course menu found on this page. Whole-course capture needs a lesson list in the sidebar.');
  }

  const { titles, openIndex, courseTitle } = summary;
  const options = {
    keepImages: state.options.keepImages,
    onlySignificantImages: state.options.onlySignificantImages,
    keepInteractionPrompts: state.options.keepInteractionPrompts,
    readFormPayload: state.options.readFormPayload,
    interactive: 'current',
    // The course shell stays loaded between lessons, so the lazy-scroll pass
    // would repeat forty times for content already fetched.
    materializeLazy: false,
  };

  const pages = [];
  const visited = [];
  let unloaded = false;

  for (let i = 0; i < titles.length; i++) {
    onStep?.(i, titles.length, titles[i]);

    const opened = await run(
      (idx) => (window.__clearCopyOpenLesson ? window.__clearCopyOpenLesson(idx) : null), [i]);
    if (!opened?.ok) {
      // A page that genuinely unloaded means this course is not client-side
      // routed; stop rather than fight the browser's unsaved-changes prompt.
      if (opened?.unloaded || opened?.reason === 'unloaded') { unloaded = true; break; }
      continue;
    }

    // Client-side routing does not tear down the top frame, so the bundle
    // normally survives from lesson to lesson. Re-injecting 126 KB into every
    // frame on every lesson was costing more than the extraction itself, so
    // do it only when the entry point has actually gone (a real navigation, or
    // a player frame that was replaced).
    const alive = await run(() => typeof window.__clearCopyExtract === 'function');
    if (!alive) await inject();
    let content;
    try {
      content = await readPageFromTab(tabId, options, { skipInject: true });
    } catch {
      continue;
    }
    if (!content || !(content.text || '').trim()) continue;

    // The menu label wins: a lesson page often has no heading of its own (a
    // Summary reads "Untitled"), and the sidebar label is what the contents
    // page must list.
    pages.push({ ...content, title: titles[i] || content.metadata?.title || 'Lesson', order: i });
    visited.push(titles[i]);
  }

  // Put the reader back on the lesson they had open.
  let restored = false;
  if (openIndex >= 0) {
    const back = await run(
      (idx) => (window.__clearCopyOpenLesson ? window.__clearCopyOpenLesson(idx) : null), [openIndex]);
    restored = !!back?.ok;
  }

  if (!pages.length) throw new Error('The course walk produced nothing to export.');
  if (unloaded) {
    status(`Stopped after ${pages.length} lessons — this course reloads the page between lessons.`, 6000);
  }

  return { pages, visited, restored, unloaded, courseTitle };
}

// How many lessons a whole-course walk would visit, so the confirmation can
// name a real number instead of asking for a blank cheque.
async function countCourseLessons() {
  const tabId = state.sourceTabId;
  if (!Number.isFinite(tabId)) return 0;
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, files: ['src/extractor.bundle.js'],
    }).catch(() => {});
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.__clearCopyFindLessonTree ? window.__clearCopyFindLessonTree() : []),
    });
    return (res?.result || []).length;
  } catch {
    return 0;
  }
}

// Reads whatever is currently loaded in tabId — one page, as it stands right now.
async function readPageFromTab(tabId, options, { skipInject = false } = {}) {
  // Inject into EVERY frame, not just the top one. Course players and embedded
  // readers host the real content on another domain, which the page itself
  // cannot read — but the extension can, by running inside that frame too.
  //
  // `skipInject` is for a course walk, which has already checked that the
  // bundle is live: pushing 126 KB into every frame once per lesson dominated
  // the walk's runtime, and client-side routing leaves the frames intact.
  if (!skipInject) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/extractor.bundle.js'],
    }).catch(() => {
      // A frame that refuses injection must not abort the others.
    });
  }

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [options],
      func: (opts) => (window.__clearCopyExtract
        ? window.__clearCopyExtract(opts)
        : null),
    });
  } catch {
    // executeScript rejects wholesale if any frame throws. Fall back to the top
    // frame so a broken sub-frame cannot cost us the whole page.
    results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [options],
      func: (opts) => (window.__clearCopyExtract ? window.__clearCopyExtract(opts) : null),
    });
  }

  const extracted = results
    .map((r) => r.result)
    .filter((r) => r && r.wordCount > 0);

  if (!extracted.length) throw new Error('Could not read this page.');

  // Each frame reports independently; the lesson is whichever has the most
  // prose. The top frame usually holds only the player shell.
  extracted.sort((a, b) => b.wordCount - a.wordCount);
  const best = extracted[0];

  // A player shell — or a pre-launch landing page with just a "Launch" button
  // and no iframe at all yet — is a handful of words of chrome. Neither case
  // requires a blocked frame: the lesson can be simply absent from the DOM
  // until the learner starts it, in the same top-level document. Say so
  // plainly rather than exporting it as though it were the lesson.
  if (best.wordCount < 25) {
    throw new Error(
      best.blockedFrames?.length
        ? 'Only the course player frame was readable, not the lesson inside it. '
          + 'Click Launch or Relaunch so the lesson is on screen, then reopen this preview.'
        : `Only found "${best.text || best.metadata?.title || 'a few words'}" on this page. `
          + 'If this is a course lesson, click Launch, Relaunch or Start so the '
          + 'content is on screen, then reopen this preview.');
  }

  // A frame we reached is no longer "blocked" — clear warnings the top frame
  // raised about frames this pass has now read.
  if (best.blockedFrames?.length && extracted.length > 1) {
    best.blockedFrames = [];
  }

  // Course pages can hold more than one real content frame at once — the
  // main lesson plus a separate embedded exercise or tool. See
  // selectContentFrames in collection.js for why this is a real threshold,
  // not just "anything the word-count winner beats".
  const frames = selectContentFrames(extracted);
  if (frames.length === 1) return best;

  const items = frames.map((r, i) => ({
    url: r.metadata?.url || '',
    title: r.metadata?.title || 'Untitled',
    html: r.html,
    faithfulHtml: r.faithfulHtml,
    metadata: r.metadata,
    wordCount: r.wordCount,
    images: r.images,
    order: i,
  }));
  const merged = mergeCollection(items, { includeContents: false, pageBreaks: false });
  return { ...merged, blockedFrames: best.blockedFrames || [] };
}

// Dev tool: run window.clearCopyDebugFrames() in this preview tab's own
// console to list every frame chrome.scripting can reach on the source tab,
// with real diagnostics distinguishing "genuinely empty" from "not yet
// rendered" — a quick census without doing a full extraction or writing a
// one-off script each time. Nothing here is used by real capture.
window.clearCopyDebugFrames = async function clearCopyDebugFrames() {
  const tabId = state.sourceTabId;
  if (!Number.isFinite(tabId)) { console.log('No source tab.'); return; }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/extractor.bundle.js'],
  }).catch(() => {});

  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyWords: (document.body?.innerText || '').trim().split(/\s+/).filter(Boolean).length,
      elementCount: document.body?.querySelectorAll('*').length ?? 0,
      hasForms: !!document.querySelector('form, input, textarea, select'),
      hasVideo: !!document.querySelector('video, audio'),
      hasIframe: !!document.querySelector('iframe'),
      svgSliderControls: document.querySelectorAll('[role="button"][aria-label][data-model-abs-id]').length,
      anyDataModelAbsId: document.querySelectorAll('[data-model-abs-id]').length,
      anyRoleButton: document.querySelectorAll('[role="button"]').length,
    }),
  }).catch((e) => { console.log('Frame census failed:', e.message); return []; });

  console.log(`${results.length} frame(s) reachable on tab ${tabId}:`);
  results.forEach((r) => {
    if (r.result) {
      const c = r.result;
      console.log(`  frameId=${r.frameId} words=${c.bodyWords} elements=${c.elementCount} `
        + `readyState=${c.readyState} forms=${c.hasForms} video=${c.hasVideo} nestedIframe=${c.hasIframe} `
        + `svgSliderControls=${c.svgSliderControls} dataModelAbsId=${c.anyDataModelAbsId} roleButton=${c.anyRoleButton} `
        + `title=${JSON.stringify(c.title)} href=${c.href}`);
    } else {
      console.log(`  frameId=${r.frameId} unreachable: ${r.error?.message ?? 'no result'}`);
    }
  });
};

// Dev tool: run window.clearCopyDebugExtract() to run a REAL extraction pass
// with debug logging turned on, then print each frame's collected debug log —
// carried back on the return value, not console.log, since a frame's own
// console output does not reliably surface in any DevTools context that's
// been tried.
//
// Pass a specific frameId (from clearCopyDebugFrames()'s output) as the first
// argument to target just that frame — waitForContent + the lazy-content
// scroll pass run per frame, so allFrames can realistically take a minute or
// more across ~10 frames; targeting one frame is the fast path for isolating
// a single widget. A client-side timeout (20s) reports back "still running"
// rather than leaving the call looking silently stuck.
window.clearCopyDebugExtract = async function clearCopyDebugExtract(frameId, options = {}) {
  const tabId = state.sourceTabId;
  if (!Number.isFinite(tabId)) { console.log('No source tab.'); return; }

  const target = Number.isFinite(frameId)
    ? { tabId, frameIds: [frameId] }
    : { tabId, allFrames: true };

  await chrome.scripting.executeScript({ target, files: ['src/extractor.bundle.js'] }).catch(() => {});

  const run = chrome.scripting.executeScript({
    target,
    args: [{ interactive: 'current', ...options }],
    func: (opts) => {
      window.__clearCopyDebug = true;
      window.__clearCopyDebugLog = [];
      return window.__clearCopyExtract ? window.__clearCopyExtract(opts) : null;
    },
  }).catch((e) => { console.log('Debug extract failed:', e.message); return []; });

  const timeout = new Promise((resolve) => setTimeout(() => resolve('__timeout__'), 20000));
  const results = await Promise.race([run, timeout]);
  if (results === '__timeout__') {
    console.log('Still running after 20s — extraction has not returned yet. '
      + 'This can legitimately take longer for allFrames; try passing a specific frameId instead.');
    return;
  }

  results.forEach((r) => {
    if (!r.result) {
      console.log(`frameId=${r.frameId}: no result (error=${r.error?.message ?? 'none'})`);
      return;
    }
    console.log(`frameId=${r.frameId} wordCount=${r.result.wordCount} title=${JSON.stringify(r.result.metadata?.title)}`);
    (r.result.debugLog || []).forEach((line) => console.log(`  ${line}`));
    if (!r.result.debugLog?.length) console.log('  (no debug log entries for this frame)');
  });
};

// Dev tool: run window.clearCopyDebugNavLinks() to see every candidate for
// "advance to the next lesson" on the current source tab — both class-based
// sidebar links AND shape-based matches ("Lesson 2 - Title", "Next lesson",
// a counter like "Lesson 1 of 8"). Reports tag, href (a real URL vs a
// JS-driven in-page control), and whether it has a click handler, so we can
// tell "this navigates" from "this swaps content on the same page" without
// clicking it and watching what happens.
window.clearCopyDebugNavLinks = async function clearCopyDebugNavLinks() {
  const tabId = state.sourceTabId;
  if (!Number.isFinite(tabId)) { console.log('No source tab.'); return; }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const COURSE_NAV_CONTAINER = /course-nav|lesson-nav|module-nav|curriculum|syllabus|sidebar/i;
      const LESSON_SHAPE = /^lesson\s*\d+(\s*(of|\/)\s*\d+)?\b|^next\b|^continue\b/i;

      const describe = (el) => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
        cls: (el.getAttribute?.('class') || '').slice(0, 80),
        href: el.getAttribute?.('href') || null,
        resolvedHref: el.href || null,
        hasOnclickAttr: el.hasAttribute?.('onclick'),
        role: el.getAttribute?.('role') || null,
      });

      const found = new Map(); // element -> descriptor, dedup

      // 1. Class-based: the original sidebar-container approach.
      Array.from(document.querySelectorAll('nav, aside, [class*="nav"], [class*="sidebar"]'))
        .filter((el) => COURSE_NAV_CONTAINER.test(`${el.className || ''} ${el.id || ''}`))
        .forEach((container) => {
          container.querySelectorAll('a[href]').forEach((a) => found.set(a, { via: 'sidebar-class', ...describe(a) }));
        });

      // 2. Shape-based: any link/button whose own text matches "Lesson N",
      // "Lesson N of M", "Next", "Continue" — the pattern this course
      // actually uses ("Lesson 8 of 8" counter, "Lesson 2 - ..." control).
      document.querySelectorAll('a, button, [role="button"], [role="link"]').forEach((el) => {
        if (found.has(el)) return;
        const text = (el.textContent || '').trim();
        if (LESSON_SHAPE.test(text)) found.set(el, { via: 'shape-match', ...describe(el) });
      });

      return Array.from(found.values());
    },
  }).catch((e) => [{ error: e.message }]);

  if (!result) { console.log('Could not read nav candidates from the source tab.'); return; }
  console.log(`${result.length} candidate(s) found:`);
  result.forEach((l) => {
    console.log(`  [${l.via}] <${l.tag}> "${l.text}" class="${l.cls}" href=${JSON.stringify(l.href)} `
      + `resolved=${l.resolvedHref} onclickAttr=${l.hasOnclickAttr} role=${l.role}`);
  });
};

// Article reads the current page as it stands. Book reads the same page but
// with every widget fully expanded (tabs, steppers, flashcards clicked
// through). Earlier this session Book also navigated the tab through every
// lesson linked from the page's own navigation, merging them into one whole-
// course document — dropped after real-world testing: the course player
// warns with a native "changes you made may not be saved" beforeunload
// prompt on every single navigation away from a live SCORM session, which
// made a multi-lesson course walk require manually dismissing that dialog
// once per lesson. Single-page capture has no such interruption.
async function extractFromSourceTab() {
  const tabId = state.sourceTabId;
  if (!Number.isFinite(tabId)) {
    throw new Error('No page to read. Open Clear Copy from the page you want to export.');
  }

  const options = {
    keepImages: state.options.keepImages,
    onlySignificantImages: state.options.onlySignificantImages,
    keepInteractionPrompts: state.options.keepInteractionPrompts,
    readFormPayload: state.options.readFormPayload,
    interactive: state.options.docType === 'article' ? 'current' : 'expand',
  };

  setLoading('Reading page…');
  return readPageFromTab(tabId, options);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ensureSheet() {
  let sheet = $('cr-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'cr-sheet';
    $('paperWrap').appendChild(sheet);
  }
  return sheet;
}

function ensureStyleTag() {
  let tag = document.getElementById('cr-doc-style');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'cr-doc-style';
    document.head.appendChild(tag);
  }
  return tag;
}

function render() {
  if (!state.content) return;
  const { options, content } = state;
  const sheet = ensureSheet();
  const styleTag = ensureStyleTag();

  const { width, height } = paperSize(options);
  const margin = marginBox(options);
  styleTag.textContent = buildStylesheet(options);
  sheet.innerHTML = buildDocumentHtml(content, options, {
    readingTime: estimateReadingTime(content.wordCount),
  });
  sheet.style.width = `${width * 96}px`;
  sheet.style.padding = `${margin.top * 96}px ${margin.right * 96}px ${margin.bottom * 96}px ${margin.left * 96}px`;
  sheet.style.background = (THEMES[options.theme] || THEMES.paper).bg;
  sheet.style.minHeight = options.docType === 'book' ? `${height * 96}px` : '';

  clearLoading();
  updateDocInfo();
  syncImageHint();
  syncFrameWarning();
  if (state.autoFit) fitWidth();
  else applyZoom();
}

function updateDocInfo() {
  const { content, options } = state;
  if (!content) return;
  const bits = [content.metadata.title];
  if (state.isCollection) {
    bits.push(`${content.partCount} page${content.partCount === 1 ? '' : 's'} merged`);
  }
  bits.push(`${content.wordCount.toLocaleString()} words`);
  bits.push(`~${estimateReadingTime(content.wordCount)} min`);
  // Evidence that Book actually opened something, so an unchanged document is
  // distinguishable from one where there was nothing to expand.
  if (content.expandedPanels > 0) {
    bits.push(`${content.expandedPanels} panels expanded`);
  }
  $('docInfo').textContent = bits.join('  ·  ');
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function applyZoom() {
  $('paperWrap').style.transform = `scale(${state.zoom})`;
  $('zoomLevel').textContent = `${Math.round(state.zoom * 100)}%`;
  // Reserve the scaled height so the scroll container tracks the zoom.
  const sheet = $('cr-sheet');
  if (sheet) {
    $('paperWrap').style.height = `${sheet.offsetHeight * state.zoom}px`;
  }
}

function fitWidth() {
  const sheet = $('cr-sheet');
  if (!sheet) return;
  const available = $('scroll').clientWidth - 56;
  state.zoom = Math.min(1, available / sheet.offsetWidth);
  applyZoom();
}

function setZoom(z) {
  state.autoFit = false;
  state.zoom = Math.min(2.5, Math.max(0.25, z));
  applyZoom();
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function fillSelect(el, entries, selected) {
  el.innerHTML = entries
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`)
    .join('');
}

function syncConditionalVisibility() {
  const type = state.options.docType;
  document.querySelectorAll('[data-hide-for]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.hideFor.split(' ').includes(type));
  });
  document.querySelectorAll('[data-show-for]').forEach((el) => {
    el.classList.toggle('hidden', !el.dataset.showFor.split(' ').includes(type));
  });
}

// Content inside a cross-origin frame cannot be read from the page's context.
// Say so plainly rather than exporting a document with the lesson missing.
function syncFrameWarning() {
  const blocked = state.content?.blockedFrames || [];
  let banner = $('frameWarning');

  if (!blocked.length) {
    banner?.remove();
    return;
  }

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'frameWarning';
    banner.className = 'warning no-print';
    $('stage').insertBefore(banner, $('scroll'));
  }

  const host = (() => {
    try { return new URL(blocked[0].src, state.content.metadata.url).hostname; }
    catch { return 'another site'; }
  })();

  // Clear Copy now reads inside cross-origin frames directly, so a frame still
  // reported here was genuinely unreadable — usually because it had not loaded
  // its content yet when the page was read.
  banner.innerHTML = `
    <strong>An embedded frame was empty when this page was read.</strong>
    ${blocked.length === 1 ? 'A frame' : `${blocked.length} frames`} from
    ${host} had no content at capture time. If the document looks incomplete,
    make sure the content is visible on the page — click any
    <em>Launch</em>, <em>Relaunch</em> or <em>Start</em> button first — then
    reload this preview.`;
}

// Depends on extraction results, so it is refreshed after every render too.
function syncImageHint() {
  const { keepImages, onlySignificantImages } = state.options;
  const stats = state.content?.images;
  const hint = $('imageHint');
  if (!hint) return;

  // Collected pages keep whatever image settings applied when each was captured,
  // so the toggles cannot act on them. Reset the disabled state each time — the
  // user can switch back to single-page at any point.
  const lockImages = state.isCollection;
  [$('keepImages'), $('onlySignificantImages')].forEach((el) => {
    el.disabled = lockImages;
    el.closest('.check').classList.toggle('disabled', lockImages);
  });

  if (lockImages) {
    hint.textContent = stats
      ? `${stats.kept} image${stats.kept === 1 ? '' : 's'} across ${state.collectionSize} collected page${state.collectionSize === 1 ? '' : 's'}. Re-add a page to change its image settings.`
      : '';
    return;
  }

  if (!keepImages || !stats) {
    hint.textContent = '';
  } else if (onlySignificantImages) {
    const dropped = stats.total - stats.kept;
    hint.textContent = dropped > 0
      ? `Kept ${stats.kept} of ${stats.total} — dropped ${dropped} icon${dropped === 1 ? '' : 's'}, avatar or spacer.`
      : `All ${stats.total} images look meaningful.`;
  } else {
    hint.textContent = `Including all ${stats.total} images.`;
  }
}

// The collected-pages list and the This page / Combined toggle.
async function syncSource() {
  const items = await loadCollection(state.session);
  state.collection = items;
  const count = items.length;

  document.querySelectorAll('#source button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.value === state.source));
    // Nothing to combine yet.
    if (b.dataset.value === 'collection') b.disabled = count === 0;
  });

  $('sourceHint').textContent = state.source === 'collection'
    ? `Exporting ${count} collected page${count === 1 ? '' : 's'} as one document.`
    : count
      ? `Exporting this page only. ${count} page${count === 1 ? '' : 's'} collected.`
      : 'Exporting this page only. Add pages to combine several into one document.';

  const panel = $('collected');
  panel.hidden = count === 0 && state.source !== 'collection';
  if (panel.hidden) return;

  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('collectedList').innerHTML = ordered.length
    ? ordered.map((item) => `
        <li>
          <span title="${item.title.replace(/"/g, '&quot;')}">${
            item.title.length > 30 ? `${item.title.slice(0, 29)}…` : item.title
          }</span>
          <button class="remove" data-url="${item.url.replace(/"/g, '&quot;')}" aria-label="Remove">×</button>
        </li>`).join('')
    : '<li class="empty">No pages collected yet.</li>';

  $('collectedList').querySelectorAll('.remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await removeFromCollection(btn.dataset.url, state.session);
      const left = (await loadCollection(state.session)).length;
      // Fall back to single-page when the collection empties out.
      if (!left) state.source = 'page';
      await refreshSource();
    });
  });

  // Only meaningful when a real tab is behind this preview.
  $('addCurrent').disabled = !state.sourceTabId;
  $('refreshBtn').disabled = state.isCollection || !state.sourceTabId;
  // Whole-course capture is offered only where there is a course menu to walk,
  // so it never appears on an ordinary article.
  $('walkCourseBtn').hidden = state.isCollection || !state.hasLessonTree;
}

// Re-read the collection, then rebuild whatever is on screen.
async function refreshSource() {
  await syncSource();
  saveOptions();
  await boot();
}

function syncControls() {
  const o = state.options;

  document.querySelectorAll('#docType button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.value === o.docType));
  });
  document.querySelectorAll('#style button').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.value === o.style));
  });

  $('docTypeHint').textContent = DOC_TYPE_HINTS[o.docType];
  $('styleHint').textContent = STYLE_HINTS[o.style];

  syncImageHint();

  $('paper').value = o.paper;
  $('orientation').value = o.orientation;
  $('margin').value = o.margin;
  $('columns').value = String(o.columns);
  $('font').value = o.font;
  $('theme').value = o.theme;

  $('fontSize').value = o.fontSize;
  $('fontSizeOut').textContent = `${o.fontSize}pt`;
  $('lineHeight').value = o.lineHeight;
  $('lineHeightOut').textContent = o.lineHeight.toFixed(2);

  $('keepImages').checked = o.keepImages;
  $('onlySignificantImages').checked = o.onlySignificantImages;
  $('onlySignificantImages').disabled = !o.keepImages;
  $('onlySignificantImages').closest('.check').classList.toggle('disabled', !o.keepImages);
  $('keepInteractionPrompts').checked = o.keepInteractionPrompts;
  $('keepInteractionPrompts').disabled = state.isCollection;
  $('keepInteractionPrompts').closest('.check').classList.toggle('disabled', state.isCollection);
  $('keepLinks').checked = o.keepLinks;
  $('showHeader').checked = o.showHeader;
  $('showFooter').checked = o.showFooter;
  $('hyphenate').checked = o.hyphenate;

  syncConditionalVisibility();
}

function update(patch, { reextract = false } = {}) {
  const styleChanged = 'style' in patch && patch.style !== state.options.style;
  const breaksChanged = 'docType' in patch && patch.docType !== state.options.docType;
  Object.assign(state.options, patch);
  saveOptions();
  syncControls();

  // The merged document bakes in the chosen style and page breaks, so those
  // changes require rebuilding the merge rather than just re-rendering.
  if (state.isCollection) {
    if (reextract || styleChanged || breaksChanged) boot();
    else render();
    return;
  }

  // Article and Book capture different amounts of the page — Article takes it
  // as it stands, Book walks every widget — so switching between them means
  // reading the page again, not just re-rendering what we already have.
  if (reextract || breaksChanged) {
    state.pageContent = null;
    boot();
  } else {
    render();
  }
}

function wireControls() {
  fillSelect($('paper'), Object.entries(PAPER).map(([k, v]) => [k, v.label]), state.options.paper);
  fillSelect($('margin'), Object.entries(MARGINS).map(([k, v]) => [k, v.label]), state.options.margin);
  fillSelect($('font'), Object.entries(FONTS).map(([k, v]) => [k, v.label]), state.options.font);
  fillSelect($('theme'), Object.entries(THEMES).map(([k, v]) => [k, v.label]), state.options.theme);

  $('source').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn || btn.disabled || btn.dataset.value === state.source) return;
    state.source = btn.dataset.value;
    state.autoFit = true;
    await refreshSource();
  });

  $('addCurrent').addEventListener('click', async () => {
    if (!state.sourceTabId) return;
    status('Reading page…', 0);
    try {
      // Always capture fresh: the page may have changed since the preview opened.
      const content = await extractFromSourceTab();
      state.pageContent = content;
      const { replaced } = await addToCollection(content, state.session);
      status(replaced ? 'Updated in collection' : 'Added to collection');
      await syncSource();
      if (state.isCollection) await boot(); // merged view must include it now
    } catch (err) {
      status(`Could not add: ${err.message}`);
    }
  });

  $('clearCollected').addEventListener('click', async () => {
    await clearCollection(state.session);
    state.source = 'page';
    await refreshSource();
    status('Collection cleared');
  });

  $('docType').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) { state.autoFit = true; update({ docType: btn.dataset.value }); }
  });
  $('style').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (btn) update({ style: btn.dataset.value });
  });

  $('paper').addEventListener('change', (e) => { state.autoFit = true; update({ paper: e.target.value }); });
  $('orientation').addEventListener('change', (e) => { state.autoFit = true; update({ orientation: e.target.value }); });
  $('margin').addEventListener('change', (e) => update({ margin: e.target.value }));
  $('columns').addEventListener('change', (e) => update({ columns: Number(e.target.value) }));
  $('font').addEventListener('change', (e) => update({ font: e.target.value }));
  $('theme').addEventListener('change', (e) => update({ theme: e.target.value }));

  $('fontSize').addEventListener('input', (e) => update({ fontSize: Number(e.target.value) }));
  $('lineHeight').addEventListener('input', (e) => update({ lineHeight: Number(e.target.value) }));

  // Image options are decided during extraction, so these re-read the page.
  // Collected pages were captured with the settings in force at capture time
  // and cannot be re-read here, so the toggles do not re-extract.
  $('keepImages').addEventListener('change', (e) =>
    update({ keepImages: e.target.checked }, { reextract: !state.isCollection }));
  $('onlySignificantImages').addEventListener('change', (e) =>
    update({ onlySignificantImages: e.target.checked }, { reextract: !state.isCollection }));
  // Decided during extraction, so this re-reads the page too.
  $('keepInteractionPrompts').addEventListener('change', (e) =>
    update({ keepInteractionPrompts: e.target.checked }, { reextract: !state.isCollection }));
  $('keepLinks').addEventListener('change', (e) => update({ keepLinks: e.target.checked }));
  $('showHeader').addEventListener('change', (e) => update({ showHeader: e.target.checked }));
  $('showFooter').addEventListener('change', (e) => update({ showFooter: e.target.checked }));
  $('hyphenate').addEventListener('change', (e) => update({ hyphenate: e.target.checked }));

  $('collapseBtn').addEventListener('click', () => {
    $('app').classList.add('collapsed');
    $('expandBtn').hidden = false;
    setTimeout(() => state.autoFit && fitWidth(), 240);
  });
  $('expandBtn').addEventListener('click', () => {
    $('app').classList.remove('collapsed');
    $('expandBtn').hidden = true;
    setTimeout(() => state.autoFit && fitWidth(), 240);
  });

  $('zoomIn').addEventListener('click', () => setZoom(state.zoom + 0.1));
  $('zoomOut').addEventListener('click', () => setZoom(state.zoom - 0.1));
  $('zoomFit').addEventListener('click', () => { state.autoFit = true; fitWidth(); });

  // The page can change after the preview opened — e.g. clicking Launch or
  // Relaunch on a course player loads the lesson into the same tab and URL.
  // Extraction only ever runs once and is cached, so nothing notices; this
  // clears that cache and re-reads the source tab from scratch.
  $('refreshBtn').addEventListener('click', async () => {
    if (state.isCollection) return;
    state.pageContent = null;
    setLoading('Reading page…');
    await boot();
  });

  $('walkCourseBtn').addEventListener('click', async () => {
    if (state.isCollection) return;
    const btn = $('walkCourseBtn');

    const count = await countCourseLessons();
    if (!count) {
      status('No course menu found on this page.', 4000);
      return;
    }

    // Walking opens each lesson in the real course player, and a player that
    // tracks progress will record them as viewed. That is a change to the
    // learner's own training record, so it is never a side effect of picking a
    // document type — it is asked for explicitly, with the count named.
    const ok = confirm(
      `Capture all ${count} lessons as one book?\n\n` +
      'Clear Copy will open each lesson in turn to read it. Your course player ' +
      'may record those lessons as viewed, and your progress may change.\n\n' +
      'This can take a minute or so. You will be returned to the lesson you ' +
      'have open now.');
    if (!ok) return;

    btn.disabled = true;
    try {
      setLoading(`Reading lesson 1 of ${count}…`);
      const walked = await walkCourseFromSourceTab((i, total, title) => {
        setLoading(`Reading lesson ${i + 1} of ${total}… ${title || ''}`.trim());
      });

      const book = mergeCollection(
        walked.pages.map((page, i) => ({ ...page, order: page.order ?? i })),
        {
          style: state.options.style,
          includeContents: true,
          pageBreaks: true,
          // The course name, not the first lesson's — pages[0] is usually an
          // "Introduction" and titling the book after it reads as a mistake.
          title: walked.courseTitle || document.title.replace(/ — Clear Copy$/, '') || 'Course',
        });

      // Present it as a collection: the same path the manual
      // Source → Combined flow already renders and exports through.
      state.isCollection = true;
      state.content = book;
      // The renderer paginates from state.blocks, not from state.content: a
      // book assigned without re-deriving them re-renders the previous
      // single-page document and looks exactly like the walk never ran.
      state.blocks = htmlToBlocks(book.html);
      state.collectionSize = walked.pages.length;
      render();
      status(`Captured ${walked.pages.length} of ${count} lessons.`, 5000);
    } catch (err) {
      // Never fail quietly here: a silent catch is what made a broken walk
      // look like an ordinary one-page export.
      console.error('[Clear Copy] course walk failed:', err);
      status(`Course walk failed: ${err.message || err}`, 8000);
    } finally {
      btn.disabled = false;
      clearLoading();
    }
  });

  $('savePdf').addEventListener('click', onSavePdf);
  $('saveMd').addEventListener('click', onSaveMarkdown);
  $('copyMd').addEventListener('click', onCopyMarkdown);

  window.addEventListener('resize', () => { if (state.autoFit) fitWidth(); });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function status(text, timeout = 2600) {
  $('status').textContent = text;
  if (timeout) setTimeout(() => { if ($('status').textContent === text) $('status').textContent = ''; }, timeout);
}

async function onSavePdf() {
  if (!state.content) return;
  const btn = $('savePdf');
  btn.disabled = true;

  // Print at 100%: the preview zoom must not reach the output.
  const restoreZoom = state.zoom;
  state.zoom = 1;
  applyZoom();

  try {
    const sheet = $('cr-sheet');
    const result = await exportPdf(state.options, state.content.metadata, {
      contentHeightPx: sheet ? sheet.scrollHeight : 0,
      onStatus: (t) => status(t, 0),
    });
    status(result.method === 'cdp' ? 'PDF saved' : 'Opened print dialog');
  } catch (err) {
    status(`Export failed: ${err.message}`);
  } finally {
    state.zoom = restoreZoom;
    applyZoom();
    btn.disabled = false;
  }
}

function currentMarkdown() {
  return toMarkdown(state.blocks, state.content.metadata);
}

function onSaveMarkdown() {
  if (!state.content) return;
  const blob = new Blob([currentMarkdown()], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, safeFilename(state.content.metadata.title, 'md'));
  status('Markdown saved');
}

async function onCopyMarkdown() {
  if (!state.content) return;
  try {
    await navigator.clipboard.writeText(currentMarkdown());
    status('Markdown copied');
  } catch {
    status('Copy failed — use Save instead');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const useCollection = state.source === 'collection';
    state.isCollection = useCollection;

    // Extract once and keep it, so toggling back to This page is instant.
    let content;
    if (useCollection) {
      content = await loadFromCollection();
    } else if (state.pageContent) {
      content = state.pageContent;
    } else {
      content = await extractFromSourceTab();
      state.pageContent = content;
    }
    state.content = content;
    state.blocks = htmlToBlocks(content.html);
    document.title = `${content.metadata.title} — Clear Copy`;

    // Whether a course menu exists is a property of the live tab, not of the
    // cached extraction, so it is re-checked on every boot — including the
    // cached-content path and after the refresh button. Checked before
    // render() so the control is visible on the first paint rather than a
    // render late.
    state.hasLessonTree = !useCollection && (await countCourseLessons()) > 1;

    render();
  } catch (err) {
    $('loading').innerHTML = `
      <p style="max-width:340px;text-align:center;line-height:1.5">
        ${err.message}<br>
        <span style="opacity:.7;font-size:12px">
          Open a normal web page and try again. Chrome system pages cannot be read.
        </span>
      </p>`;
  }
}

(async function init() {
  await loadOptions();

  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tab'));
  if (Number.isFinite(tabId)) state.sourceTabId = tabId;

  // Results are kept per capture session so two previews open on two
  // different courses do not write into one interleaved document. The source
  // tab identifies the session: reopening the preview for the same page finds
  // the collection it was already building, while a second page gets its own.
  // Settings are deliberately NOT scoped this way — those are preferences,
  // and the reader expects them shared.
  state.session = params.get('session')
    || (Number.isFinite(tabId) ? `tab-${tabId}` : 'default');
  // Opened straight from "Export all as one document".
  if (params.get('source') === 'collection') state.source = 'collection';

  wireControls();
  syncControls();
  await syncSource();
  await boot();
})();
