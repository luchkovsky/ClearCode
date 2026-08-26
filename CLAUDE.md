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
.claude/commands/   /build and /validate
```

`.tools/` is a sibling of `ClearCopy/`, not nested inside it. `build.js` and
`validate.js` resolve the extension's own files (manifest, `src/`, popup/
preview/background) via a `ROOT` pointing at `../ClearCopy`; `validate.js`'s
own fixtures under `.tools/test/` use a separate `TEST_ROOT` pointing at
itself. This split keeps `ClearCopy/` — the thing that actually gets loaded
unpacked into Chrome — free of anything a reader of the shipped code doesn't
need: no `test/` fixtures, no Python icon-generation script, no test runner.


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
| `src/debug.js` | Buffered `debugLog` — see note below on why console.log alone isn't enough. |
| `src/settings.js` | Extension-level preferences, distinct from per-export options in `render.js`. |
| `background.js` | Service worker; the only place `chrome.debugger` is used. |
| `preview.js` | Preview controller; extraction, live re-render, export, and the whole-course walk driver. |

### Document types → engines

The engine is chosen per document type — a deliberate design decision:

| Type | Captures | Pagination | Engine |
| --- | --- | --- | --- |
| Article | the current page as it stands (`interactive: 'current'`) | none, one continuous page | CDP with a computed tall page |
| Book | the current page with every tab/stepper/flashcard/accordion clicked through (`interactive: 'expand'`), plus any form payload; optionally every lesson of a course | paper pages + running heads | CDP `Page.printToPDF` |

**The document type decides what is captured, not just how it is laid out.**
`extractDocument({ interactive })` gates `revealHiddenContent`'s expand-intent
passes and `harvestInteractiveWidgets` (tabs, steppers, flashcards, generic
accordions), and the form-payload pass below. Article is a snapshot of what's
currently open; Book clicks through the rest of what's on the *same page*.
Changing docType re-extracts rather than just re-rendering — see
`breaksChanged` in preview.js. Whole-course capture is *not* part of this
gate: it is a separate, explicitly confirmed action, because it navigates the
reader's real course.

**Whole-course capture exists again, and the reason it was reverted still
governs when it may run.** Walking a course lesson by lesson was tried once as
`collectWholeCourse` and removed: LearnUpon's SCORM player registers a
`beforeunload` handler on a live lesson session, so every lesson-to-lesson
transition raised Chrome's native "changes you made may not be saved" prompt,
one manual click per lesson. Dismissing a browser safety prompt
programmatically was rejected then and is still rejected — it overrides a
safeguard the course player put there on purpose.

That wall is specific to a player that unloads the page. A course whose menu
routes **client-side** never unloads the document, so the prompt cannot appear,
and there is nothing to work around. `walkLessonTree`'s primitives
(`findLessonTreeItems`, `openLessonByIndex`, `lessonTreeSummary` in
`extract.js`) drive that case, and **`openLessonByIndex` aborts the moment a
navigation actually unloads the page** — that guard is what keeps this from
becoming the thing that was rejected. Do not remove it to "support more
platforms".

Three further constraints, each load-bearing:

- **Only leaf `treeitem`s are lessons.** A group row contains other treeitems
  and selecting it lands on its first child, capturing that lesson twice and
  titling it after the section.
- **`TAB_UNSAFE` still applies.** "Save and exit course" wears the same markup
  as a lesson in the same tree; following it during a walk can end an
  enrollment rather than merely navigating.
- **The walk is driven one lesson per call from `preview.js`, not as one
  in-page loop.** A course page's extracted HTML runs to hundreds of
  kilobytes and both the Reader and Faithful trees are returned; forty of
  those is ~14MB, far past what `chrome.scripting.executeScript` can
  structured-clone in a single return. The call fails wholesale and the reader
  silently gets an ordinary one-page export — which is exactly how this first
  shipped. Keeping the loop in the caller also buys per-lesson progress and a
  usable partial book when something fails part-way.

It is offered as a **book icon in the preview's stage bar**, shown only when a
lesson tree is detected, and asks for confirmation naming the lesson count:
walking opens each lesson in the real player, and a player that tracks
progress **will record them as viewed**. That is a change to the learner's own
training record, so it is never a side effect of choosing a document type.

`discoverCourseLessonLinks` still exists for `<a href>`-shaped menus and is
surfaced by `clearCopyDebugNavLinks()`. It finds nothing on a tree-shaped menu
(Sana's sidebar carries two anchors on a 40-lesson course), which is why the
tree walk is a separate detector rather than an extension of it. The manual
**Source → Combined** flow (`src/collection.js`) remains the answer for any
platform that does unload between lessons, because the reader — not the
extension — drives each navigation.

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
- **A fifth content shape: questions that live in a script payload, not the
  DOM.** A virtualised form renderer (Typeform, confirmed against a live
  apidays form) mounts a rolling window of ~3 questions and keeps the other 19
  in the form definition it shipped to the browser. Unlike every widget shape
  above, no reveal and no click reaches them — they are not in the DOM in any
  form, hidden or otherwise. `findFormPayloadFields` locates the definition by
  the *shape of the data* (an array whose entries carry a string `type` and a
  string `title`, most long enough to be a question), never by hostname, and
  `buildFormPayloadTree` renders it as prose. **Book only**: reading it clicks
  nothing and submits nothing, but the questions the reader has not reached
  are not "the page as it stands", so Article deliberately stops at what is
  mounted. Gated by the `readFormPayload` setting. **`allow_other_choice` and
  `none_of_the_above` are sibling flags, not members of `choices`** — reading
  the array alone silently dropped a real option from 12 of 14 questions on
  the real form.
- **Answer options are content even though the markup is a control.** Form
  renderers emit each choice as `<button role="checkbox">` holding the label,
  and `STRIP_TAGS` removes every `<button>`, so a form exported as a question
  with "Choose as many as you like" and nothing under it. They are *unwrapped*
  into `<li>` before the strip runs — the reader wants the label, not a
  control they cannot operate on paper. Gated on the checkbox/radio roles: a
  plain `<button>Continue</button>` is still furniture and still stripped.
- **`legend` is a content-root scoring tag.** A form page puts every question
  title in a `<legend>` inside a `<fieldset>` and every option in a `<div>`,
  so it can carry a whole document of real reading matter without a single
  `<p>`, `<li>` or `<h1>`. Without `legend` such a page scored zero, elected
  no root of its own, and lost the contest to whatever surrounding chrome
  *did* use prose tags. Same failure as the `BODY` scoring-candidate bug, one
  level down: the vocabulary the page actually uses was not on the list.
- **A heading inside `aside`/`nav`/`footer` must not title the export.**
  `contentHeading` took the first `h1, h2` in document order, so when scoring
  falls back to `<body>` a help sidebar's `<h2>` named the whole document
  ("Frequently asked questions about this survey"). Landmark chrome is also
  stripped from the clean tree in that fallback case — scoped to
  `clone.tagName === 'BODY'`, so a page whose content genuinely lives in
  `<header>` or `<aside>` keeps it when that element was elected on merit.
- **The empty-node sweep includes headings and rows.** An `<h2></h2>` prints
  as a gap where a title should be and an emptied `<tr>` as a blank stripe
  across the table. Emptiness is measured with `&nbsp;` folded to a plain
  space, because `trim()` treats U+00A0 as content and CMS output is full of
  it. Assert these on `html`, not `md`: the Markdown side already drops them,
  so a Markdown assertion passes while testing nothing.
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

## Debugging inside injected frames

`console.log` from code injected via `chrome.scripting.executeScript` does not
reliably surface in any DevTools context — confirmed repeatedly across nested
iframes, service-worker targets, and context switches. `src/debug.js`'s
`debugLog(tag, ...args)` instead buffers onto `window.__clearCopyDebugLog`,
gated behind `window.__clearCopyDebug`, so the caller can read it back off the
injection's *return value* — the one channel that is actually reliable.

`preview.js` exposes three dev-console commands built on this, kept in the
codebase permanently rather than stripped after each debugging session:
- `clearCopyDebugFrames()` — census of every frame (word count, element count,
  readyState, forms/video/nested-iframe presence, SVG-slider control counts).
- `clearCopyDebugNavLinks()` — reports `discoverCourseLessonLinks` candidates,
  by class-based and shape-based ("Lesson N", "Next", "Continue") detection.
- `clearCopyDebugExtract(frameId, options)` — runs a real extraction against
  one frame (or all) with `window.__clearCopyDebug = true` and a 20-second
  client-side timeout, printing each frame's buffered `debugLog`.

`.tools/test/diagnose-walk.js` covers the one path none of the above reach:
paste it into the **preview tab's** console (not the course page's) to report
whether the bundle is injected and at which `API_VERSION`, whether the walk
entry points exist, what the lesson tree returns, and whether one lesson can
actually be opened. It exists because a stale bundle in an already-injected
tab presents identically to a missing feature — the button simply never
appears — and that is indistinguishable from the outside.

## Conventions

- No build step, framework, or dependencies beyond Node for `.tools/build.js`
  and `.tools/validate.js`.
- Comments explain *why*, not what. Existing comments mark real hazards.
- Match surrounding style: ES modules in `src/`, 2-space indent, single quotes.

## Verified vs. unverified

- **Verified**: extraction, Markdown fidelity, ad stripping, image filtering,
  both document types, both styles, form-payload reading, and the lesson-tree
  walk — all through `validate.js`, which drives the extractor over CDP.
- **Not verified — and this is a real gap, not a formality**: anything that
  only exists inside a loaded extension. `validate.js` reaches
  `window.__clearCopy*` directly and never crosses the
  `chrome.scripting.executeScript` boundary, so the preview's own wiring —
  button visibility, option plumbing, the walk's per-lesson driver — is
  covered by no test at all. Two bugs shipped green through this gap in one
  session: a walk that returned ~14MB in a single `executeScript` result (the
  call fails wholesale and the reader silently gets a one-page export), and a
  redundant bundle re-injection that pushed 130KB into every frame per lesson.
  A suite at 257/257 says nothing about that path. **Load the extension
  unpacked and exercise the actual button before believing a UI change works.**
- **Not verified**: the CDP export path against a live `chrome.debugger` attach —
  the extension would not load in an automated Chrome profile. Load it unpacked
  and click **Save PDF** once to confirm.
