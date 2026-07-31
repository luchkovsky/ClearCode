// Debug logging for the injected bundle. Off by default — real users never
// see this. Turn on from any page/frame console with:
//   window.__clearCopyDebug = true
// then re-run the action (reopen the preview, click refresh).
//
// Also buffered on window.__clearCopyDebugLog, not just console.log: a
// console.log from inside a chrome.scripting-injected frame does not
// reliably reach the DevTools console of whichever tab you happen to have
// open (confirmed the hard way — a frame's own logs can be invisible from
// every console context tried). extractDocument's result carries this
// buffer back to preview.js, which is the one channel proven to work for
// every frame every time this session.
export function debugLog(tag, ...args) {
  if (typeof window === 'undefined' || !window.__clearCopyDebug) return;
  const line = `[ClearCopy:${tag}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  (window.__clearCopyDebugLog ||= []).push(line);
}
