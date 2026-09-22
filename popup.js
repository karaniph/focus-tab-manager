// FocusTab Manager — popup logic. Everything stays local via chrome.storage.local.
const RAM_PER_SLEEPING_TAB_MB = 60;
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const STORAGE_KEYS = { savedMB: 'totalSavedMB', freed: 'totalFreedTabs', undo: 'lastUndo' };

const ramValueEl = document.querySelector('.ram-ring__value');
const statsLineEl = document.getElementById('stats-line');
const statusEl = document.getElementById('status');
const tabListEl = document.getElementById('tab-list');
const tabCountEl = document.getElementById('tab-count');
const searchEl = document.getElementById('search');
const primaryButton = document.getElementById('declutter-btn');
const undoButton = document.getElementById('undo-btn');
const collapseButton = document.getElementById('collapse-btn');
const expandButton = document.getElementById('expand-btn');

let allTabs = [];
let allGroups = [];
let sessionSavedMB = 0;

function getBaseDomain(rawUrl) {
  try {
    const { hostname } = new URL(rawUrl);
    if (!hostname || hostname === 'localhost') return hostname || 'local';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return hostname;
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length <= 2) return hostname;
    const twoPart = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'com.mx', 'co.in', 'com.sg']);
    if (twoPart.has(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  } catch {
    return 'other';
  }
}

function formatGroupLabel(domain, count) {
  const label = domain.replace(/^www\./, '');
  return count === 1 ? label : `${label} (${count})`;
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg || '';
}

function animateCounter(targetValue) {
  const startValue = Number.parseInt(ramValueEl.textContent, 10) || 0;
  const duration = 650;
  const startTime = performance.now();
  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    ramValueEl.textContent = `${Math.round(startValue + (targetValue - startValue) * eased)} MB`;
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

async function loadPersisted() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEYS.savedMB, STORAGE_KEYS.undo]);
    sessionSavedMB = Number(data[STORAGE_KEYS.savedMB]) || 0;
    animateCounter(sessionSavedMB);
    const undo = data[STORAGE_KEYS.undo];
    if (undoButton) undoButton.disabled = !(undo && undo.groupIds && undo.groupIds.length);
  } catch {
    // storage unavailable (e.g. preview) — stay ephemeral
  }
}

async function refresh() {
  if (!chrome?.tabs) {
    setStatus('Open in Chrome to manage real tabs.');
    return;
  }
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ currentWindow: true }),
    (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        return chrome.tabGroups ? await chrome.tabGroups.query({ windowId: win.id }) : [];
      } catch {
        return chrome.tabGroups ? await chrome.tabGroups.query({}) : [];
      }
    })(),
  ]);
  allTabs = tabs || [];
  allGroups = groups || [];
  renderAll();
}

function makeFallbackIcon(title) {
  const span = document.createElement('span');
  span.className = 'tab-fav tab-fav--fallback';
  span.textContent = (title || '?').trim().charAt(0).toUpperCase() || '?';
  span.setAttribute('aria-hidden', 'true');
  return span;
}

function renderAll() {
  const q = (searchEl.value || '').toLowerCase().trim();
  const visible = q
    ? allTabs.filter((t) => `${t.title || ''} ${t.url || ''}`.toLowerCase().includes(q))
    : allTabs;

  const groupById = new Map(allGroups.map((g) => [g.id, g]));
  const frozenCount = allTabs.filter((t) => t.discarded).length;

  if (statsLineEl) {
    statsLineEl.textContent =
      `${allTabs.length} open · ${allGroups.length} groups · ${frozenCount} frozen`;
  }
  if (tabCountEl) tabCountEl.textContent = `${visible.length} shown`;

  tabListEl.innerHTML = '';
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = q ? 'No tabs match your search.' : 'No tabs in this window. Open a few tabs, then De-Clutter.';
    tabListEl.appendChild(empty);
    return;
  }

  for (const tab of visible) {
    const row = document.createElement('div');
    row.className = 'tab-row' + (tab.active ? ' is-active' : '') + (tab.discarded ? ' is-frozen' : '');
    row.setAttribute('role', 'listitem');

    const fav = document.createElement('img');
    fav.className = 'tab-fav';
    fav.alt = '';
    if (tab.favIconUrl) {
      fav.src = tab.favIconUrl;
      fav.onerror = () => fav.replaceWith(makeFallbackIcon(tab.title));
    } else {
      fav.replaceWith(makeFallbackIcon(tab.title));
    }

    const copy = document.createElement('button');
    copy.className = 'tab-copy';
    copy.type = 'button';
    copy.title = tab.url || tab.title || 'Tab';
    const title = document.createElement('strong');
    title.textContent = tab.title || '(no title)';
    const meta = document.createElement('span');
    const group = groupById.get(tab.groupId);
    const bits = [getBaseDomain(tab.url || '')];
    if (group?.title) bits.push(`in ${group.title}`);
    if (tab.discarded) bits.push('frozen');
    if (tab.pinned) bits.push('pinned');
    meta.textContent = bits.join(' · ');
    copy.append(title, meta);
    copy.addEventListener('click', async () => {
      if (tab.id != null) {
        await chrome.tabs.update(tab.id, { active: true });
        window.close();
      }
    });

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close tab');
    close.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (tab.id != null) {
        await chrome.tabs.remove(tab.id);
        await refresh();
      }
    });

    row.append(fav, copy, close);
    tabListEl.appendChild(row);
  }
}

function isEligible(tab) {
  return Boolean(
    tab.url &&
    tab.id != null &&
    !tab.url.startsWith('chrome://') &&
    !tab.url.startsWith('chrome-extension://') &&
    !tab.url.startsWith('edge://') &&
    !tab.url.startsWith('about:') &&
    !tab.pinned
  );
}

async function groupAndFreezeTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const eligible = tabs.filter(isEligible);
  if (!eligible.length) {
    setStatus('Nothing to freeze — pinned and system tabs are skipped.');
    return { groups: 0, frozen: 0 };
  }

  const byDomain = new Map();
  for (const tab of eligible) {
    const d = getBaseDomain(tab.url);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(tab);
  }

  const current = tabs.find((t) => t.active);
  const activeDomain = current?.url ? getBaseDomain(current.url) : null;
  const multi = [...byDomain.entries()].filter(([, v]) => v.length > 1);

  const createdGroupIds = [];
  let frozen = 0;
  let colorIdx = 0;

  // 1) Group multi-tab domains (collapse everything except active domain)
  for (const [domain, domainTabs] of multi) {
    const ids = domainTabs.map((t) => t.id).filter((id) => id != null);
    if (!ids.length) continue;
    const gid = await chrome.tabs.group({ tabIds: ids });
    createdGroupIds.push(gid);
    const collapse = domain !== activeDomain;
    await chrome.tabGroups.update(gid, {
      title: formatGroupLabel(domain, domainTabs.length).slice(0, 32),
      color: GROUP_COLORS[colorIdx++ % GROUP_COLORS.length],
      collapsed: collapse,
    });
    if (collapse) {
      for (const t of domainTabs.filter((t) => !t.active && !t.discarded)) {
        try { await chrome.tabs.discard(t.id); frozen++; } catch { /* e.g. audible/active */ }
      }
    }
  }

  // 2) If user has all-unique domains (the old "Grouped 0 domains" dead-end),
  //    still deliver value: freeze every inactive eligible tab.
  if (multi.length === 0) {
    for (const t of eligible.filter((t) => !t.active && !t.discarded)) {
      try { await chrome.tabs.discard(t.id); frozen++; } catch { /* skip */ }
    }
  }

  const gained = frozen * RAM_PER_SLEEPING_TAB_MB;
  sessionSavedMB += gained;
  animateCounter(sessionSavedMB);
  try {
    const prev = await chrome.storage.local.get(STORAGE_KEYS.freed);
    await chrome.storage.local.set({
      [STORAGE_KEYS.savedMB]: sessionSavedMB,
      [STORAGE_KEYS.freed]: (Number(prev[STORAGE_KEYS.freed]) || 0) + frozen,
      [STORAGE_KEYS.undo]: { groupIds: createdGroupIds, at: Date.now() },
    });
  } catch { /* ignore */ }
  if (undoButton) undoButton.disabled = !createdGroupIds.length;

  return { groups: createdGroupIds.length, frozen };
}

async function undoLast() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.undo);
  const undo = data[STORAGE_KEYS.undo];
  if (!undo?.groupIds?.length) return;
  for (const gid of undo.groupIds) {
    try {
      const tabIds = (await chrome.tabs.query({ groupId: gid })).map((t) => t.id).filter((id) => id != null);
      if (tabIds.length) await chrome.tabs.ungroup(tabIds);
    } catch { /* group already gone */ }
  }
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      try { await chrome.tabGroups.update(g.id, { collapsed: false }); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  await chrome.storage.local.remove(STORAGE_KEYS.undo);
  undoButton.disabled = true;
  setStatus('Undone — groups ungrouped and expanded.');
  await refresh();
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadPersisted();
  await refresh();

  searchEl?.addEventListener('input', renderAll);

  primaryButton?.addEventListener('click', async () => {
    primaryButton.disabled = true;
    const orig = primaryButton.textContent;
    primaryButton.textContent = 'Working…';
    setStatus('');
    try {
      const { groups, frozen } = await groupAndFreezeTabs();
      await refresh();
      if (groups === 0 && frozen > 0) {
        setStatus(`No duplicate sites — froze ${frozen} idle tab${frozen === 1 ? '' : 's'} instead.`);
      } else if (groups === 0 && frozen === 0) {
        setStatus('Already tidy — nothing to group or freeze.');
      } else {
        setStatus(`Grouped ${groups} site${groups === 1 ? '' : 's'} · froze ${frozen} idle tab${frozen === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      console.error(err);
      setStatus('Could not organize tabs in this window.');
    } finally {
      primaryButton.disabled = false;
      primaryButton.textContent = orig;
    }
  });

  undoButton?.addEventListener('click', async () => {
    undoButton.disabled = true;
    try { await undoLast(); } finally { await refresh(); }
  });

  collapseButton?.addEventListener('click', async () => {
    const groups = await chrome.tabGroups.query({});
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    for (const g of groups) {
      const inActive = active?.groupId === g.id;
      if (!inActive) { try { await chrome.tabGroups.update(g.id, { collapsed: true }); } catch { /* skip */ } }
    }
    setStatus(`Collapsed ${groups.length} group${groups.length === 1 ? '' : 's'}.`);
    await refresh();
  });

  expandButton?.addEventListener('click', async () => {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      try { await chrome.tabGroups.update(g.id, { collapsed: false }); } catch { /* skip */ }
    }
    setStatus('Expanded all groups.');
    await refresh();
  });
});
