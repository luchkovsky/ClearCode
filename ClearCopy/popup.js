import { loadCollection, addToCollection, removeFromCollection, clearCollection } from './src/collection.js';

// The popup always acts on the tab it was opened over, so that tab names the
// collection bucket — the same one its preview reads. Keeps two pages'
// captures apart without the reader having to think about sessions.
const sessionForTab = (tab) => (tab && Number.isFinite(tab.id) ? `tab-${tab.id}` : 'default');

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/;

const $ = (id) => document.getElementById(id);
const status = (text) => { $('status').textContent = text; };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function guard() {
  const tab = await activeTab();
  if (!tab?.id) {
    status('No active tab.');
    return null;
  }
  if (RESTRICTED.test(tab.url || '')) {
    status('Open a normal web page first.');
    return null;
  }
  return tab;
}

// Inject the bundle and extract, reused by every action here.
//
// Runs in every frame: embedded course players host the lesson on another
// domain, which the page cannot read but the extension can.
async function extract(tabId, options = {}) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/extractor.bundle.js'],
  }).catch(() => {}); // a frame refusing injection must not abort the rest

  const args = [{ keepImages: true, onlySignificantImages: true, ...options }];
  const runner = (opts) => (window.__clearCopyExtract ? window.__clearCopyExtract(opts) : null);

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, args, func: runner,
    });
  } catch {
    // executeScript rejects wholesale if any frame throws.
    results = await chrome.scripting.executeScript({ target: { tabId }, args, func: runner });
  }

  const extracted = results.map((r) => r.result).filter((r) => r && r.wordCount > 0);
  if (!extracted.length) throw new Error('Nothing to extract.');

  // The frame with the most prose is the content; the top frame is the shell.
  extracted.sort((a, b) => b.wordCount - a.wordCount);
  const best = extracted[0];

  // Too little content either means a blocked cross-origin frame, or (just as
  // often) a pre-launch landing page with only a "Launch" button — no iframe
  // involved at all, just an empty course-player state.
  if (best.wordCount < 25) {
    throw new Error('Only found a few words on this page — click Launch, Relaunch or Start first.');
  }
  return best;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

let popupSession = 'default';

async function renderCollection() {
  const items = await loadCollection(popupSession);
  const panel = $('collection');

  if (!items.length) {
    panel.hidden = true;
    $('addHint').textContent = 'Collect lessons, export as one PDF';
    return;
  }

  panel.hidden = false;
  $('collectionCount').textContent =
    `${items.length} page${items.length === 1 ? '' : 's'} collected`;
  $('addHint').textContent = 'Adds to the collection below';

  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  $('collectionList').innerHTML = ordered.map((item) => {
    // Mark excerpts so a selection is not mistaken for a whole page.
    const mark = item.isSelection ? '<span class="tag">excerpt</span> ' : '';
    const label = item.title.length > 30 ? `${item.title.slice(0, 29)}…` : item.title;
    return `
    <li>
      <span title="${item.title.replace(/"/g, '&quot;')}">${mark}${label}</span>
      <button class="remove" data-url="${item.url.replace(/"/g, '&quot;')}" title="Remove">×</button>
    </li>`;
  }).join('');

  $('collectionList').querySelectorAll('.remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await removeFromCollection(btn.dataset.url, popupSession);
      // Bind the popup to the tab it was opened over before drawing anything, so
// the collection it shows is that page's, not another window's.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    popupSession = sessionForTab(tab);
  } catch {}
  await renderCollection();
})();
      status('Removed');
    });
  });
}

$('addToCollection').addEventListener('click', async () => {
  const tab = await guard();
  if (!tab) return;

  status('Reading page…');
  try {
    const content = await extract(tab.id);
    const { replaced } = await addToCollection(content, popupSession);
    await renderCollection();
    status(replaced ? 'Updated in collection' : 'Added to collection');
  } catch (err) {
    status(`Failed: ${err.message}`);
  }
});

$('addSelection').addEventListener('click', async () => {
  const tab = await guard();
  if (!tab) return;

  status('Reading selection…');
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['src/extractor.bundle.js'],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: [{ keepImages: true }],
      func: (opts) => window.__clearCopySelection(opts),
    });

    // The selection lives in exactly one frame; the rest return null.
    const captured = results
      .map((r) => r.result)
      .filter((r) => r && r.wordCount > 0)
      .sort((a, b) => b.wordCount - a.wordCount)[0];

    if (!captured) {
      status('Select some text on the page first.');
      return;
    }

    await addToCollection(captured, popupSession);
    await renderCollection();
    status(`Added ${captured.wordCount} words`);
  } catch (err) {
    status(`Failed: ${err.message}`);
  }
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('clearCollection').addEventListener('click', async () => {
  await clearCollection(popupSession);
  await renderCollection();
  status('Collection cleared');
});

$('exportCollection').addEventListener('click', async () => {
  const tab = await activeTab();
  await chrome.tabs.create({
    url: chrome.runtime.getURL(
      `preview.html?source=collection&session=${encodeURIComponent(popupSession)}`),
    index: (tab?.index ?? 0) + 1,
  });
  window.close();
});

// ---------------------------------------------------------------------------
// Single page
// ---------------------------------------------------------------------------

$('openPreview').addEventListener('click', async () => {
  const tab = await guard();
  if (!tab) return;
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?tab=${tab.id}`),
    index: tab.index + 1,
  });
  window.close();
});

renderCollection();
