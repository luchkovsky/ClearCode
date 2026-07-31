import { loadSettings, saveSettings, resetSettings, DEFAULT_SETTINGS } from './src/settings.js';
import { loadCollection, clearCollection } from './src/collection.js';

const $ = (id) => document.getElementById(id);

const CHECKBOXES = [
  'keepImages', 'onlySignificantImages', 'keepInteractionPrompts',
  'notifyOnCapture', 'openPreviewAfterAdd',
];
const SELECTS = ['defaultDocType', 'defaultStyle'];

function status(text, timeout = 2600) {
  $('status').textContent = text;
  if (timeout) {
    setTimeout(() => { if ($('status').textContent === text) $('status').textContent = ''; }, timeout);
  }
}

// ---------------------------------------------------------------------------
// Shortcuts
//
// Chrome owns the bindings; an extension can read them but cannot set them.
// So we display what is currently assigned and link to Chrome's own editor.
// ---------------------------------------------------------------------------

const COMMAND_LABELS = {
  'add-page': 'Add this page to the collection',
  'add-selection': 'Add the selected text',
  'open-preview': 'Open the preview',
  _execute_action: 'Open the toolbar popup',
};

async function renderShortcuts() {
  const table = $('shortcuts');
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch {
    table.innerHTML = '<tr><td>Shortcuts unavailable in this context.</td></tr>';
    return;
  }

  table.innerHTML = commands.map((cmd) => {
    const label = COMMAND_LABELS[cmd.name] || cmd.description || cmd.name;
    const key = cmd.shortcut
      ? `<kbd>${cmd.shortcut.replace(/\+/g, ' + ')}</kbd>`
      : '<kbd class="unset">not set</kbd>';
    return `<tr><td>${label}</td><td>${key}</td></tr>`;
  }).join('');
}

$('editShortcuts').addEventListener('click', () => {
  // chrome://extensions/shortcuts cannot be opened with tabs.create from a
  // content-script context, but an extension page may do it.
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------

function applyToForm(settings) {
  CHECKBOXES.forEach((id) => { $(id).checked = !!settings[id]; });
  SELECTS.forEach((id) => { $(id).value = settings[id]; });
  $('maxCollectionItems').value = settings.maxCollectionItems;
}

function readForm() {
  const patch = {};
  CHECKBOXES.forEach((id) => { patch[id] = $(id).checked; });
  SELECTS.forEach((id) => { patch[id] = $(id).value; });
  patch.maxCollectionItems = Number($('maxCollectionItems').value);
  return patch;
}

$('save').addEventListener('click', async () => {
  const saved = await saveSettings(readForm());
  // saveSettings clamps out-of-range values, so reflect what was actually kept.
  applyToForm(saved);
  status('Settings saved');
});

$('reset').addEventListener('click', async () => {
  applyToForm(await resetSettings());
  status('Reset to defaults');
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function renderCollection() {
  const items = await loadCollection();
  if (!items.length) {
    $('collectionSummary').textContent = 'Nothing collected yet.';
    $('clearCollection').disabled = true;
    return;
  }
  const selections = items.filter((i) => i.isSelection).length;
  const pages = items.length - selections;
  const words = items.reduce((sum, i) => sum + (i.wordCount || 0), 0);

  const parts = [];
  if (pages) parts.push(`${pages} page${pages === 1 ? '' : 's'}`);
  if (selections) parts.push(`${selections} selection${selections === 1 ? '' : 's'}`);
  $('collectionSummary').textContent =
    `${parts.join(' and ')} · ${words.toLocaleString()} words`;
  $('clearCollection').disabled = false;
}

$('clearCollection').addEventListener('click', async () => {
  await clearCollection();
  await renderCollection();
  status('Collection cleared');
});

$('openPreview').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('preview.html?source=collection') });
});

// ---------------------------------------------------------------------------

(async function init() {
  applyToForm(await loadSettings());
  await renderShortcuts();
  await renderCollection();
})();
