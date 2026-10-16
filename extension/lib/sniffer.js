'use strict';

// Per-tab resource table for sniffed downloads + the toolbar badge.
//
// Two resilience properties this module guarantees:
//  1. Every entry is stamped with the PAGE it came from, and pruning only
//     drops entries whose owner page is KNOWN and different. (Stamping an
//     entry with its own resource URL instead would make every prune call
//     wipe the whole list.)
//  2. The table survives service-worker eviction: it is mirrored into
//     chrome.storage.session (which Chrome clears on browser restart) and
//     lazily restored on first use.

(function (root) {
  const maps = new Map(); // tabId -> Map(pageKey(url) -> resource)
  let loaded = false;
  let persistTimer = null;

  function pageKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.search;
    } catch {
      return String(url || '');
    }
  }

  function setBadge(tabId) {
    const n = maps.get(tabId)?.size || 0;
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
      const p = chrome.action.setBadgeText({ tabId, text: n ? String(Math.min(n, 99)) : '' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* tab closed */
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPersist();
    }, 500);
  }

  async function flushPersist() {
    const doc = {};
    for (const [tabId, map] of maps) {
      if (map.size > 0) doc[tabId] = [...map.values()].slice(0, 200);
    }
    try {
      await chrome.storage.session.set({ dmqSniff: doc });
    } catch {
      /* session storage unavailable — degrade to memory-only */
    }
  }

  /** Restore the table after a service-worker restart (merge, never clobber). */
  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const got = await chrome.storage.session.get('dmqSniff');
      const doc = got && got.dmqSniff;
      if (!doc || typeof doc !== 'object') return;
      for (const [tabIdStr, entries] of Object.entries(doc)) {
        const tabId = Number(tabIdStr);
        if (!Number.isInteger(tabId) || !Array.isArray(entries)) continue;
        let map = maps.get(tabId);
        if (!map) {
          map = new Map();
          maps.set(tabId, map);
        }
        for (const e of entries) {
          if (!e || typeof e.url !== 'string') continue;
          const k = pageKey(e.url);
          if (!map.has(k)) map.set(k, e);
        }
      }
    } catch {
      /* ignore */
    }
  }
  void ensureLoaded();

  /** @returns {boolean} true when a new resource was recorded */
  function add(tabId, res) {
    if (!Number.isInteger(tabId) || tabId < 0) return false; // tab-less beacons are ignored
    const entry = { ...res, ownerPage: res.ownerPage || (res.pageUrl ? pageKey(res.pageUrl) : '') };
    let map = maps.get(tabId);
    if (!map) {
      map = new Map();
      maps.set(tabId, map);
    }
    const key = pageKey(entry.url);
    const prev = map.get(key);
    if (prev) {
      if (entry.size && !prev.size) prev.size = entry.size; // late Content-Length
      return false;
    }
    map.set(key, entry);
    setBadge(tabId);
    schedulePersist();
    return true;
  }

  /**
   * Drop entries captured on OTHER pages. Entries with an unknown owner
   * (added before the tab's page was known) are kept — full navigations are
   * handled by clear() instead, so nothing is wiped by accident.
   */
  async function pruneToPage(tabId, url) {
    await ensureLoaded();
    const map = maps.get(tabId);
    if (!map) return;
    const cur = pageKey(url);
    let changed = false;
    for (const [k, r] of map) {
      if (r.ownerPage && r.ownerPage !== cur) {
        map.delete(k);
        changed = true;
      }
    }
    if (changed) {
      setBadge(tabId);
      schedulePersist();
    }
  }

  async function clear(tabId) {
    await ensureLoaded();
    maps.delete(tabId);
    setBadge(tabId);
    schedulePersist();
  }

  async function getAll(tabId) {
    await ensureLoaded();
    const map = maps.get(tabId);
    return map ? [...map.values()] : [];
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (maps.delete(tabId)) schedulePersist();
  });

  root.DMQ = root.DMQ || {};
  root.DMQ.sniffer = { add, clear, getAll, pruneToPage, pageKey };
})(typeof self !== 'undefined' ? self : globalThis);
