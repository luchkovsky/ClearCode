// Extension-level settings, distinct from the per-export options in render.js.
//
// render.js DEFAULT_OPTIONS describes one document (paper, typography…) and is
// saved by the preview as you adjust it. These are preferences about how the
// extension behaves, edited on the options page.

const KEY = 'clearcopy:settings';

export const DEFAULT_SETTINGS = {
  // What the shortcuts and context menu capture.
  keepImages: true,
  onlySignificantImages: true,
  keepInteractionPrompts: false,

  // Behaviour after a capture.
  notifyOnCapture: true,      // brief badge confirmation
  openPreviewAfterAdd: false, // jump straight to the preview

  // Defaults the preview starts from.
  defaultDocType: 'article',  // article | book
  defaultStyle: 'reader',     // reader | faithful

  // Housekeeping.
  maxCollectionItems: 60,
};

// Values the UI offers, so the options page and validation agree.
export const SETTING_CHOICES = {
  defaultDocType: ['article', 'book'],
  defaultStyle: ['reader', 'faithful'],
};

export async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_SETTINGS, ...(stored[KEY] || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };

  // Never persist a value the UI cannot represent.
  for (const [field, allowed] of Object.entries(SETTING_CHOICES)) {
    if (!allowed.includes(next[field])) next[field] = DEFAULT_SETTINGS[field];
  }
  next.maxCollectionItems = Math.max(1, Math.min(500, Number(next.maxCollectionItems) || DEFAULT_SETTINGS.maxCollectionItems));

  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [KEY]: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

// The extraction options implied by the current settings, used by every
// capture path (shortcut, context menu, popup) so they behave identically.
export function extractionOptions(settings) {
  return {
    keepImages: settings.keepImages,
    onlySignificantImages: settings.onlySignificantImages,
    keepInteractionPrompts: settings.keepInteractionPrompts,
  };
}
