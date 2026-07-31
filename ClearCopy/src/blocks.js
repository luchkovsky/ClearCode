// Normalizes cleaned HTML into a flat block list.
// The Markdown serializer walks this structure, so .md output stays in sync with
// what the PDF renders by construction.

const HEADING = /^H([1-6])$/;

function inlineRuns(node, inherited = {}) {
  const runs = [];

  const visit = (n, style) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.nodeValue.replace(/\s+/g, ' ');
      if (text) runs.push({ text, ...style });
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;

    const tag = n.tagName;
    if (tag === 'BR') { runs.push({ text: '\n', ...style }); return; }
    if (tag === 'IMG') {
      const src = n.getAttribute('src');
      if (src) runs.push({ image: src, alt: n.getAttribute('alt') || '', ...style });
      return;
    }

    const next = { ...style };
    if (tag === 'STRONG' || tag === 'B') next.bold = true;
    if (tag === 'EM' || tag === 'I') next.italic = true;
    if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') next.code = true;
    if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') next.strike = true;
    if (tag === 'MARK') next.mark = true;
    if (tag === 'SUP') next.sup = true;
    if (tag === 'SUB') next.sub = true;
    if (tag === 'A') {
      const href = n.getAttribute('href');
      if (href && !href.startsWith('#')) next.href = href;
    }

    for (const child of n.childNodes) visit(child, next);
  };

  for (const child of node.childNodes) visit(child, inherited);

  // Merge adjacent runs sharing identical styling.
  const merged = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    if (
      prev && !prev.image && !run.image &&
      prev.bold === run.bold && prev.italic === run.italic &&
      prev.code === run.code && prev.strike === run.strike && prev.href === run.href &&
      prev.mark === run.mark && prev.sup === run.sup && prev.sub === run.sub
    ) {
      prev.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }

  return merged.filter((r) => r.image || r.text.trim() || r.text === '\n');
}

const hasText = (node) => !!(node.textContent || '').trim();

function listItems(listEl, depth, ordered) {
  const items = [];
  let index = Number(listEl.getAttribute('start')) || 1;

  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;

    // Split the item's own text from any nested list it contains.
    const own = document.createElement('div');
    const nested = [];
    for (const child of li.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')) {
        nested.push(child);
      } else {
        own.appendChild(child.cloneNode(true));
      }
    }

    const checkbox = own.querySelector('input[type="checkbox"]');
    let checked;
    if (checkbox) {
      checked = checkbox.getAttribute('data-checked') === 'true' || checkbox.hasAttribute('checked');
      checkbox.remove(); // the marker replaces it; keeping it would duplicate
    }

    items.push({
      runs: inlineRuns(own),
      depth,
      ordered,
      // Numbering is per list, so nested lists restart instead of continuing.
      index: ordered ? index++ : undefined,
      checked,
    });

    nested.forEach((n) => {
      const nestedOrdered = n.tagName === 'OL';
      items.push(...listItems(n, depth + 1, nestedOrdered));
    });
  }
  return items;
}

export function htmlToBlocks(html) {
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;
  const blocks = [];

  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName;
      const heading = HEADING.exec(tag);

      if (heading) {
        if (hasText(el)) blocks.push({ type: 'heading', level: +heading[1], runs: inlineRuns(el) });
        continue;
      }

      if (tag === 'P') {
        const runs = inlineRuns(el);
        if (runs.length) blocks.push({ type: 'paragraph', runs });
        continue;
      }

      if (tag === 'UL' || tag === 'OL') {
        const ordered = tag === 'OL';
        const items = listItems(el, 0, ordered);
        if (items.length) blocks.push({ type: 'list', ordered, items });
        continue;
      }

      if (tag === 'PRE') {
        const code = el.querySelector('code');
        const lang = code?.className.match(/language-(\w+)/)?.[1] || '';
        const text = (el.textContent || '').replace(/\n+$/, '');
        if (text.trim()) blocks.push({ type: 'code', lang, text });
        continue;
      }

      if (tag === 'BLOCKQUOTE') {
        const inner = htmlToBlocks(el.innerHTML);
        if (inner.length) blocks.push({ type: 'quote', blocks: inner });
        continue;
      }

      if (tag === 'FIGURE') {
        const img = el.querySelector('img');
        const caption = el.querySelector('figcaption');
        if (img?.getAttribute('src')) {
          blocks.push({
            type: 'image',
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt') || '',
            caption: caption?.textContent?.trim() || '',
          });
        }
        continue;
      }

      if (tag === 'IMG') {
        const src = el.getAttribute('src');
        if (src) blocks.push({ type: 'image', src, alt: el.getAttribute('alt') || '', caption: '' });
        continue;
      }

      if (tag === 'TABLE') {
        const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.querySelectorAll('th, td')).map((cell) => ({
            runs: inlineRuns(cell),
            header: cell.tagName === 'TH',
          }))
        ).filter((r) => r.length);

        if (rows.length) {
          // Only treat row 0 as a header when it is *entirely* <th> — a leading
          // <th> in each row is a row-label column, and consuming it would
          // silently drop that row's data.
          const inThead = !!el.querySelector('thead');
          const allHeader = rows[0].every((c) => c.header);
          const useHeader = allHeader && (inThead || rows.length > 1);

          blocks.push({
            type: 'table',
            header: useHeader ? rows[0] : null,
            rows: useHeader ? rows.slice(1) : rows,
          });
        }
        continue;
      }

      // Definition lists: render as term + indented definition so the pairing
      // survives, rather than collapsing into loose paragraphs.
      if (tag === 'DL') {
        const items = [];
        for (const child of el.children) {
          if (child.tagName === 'DT' && hasText(child)) {
            items.push({ runs: inlineRuns(child), depth: 0, term: true });
          } else if (child.tagName === 'DD' && hasText(child)) {
            items.push({ runs: inlineRuns(child), depth: 1 });
          }
        }
        if (items.length) blocks.push({ type: 'list', ordered: false, definition: true, items });
        continue;
      }

      if (tag === 'HR') { blocks.push({ type: 'rule' }); continue; }

      // A <summary> labels its disclosure section, so keep it as a heading.
      if (tag === 'SUMMARY') {
        if (hasText(el)) blocks.push({ type: 'heading', level: 3, runs: inlineRuns(el) });
        continue;
      }

      // Generic container: recurse, but if it holds only inline content treat it
      // as a paragraph so loose text in <div>s is not lost.
      if (el.children.length === 0) {
        const runs = inlineRuns(el);
        if (runs.length && hasText(el)) blocks.push({ type: 'paragraph', runs });
      } else {
        const before = blocks.length;
        walk(el);
        if (blocks.length === before && hasText(el)) {
          blocks.push({ type: 'paragraph', runs: inlineRuns(el) });
        }
      }
    }
  };

  walk(doc.body);
  return blocks;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

// Escape only what would actually change how the line parses. Escaping every
// period/dash/paren makes prose unreadable for no benefit.
function escapeMd(text) {
  return text
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    // Leading markers matter only at the start of a line.
    .replace(/^(\s*)([#>])/gm, '$1\\$2')
    .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3')
    .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3');
}

function runsToMarkdown(runs, { escape = true } = {}) {
  return runs.map((run) => {
    if (run.image) return `![${run.alt}](${run.image})`;
    if (run.text === '\n') return '  \n';

    let text = escape ? escapeMd(run.text) : run.text;
    if (!text.trim()) return text;

    // Preserve surrounding spaces outside the emphasis markers, or the markdown
    // will not render.
    const lead = text.match(/^\s*/)[0];
    const tail = text.match(/\s*$/)[0];
    let core = text.trim();

    if (run.code) core = `\`${run.text.trim()}\``;
    if (run.bold) core = `**${core}**`;
    if (run.italic) core = `*${core}*`;
    if (run.strike) core = `~~${core}~~`;
    // GFM-flavoured; renderers that lack these still show the text legibly.
    if (run.mark) core = `==${core}==`;
    if (run.sup) core = `^${core}^`;
    if (run.sub) core = `~${core}~`;
    if (run.href) core = `[${core}](${run.href})`;

    return lead + core + tail;
  }).join('').replace(/[ \t]+/g, ' ').trim();
}

function blocksToMarkdown(blocks, depth = 0) {
  const out = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(`${'#'.repeat(block.level)} ${runsToMarkdown(block.runs)}`);
        break;

      case 'paragraph':
        out.push(runsToMarkdown(block.runs));
        break;

      case 'list': {
        const lines = [];
        for (const item of block.items) {
          const indent = '  '.repeat(item.depth);
          const text = runsToMarkdown(item.runs);

          if (block.definition) {
            // Bold term, indented definition beneath. Terms need a blank line
            // before them or renderers run consecutive pairs together.
            if (item.term) {
              if (lines.length) lines.push('');
              lines.push(`**${text}**`);
            } else {
              lines.push(`${indent}: ${text}`);
            }
            continue;
          }

          const ordered = item.ordered ?? block.ordered;
          let marker = ordered ? `${item.index ?? 1}. ` : '- ';
          if (item.checked !== undefined) marker = item.checked ? '- [x] ' : '- [ ] ';
          lines.push(indent + marker + text);
        }
        out.push(lines.join('\n'));
        break;
      }

      case 'code':
        out.push(`\`\`\`${block.lang}\n${block.text}\n\`\`\``);
        break;

      case 'quote':
        out.push(blocksToMarkdown(block.blocks, depth + 1).split('\n').map((l) => `> ${l}`.trimEnd()).join('\n'));
        break;

      case 'image':
        out.push(`![${block.alt}](${block.src})${block.caption ? `\n*${block.caption}*` : ''}`);
        break;

      case 'table': {
        // Markdown requires a header row. A header-less table gets its first row
        // promoted, which reads better than a row of empty cells.
        let header = block.header;
        let bodyRows = block.rows;
        if (!header) {
          if (!bodyRows.length) break;
          header = bodyRows[0];
          bodyRows = bodyRows.slice(1);
        }
        const width = Math.max(header.length, ...bodyRows.map((r) => r.length), 1);
        // Escape pipes after inline formatting, and collapse newlines: a table
        // cell must stay on one line or the row breaks.
        const cell = (c) => (c
          ? runsToMarkdown(c.runs).replace(/\n+/g, ' ').replace(/\|/g, '\\|')
          : '');
        const pad = (row) => Array.from({ length: width }, (_, i) => cell(row[i]));
        const lines = [
          `| ${pad(header).join(' | ')} |`,
          `| ${Array(width).fill('---').join(' | ')} |`,
          ...bodyRows.map((row) => `| ${pad(row).join(' | ')} |`),
        ];
        out.push(lines.join('\n'));
        break;
      }

      case 'rule':
        out.push('---');
        break;
    }
  }

  return out.join('\n\n');
}

export function toMarkdown(blocks, metadata, { frontmatter = true } = {}) {
  const body = blocksToMarkdown(blocks);
  if (!frontmatter) return `# ${metadata.title}\n\n${body}\n`;

  const yaml = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const fields = [`title: ${yaml(metadata.title)}`, `source: ${yaml(metadata.url)}`];
  if (metadata.author) fields.push(`author: ${yaml(metadata.author)}`);
  if (metadata.date) fields.push(`date: ${yaml(metadata.date)}`);
  if (metadata.siteName) fields.push(`site: ${yaml(metadata.siteName)}`);
  fields.push(`saved: ${yaml(new Date().toISOString())}`);

  return `---\n${fields.join('\n')}\n---\n\n# ${metadata.title}\n\n${body}\n`;
}

export function estimateReadingTime(wordCount) {
  return Math.max(1, Math.round(wordCount / 220));
}
