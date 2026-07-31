// Clear Copy diagnostic — run in the DevTools console ON THE PAGE THAT FAILS.
//
//   1. Open the failing page and make sure the content is visible on screen
//   2. Open DevTools (F12 or Cmd-Opt-I) → Console tab
//   3. Paste this whole file, press Enter, wait for "DIAGNOSTIC COMPLETE"
//   4. Copy everything it prints
//
// It runs the real extractor and reports what it produced and why, then puts
// the page back exactly as it found it.

(async () => {
  const OUT = {};
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const say = (...a) => console.log(...a);

  say('%c Clear Copy diagnostic — running… ', 'background:#4c8dff;color:#fff;font-weight:bold;padding:2px 6px');

  // --- 1. What kind of page is this? ---------------------------------------
  OUT.page = {
    url: location.href,
    title: document.title,
    // Empty custom elements are the signature of a not-yet-rendered SPA.
    customElements: [...new Set([...document.querySelectorAll('*')]
      .map((el) => el.tagName.toLowerCase()).filter((t) => t.includes('-')))].slice(0, 30),
  };

  // --- 2. Where is the visible text? ---------------------------------------
  // The extractor has to choose one container. These are its options.
  const blocks = [...document.querySelectorAll('div, section, article, main, [class*="content"], [id*="content"]')]
    .map((el) => ({ el, chars: clean(el.textContent).length }))
    .filter((b) => b.chars > 150)
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 10)
    .map(({ el, chars }) => {
      const r = el.getBoundingClientRect();
      let links = 0;
      el.querySelectorAll('a').forEach((a) => { links += clean(a.textContent).length; });
      return {
        el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${
          el.getAttribute('class') ? '.' + el.getAttribute('class').split(/\s+/)[0] : ''}`,
        chars,
        linkPct: chars ? Math.round((links / chars) * 100) : 0,
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        visible: getComputedStyle(el).display !== 'none' && !!(r.width || r.height),
      };
    });
  OUT.largestTextBlocks = blocks;

  // --- 3. Frames ------------------------------------------------------------
  // A cross-origin frame is unreadable *from the page*, but the extension
  // injects into it directly, so this alone no longer means content is lost.
  OUT.frames = [...document.querySelectorAll('iframe, frame')].map((f) => {
    const r = f.getBoundingClientRect();
    let sameOrigin = false;
    let innerChars = 0;
    try {
      const d = f.contentDocument;
      sameOrigin = !!d;
      innerChars = clean(d?.body?.innerText).length;
    } catch { sameOrigin = false; }
    return {
      src: (f.getAttribute('src') || '(none)').slice(0, 100),
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      sameOrigin,
      innerChars,
    };
  }).filter((f) => f.size !== '0x0');

  // --- 4. Shadow roots ------------------------------------------------------
  OUT.shadowRoots = [...document.querySelectorAll('*')]
    .filter((el) => el.shadowRoot)
    .slice(0, 15)
    .map((el) => ({ tag: el.tagName.toLowerCase(), chars: clean(el.shadowRoot.textContent).length }))
    .filter((s) => s.chars > 50);

  // --- 5. Run the real extractor -------------------------------------------
  // This is the part that matters: what does Clear Copy actually produce here?
  if (!window.__clearCopyExtract) {
    // Still useful without it: the page survey above often identifies the
    // problem on its own (cross-origin frame, content in a shadow root, an
    // empty shell). Say so rather than looking like a failure.
    OUT.extractor = 'not loaded in this tab — the page survey above is still valid. '
      + 'For the full report, open the Clear Copy preview on this page first, then rerun this script here.';
  } else {
    try {
      const t0 = performance.now();
      const c = await window.__clearCopyExtract({ keepImages: true, onlySignificantImages: true });
      const md = window.__clearCopyToMarkdown ? window.__clearCopyToMarkdown(c) : '';

      OUT.extractor = {
        tookMs: Math.round(performance.now() - t0),
        titleProduced: c.metadata?.title,
        words: c.wordCount,
        images: c.images,
        blockedFrames: c.blockedFrames,
        // The first slice of real output — usually enough to see what went wrong.
        firstText: clean(c.text).slice(0, 400),
        markdownStart: md.slice(0, 600),
      };

      // How much of the page's prose did it capture?
      let pageProse = 0;
      document.body.querySelectorAll('p, li, td, blockquote, pre, h1, h2, h3, h4').forEach((n) => {
        if (n.closest('nav, header, footer, aside')) return;
        const st = getComputedStyle(n);
        if (st.display === 'none' || st.visibility === 'hidden') return;
        pageProse += clean(n.textContent).length;
      });
      const got = clean(c.text).length;
      OUT.coverage = {
        visibleProseOnPage: pageProse,
        capturedByExtractor: got,
        percent: pageProse ? Math.round((got / pageProse) * 100) + '%' : 'n/a',
        verdict: !pageProse ? 'no prose found on page at all'
          : got / pageProse >= 0.7 ? 'GOOD — captured most of the page'
          : got / pageProse >= 0.3 ? 'PARTIAL — roughly half is missing'
          : 'BAD — almost nothing captured',
      };
    } catch (err) {
      OUT.extractor = { error: String(err && err.message || err) };
    }
  }

  // Kept on the window so it can be re-read without rerunning.
  window.__clearCopyDiagnostic = OUT;

  const json = JSON.stringify(OUT, null, 2);
  say('%c DIAGNOSTIC COMPLETE ', 'background:#2a7;color:#fff;font-weight:bold;padding:2px 6px');

  // Headline answer first, so the useful part is not buried.
  if (OUT.coverage) {
    say(`Verdict: ${OUT.coverage.verdict}  (captured ${OUT.coverage.percent} of the page's visible text)`);
  }
  if (OUT.extractor?.titleProduced) say(`Title produced: "${OUT.extractor.titleProduced}"`);
  if (OUT.extractor?.words != null) say(`Words captured: ${OUT.extractor.words}`);
  if (OUT.frames?.some((f) => !f.sameOrigin)) {
    say('%cThere is a cross-origin frame on this page — content inside it cannot be read.', 'color:#c60');
  }

  // Copy to clipboard where permitted; otherwise fall back to printing.
  try {
    await navigator.clipboard.writeText(json);
    say('%c Full report copied to your clipboard — paste it in the chat. ',
        'background:#333;color:#fff;padding:2px 6px');
  } catch {
    say('Clipboard blocked. Run this to copy it:  copy(__clearCopyDiagnostic)');
    say(json);
  }

  return OUT;
})();
