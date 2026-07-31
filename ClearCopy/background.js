// Service worker: owns the chrome.debugger (CDP) export path, since content
// scripts cannot attach a debugger themselves.

const CDP_VERSION = '1.3';
const attached = new Set();

async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, CDP_VERSION);
  attached.add(tabId);
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
  attached.delete(tabId);
}

const send = (tabId, method, params) =>
  chrome.debugger.sendCommand({ tabId }, method, params || {});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

// Print the tab to PDF over CDP.
//
// Two things matter for fidelity:
//  1. We size the viewport to the printable width *before* printing, so the page
//     lays out at final width instead of being scaled afterwards.
//  2. For continuous ("article") output we pass an explicit tall paperHeight and
//     pageRanges:"1", which is how a single unbroken page is produced.
async function printToPdf(tabId, params) {
  const {
    paperWidth,
    paperHeight,
    marginTop = 0,
    marginRight = 0,
    marginBottom = 0,
    marginLeft = 0,
    printBackground = true,
    scale = 1,
    landscape = false,
    continuous = false,
    contentHeightPx = 0,
    displayHeaderFooter = false,
    headerTemplate = '',
    footerTemplate = '',
  } = params;

  await attach(tabId);

  try {
    await send(tabId, 'Page.enable');

    const printableWidthPx = Math.round((paperWidth - marginLeft - marginRight) * 96);

    await send(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: printableWidthPx,
      height: 0,
      deviceScaleFactor: 0,
      mobile: false,
    });

    // Give the page a beat to reflow at the new width before we measure/print.
    await new Promise((r) => setTimeout(r, 450));

    let finalHeight = paperHeight;
    if (continuous) {
      // Re-measure at the print width: content height changes when the viewport does.
      const measured = contentHeightPx || (await send(tabId, 'Runtime.evaluate', {
        expression: `(() => {
          const d = document.documentElement;
          return Math.max(d.scrollHeight, document.body.scrollHeight);
        })()`,
        returnByValue: true,
      })).result?.value || 0;
      finalHeight = measured / 96 + marginTop + marginBottom;
    }

    const result = await send(tabId, 'Page.printToPDF', {
      paperWidth,
      paperHeight: finalHeight,
      marginTop,
      marginRight,
      marginBottom,
      marginLeft,
      printBackground,
      scale,
      landscape,
      preferCSSPageSize: false,
      displayHeaderFooter,
      headerTemplate: headerTemplate || '<span></span>',
      footerTemplate: footerTemplate || '<span></span>',
      transferMode: 'ReturnAsBase64',
      ...(continuous ? { pageRanges: '1' } : {}),
    });

    return { ok: true, data: result.data };
  } finally {
    try {
      await send(tabId, 'Emulation.clearDeviceMetricsOverride');
    } catch {}
    await detach(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'cdp-print') {
    const tabId = message.tabId ?? sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'no-tab' });
      return true;
    }
    printToPdf(tabId, message.params)
      .then(sendResponse)
      .catch((err) => {
        detach(tabId);
        sendResponse({ ok: false, error: String(err?.message || err) });
      });
    return true; // async
  }

  if (message?.type === 'open-preview') {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`preview.html?tab=${message.tabId}`),
      index: message.index,
    }).then((tab) => sendResponse({ ok: true, tabId: tab.id }));
    return true;
  }

  return false;
});

// Toolbar click opens the preview for the current tab.
chrome.action.onClicked?.addListener?.((tab) => {
  if (!tab.id) return;
  chrome.tabs.create({
    url: chrome.runtime.getURL(`preview.html?tab=${tab.id}`),
    index: tab.index + 1,
  });
});

// ---------------------------------------------------------------------------
// Capture from keyboard shortcuts and the context menu
//
// Both fire outside any page, so the worker owns them. They share one code path
// with the popup, so a page added by shortcut is identical to one added by
// clicking — same settings, same extraction.
// ---------------------------------------------------------------------------

const RESTRICTED = /^(chrome|edge|about|chrome-extension|devtools|view-source):|^https:\/\/chromewebstore\.google\.com/;

// Brief badge feedback: a capture triggered by a keystroke is otherwise silent.
async function flashBadge(text, colour) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: colour });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1600);
  } catch {}
}

async function captureFromTab(tab, { selectionOnly = false } = {}) {
  if (!tab?.id) return { ok: false, error: 'No active tab.' };
  if (RESTRICTED.test(tab.url || '')) return { ok: false, error: 'Not a normal web page.' };

  const { loadSettings, extractionOptions } = await import('./src/settings.js');
  const { addToCollection } = await import('./src/collection.js');
  const settings = await loadSettings();
  const options = extractionOptions(settings);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['src/extractor.bundle.js'],
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    args: [options, selectionOnly],
    func: (opts, wantSelection) => (wantSelection
      ? window.__clearCopySelection(opts)
      : window.__clearCopyExtract(opts)),
  });

  const captured = results
    .map((r) => r.result)
    .filter((r) => r && r.wordCount > 0)
    .sort((a, b) => b.wordCount - a.wordCount)[0];

  if (!captured) {
    return {
      ok: false,
      error: selectionOnly ? 'Nothing selected on this page.' : 'Could not read this page.',
    };
  }

  const { count } = await addToCollection(captured);
  return { ok: true, count, title: captured.metadata?.title, selection: selectionOnly };
}

async function runCapture(tab, opts) {
  const result = await captureFromTab(tab, opts).catch((err) => ({
    ok: false, error: String(err?.message || err),
  }));

  const { loadSettings } = await import('./src/settings.js');
  const settings = await loadSettings();

  if (result.ok) {
    if (settings.notifyOnCapture) await flashBadge(String(result.count), '#2a9d5c');
    if (settings.openPreviewAfterAdd) {
      chrome.tabs.create({
        url: chrome.runtime.getURL('preview.html?source=collection'),
        index: (tab?.index ?? 0) + 1,
      });
    }
  } else if (settings.notifyOnCapture) {
    await flashBadge('!', '#c0392b');
  }
  return result;
}

chrome.commands?.onCommand?.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (command === 'add-page') return void runCapture(tab);
  if (command === 'add-selection') return void runCapture(tab, { selectionOnly: true });
  if (command === 'open-preview' && tab?.id) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`preview.html?tab=${tab.id}`),
      index: tab.index + 1,
    });
  }
});

// Context menu. Rebuilt on install/update so stale entries never linger.
function buildContextMenus() {
  chrome.contextMenus?.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cc-add-page',
      title: 'Add this page to Clear Copy',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'cc-add-selection',
      title: 'Add selection to Clear Copy',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'cc-open-preview',
      title: 'Open Clear Copy preview',
      contexts: ['page', 'selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(buildContextMenus);
chrome.runtime.onStartup?.addListener?.(buildContextMenus);

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === 'cc-add-page') runCapture(tab);
  if (info.menuItemId === 'cc-add-selection') runCapture(tab, { selectionOnly: true });
  if (info.menuItemId === 'cc-open-preview' && tab?.id) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`preview.html?tab=${tab.id}`),
      index: tab.index + 1,
    });
  }
});
