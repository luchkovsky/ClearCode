# Clear Copy

Chrome extension (MV3) that turns a web page into a clean, readable document:
expands hidden content, extracts the real article, and exports as PDF or
Markdown with a live preview for adjusting format.

## Repository layout

```
ClearCopy/          the extension — all work happens here. No tests, no build
                    tooling, no Python: just the code that ships.
.tools/             build.js, validate.js, test/ fixtures, tools/make-icons.py —
                    everything that develops or verifies the extension but
                    isn't shipped as part of it.
WebPDF/             READ-ONLY reference: a minified competitor build. Never edit.
.claude/commands/   /build and /validate
```

`.tools/` is a sibling of `ClearCopy/`, not nested inside it. `build.js` and
`validate.js` resolve the extension's own files (manifest, `src/`, popup/
preview/background) via a `ROOT` pointing at `../ClearCopy`; `validate.js`'s
own fixtures under `.tools/test/` use a separate `TEST_ROOT` pointing at
itself. This split keeps `ClearCopy/` — the thing that actually gets loaded
unpacked into Chrome — free of anything a reader of the shipped code doesn't
need: no `test/` fixtures, no Python icon-generation script, no test runner.

`WebPDF/` is a decompiled third-party extension kept only to study its
algorithms. It is not our code, is not shipped, and must never be modified.

## Commands

```sh
cd .tools
node build.js               # regenerate ClearCopy/src/extractor.bundle.js
node validate.js            # full checks incl. headless Chrome behaviour tests
node validate.js --static   # skip the browser
```

Or use `/build` and `/validate`.

## The one rule that bites

**`src/extractor.bundle.js` is generated. Never edit it by hand, and run
`node build.js` after touching `src/extract.js` or `src/blocks.js`.**

It exists because `chrome.scripting.executeScript` injects a *classic* script,
and a dynamic `import()` inside it is evaluated against the **page's** CSP —
strict sites (Wikipedia, GitHub, most news) block it, so extraction silently
fails. The bundle avoids imports entirely.

**Bump `API_VERSION` in `build.js` whenever `extract.js`'s exposed API
changes** (not just its internals) — the bundle guards re-injection with
`if (window.__clearCopyApiVersion === API_VERSION) return;`, so a frame that
already ran an older bundle this browser session will silently keep running
that *old* code after a rebuild, even though `node build.js` succeeded and
the extension was reloaded. Only a fresh navigation (or bumping the version)
clears it. This cost a full debugging session: real fixes and diagnostic
logging were added to `extract.js`, rebuilt, and reloaded, yet a live tab
that had already been injected into kept executing the pre-fix code with no
error of any kind — the extraction result still looked plausible, just wrong.

The preview page (`render.js`, `collection.js`, `export.js`) runs under the
*extension's* CSP, so normal ES module imports work there and need no build.

## Architecture

Extraction happens **once** per page; everything downstream re-renders from that
result, so preview controls stay instant. This is cached in `state.pageContent`
and never invalidated on its own — if the page changes after the preview opened
(most commonly: the learner clicks **Launch/Relaunch** on a course player,
loading the real lesson into the same tab and URL), the preview keeps showing
what it read before that. The refresh icon in the stage bar
(`preview.js`'s `refreshBtn` handler) clears the cache and re-extracts on
demand — there is no automatic re-extraction, so this button is the only way
to catch up after a same-tab, same-URL content change.

```
page ──▶ extract.js ──▶ { html, faithfulHtml, metadata, images }
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
         blocks.js       render.js       collection.js
        (block model)   (Reader/Faithful)  (merge pages)
              │               │                │
              ▼               └────────┬───────┘
          Markdown                     ▼
                                   export.js
```

### Files

| File | Role |
| --- | --- |
| `src/extract.js` | Page materialization + content extraction. The heart of the project. |
| `src/blocks.js` | HTML → block model → Markdown. Shared by PDF and `.md`. |
| `src/render.js` | Paper geometry, themes, fonts, stylesheet generation. |
| `src/export.js` | Picks the engine per document type; CDP with print fallback. |
| `src/collection.js` | Capture-as-you-browse store + merge into one document. |
| `background.js` | Service worker; the only place `chrome.debugger` is used. |
| `preview.js` | Preview controller; extraction, live re-render, export. |

### Document types → engines

The engine is chosen per document type — a deliberate design decision:

| Type | Captures | Pagination | Engine |
| --- | --- | --- | --- |
| Article | the current page as it stands (`interactive: 'current'`) | none, one continuous page | CDP with a computed tall page |
| Book | the current page with every tab/stepper/flashcard/accordion clicked through (`interactive: 'expand'`) | paper pages + running heads | CDP `Page.printToPDF` |

**The document type decides what is captured, not just how it is laid out.**
`extractDocument({ interactive })` gates `revealHiddenContent`'s expand-intent
passes and `harvestInteractiveWidgets` (tabs, steppers, flashcards, generic
accordions). Article is a snapshot of what's currently open; Book clicks
through the rest of what's on the *same page*. Changing docType re-extracts
rather than just re-rendering — see `breaksChanged` in preview.js.

**Book briefly meant something much bigger — walking the whole course, not
just one page — and that was deliberately reverted.** `discoverCourseLessonLinks`
(`extract.js`) still exists and finds every same-origin lesson link in a
page's own nav/sidebar (filtered through `TAB_UNSAFE`, extended with
`save + exit/close/quit`, `unenroll`, `withdraw`, `end course/session/lesson`,
and `NON_READING_PAGE` for quiz/lab/video links), and `clearCopyDebugNavLinks()`
in `preview.js` still surfaces it as a dev tool. But actually navigating the
tab through each lesson — tried as `collectWholeCourse` — hit a hard, real
wall: LearnUpon's SCORM player registers a `beforeunload` handler on a live
lesson session, so every single lesson-to-lesson transition triggered
Chrome's native "changes you made may not be saved" prompt, requiring a
manual click per lesson on every course. That defeats the point of automating
it, so the navigation path was removed entirely rather than worked around
(dismissing a browser safety prompt programmatically was rejected as
overriding a safeguard the course player put there on purpose). If a
whole-course capture is wanted again, the existing manual **Source → Combined**
flow (`src/collection.js`, "Add current page" per lesson) is the mechanism
that doesn't fight this prompt, because the reader — not the extension —
drives each navigation.

A ruled-paper "Notepad" engine existed briefly and was removed — it emulated
physical note paper, which was never the goal. "Collecting notes into one
document" is the **Source → Combined** control, backed by `src/collection.js`.
The old engine is in `.v1-backup/notepad.js` if it is ever wanted.

PDF export uses CDP via the `debugger` permission for exact geometry. Chrome
shows a "debugging this browser" banner while it runs. If the debugger cannot
attach, `export.js` falls back to `window.print()`, where the `@page` rules in
the preview stylesheet govern pagination.

### Styles

- **Reader** — rebuilt typography. Also the source of the Markdown.
- **Faithful** — the page's own fonts/colours/boxes, minus clutter.

Both are produced in one extraction pass (`html` and `faithfulHtml`) so toggling
is instant. **Markdown always derives from the Reader tree** so no inline
styling leaks into `.md`.

## Non-obvious things in extract.js

These solve real bugs; don't remove them without understanding why they exist.

- **Viewport-unit freezing** — resolves `vh`/`vw`/`vmin`/`vmax` to pixels before
  printing. Printing resizes the viewport, which would otherwise silently
  reflow the whole layout. Walks `adoptedStyleSheets` and shadow roots too.
- **Frozen heights are stripped from the clean tree** — correct for capture,
  but on paper they reserve dead whitespace. Faithful mode keeps more of its
  box styling than Reader.
- **Image significance is computed on the *live* node** — a clone has no layout
  box. Geometry is only trusted when `img.complete && naturalWidth > 0`, because
  a broken or still-loading image collapses to its alt-text size and would be
  misjudged as decoration. **Declared `width`/`height` win over the measured
  rect until the image decodes** — this applies in `isRealChrome` too.
- **Intent outranks geometry in `isSignificantImage`.** Publishing platforms
  break naive filtering four ways, each of which silently dropped real article
  images: wide hero banners look like slivers; lazy images never decode;
  `role="presentation"` is stamped on meaningful images; and content images sit
  inside `role="button"` expand/edit wrappers. A caption or descriptive alt text
  overrides all of those. Size alone does **not** override an explicit
  `role="presentation"`, and a junk-sounding filename only disqualifies a
  *small* image (article graphics are routinely named `*-logo-*`).
  Losing a real picture is worse than keeping a doubtful one.
- **Checkbox state is captured at clone time** — `cloneNode` copies the `checked`
  *attribute*, not the live property.
- **Ad stripping runs before other passes**, and ad nodes are also barred from
  the content-root contest so ad copy cannot pull extraction toward itself.
  Inside a detached clone `isConnected` is always false — use `root.contains()`.
- **`className` is unreliable on SVG** (it is an `SVGAnimatedString`); read the
  `class` attribute instead.
- **All page mutations go through `StyleManager`** and are reverted in a
  `finally`. The user's tab must be left exactly as found.
- **Tab widgets are harvested by clicking, not revealing.** Course authoring
  tools reuse one panel — clicking a tab replaces its text, so the other panels
  never coexist in the DOM. `harvestInteractiveWidgets` clicks each control,
  captures the panel, then restores the original tab.
  `spliceHarvestedWidgets` matches clone to live tree **by walk position**, so
  it must run before any removal shifts the indices (same constraint as
  `captureFaithfulStyles`).
- **Clicking is filtered by `TAB_UNSAFE`** — never click anything matching
  submit/exit/delete/pay. Synthetic clicks on a logged-in course page can
  otherwise mark lessons complete or navigate away.
- **Extraction waits for client-side rendering first.** Single-page apps
  (AngularJS, React, Vue) serve an HTML shell whose content elements are empty
  and fill them from JS. Extracting immediately captures the shell — on a
  LearnUpon course page that means the static "This page has no content"
  placeholder and the SCORM modal machinery, and nothing else. `waitForContent`
  polls rendered prose until it stops growing (max 6s). **This is the single
  most important fix for LMS pages**; without it those exports are empty.
- **Injection uses `allFrames: true`, and this is essential.** Course players
  host the lesson on a *different domain* (Kong Academy serves it from
  CloudFront). The page cannot read that frame — same-origin policy — so no
  amount of extraction logic in the top frame can reach it. The extension can,
  because `<all_urls>` lets it inject into the frame directly. Each frame
  extracts independently and the caller keeps the richest results (see next
  bullet). **Never drop back to single-frame injection**: the top frame of a
  course page holds only the player shell, and the export silently becomes ~2
  words.
- **A course page can hold more than one real content frame at once.**
  Confirmed on a real OpenAI Academy lesson: the main lesson body shared the
  page with a separate "Workflow Selection Funnel" widget and a "Meeting Pack
  Prompt Builder" tool — three distinct SCORM asset frames, each a genuine
  section a reader would want, not plumbing. Picking only the single richest
  frame (the old behaviour) silently dropped the other two. `selectContentFrames`
  (`src/collection.js`) takes the word-count winner plus any other frame at or
  above `OTHER_FRAME_MIN_WORDS` (25) — a real threshold, not just "beats the
  winner," so SCORM plumbing frames (`blank.html`, `AICCComm.html`, a handful of
  words each) aren't merged in as bogus sections. The selected frames are
  stitched with `mergeCollection({ includeContents: false, pageBreaks: false })`
  — continuous, no table of contents — since these are sections of one page,
  not separate collected pages. Kept as a pure function specifically so it's
  unit-testable without a loaded extension: `chrome.scripting.executeScript`
  only exists inside one, so `validate.js` (a raw-CDP harness) can't exercise
  `allFrames: true` directly.
- **The low-content guard must not require a blocked frame.** `preview.js` and
  `popup.js` warn instead of exporting when the best frame has under 25 words.
  It is tempting to gate that only on `blockedFrames.length` (a cross-origin
  frame the page can't read), but the same symptom happens with **zero**
  frames blocked: some LMS course pages don't create the lesson content
  anywhere in the DOM — no frame, no hidden segment — until the learner clicks
  **Launch**. `test/prelaunch-fixture.html` reproduces that exact shape
  (`<lup-show-course-page>` holding only a Launch button). Keep the guard
  unconditional and let the error message, not the trigger, distinguish the
  two causes.
- **`BODY` is a scoring candidate.** A framed lesson (SCORM module, embedded
  reader) is a standalone document whose content sits directly on `<body>` with
  no wrapper `<div>`. Without `BODY` in `isCandidateContainer` nothing
  accumulates a score, `findContentRoot` returns nothing for that frame, and the
  lesson looks empty. This was the LearnUpon "Relaunch" bug.
- **Player containers are kept when they hold content.** `#scorm-content` and
  friends are empty scaffolding until the player fills them, then they hold the
  entire lesson. `LAZY_SHELL_SELECTORS` + `holdsContent` remove them only while
  empty; `APP_SHELL_SELECTORS` is for chrome that is never content.
- **Widget harvesting runs per document**, not just the top one — flashcards and
  steppers live inside the player frame.
- **Three widget shapes, handled separately.** *Tabs* have one control per panel
  and are clicked once each. *Sequential steppers* ("1 of 6" with Start and a
  next arrow) have no control per panel and must be clicked repeatedly until
  the content stops changing — clicking once captures only the first step and
  leaves the section as a bare counter. `harvestStepper` walks up to 30 steps;
  a widget is walked by each of its controls and the richest result wins,
  because whether Start or Next advances the panel varies by implementation.
- **A fourth widget shape needs no clicking at all: carousels hidden via the
  `hidden`/`inert` HTML attributes.** Some carousel frameworks (Rise 360's own
  `block-process-card` component, confirmed against a real Kong Academy
  lesson) keep every slide's text fully in the DOM at all times — inactive
  slides are marked `hidden inert`, not emptied and refilled on click like
  the tab/stepper/flashcard shapes above. Detected by shape in
  `revealHiddenContent` (siblings sharing `hidden`+`inert`, next to a visible
  sibling of the same class). **Ungated — Article reveals it too**, unlike
  every other widget shape: a tab or stepper needs a simulated click before
  its other panels' text exists at all, so opening those is Book-only
  expansion, but a carousel slide here already exists at zero cost — a reader
  would just click through it on the real page, so it counts as "the page as
  it stands." **This alone is not enough**: `buildCleanTree` also strips
  any element still carrying `hidden` at clone time, because `cloneNode`
  copies the attribute regardless of computed style — without that second
  half, Article would export every slide's text anyway, since the live
  page's visibility is lost once the tree is flattened to HTML/Markdown. That
  strip must run *after* `spliceHarvestedWidgets`/`captureFaithfulStyles`
  (same walk-position constraint as everything else in that opening block).
  Both halves are sabotage-tested independently in
  `test/hidden-inert-carousel-fixture.html`.
- **"Visually hidden" accessibility text is stripped, not just `display:none`
  content.** Screen-reader-only captions (`.visually-hidden-always` and
  similar classes) stay in `textContent` while being invisible on screen via
  clip/absolute-positioning rather than `display:none` — a real export leaked
  a stray "Numbered divider1" this way, a caption meant to be *announced*
  around a decorative divider block, never *read*. `stripScreenReaderOnly`
  cross-checks the live node's bounding box (like `stripDecorativeSvg`) before
  removing, so a real on-screen element that merely reuses one of these class
  names survives. Sabotage-tested in `test/screen-reader-fixture.html`.
- **A widget shape that's already fully expanded is left alone, not
  re-clicked.** `panelAlreadyExpanded` skips `harvestInteractiveWidgets`'
  click loop for any group whose panel already holds 2+ substantial children
  at once — the shape the hidden+inert carousel reveal leaves behind. Clicking
  through it anyway added nothing (the content was already all present) and
  was measured taking 10+ minutes on a real 8-slide Rise 360 carousel: each
  click did a nested full-tree scan across every other control to strip
  labels, an O(controls²) cost per widget.
- **Numbered pagination ("1 2 3 4") is detected by shape, not class name.**
  `numericPaginationGroups` finds sibling controls whose labels read 1..n. This
  is the most reliable stepper signal (one control per step, in order) and many
  sites give those dots no useful class. Sabotage-tested as load-bearing for
  `test/carousel-fixture.html`.
- **Icon-only arrows have no text content**, so `aria-label`/`title` are the
  only identification. Controls labelled prev/back are skipped — walking
  backwards re-collects panels already captured.
- **The empty-node sweep must include `li`.** Carousel pagination is often a
  list whose numbers come from CSS counters, so the `<li>` elements carry no
  text and exported as a run of bare `- ` bullets. The sweep also drops lists
  left with no items.
- **Interaction prompts are stripped by default** ("Click to flip", "Click on
  the Start button…"). Once the panels are laid out in sequence those
  instructions describe something the reader cannot do. `INTERACTION_PROMPT`
  only matches short imperative leaves, so prose beginning with "Click" is
  safe. The preview's **Keep "click to…" prompts** checkbox restores them.
- **`findPanelFor` checks siblings as well as ancestors**: flashcard and
  carousel widgets put the panel next to the control strip, not around it.
- **Articulate Storyline/Rise widgets are drawn as SVG, not HTML.** These
  course-authoring tools render an entire "slide" as absolutely-positioned SVG
  shapes and `<text>`/`<tspan>` elements — there is no tab, accordion or panel
  markup to match. A glossary term is a `role="button"` shape with an
  `aria-label` naming it; clicking reveals a sibling that gains SVG text.
  `harvestSvgSliders` detects these by the `data-model-abs-id` attribute
  specifically (Articulate's own runtime marker) rather than by
  `[role="button"][aria-label]` alone — that broader selector matches ordinary
  icon buttons already owned by the tab/stepper harvesters, and without the
  extra fingerprint this widget would double-click their controls too. Bounded
  to 20 controls; confirmed against the real DOM of a Kong Academy lesson that
  exported as 22 words of glued-together term labels before this fix.
  `test/svg-slider-fixture.html` reproduces it — the definitions are inserted
  by JS only on click, never pre-rendered `display:none`, so the fixture can't
  pass via the unconditional reveal pass instead of the harvester actually
  running.
- **The content root is grown when it looks truncated.** Scoring can settle on
  one small block and silently drop the rest of the article.
  `growRootIfTruncated` compares the chosen root's prose against the page total
  and climbs while an ancestor holds materially more, refusing any parent that
  is mostly links (that is the nav shell).
- **The content heading beats `og:title`/`<title>`.** Learning platforms put the
  page *type* there ("Theory Lesson"), not the lesson name. `GENERIC_TITLE`
  lists those labels; a real heading always wins.
- **Inline `<svg>` is stripped unless it is large on screen.** An icon has no
  intrinsic size, so left in the document it expands to fill the column and
  renders as a full-page line drawing. Measured on the live node, like images.
  **Size alone is not enough for Articulate Storyline content**: every slide's
  background is itself a full-canvas SVG (a gradient-filled rect plus an
  inner-shadow `<filter>|`, sized to the whole slide), so it passes the plain
  size check while depicting nothing. `isArticulateBackgroundFill` overrides
  `keep` for any large SVG matching Articulate's own runtime fingerprint
  (`data-reactid`/`data-commandset-id`) that has no `<image>` and no real
  `<text>`/`<tspan>` — confirmed against a real Kong Academy slide that
  otherwise printed as a plain colour rectangle in the exported PDF. A
  genuine large diagram (real `<text>`, or an `<image>`) still survives the
  same pass; `test/articulate-background-fixture.html` sabotage-tests both
  halves together.
- **Copy-protection is relaxed, not defeated.** `neutraliseCopyProtection`
  clears `user-select` locks, copy/selectstart handlers, and transparent
  overlays so already-visible DOM text extracts normally. It only hides
  overlays that are large, transparent AND empty — a real sticky header or
  dialog must survive. Everything is reverted with the rest of the mutations.

## Testing

`validate.js` drives real headless Chrome against `test/fixture.html` and
asserts on the produced Markdown — it is not a syntax check. The fixture
deliberately contains hidden content, clamped text, ad units of ten varieties,
decorative vs. meaningful images, and awkward tables.

**When fixing a bug, add a case to the relevant fixture and an assertion to
`validate.js` first.** Never weaken an assertion to make a run pass — if a check
fails, the code is wrong, not the test.

**Then prove the assertion can fail**: revert the fix, confirm the check goes
red, restore. Assertions here have twice looked green while testing nothing —
once because the fixture was too easy, once because an SVG check ran against the
Markdown, which never contains raw HTML. Assert PDF-side defects on `html`,
Markdown-side defects on `md`.

## Conventions

- No build step, framework, or dependencies beyond Node for the two scripts.
- Comments explain *why*, not what. Existing comments mark real hazards.
- Match surrounding style: ES modules in `src/`, 2-space indent, single quotes.

## Verified vs. unverified

- **Verified**: extraction, Markdown fidelity, ad stripping, image filtering,
  all three document types, both styles, and the preview UI end-to-end.
- **Not verified**: the CDP export path against a live `chrome.debugger` attach —
  the extension would not load in an automated Chrome profile. Load it unpacked
  and click **Save PDF** once to confirm.
