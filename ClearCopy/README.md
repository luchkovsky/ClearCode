# Clear Copy

Turns a web page into a clean, readable document. It expands content the page is
hiding, extracts the real article, and lets you shape the output in a live
preview before saving as PDF or Markdown.

Built for pages that defeat ordinary "save as PDF": course lessons behind a
player, tabbed and stepped widgets, single-page apps, and copy-protected text.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Collecting selections](#collecting-selections)
- [Configuration reference](#configuration-reference)
- [Article vs Book](#article-vs-book)
- [Reader vs Faithful](#reader-vs-faithful)
- [Combining several pages](#combining-several-pages)
- [What it handles automatically](#what-it-handles-automatically)
- [Markdown output](#markdown-output)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `ClearCopy` folder

After changing any source file, click **Reload** on the extension card.

---

## Quick start

Click the toolbar icon:

| Action | What it does |
| --- | --- |
| **Open preview** | Full editor — adjust everything, then export |
| **Add this page** | Adds the page to a collection for combined export |
| **Add selection** | Adds just the highlighted text |

In the preview, **Save PDF**, **Save Markdown**, or **Copy Markdown**.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+C` | Add this page to the collection |
| `Alt+Shift+S` | Add the selected text |
| `Alt+Shift+P` | Open the preview |

Change or clear them at `chrome://extensions/shortcuts`, or via
**Settings & shortcuts** in the popup. Chrome owns shortcut assignment, so an
extension can show the current bindings but cannot set them itself.

A capture triggered by a keystroke briefly shows the collection count on the
toolbar icon, since there is otherwise no sign it worked.

### Right-click menu

Right-click a page for **Add this page to Clear Copy**, or right-click a
selection for **Add selection to Clear Copy**.

### Collecting selections

Highlight text and add it — the excerpt keeps its headings, lists and tables
rather than collapsing to plain text. Several excerpts from the same page are
kept separately (adding a whole page twice updates it in place; selections never
overwrite each other). Excerpts are marked **excerpt** in the collection list.

**Before exporting a course lesson**, click any **Launch / Relaunch / Start**
button so the lesson is actually on screen. Clear Copy reads what is rendered.

---

## Configuration reference

There are two layers of configuration:

- **Extension settings** — how capturing behaves. Popup → **Settings & shortcuts**,
  or right-click the toolbar icon → **Options**.
- **Document options** — how one export looks. The preview panel, covered below.

### Extension settings

| Setting | Default | Effect |
| --- | --- | --- |
| **Include images** | ✓ | Off strips every image from captured pages |
| **Meaningful images only** | ✓ | Drops icons, avatars, spacers, tracking pixels |
| **Keep "click to…" prompts** | ✗ | Keeps instructions like *"Click to flip"* |
| **Show a badge confirmation** | ✓ | Flashes the collection count after a capture |
| **Open the preview immediately** | ✗ | Jump to the preview after adding |
| **Document type** | Book | Starting point for new previews |
| **Style** | Reader | Starting point for new previews |
| **Collection limit** | 60 | Oldest entries dropped beyond this (1–500) |

The first three apply to every capture path — shortcut, right-click menu and
popup — so a page added by keystroke is identical to one added by clicking.

### Document options

Every control in the preview panel, with its default.

### Source

| Option | Default | Effect |
| --- | --- | --- |
| **This page** | ✓ | Export the page the preview was opened from |
| **Combined** | | Merge all collected pages into one document |

The collected list appears below with **Add current page** and **Clear**; the
× beside an entry removes it. See [Combining several pages](#combining-several-pages).

### Document type

| Option | Default | Effect |
| --- | --- | --- |
| **Article** | | Only what is open now — one continuous page |
| **Book** | ✓ | Everything opened out — paginated pages |

Fully explained in [Article vs Book](#article-vs-book).

### Style

| Option | Default | Effect |
| --- | --- | --- |
| **Reader** | ✓ | Rebuilt with clean typography |
| **Faithful** | | Keeps the site's own fonts, colours and boxes |

### Page

| Option | Default | Values |
| --- | --- | --- |
| **Paper** | A4 | A3, A4, A5, Letter, Legal, Tabloid |
| **Orientation** | Portrait | Portrait, Landscape |
| **Margins** | Normal | None (0"), Narrow (0.4"), Normal (~0.7"), Wide (~1.1") |
| **Columns** | Single | Single, Two — *Book only* |

### Typography

| Option | Default | Values |
| --- | --- | --- |
| **Typeface** | Serif | Serif (Georgia), Sans (system), Mono |
| **Size** | 12 pt | 8–18 pt |
| **Leading** | 1.60 | 1.2–2.2 (line height) |
| **Theme** | Paper | Paper (white), Sepia, Night (dark) |

Night theme prints its dark background — useful for screen reading, wasteful on
paper. Use Paper for anything you will print.

### Content

| Option | Default | Effect |
| --- | --- | --- |
| **Include images** | ✓ | Off strips every image |
| **Meaningful images only** | ✓ | Drops icons, avatars, spacers, tracking pixels. **Untick this first if a picture you wanted is missing.** |
| **Keep "click to…" prompts** | ✗ | Keeps instructions like *"Click to flip"*, which are meaningless once the panels are laid out |
| **Show link styling** | ✓ | Off renders links as plain text (URLs are still kept in Markdown) |
| **Title block** | ✓ | Title, author, date and reading time at the top |
| **Page numbers** | ✓ | Running head and page numbers — *Book only* |
| **Hyphenation** | ✗ | Justified-looking text with hyphen breaks |

Options marked *Book only* are hidden in Article mode. The three image and
prompt options re-read the page when changed, so they take a moment; everything
else re-renders instantly.

Settings persist between sessions. Collected pages keep the image settings that
applied when each was captured, so those toggles are disabled while **Combined**
is selected — re-add a page to change them.

---

## Article vs Book

They differ in **how much of the page is captured**, not just in page geometry.

| | Article | Book |
| --- | --- | --- |
| **Interactive content** | Only what is open now | Every tab, step and panel |
| **Collapsed sections** | Left closed | Opened |
| Page height | Grows to fit the content | Fixed (A4, Letter…) |
| Page breaks | None — nothing is ever split | Content flows across pages |
| Running heads | — | Title + page numbers |
| Columns | — | 1 or 2 |
| Merged collections | Pages run on continuously | Each page starts a new sheet |

**Article** is a snapshot: the page exactly as it stands. A carousel showing
step 1 contributes step 1 and nothing else. The output is literally one page,
as tall as the whole document, so nothing is ever split mid-table.

**Book** opens everything out. It clicks through every carousel step, tab and
flashcard, and expands collapsed sections, then lays the result on paper pages.
A lesson with two six-step walkthroughs yields all twelve panels. The preview
reports how many panels were expanded, so you can tell at a glance whether
there was anything to open.

**Choose Article** for a quick snapshot, or when you only want the part on screen.
**Choose Book** for the complete lesson, and for anything you will print.

Switching between them re-reads the page, since they capture different things.
Either way the live page is restored — widgets are returned to the step they
were on.

PDF export drives Chrome's DevTools Protocol (the `debugger` permission), which
gives exact page geometry. Chrome shows a *"debugging this browser"* banner
while it runs — that is expected and stops when the export finishes. If the
debugger cannot attach, export falls back to the print dialog automatically.

---

## Reader vs Faithful

- **Reader** — rebuilt with consistent typography and spacing. Best for reading,
  and the source of the Markdown export.
- **Faithful** — keeps the page's own fonts, colours and boxes, minus the
  clutter. Best when the visual design carries meaning (dashboards, styled
  reports).

Both are extracted in one pass, so switching is instant. Markdown always comes
from the Reader structure, so no inline styling leaks into `.md`.

---

## Combining several pages

For material split across many pages — course lessons, multi-part articles:

1. Open a page, click **Add this page** (popup) or **Add current page** (preview)
2. Browse to the next page and add it too — nothing navigates on its own
3. Switch **Source** to **Combined**

Pages merge in the order they were first added, with a contents list. Re-adding
a page updates it in place rather than duplicating it. In Book mode each page
starts a new sheet.

---

## What it handles automatically

### Interactive widgets

Tabs and steppers reuse a single panel — clicking a tab *replaces* its text, so
the other panels never exist at the same moment and cannot simply be revealed.
Clear Copy clicks through them and lays the panels out in sequence:

- **Tabs and flashcards** — one control per panel, clicked once each; panels
  become headed sections
- **Sequential steppers** — a *Start* button and a next arrow with a "1 of 6"
  counter, clicked repeatedly until the content stops changing
- **Numbered carousels** — pagination dots (`1 2 3 4`) with arrows, the shape
  course tools use for walkthroughs. Each numbered step is visited in turn,
  including when the arrows are icon-only and the dots have no class name
- **Articulate Storyline/Rise glossary sliders** — some course tools draw the
  whole slide as SVG shapes instead of HTML, with no tab markup at all. Each
  term is still clicked and its revealed definition captured as a section

This happens in **Book** mode. Article captures only the panel currently on
screen. Either way widgets are restored afterwards, and controls that submit,
exit or mark progress are **never** clicked.

### Course players

Some platforms show only a title and a **Launch / Relaunch** button; clicking
it loads the lesson, sometimes into an embedded player on another domain
(which the page itself cannot read but Clear Copy can), sometimes by creating
the lesson content directly on the same page with no embedded player at all.
Either way, until you click that button the lesson simply does not exist yet
— there is nothing hidden to reveal, so Clear Copy warns instead of exporting
an empty shell.

### Single-page apps

Sites that serve an empty HTML shell and fill it from JavaScript are waited for
(up to 6 seconds) before reading, so the export is not an empty skeleton.

### Copy-protected pages

`user-select: none`, `oncopy` handlers and transparent overlays are relaxed on
the working copy so already-visible text extracts normally. The live page is
restored exactly as found.

### Advertising

Ad-network slots (AdSense, GPT/DoubleClick, Taboola, Outbrain, Criteo),
`data-ad-*` slots, ad iframes, sponsored units, cookie banners, newsletter
interstitials and paywall overlays are removed — and ad nodes cannot win the
content-detection contest. Editorial text that merely *mentions* advertising is
kept.

### Images

Kept: captioned figures, descriptive alt text, anything at content size,
including wide hero banners and lazy-loaded diagrams.
Dropped: icons, avatars, spacers, tracking pixels, header/footer logos.

### Hidden content

Opens `<details>`, ARIA-collapsed regions and inert tab panels; removes line
clamps and fade masks; scrolls to trigger lazy loaders; freezes `vh`/`vw`
lengths so printing does not reflow the layout; walks same-origin frames and
shadow roots.

**All page mutations are reverted** — the live tab is left exactly as found.

---

## Markdown output

Supported: all six heading levels; bold, italic, inline code, strikethrough,
highlight (`==text==`), superscript, subscript; links; nested unordered and
ordered lists with independent numbering; task-list checkboxes; tables with
header rows, escaped pipes, inline formatting and ragged-row padding; fenced
code blocks with language; nested blockquotes; images with alt text and
captions; definition lists; horizontal rules; YAML frontmatter.

Escaping is minimal — only characters that would change parsing are escaped, so
prose stays readable.

*Known limitation:* Markdown has no row-header concept, so a table using `<th>`
as a row label renders its first row as the header.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Almost nothing exported | Click **Launch / Relaunch / Start** so the lesson is on screen, then reopen the preview. This can happen even with no embedded player at all — some course pages don't create the lesson content in the page until you launch it |
| Preview shows the page from before I clicked Launch/Relaunch | Click the refresh icon in the toolbar (next to the zoom controls). The preview reads the page once when it opens; if you click Launch/Relaunch *after* opening the preview, use refresh to re-read it — the page hasn't changed URL, so nothing does this automatically |
| A picture is missing | Untick **Meaningful images only** |
| Sections show a counter but no text | The stepper needs a moment — reload the page, let it settle, retry |
| Wrong title | Clear Copy prefers the content heading; if a page has none, it falls back to the tab title |
| "Debugging this browser" banner | Expected during PDF export; it disappears when the export finishes |
| Export failed / print dialog opened | The debugger could not attach — the print dialog is the fallback. Close any open DevTools on that tab and retry |
| Changes to source not taking effect | `cd .tools && node build.js`, then **Reload** the extension |

### Still wrong?

Run `.tools/test/diagnose.js` in the DevTools console **on the page that fails**:

1. Open the failing page and make the content visible
2. Open the Clear Copy preview (this loads the extractor into the tab)
3. Back on the page tab, press **F12** → **Console**
4. Paste `.tools/test/diagnose.js`, press Enter, wait for `DIAGNOSTIC COMPLETE`

It prints a verdict (how much of the page was captured), the title produced,
frames and whether they were readable, and the first 400 characters extracted.
It only reads the page — nothing is changed.

---

## Development

`.tools/` is a sibling of this folder, not nested inside it — it holds the
build script, test runner, fixtures and icon generator so this folder stays
just the shipped extension: no tests, no build tooling, no Python.

```
ClearCopy/  (this folder — the shipped extension)
  manifest.json
  background.js          service worker; owns the CDP export path
  popup.html/js          toolbar popup
  options.html/js        extension settings + shortcut list
  preview.html/css/js    the preview editor
  src/
    extract.js           content extraction + page materialization
    blocks.js            block model + Markdown serializer
    render.js            paper geometry, themes, stylesheet
    settings.js          extension-level preferences
    collection.js        capture-as-you-browse store + merge
    export.js            engine selection + CDP/print fallback
    debug.js             opt-in debug logging for the injected bundle
    extractor.bundle.js  GENERATED — do not edit

.tools/     (sibling directory — dev tooling, not shipped)
  build.js              regenerates ClearCopy/src/extractor.bundle.js
  validate.js           test runner
  tools/make-icons.py   regenerates ClearCopy/icons/ from source
  test/
    *.html               fixtures for each failure mode
    diagnose.js          in-page diagnostic
```

### Build

```sh
cd .tools
node build.js                     # or /build — regenerates the injected bundle
python3 tools/make-icons.py       # regenerates ../ClearCopy/icons/ from source
```

`extract.js` and `blocks.js` are bundled into `extractor.bundle.js` because a
dynamic `import()` inside an injected script is evaluated against the *page's*
CSP, which strict sites block. **Run this after editing either file**, or the
extension keeps running the previous code.

The preview page loads `render.js`, `collection.js` and `export.js` as normal ES
modules — it runs under the extension's own CSP, so imports work there.

### Test

```sh
cd .tools
node validate.js            # full checks, incl. headless Chrome
node validate.js --static   # skip the browser
```

The behavioural tests inject the real bundle into the fixtures in `.tools/test/`
and assert on the HTML and Markdown produced. When fixing a bug, add a case to
a fixture and an assertion to `validate.js` **first** — then revert your fix
and confirm the check goes red, so you know it tests something.
