'use strict';

// Typed chrome.storage wrappers. The MV3 service worker holds NO in-memory
// state across events — everything lives here.

(function (root) {
  const DEFAULTS = Object.freeze({
    locale: 'auto', // 'auto' follows the browser UI language; else 'zh-CN' | 'en'
    port: 8787,
    token: '', // capture token from pairing
    protocolToken: '', // lets the extension cold-launch the app (downloadmgr://open)
    takeover: true, // hand browser downloads to the app (only while it is reachable)
    categories: { video: true, audio: true, archive: true, program: true, document: true, model: true },
    customExt: [], // extra extensions to take over
    minSize: 0, // takeover size floor in MB (0 = no floor)
    ignore: [], // hostnames / URL substrings: never sniff, never take over
  });

  async function getSettings() {
    const got = await chrome.storage.local.get('settings');
    const merged = { ...DEFAULTS, ...(got.settings || {}) };
    merged.categories = { ...DEFAULTS.categories, ...((got.settings && got.settings.categories) || {}) };
    return merged;
  }

  async function setSettings(patch) {
    const next = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  async function getRecent() {
    const got = await chrome.storage.local.get('recent');
    return Array.isArray(got.recent) ? got.recent : [];
  }

  async function pushRecent(entry) {
    const list = await getRecent();
    list.unshift(entry);
    await chrome.storage.local.set({ recent: list.slice(0, 10) });
  }

  async function getQueue() {
    const got = await chrome.storage.local.get('queue');
    return Array.isArray(got.queue) ? got.queue : [];
  }

  async function setQueue(queue) {
    await chrome.storage.local.set({ queue: queue.slice(-50) });
  }

  /** 10s dedupe window, session-scoped so a browser restart clears it. */
  async function isDuplicate(key) {
    const got = await chrome.storage.session.get('seen');
    const seen = got.seen || {};
    const now = Date.now();
    for (const k of Object.keys(seen)) {
      if (now - seen[k] > 10_000) delete seen[k];
    }
    const dup = Boolean(seen[key]);
    seen[key] = now;
    await chrome.storage.session.set({ seen });
    return dup;
  }

  root.DMQ = root.DMQ || {};
  root.DMQ.storage = { getSettings, setSettings, getRecent, pushRecent, getQueue, setQueue, isDuplicate, DEFAULTS };
})(typeof self !== 'undefined' ? self : globalThis);
