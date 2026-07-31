// Export orchestration: one interface, three pagination engines.
//
//   article  -> continuous single page, no breaks (CDP; falls back to print)
//   book     -> paginated paper with running heads (CDP; falls back to print)
//
// The CDP path yields exact geometry but needs the debugger permission; when it
// is unavailable or denied we degrade to window.print() rather than failing.

import { paperSize, marginBox } from './render.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function runningHeadTemplates(options, metadata) {
  if (!options.showFooter && !options.showHeader) return { header: '', footer: '' };

  const style = 'font-family:system-ui,sans-serif;font-size:8px;color:#888;width:100%;padding:0 12mm;';
  const header = options.showHeader
    ? `<div style="${style}display:flex;justify-content:space-between">
         <span>${escapeHtml(metadata.title).slice(0, 70)}</span>
         <span>${escapeHtml(metadata.siteName || '')}</span>
       </div>`
    : '<span></span>';
  const footer = options.showFooter
    ? `<div style="${style}text-align:center">
         <span class="pageNumber"></span> / <span class="totalPages"></span>
       </div>`
    : '<span></span>';

  return { header, footer };
}

export function buildCdpParams(options, metadata, { contentHeightPx = 0 } = {}) {
  const { width, height } = paperSize(options);
  const margin = marginBox(options);
  const continuous = options.docType === 'article';
  const { header, footer } = runningHeadTemplates(options, metadata);

  // Running heads need margin room; without them we use the raw margin box.
  const wantsRunningHeads = options.docType === 'book' && (options.showHeader || options.showFooter);

  return {
    paperWidth: width,
    paperHeight: height,
    marginTop: margin.top + (wantsRunningHeads && options.showHeader ? 0.25 : 0),
    marginRight: margin.right,
    marginBottom: margin.bottom + (wantsRunningHeads && options.showFooter ? 0.25 : 0),
    marginLeft: margin.left,
    printBackground: true,
    scale: 1,
    landscape: options.orientation === 'landscape',
    continuous,
    contentHeightPx,
    displayHeaderFooter: wantsRunningHeads,
    headerTemplate: wantsRunningHeads ? header : '',
    footerTemplate: wantsRunningHeads ? footer : '',
  };
}

function base64ToBlob(base64, type = 'application/pdf') {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function safeFilename(title, ext) {
  const base = (title || 'document')
    .replace(/[\/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'document';
  return `${base}.${ext}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Ask the service worker to drive CDP against *this* preview tab.
async function exportViaCdp(options, metadata, contentHeightPx) {
  const tabId = await new Promise((resolve) => {
    chrome.tabs.getCurrent((tab) => resolve(tab?.id));
  });
  if (tabId == null) throw new Error('no-tab');

  const response = await chrome.runtime.sendMessage({
    type: 'cdp-print',
    tabId,
    params: buildCdpParams(options, metadata, { contentHeightPx }),
  });

  if (!response?.ok) throw new Error(response?.error || 'cdp-failed');
  return base64ToBlob(response.data);
}

// Fallback: hand off to Chrome's print dialog. Pagination is then governed by the
// @page rules already in the preview stylesheet.
function exportViaPrint() {
  window.print();
}

export async function exportPdf(options, metadata, { contentHeightPx = 0, onStatus } = {}) {
  try {
    onStatus?.('Rendering PDF…');
    const blob = await exportViaCdp(options, metadata, contentHeightPx);
    downloadBlob(blob, safeFilename(metadata.title, 'pdf'));
    onStatus?.('Saved');
    return { ok: true, method: 'cdp' };
  } catch (err) {
    // Debugger unavailable, denied, or already attached elsewhere.
    onStatus?.('Opening print dialog…');
    exportViaPrint();
    return { ok: true, method: 'print', reason: String(err?.message || err) };
  }
}
