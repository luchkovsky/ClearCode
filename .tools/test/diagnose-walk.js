// Clear Copy — whole-course walk diagnostic.
//
// Run this in the DevTools console OF THE PREVIEW TAB (right-click inside the
// Clear Copy preview → Inspect), NOT the course page: it exercises the same
// extension APIs the walk uses, which only exist there.
//
//   1. Open the course, then open the Clear Copy preview
//   2. Right-click inside the preview → Inspect → Console
//   3. Paste this whole file, press Enter
//   4. Copy everything it prints
(async () => {
  const out = {};
  const say = (...a) => console.log(...a);
  say('%c Clear Copy walk diagnostic ', 'background:#4c8dff;color:#fff;padding:2px 6px');

  // Which tab is the preview reading from?
  const tabs = await chrome.tabs.query({});
  out.sourceTabGuess = tabs
    .filter((t) => t.url && !t.url.startsWith('chrome-extension://'))
    .map((t) => ({ id: t.id, url: (t.url || '').slice(0, 70) }));

  const tabId = Number(prompt('Tab id of the COURSE page (see list in console):',
    out.sourceTabGuess[0]?.id ?? ''));
  out.tabId = tabId;

  const run = async (label, func, args = []) => {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, args, func });
      out[label] = res?.result;
    } catch (e) {
      out[label] = `THREW: ${e.message}`;
    }
  };

  // 1. Is the bundle there, and which version?
  await run('apiVersion', () => window.__clearCopyApiVersion ?? 'not injected');

  // 2. Inject it, as the walk does.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, files: ['src/extractor.bundle.js'],
    });
    out.injected = 'ok';
  } catch (e) {
    out.injected = `THREW: ${e.message}`;
  }

  await run('apiVersionAfterInject', () => window.__clearCopyApiVersion ?? 'still missing');

  // 3. Do the walk entry points exist?
  await run('entryPoints', () => ({
    lessonTree: typeof window.__clearCopyLessonTree,
    openLesson: typeof window.__clearCopyOpenLesson,
    extract: typeof window.__clearCopyExtract,
  }));

  // 4. What does the tree report?
  await run('lessonTree', () => {
    if (!window.__clearCopyLessonTree) return 'entry point missing';
    const s = window.__clearCopyLessonTree();
    return { count: s.titles.length, openIndex: s.openIndex,
             courseTitle: s.courseTitle, first5: s.titles.slice(0, 5) };
  });

  // 5. Can one lesson actually be opened?
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.__clearCopyOpenLesson ? window.__clearCopyOpenLesson(1) : 'missing'),
    });
    out.openLessonOne = res?.result;
  } catch (e) {
    out.openLessonOne = `THREW: ${e.message}`;
  }

  say('=== COPY EVERYTHING BELOW ===');
  say(JSON.stringify(out, null, 2));
  say('=== DIAGNOSTIC COMPLETE ===');
})();
