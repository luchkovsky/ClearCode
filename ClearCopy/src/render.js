// Render layer: turns extracted content + format options into the preview document.
// The same DOM the user previews is what gets printed, so what-you-see is what-you-get.

export const PAPER = {
  a4:      { width: 8.27, height: 11.69, label: 'A4' },
  letter:  { width: 8.5,  height: 11,    label: 'Letter' },
  legal:   { width: 8.5,  height: 14,    label: 'Legal' },
  a5:      { width: 5.83, height: 8.27,  label: 'A5' },
  a3:      { width: 11.7, height: 16.54, label: 'A3' },
  tabloid: { width: 11,   height: 17,    label: 'Tabloid' },
};

export const MARGINS = {
  none:   { top: 0,    right: 0,    bottom: 0,    left: 0,    label: 'None' },
  narrow: { top: 0.4,  right: 0.4,  bottom: 0.4,  left: 0.4,  label: 'Narrow' },
  normal: { top: 0.75, right: 0.7,  bottom: 0.75, left: 0.7,  label: 'Normal' },
  wide:   { top: 1,    right: 1.15, bottom: 1,    left: 1.15, label: 'Wide' },
};

export const THEMES = {
  paper:  { bg: '#ffffff', fg: '#1a1a1a', muted: '#6b6b6b', rule: '#e0e0e0', accent: '#1a56db', label: 'Paper' },
  sepia:  { bg: '#faf4e8', fg: '#3b3226', muted: '#7a6a52', rule: '#e0d3ba', accent: '#8a5a2b', label: 'Sepia' },
  night:  { bg: '#16181d', fg: '#e3e5e8', muted: '#9aa0a6', rule: '#2e3238', accent: '#7aa2f7', label: 'Night' },
};

export const FONTS = {
  serif:  { label: 'Serif',  stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
  sans:   { label: 'Sans',   stack: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  mono:   { label: 'Mono',   stack: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' },
};

export const DEFAULT_OPTIONS = {
  docType: 'article',   // article | book
  style: 'reader',      // reader | faithful
  paper: 'a4',
  orientation: 'portrait',
  margin: 'normal',
  theme: 'paper',
  font: 'serif',
  fontSize: 12,         // pt
  lineHeight: 1.6,
  keepImages: true,
  onlySignificantImages: true,
  keepInteractionPrompts: false,
  keepLinks: true,
  showHeader: true,     // title block
  showFooter: true,     // page numbers (book only)
  hyphenate: false,
  columns: 1,
};

export function paperSize(options) {
  const paper = PAPER[options.paper] || PAPER.a4;
  const landscape = options.orientation === 'landscape';
  return {
    width: landscape ? paper.height : paper.width,
    height: landscape ? paper.width : paper.height,
  };
}

export function marginBox(options) {
  return MARGINS[options.margin] || MARGINS.normal;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

export function buildStylesheet(options) {
  const theme = THEMES[options.theme] || THEMES.paper;
  const font = FONTS[options.font] || FONTS.serif;
  const { width, height } = paperSize(options);
  const margin = marginBox(options);
  const contentWidth = width - margin.left - margin.right;

  // Article mode is one continuous page: height grows with content, so we only
  // constrain width and let the flow run.
  const pageRule = options.docType === 'article'
    ? `@page { size: ${width}in auto; margin: ${margin.top}in ${margin.right}in ${margin.bottom}in ${margin.left}in; }`
    : `@page { size: ${width}in ${height}in; margin: ${margin.top}in ${margin.right}in ${margin.bottom}in ${margin.left}in; }`;

  return `
${pageRule}

:root {
  --bg: ${theme.bg};
  --fg: ${theme.fg};
  --muted: ${theme.muted};
  --rule: ${theme.rule};
  --accent: ${theme.accent};
  --font: ${font.stack};
  --size: ${options.fontSize}pt;
  --leading: ${options.lineHeight};
  --content-width: ${contentWidth}in;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
}

body {
  font-family: var(--font);
  font-size: var(--size);
  line-height: var(--leading);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.cr-doc {
  max-width: var(--content-width);
  margin: 0 auto;
  padding: 0;
  ${options.hyphenate ? 'hyphens: auto; -webkit-hyphens: auto;' : ''}
  ${options.columns > 1 ? `column-count: ${options.columns}; column-gap: 2em;` : ''}
}

/* Title block */
.cr-header {
  margin-bottom: 2em;
  padding-bottom: 1em;
  border-bottom: 1px solid var(--rule);
  break-after: avoid;
  break-inside: avoid;
  ${options.columns > 1 ? 'column-span: all;' : ''}
}
.cr-title {
  font-size: 1.9em;
  line-height: 1.2;
  font-weight: 700;
  margin: 0 0 .4em;
  letter-spacing: -0.01em;
}
.cr-meta {
  font-size: .78em;
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: .5em;
  align-items: baseline;
}
.cr-meta > *:not(:last-child)::after { content: '·'; margin-left: .5em; opacity: .6; }
.cr-meta a { color: var(--muted); }

/* Flow */
.cr-body > *:first-child { margin-top: 0; }
.cr-body p { margin: 0 0 .9em; orphans: 3; widows: 3; }

.cr-body h1, .cr-body h2, .cr-body h3,
.cr-body h4, .cr-body h5, .cr-body h6 {
  line-height: 1.25;
  margin: 1.6em 0 .5em;
  break-after: avoid;
  break-inside: avoid;
  font-weight: 650;
}
.cr-body h1 { font-size: 1.55em; }
.cr-body h2 { font-size: 1.32em; }
.cr-body h3 { font-size: 1.15em; }
.cr-body h4, .cr-body h5, .cr-body h6 { font-size: 1em; }

.cr-body a {
  color: ${options.keepLinks ? 'var(--accent)' : 'inherit'};
  text-decoration: ${options.keepLinks ? 'underline' : 'none'};
  text-underline-offset: 2px;
}

.cr-body img, .cr-body figure, .cr-body video {
  max-width: 100%;
  height: auto;
  break-inside: avoid;
}
.cr-body figure { margin: 1.2em 0; }
.cr-body figcaption {
  font-size: .8em;
  color: var(--muted);
  margin-top: .4em;
  text-align: center;
}

.cr-body ul, .cr-body ol { margin: 0 0 .9em; padding-left: 1.5em; }
.cr-body li { margin-bottom: .3em; break-inside: avoid; }

.cr-body blockquote {
  margin: 1.2em 0;
  padding-left: 1em;
  border-left: 3px solid var(--accent);
  color: var(--muted);
  font-style: italic;
  break-inside: avoid;
}

.cr-body pre {
  background: color-mix(in srgb, var(--fg) 6%, transparent);
  border: 1px solid var(--rule);
  border-radius: 6px;
  padding: .8em 1em;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: .85em;
  font-family: ${FONTS.mono.stack};
  break-inside: avoid;
}
.cr-body code {
  font-family: ${FONTS.mono.stack};
  font-size: .88em;
}
.cr-body pre code { font-size: inherit; }
.cr-body :not(pre) > code {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  padding: .12em .35em;
  border-radius: 3px;
}

.cr-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.2em 0;
  font-size: .9em;
  break-inside: avoid;
}
.cr-body th, .cr-body td {
  border: 1px solid var(--rule);
  padding: .45em .6em;
  text-align: left;
  vertical-align: top;
}
.cr-body th { background: color-mix(in srgb, var(--fg) 5%, transparent); font-weight: 600; }
.cr-body thead { display: table-header-group; }

.cr-body hr { border: 0; border-top: 1px solid var(--rule); margin: 2em 0; }

/* Merged collections: contents list plus one section per captured page. */
.cr-toc {
  margin-bottom: 2em;
  padding-bottom: 1.2em;
  border-bottom: 1px solid var(--rule);
  break-after: page;
}
.cr-toc h2 { margin-top: 0; font-size: 1.3em; }
.cr-toc ol { padding-left: 1.4em; }
.cr-toc li { margin-bottom: .45em; }
.cr-toc a { color: var(--fg); text-decoration: none; }

.cr-part-break { break-before: page; page-break-before: always; }
.cr-part-title {
  font-size: 1.55em;
  margin: 0 0 .8em;
  padding-bottom: .3em;
  border-bottom: 2px solid var(--accent);
  break-after: avoid;
}
/* The part title is the section heading, so a repeated inner h1 is noise. */
.cr-part > h1:not(.cr-part-title) { font-size: 1.3em; }

/* Faithful mode keeps the source styling (inlined at extraction time); we only
   normalize what would break on paper. Reader typography must not override it,
   so these rules stay narrow and structural. */
.cr-faithful .cr-body * {
  max-width: 100% !important;
  animation: none !important;
  transition: none !important;
  position: static !important;
  float: none !important;
  transform: none !important;
}
.cr-faithful .cr-body img,
.cr-faithful .cr-body figure,
.cr-faithful .cr-body video { height: auto !important; break-inside: avoid; }
.cr-faithful .cr-body p,
.cr-faithful .cr-body li { orphans: 3; widows: 3; }
.cr-faithful .cr-body h1, .cr-faithful .cr-body h2,
.cr-faithful .cr-body h3, .cr-faithful .cr-body h4 { break-after: avoid; }
.cr-faithful .cr-body pre,
.cr-faithful .cr-body blockquote,
.cr-faithful .cr-body table { break-inside: avoid; }
/* Source pages often set a dark page background on inner blocks; on paper that
   prints as large ink slabs, so only keep backgrounds on small elements. */
.cr-faithful .cr-body > * { background-color: transparent !important; }

@media print {
  html, body { background: #fff; }
  .cr-doc { max-width: none; }
  .no-print { display: none !important; }
}
`.trim();
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

function headerHtml(metadata, options, readingTime) {
  if (!options.showHeader) return '';
  const bits = [];
  if (metadata.author) bits.push(`<span>${escapeHtml(metadata.author)}</span>`);
  if (metadata.date) bits.push(`<span>${escapeHtml(metadata.date)}</span>`);
  if (metadata.siteName) bits.push(`<span>${escapeHtml(metadata.siteName)}</span>`);
  if (readingTime) bits.push(`<span>${readingTime} min read</span>`);

  return `
    <header class="cr-header">
      <h1 class="cr-title">${escapeHtml(metadata.title)}</h1>
      <div class="cr-meta">${bits.join('')}</div>
    </header>`;
}

// Faithful mode inlines the source's own computed styles; reader mode uses ours.
export function buildDocumentHtml(content, options, { readingTime } = {}) {
  const faithful = options.style === 'faithful';
  const body = faithful ? (content.faithfulHtml || content.html) : content.html;
  return `
    <div class="cr-doc ${faithful ? 'cr-faithful' : 'cr-reader'}" id="cr-doc">
      ${headerHtml(content.metadata, options, readingTime)}
      <div class="cr-body">${body}</div>
    </div>`;
}

export function buildStandaloneHtml(content, options, { readingTime } = {}) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(content.metadata.title)}</title>
<style>${buildStylesheet(options)}</style>
</head>
<body>${buildDocumentHtml(content, options, { readingTime })}</body>
</html>`;
}
