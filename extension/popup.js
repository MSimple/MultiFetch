'use strict';

(async () => {
  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const statusPill = $('status');
  const statusText = $('status-text');
  const selAllBtn = $('selAll');
  const selection = new Map(); // url -> boolean
  let resources = [];
  let tabId = null;
  let lastSig = null;
  let autoTried = false;

  const CATS = ['image', 'video', 'audio', 'program', 'archive', 'document', 'model', 'file'];
  const SORTS = ['order', 'name', 'size', 'type'];
  let query = '';
  let catFilter = 'all';
  let sortKey = 'order';

  await DMQ.i18n.init();
  DMQ.i18n.fill(document);
  const t = DMQ.i18n.t;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && Number.isInteger(tab.id) ? tab.id : null;

  // ---- tools ----

  const searchInput = $('search');
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase();
    buildCatOptions();
    draw();
  });

  let catSelect = null;

  function catCounts() {
    const counts = { all: 0 };
    for (const c of CATS) counts[c] = 0;
    for (const r of resources) {
      if (query) {
        const hay = `${r.filename || ''} ${r.url || ''}`.toLowerCase();
        if (!hay.includes(query)) continue;
      }
      counts.all++;
      counts[catKey(r)] = (counts[catKey(r)] || 0) + 1;
    }
    return counts;
  }

  function buildCatOptions() {
    const counts = catCounts();
    const options = [{ value: 'all', label: t('popup.filter.all'), count: counts.all }];
    for (const c of CATS) options.push({ value: c, label: t('cat.' + c), count: counts[c] || 0 });
    if (catSelect) catSelect.setOptions(options, catFilter);
    return options;
  }

  catSelect = DMQ.select.makeSelect({
    el: $('cat-filter'),
    className: 'cat-filter',
    options: buildCatOptions(),
    value: catFilter,
    onChange: (v) => {
      catFilter = v;
      draw();
    },
  });

  DMQ.select.makeSelect({
    el: $('sort'),
    className: 'sort',
    options: SORTS.map((k) => ({ value: k, label: t('popup.sort.' + k) })),
    value: sortKey,
    onChange: (v) => {
      sortKey = v;
      draw();
    },
  });

  // ---- helpers ----

  function setStatus(kind, message) {
    statusPill.className = 'pill ' + kind;
    statusText.textContent = message;
  }

  function fmtSize(b) {
    if (!Number.isFinite(b) || b <= 0) return t('popup.unknownSize');
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = b;
    while (n >= 1024 && i < 3) {
      n /= 1024;
      i++;
    }
    return n.toFixed(i ? 1 : 0) + ' ' + u[i];
  }

  function isImage(r) {
    return r.category === 'image' || /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico|tiff?)(\?|#|$)/i.test(r.url || '');
  }

  function catKey(r) {
    return r.category || 'file';
  }

  function matches(r) {
    if (query) {
      const hay = `${r.filename || ''} ${r.url || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (catFilter === 'all') return true;
    return catKey(r) === catFilter;
  }

  function sorted(list) {
    const arr = [...list];
    if (sortKey === 'name') {
      arr.sort((a, b) => (a.filename || a.url || '').localeCompare(b.filename || b.url || ''));
    } else if (sortKey === 'size') {
      arr.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    } else if (sortKey === 'type') {
      arr.sort((a, b) => catKey(a).localeCompare(catKey(b)) || (a.filename || a.url || '').localeCompare(b.filename || b.url || ''));
    }
    return arr;
  }

  function view() {
    return sorted(resources.filter(matches));
  }

  function updateSelAll() {
    const vis = view();
    const allSelected = vis.length > 0 && vis.every((r) => selection.get(r.url));
    selAllBtn.textContent = allSelected ? t('popup.deselectAll') : t('popup.selectAll');
  }

  function draw() {
    listEl.textContent = '';
    if (resources.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = t('popup.empty');
      listEl.appendChild(empty);
      updateSelAll();
      return;
    }
    const items = view();
    if (items.length === 0) {
      const none = document.createElement('div');
      none.className = 'noMatch';
      none.textContent = t('popup.noMatch');
      listEl.appendChild(none);
      updateSelAll();
      return;
    }
    for (const r of items) listEl.appendChild(buildRow(r));
    updateSelAll();
  }

  function buildRow(r) {
    const row = document.createElement('label');
    row.className = 'item' + (selection.get(r.url) ? ' on' : '');

    if (isImage(r)) {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.addEventListener('error', () => {
        thumb.classList.add('fail');
        img.remove();
      });
      img.src = r.url;
      thumb.appendChild(img);
      row.appendChild(thumb);
    }

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'item-check';
    cb.checked = Boolean(selection.get(r.url));
    cb.addEventListener('change', () => {
      selection.set(r.url, cb.checked);
      row.classList.toggle('on', cb.checked);
      updateSelAll();
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const fn = document.createElement('div');
    fn.className = 'fn';
    fn.textContent = r.filename || r.url;
    fn.title = r.filename || '';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${fmtSize(r.size)} · ${r.url}`;
    sub.title = r.url;
    meta.appendChild(fn);
    meta.appendChild(sub);

    const tag = document.createElement('span');
    tag.className = 'tag' + (r.category ? ' cat-' + r.category : '');
    tag.textContent = r.category ? t('cat.' + r.category) : t('cat.file');

    row.appendChild(cb);
    row.appendChild(meta);
    row.appendChild(tag);
    return row;
  }

  function selectedItems() {
    return resources
      .filter((r) => selection.get(r.url))
      .map((r) => ({ url: r.url, filename: r.filename, size: r.size, referer: r.ownerPage }));
  }

  // ---- data ----

  function load() {
    if (tabId == null) return;
    chrome.runtime.sendMessage({ type: 'getResources', tabId }, (resp) => {
      void chrome.runtime.lastError;
      if (!resp || !resp.ok) return;
      const app = resp.app || {};
      if (!app.online) setStatus('off', t('popup.appOffline'));
      else if (app.paired) setStatus('on', t('popup.online', app.port));
      else setStatus('warn', t('popup.unpaired'));

      if (app.online && !app.paired && !autoTried) {
        autoTried = true;
        DMQ.client.ensurePaired().then((p) => {
          if (p.ok) load();
        });
      }

      const next = resp.resources || [];
      const nextSig = next.map((r) => r.url).join('|');
      if (nextSig === lastSig) return; // nothing new → keep the current UI state
      lastSig = nextSig;

      for (const r of next) if (!selection.has(r.url)) selection.set(r.url, true);
      const present = new Set(next.map((r) => r.url));
      for (const k of [...selection.keys()]) if (!present.has(k)) selection.delete(k);
      resources = next;
      buildCatOptions();
      draw();
    });
  }

  load();
  setInterval(load, 1500);

  $('send').addEventListener('click', () => {
    const items = selectedItems();
    if (items.length === 0) return;
    $('send').disabled = true;
    chrome.runtime.sendMessage({ type: 'send-items', items }, (resp) => {
      void chrome.runtime.lastError;
      $('send').disabled = false;
      const r = resp || {};
      const ok = r.sent > 0 || r.queued > 0;
      statusText.textContent =
        r.sent > 0 ? t('popup.sentCount', r.sent) : r.queued > 0 ? t('popup.queuedCount', r.queued) : t('popup.sendFailed');
      statusPill.className = 'pill ' + (r.sent > 0 ? 'on' : r.queued > 0 ? 'warn' : 'off');
      if (ok) setTimeout(() => window.close(), 800);
    });
  });

  selAllBtn.addEventListener('click', () => {
    const vis = view();
    const allSelected = vis.length > 0 && vis.every((r) => selection.get(r.url));
    for (const r of vis) selection.set(r.url, !allSelected);
    draw();
  });

  $('clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'clear', tabId }, () => {
      void chrome.runtime.lastError;
      resources = [];
      selection.clear();
      lastSig = null;
      draw();
    });
  });

  $('takeover').addEventListener('change', async () => {
    await DMQ.storage.setSettings({ takeover: $('takeover').checked });
  });
  DMQ.storage.getSettings().then((s) => {
    $('takeover').checked = s.takeover !== false;
  });

  $('open-options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
