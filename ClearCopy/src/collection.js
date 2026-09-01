// Lesson collection: capture pages as you browse, then export them as one
// document. Nothing navigates on its own — you stay in control of what is
// captured and when.

// One bucket per capture session, not one for the whole extension. Two
// previews open on two different courses were writing to the same array, so
// the reader got a single interleaved document instead of two books.
//
// The session id travels in the preview's own URL, so each window keeps its
// own result while *settings* (which are preferences, not results) stay
// global and shared — see settings.js.
const KEY_PREFIX = 'clearcopy:collection';
const DEFAULT_SESSION = 'default';

// The legacy single-bucket key. Still read on first use of a session so a
// collection in progress when this shipped is adopted rather than lost.
const LEGACY_KEY = 'clearcopy:collection';

const keyFor = (session) =>
  (!session || session === DEFAULT_SESSION) ? LEGACY_KEY : `${KEY_PREFIX}:${session}`;

const MAX_ITEMS = 60;

// Extracted HTML can be large; keep the collection well inside the
// chrome.storage.local quota rather than failing on save.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

const byteLength = (value) => new Blob([JSON.stringify(value)]).size;

export async function loadCollection(session) {
  try {
    const key = keyFor(session);
    const stored = await chrome.storage.local.get(key);
    const items = stored[key];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

async function save(items, session) {
  await chrome.storage.local.set({ [keyFor(session)]: items });
}

// Pages are identified by URL so re-visiting a lesson updates it in place
// instead of duplicating it.
//
// Selections are the exception: several excerpts from one page are all valid
// and must not overwrite each other, so each gets a unique key.
export async function addToCollection(content, session) {
  const items = await loadCollection(session);
  const pageUrl = content.metadata?.url || '';
  const isSelection = !!content.isSelection;
  const url = isSelection
    ? `${pageUrl}#clearcopy-selection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : pageUrl;

  const entry = {
    url,
    title: content.metadata?.title || 'Untitled',
    html: content.html,
    faithfulHtml: content.faithfulHtml,
    metadata: content.metadata,
    wordCount: content.wordCount,
    images: content.images,
    isSelection,
    sourceUrl: isSelection ? pageUrl : undefined,
    capturedAt: Date.now(),
  };

  // A selection never replaces an existing entry.
  const existing = isSelection ? -1 : items.findIndex((item) => item.url === url);
  if (existing >= 0) {
    // Keep the original position so collection order follows the order the
    // lessons were first visited, which is usually course order.
    entry.order = items[existing].order;
    items[existing] = entry;
  } else {
    entry.order = items.length;
    items.push(entry);
  }

  // Trim oldest-first if we exceed the limits.
  let trimmed = items.slice(-MAX_ITEMS);
  while (trimmed.length > 1 && byteLength(trimmed) > MAX_TOTAL_BYTES) {
    trimmed = trimmed.slice(1);
  }

  await save(trimmed, session);
  return { count: trimmed.length, replaced: existing >= 0, trimmed: trimmed.length < items.length };
}

export async function removeFromCollection(url, session) {
  const items = (await loadCollection(session)).filter((item) => item.url !== url);
  await save(items, session);
  return items.length;
}

export async function clearCollection(session) {
  await chrome.storage.local.remove(keyFor(session));
}

// Every session bucket currently in storage, so the options page can show and
// clear collections that belong to windows the reader has since closed.
export async function listCollectionSessions() {
  try {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter((k) => k === LEGACY_KEY || k.startsWith(`${KEY_PREFIX}:`))
      .map((k) => ({
        session: k === LEGACY_KEY ? DEFAULT_SESSION : k.slice(KEY_PREFIX.length + 1),
        count: Array.isArray(all[k]) ? all[k].length : 0,
      }))
      .filter((entry) => entry.count > 0);
  } catch {
    return [];
  }
}

// Drop buckets belonging to sessions that are no longer open, so a reader who
// opens many previews does not accumulate collections forever.
export async function pruneCollectionSessions(liveSessions) {
  const live = new Set([DEFAULT_SESSION, ...liveSessions]);
  const sessions = await listCollectionSessions();
  const dead = sessions.filter((s) => !live.has(s.session));
  await Promise.all(dead.map((s) => chrome.storage.local.remove(keyFor(s.session))));
  return dead.length;
}

export async function reorderCollection(urls, session) {
  const items = await loadCollection(session);
  const byUrl = new Map(items.map((item) => [item.url, item]));
  const ordered = urls.map((u) => byUrl.get(u)).filter(Boolean);
  // Anything not named keeps its relative position at the end.
  items.forEach((item) => { if (!urls.includes(item.url)) ordered.push(item); });
  ordered.forEach((item, i) => { item.order = i; });
  await save(ordered, session);
  return ordered;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const normalize = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The section already prints the part title, so a matching heading at the top of
// the captured body would show it twice.
function stripLeadingTitle(html, title) {
  if (!html || !title) return html;
  const doc = document.implementation.createHTMLDocument('');
  doc.body.innerHTML = html;

  for (const node of Array.from(doc.body.children).slice(0, 2)) {
    if (!/^H[1-3]$/.test(node.tagName)) continue;
    if (normalize(node.textContent) !== normalize(title)) continue;
    node.remove();
    break;
  }
  return doc.body.innerHTML;
}

const slug = (text, index) =>
  `cr-part-${index}-${String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;

// Merge collected pages into a single document, in collection order, with a
// contents list and each lesson as its own section.
export function mergeCollection(items, {
  style = 'reader',
  includeContents = true,
  title = '',
  pageBreaks = true,
} = {}) {
  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const contents = includeContents && ordered.length > 1
    ? `<nav class="cr-toc">
         <h2>Contents</h2>
         <ol>
           ${ordered.map((item, i) =>
             `<li><a href="#${slug(item.title, i)}">${escapeHtml(item.title)}</a></li>`).join('\n')}
         </ol>
       </nav>`
    : '';

  const sections = ordered.map((item, i) => {
    const raw = style === 'faithful' ? (item.faithfulHtml || item.html) : item.html;
    const body = stripLeadingTitle(raw, item.title);
    // Each captured page starts a new sheet in paginated output.
    const breakClass = pageBreaks && i > 0 ? ' cr-part-break' : '';
    return `<section class="cr-part${breakClass}" id="${slug(item.title, i)}">
      <h1 class="cr-part-title">${escapeHtml(item.title)}</h1>
      ${body}
    </section>`;
  }).join('\n');

  const totalWords = ordered.reduce((sum, item) => sum + (item.wordCount || 0), 0);
  const first = ordered[0];

  return {
    metadata: {
      ...(first?.metadata || {}),
      title: title || deriveCollectionTitle(ordered),
      url: first?.metadata?.url || '',
    },
    html: contents + sections,
    faithfulHtml: contents + sections,
    text: '',
    wordCount: totalWords,
    images: {
      total: ordered.reduce((s, i2) => s + (i2.images?.total || 0), 0),
      kept: ordered.reduce((s, i2) => s + (i2.images?.kept || 0), 0),
    },
    partCount: ordered.length,
  };
}

// A course page can hold more than one real content frame at once — the main
// lesson plus a separate embedded exercise or tool. Confirmed on a real
// OpenAI Academy lesson: "Choose your Workflow" alongside a "Workflow
// Selection Funnel" widget and a "Meeting Pack Prompt Builder" tool, three
// distinct SCORM asset frames on one page. Picking only the richest frame
// (word-count winner) silently dropped the other two entirely.
//
// This is a pure selection step, kept separate from the chrome.scripting
// call that produces `results` so it can be unit-tested without a real
// extension context: `chrome.scripting.executeScript({allFrames:true})` only
// exists inside a loaded extension, so a raw-CDP test harness (validate.js)
// cannot drive it directly.
//
// A real threshold (not just "more than the winner") keeps SCORM plumbing
// frames (blank.html, AICCComm.html, sandbox.html — a handful of words each)
// from being merged in as bogus sections.
export const OTHER_FRAME_MIN_WORDS = 25;

export function selectContentFrames(extracted) {
  if (!extracted.length) return [];
  const sorted = [...extracted].sort((a, b) => b.wordCount - a.wordCount);
  const best = sorted[0];
  const others = sorted.slice(1).filter((r) => r.wordCount >= OTHER_FRAME_MIN_WORDS);
  return [best, ...others];
}

// Course pages are usually titled "Lesson 2 - Securing X". A shared prefix names
// the course, but numbering makes the prefix a useless stub like "Lesson", so
// such prefixes are rejected in favour of the site name.
const NUMBERING_STUB = /^(lesson|module|part|chapter|section|unit|step|page|topic|day|week)$/i;

function deriveCollectionTitle(items) {
  if (!items.length) return 'Collected pages';
  if (items.length === 1) return items[0].title;

  const titles = items.map((i) => i.title);
  let prefix = titles[0];
  for (const t of titles.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < t.length && prefix[k] === t[k]) k++;
    prefix = prefix.slice(0, k);
    if (!prefix) break;
  }
  prefix = prefix.replace(/[\s\-–—:|,.0-9]+$/, '').trim();

  const site = items[0].metadata?.siteName;
  if (prefix.length >= 6 && !NUMBERING_STUB.test(prefix)) return prefix;
  return site ? `${site} — ${items.length} pages` : `Collected pages (${items.length})`;
}
