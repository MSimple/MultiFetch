'use strict';

// MV3 service worker. Stateless by design: every event re-reads storage,
// acts, and exits. Retries and health checks run through chrome.alarms.
// All app traffic happens here (never in content scripts), so the tokens
// never touch a web page.

importScripts('lib/storage.js', 'lib/i18n.js', 'lib/client.js', 'lib/queue.js', 'lib/detect.js', 'lib/sniffer.js');

const t = (key, ...args) => DMQ.i18n.t(key, ...args);

const MENUS = { link: 'dmq-link', all: 'dmq-all', toggle: 'dmq-takeover' };

// Current page URL per tab. Sniffed resources are stamped with this (NOT with
// their own URL) so "prune other pages" can never wipe the whole list.
const tabPages = new Map();

function rememberTabUrl(tabId, url) {
  if (!Number.isInteger(tabId) || tabId < 0 || !url) return;
  const prev = tabPages.get(tabId);
  if (url === prev) return;
  tabPages.set(tabId, url);
  if (prev) void DMQ.sniffer.pruneToPage(tabId, url); // drop entries from the previous page
}

let settings = { ...DMQ.storage.DEFAULTS, categories: { ...DMQ.storage.DEFAULTS.categories } };
let appOnline = false;
let appPaired = false;

async function refreshSettings() {
  try {
    settings = await DMQ.storage.getSettings();
  } catch {
    /* keep defaults */
  }
  DMQ.i18n.setLocale(DMQ.i18n.pick(settings.locale));
}

async function refreshHealth() {
  try {
    const st = await DMQ.client.checkStatus();
    appOnline = st.app;
    appPaired = st.paired;
  } catch {
    appOnline = false;
  }
}

void refreshSettings();
void refreshHealth();
void DMQ.client.ensurePaired(); // auto-pair quietly whenever the app is up
chrome.alarms.create('dmq-health', { periodInMinutes: 0.5 });
chrome.alarms.create('dmq-flush', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dmq-health') void refreshHealth();
  if (alarm.name === 'dmq-flush') void DMQ.queue.flush();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    // Locale/takeover may have changed: rebuild the menus with fresh labels.
    void refreshSettings().then(buildMenus);
  }
});

// ---- context menus ----
// onInstalled, the initial boot and every settings change can all fire in
// quick succession. removeAll() is async, so overlapping builds create the
// same ids while the previous batch still exists → "duplicate id" errors.
// Serialize every build on a promise chain, and always consume lastError.
let menuChain = Promise.resolve();
function buildMenus() {
  menuChain = menuChain
    .then(
      () =>
        new Promise((resolve) => {
          chrome.contextMenus.removeAll(() => {
            void chrome.runtime.lastError;
            const create = (opts) => chrome.contextMenus.create(opts, () => void chrome.runtime.lastError);
            create({ id: MENUS.link, title: t('menu.downloadLink'), contexts: ['link', 'video', 'audio', 'image'] });
            create({ id: MENUS.all, title: t('menu.sendPage'), contexts: ['page', 'action'] });
            create({
              id: MENUS.toggle,
              type: 'checkbox',
              checked: settings.takeover !== false,
              title: t('menu.takeover'),
              contexts: ['action'],
            });
            resolve();
          });
        })
    )
    .catch(() => {});
}

chrome.runtime.onInstalled.addListener(buildMenus);
void refreshSettings().then(buildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENUS.link) {
    const url = info.linkUrl || info.srcUrl;
    if (url) {
      void sendItems([
        {
          url,
          filename: DMQ.detect.filenameFromUrl(url),
          referer: tab && tab.url ? tab.url : undefined,
        },
      ]);
    }
  } else if (info.menuItemId === MENUS.all) {
    void (async () => {
      const items = tab && Number.isInteger(tab.id) ? await DMQ.sniffer.getAll(tab.id) : [];
      if (items.length === 0) {
        notify(t('ext.name'), t('notify.noResources'));
        return;
      }
      void sendItems(items.map((r) => ({ url: r.url, filename: r.filename, size: r.size, referer: r.ownerPage })));
    })();
  } else if (info.menuItemId === MENUS.toggle) {
    const next = info.checked === true;
    void DMQ.storage.setSettings({ takeover: next });
    notify(t('ext.name'), next ? t('notify.takeoverOn') : t('notify.takeoverOff'));
  }
});

// ---- header sniffing: catch media/files before anything is downloaded ----
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    try {
      if (details.type === 'main_frame') return;
      if (DMQ.detect.isIgnored(details.url, settings.ignore)) return;

      let mime = '';
      let size = null;
      let disposition = '';
      for (const h of details.responseHeaders || []) {
        const n = h.name.toLowerCase();
        if (n === 'content-type') mime = h.value || '';
        else if (n === 'content-length') size = Number.parseInt(h.value, 10);
        else if (n === 'content-disposition') disposition = h.value || '';
      }

      const verdict = DMQ.detect.sniffVerdict({ url: details.url, mime, size, disposition });
      if (!verdict.capture) return;

      DMQ.sniffer.add(details.tabId, {
        url: details.url,
        filename: DMQ.detect.filenameFromDisposition(disposition) || DMQ.detect.filenameFromUrl(details.url),
        mime,
        size: Number.isFinite(size) ? size : null,
        tag: verdict.tag,
        category: verdict.category || null, // stable key; the popup localizes it
        referer: details.initiator || '',
        pageUrl: tabPages.get(details.tabId) || '',
      });
    } catch {
      /* sniffing must never break browsing */
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ---- download takeover (IDM behaviour) ----
// Safety gate their implementation lacks: only take over while the app is
// paired AND reachable — otherwise the browser download would be cancelled
// with nowhere to go. When the app is down, the browser keeps the download.
chrome.downloads.onDeterminingFilename.addListener((item) => {
  try {
    if (!settings.takeover || !appOnline || !appPaired) return;
    const url = item.finalUrl || item.url;
    const ok = DMQ.detect.shouldIntercept(
      { url, filename: item.filename, mime: item.mime, size: item.fileSize, byExtensionId: item.byExtensionId },
      settings
    );
    if (!ok) return;

    const basename = String(item.filename || '').split(/[\\/]/).pop() || DMQ.detect.filenameFromUrl(url);
    // Promise form: a rejected cancel (the download already finished before we
    // could stop it → "Download must be in progress") is swallowed by .catch,
    // so it can never surface as Chrome's "Unchecked runtime.lastError".
    try {
      void chrome.downloads.cancel(item.id).catch(() => {});
    } catch {
      /* downloads API unavailable in this context */
    }
    try {
      void chrome.downloads.erase({ id: item.id }).catch(() => {});
    } catch {
      /* ignore */
    }
    void sendItems(
      [{ url, filename: basename, size: item.fileSize > 0 ? item.fileSize : undefined, referer: item.referrer || '' }],
      { quiet: true }
    );
  } catch {
    /* never break the browser's own download path */
  }
});

// ---- page lifecycle: a tab's resource list belongs to one page ----
chrome.webNavigation?.onCommitted?.addListener?.((d) => {
  if (d.frameId === 0 && Number.isInteger(d.tabId) && d.tabId >= 0) {
    if (d.url) tabPages.set(d.tabId, d.url); // know the page before its resources arrive
    void DMQ.sniffer.clear(d.tabId);
  }
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!tab) return;
  const url = change.url || tab.url;
  if (url && (change.url || change.status === 'loading' || change.status === 'complete')) {
    rememberTabUrl(tabId, url);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabPages.delete(tabId);
});

// ---- messaging (popup + content script) ----
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      if (!msg) return reply({ ok: false, error: 'empty' });

      if (msg.type === 'getResources') {
        // verify against the tab's LIVE url — the SW may have missed a navigation
        try {
          const t = await chrome.tabs.get(msg.tabId);
          if (t && t.url) rememberTabUrl(msg.tabId, t.url);
        } catch {
          /* tab gone */
        }
        const st = await DMQ.client.checkStatus();
        appOnline = st.app;
        appPaired = st.paired;
        reply({
          ok: true,
          resources: await DMQ.sniffer.getAll(msg.tabId),
          app: { online: st.app, paired: st.paired, port: st.port || null },
        });
        return;
      }

      if (msg.type === 'clear') {
        await DMQ.sniffer.clear(msg.tabId);
        reply({ ok: true });
        return;
      }

      if (msg.type === 'send-items' && Array.isArray(msg.items)) {
        const result = await sendItems(msg.items);
        reply({ ok: true, ...result });
        return;
      }

      if (msg.type === 'get-sniffed-for-tab') {
        const tabId = sender && sender.tab ? sender.tab.id : msg.tabId;
        reply({ ok: true, items: Number.isInteger(tabId) ? await DMQ.sniffer.getAll(tabId) : [] });
        return;
      }

      // Content scripts live in the page and cannot import lib/i18n.js, so the
      // SW hands them translated labels on request.
      if (msg.type === 'get-labels' && Array.isArray(msg.keys)) {
        const labels = {};
        for (const k of msg.keys.slice(0, 20)) labels[k] = DMQ.i18n.t(String(k));
        reply({ ok: true, locale: DMQ.i18n.current(), labels });
        return;
      }

      reply({ ok: false, error: 'unknown-message' });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async reply
});

// ---- delivery ----
async function deliver(item) {
  const payload = {
    url: item.url,
    filename: item.filename || undefined,
    size: Number.isFinite(item.size) ? item.size : undefined,
    referer: item.referer || undefined,
  };
  let r = await DMQ.client.sendItem(payload);
  if (r.state === 'unauthorized' || r.state === 'forbidden') {
    // token rotated or origin re-pinned: one automatic re-pair, then retry
    const repaired = await DMQ.client.ensurePaired({ force: true });
    if (repaired.ok) r = await DMQ.client.sendItem(payload);
  }
  return r;
}

async function sendItems(items, { quiet = false } = {}) {
  const results = { sent: 0, queued: 0, failed: 0 };
  for (const item of items) {
    const r = await deliver(item);
    if (r.state === 'ok') {
      results.sent++;
      await DMQ.storage.pushRecent({ url: item.url, at: Date.now(), status: r.data.status });
    } else if (r.state === 'unauthorized' || r.state === 'forbidden') {
      results.failed++;
      notify(t('notify.unpaired.title'), t('notify.unpaired.body'));
      return results;
    } else {
      results.queued++;
      await DMQ.queue.enqueue({ url: item.url, filename: item.filename, size: item.size, referer: item.referer });
    }
  }
  if (results.queued > 0) {
    // launch the app once; the retry queue delivers everything afterwards
    await DMQ.client.launchApp();
    notify(t('notify.offline.title'), t('notify.offline.body', results.queued));
  } else if (!quiet && results.sent > 0) {
    notify(t('notify.sent.title'), items.length === 1 ? items[0].filename || items[0].url : t('notify.sent.many', items.length));
  }
  return results;
}

function notify(title, message) {
  try {
    chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message });
  } catch {
    /* notifications unavailable */
  }
}
