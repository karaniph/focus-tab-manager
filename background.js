// MV3 service worker — keyboard shortcut + first-install defaults. Stays event-driven.
const RAM_PER_TAB = 60;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ totalSavedMB: 0, totalFreedTabs: 0 });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'declutter') return;
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const eligible = tabs.filter(
      (t) =>
        t.url &&
        t.id != null &&
        !t.url.startsWith('chrome://') &&
        !t.url.startsWith('chrome-extension://') &&
        !t.url.startsWith('edge://') &&
        !t.url.startsWith('about:') &&
        !t.pinned &&
        !t.active &&
        !t.discarded
    );
    let frozen = 0;
    for (const t of eligible) {
      try {
        await chrome.tabs.discard(t.id);
        frozen++;
      } catch {
        // skip audible / active tabs
      }
    }
    if (frozen > 0) {
      const prev = await chrome.storage.local.get(['totalSavedMB', 'totalFreedTabs']);
      await chrome.storage.local.set({
        totalSavedMB: (Number(prev.totalSavedMB) || 0) + frozen * RAM_PER_TAB,
        totalFreedTabs: (Number(prev.totalFreedTabs) || 0) + frozen,
      });
    }
  } catch (e) {
    console.warn('FocusTab declutter failed', e);
  }
});
