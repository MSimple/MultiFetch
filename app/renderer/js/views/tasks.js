'use strict';

// Tasks view: add form, search/filter/sort toolbar, and the task list with
// per-status row actions and an expandable detail panel. Summaries come from
// main; rows are updated IN PLACE per id (keyed diff) so 4 Hz progress batches
// never rebuild the list, reset hover/focus, or disturb text selection.

(function () {
  const { el, clear } = window.DM.dom;
  const { t, errorText } = window.DM.i18n;
  const { icon } = window.DM.icons;
  const { button, iconButton, modal, toast, select } = window.DM.ui;
  const fmt = window.DM.format;

  const ACTIVE = ['queued', 'connecting', 'downloading'];
  const DOWNLOADING = ['connecting', 'downloading'];
  const RESUMABLE = ['paused', 'error', 'canceled'];
  const FILTERS = ['all', 'active', 'done', 'error'];
  const SORTS = ['order', 'name', 'size', 'progress'];
  const CATS = ['image', 'video', 'audio', 'program', 'archive', 'document', 'model'];

  let tasks = new Map(); // id -> summary (insertion order == default display order)
  const rowEls = new Map(); // id -> row entry (element refs)
  const selected = new Set(); // checked task ids
  let listEl = null;
  let emptyEl = null;
  let noMatchEl = null;
  let errorLine = null;
  let urlInput = null;
  let nameInput = null;
  let dirPath = null;
  let queuePill = null;
  let queueText = null;
  let searchInput = null;
  let filterBar = null;
  let catBar = null;
  let catItems = null;
  let sortSelect = null;
  let batchBar = null;
  let batchCount = null;
  let unsubscribeTasks = null;

  let query = '';
  let statusFilter = 'all';
  let catFilter = 'all';
  let sortKey = 'order';
  let lastOrderSig = '';

  function createRow(task) {
    const check = el('input', { type: 'checkbox', class: 'task-check', 'aria-label': t('action.select') });
    const dot = el('span', { class: 'dot' });
    const name = el('button', { class: 'task-name', type: 'button', title: '', 'aria-expanded': 'false' });
    const catTag = el('span', { class: 'cat-tag', hidden: 'hidden' });
    const size = el('span', { class: 'task-size' });
    const line1 = el('div', { class: 'task-line1' }, name, catTag, size);

    const chip = el('span', { class: 'chip' });
    const barFill = el('i', { class: 'bar-fill' });
    const bar = el('div', { class: 'bar' }, barFill);
    const pct = el('span', { class: 'task-pct' });
    const speed = el('span', { class: 'task-speed' });
    const line2 = el('div', { class: 'task-line2' }, chip, bar, pct, speed);

    const errLine = el('div', { class: 'task-error', hidden: 'hidden' });
    const main = el('div', { class: 'task-main' }, line1, line2, errLine);
    const actions = el('div', { class: 'task-actions' });
    const root = el('div', { class: 'task' }, check, dot, main, actions);
    const entry = {
      id: task.id,
      root,
      check,
      name,
      catTag,
      size,
      chip,
      barFill,
      pct,
      speed,
      errLine,
      actions,
      main,
      detail: null,
      detailLoaded: false,
      status: null,
      segSig: '',
      indeterminate: null,
      wired: false,
    };
    return entry;
  }

  function updateRow(task, entry) {
    const name = task.filename || task.url;
    if (entry.name.textContent !== name) {
      entry.name.textContent = name;
      entry.name.title = name;
    }
    if (!entry.wired) {
      entry.wired = true;
      entry.name.addEventListener('click', () => toggleDetail(entry));
      entry.check.addEventListener('change', () => {
        if (entry.check.checked) selected.add(entry.id);
        else selected.delete(entry.id);
        entry.root.classList.toggle('selected', entry.check.checked);
        updateBatchBar();
      });
    }
    entry.check.checked = selected.has(entry.id);
    entry.root.classList.toggle('selected', entry.check.checked);

    const cat = task.category || null;
    entry.catTag.hidden = !cat;
    if (cat) {
      const label = t('cat.' + cat);
      if (entry.catTag.textContent !== label) entry.catTag.textContent = label;
      if (entry.catTag.dataset.cat !== cat) entry.catTag.dataset.cat = cat;
    }

    const status = task.status || 'queued';
    if (status !== entry.status) {
      entry.status = status;
      entry.root.dataset.status = status;
      entry.chip.className = 'chip st-' + status;
      entry.chip.textContent = t('status.' + status);
      renderActions(entry.actions, task);
    }

    const errTitle = task.error && task.error.message ? String(task.error.message) : '';
    if (entry.chip.title !== errTitle) entry.chip.title = errTitle;

    const errMsg = status === 'error' && task.error && task.error.message ? String(task.error.message) : '';
    entry.errLine.hidden = !errMsg;
    if (errMsg && entry.errLine.textContent !== errMsg) {
      entry.errLine.textContent = errMsg;
      entry.errLine.title = errMsg;
    }

    const sizeText = Number.isFinite(task.totalBytes)
      ? `${fmt.formatBytes(task.downloadedBytes)} / ${fmt.formatBytes(task.totalBytes)}`
      : task.downloadedBytes > 0
        ? fmt.formatBytes(task.downloadedBytes)
        : '—';
    if (entry.size.textContent !== sizeText) entry.size.textContent = sizeText;

    const indeterminate = DOWNLOADING.includes(status) && !Number.isFinite(task.totalBytes);
    if (indeterminate !== entry.indeterminate) {
      entry.indeterminate = indeterminate;
      entry.root.classList.toggle('indeterminate', indeterminate);
    }

    const pctNum = Math.round(Math.max(0, Math.min(1, task.progress || 0)) * 100);
    const fillW = (status === 'done' ? 100 : pctNum) + '%';
    if (entry.barFill.style.width !== fillW) entry.barFill.style.width = fillW;
    const pctText = status === 'done' ? '100%' : pctNum + '%';
    if (entry.pct.textContent !== pctText) entry.pct.textContent = pctText;

    updateSegments(task, entry, status);
    updateSpeed(task, entry, status);
  }

  function updateSegments(task, entry, status) {
    const segs = Array.isArray(task.segments) ? task.segments : [];
    // Keep the per-segment bars visible for every multi-segment task (paused,
    // errored and finished included) so the thread breakdown stays readable.
    const show = segs.length > 1;
    if (!show) {
      if (entry.strip) {
        entry.strip.remove();
        entry.strip = null;
        entry.segSig = '';
      }
      return;
    }
    let sig = status;
    for (const s of segs) {
      const len = s.end != null ? s.end - s.start + 1 : null;
      const done = Math.min(s.done || 0, len != null ? len : s.done || 0);
      const p = len ? Math.max(0, Math.min(1, done / len)) : s.state === 'done' ? 1 : 0;
      sig += `|${s.state || 'pending'}:${Math.round(p * 100)}`;
    }
    if (sig === entry.segSig) return;
    entry.segSig = sig;

    if (!entry.strip) {
      entry.strip = el('div', { class: 'seg-strip' });
      entry.main.appendChild(entry.strip);
    }
    clear(entry.strip);
    for (const s of segs) {
      const len = s.end != null ? s.end - s.start + 1 : null;
      const done = Math.min(s.done || 0, len != null ? len : s.done || 0);
      const p = len ? Math.max(0, Math.min(1, done / len)) : s.state === 'done' ? 1 : 0;
      const inner = el('i');
      inner.style.width = Math.round(p * 100) + '%';
      entry.strip.appendChild(
        el(
          'span',
          {
            class: `seg ${s.state || 'pending'}`,
            title: t(
              'tasks.seg.title',
              s.i + 1,
              fmt.formatBytes(s.start),
              fmt.formatBytes(done),
              len != null ? fmt.formatBytes(len) : '?'
            ),
          },
          inner
        )
      );
    }
  }

  function updateSpeed(task, entry, status) {
    if (status === 'downloading' && task.speedBps > 0) {
      let text = `${fmt.formatBytes(task.speedBps)}/s`;
      if (Number.isFinite(task.totalBytes) && task.totalBytes > 0) {
        const remain = Math.max(0, task.totalBytes - (task.downloadedBytes || 0));
        text += ` · ${t('tasks.eta', fmt.formatEta(remain / task.speedBps))}`;
      }
      if (entry.speed.textContent !== text) entry.speed.textContent = text;
      entry.speed.hidden = false;
    } else {
      entry.speed.hidden = true;
    }
  }

  function renderActions(cell, task) {
    const status = task.status || 'queued';
    clear(cell);
    if (ACTIVE.includes(status)) {
      cell.appendChild(iconButton({ iconName: 'pause', label: t('action.pause'), onClick: () => window.dm.tasks.pause(task.id) }));
      cell.appendChild(iconButton({ iconName: 'cancel', label: t('action.cancel'), danger: true, onClick: () => window.dm.tasks.cancel(task.id) }));
    } else if (status === 'awaiting') {
      cell.appendChild(iconButton({ iconName: 'resume', label: t('action.start'), onClick: () => window.dm.tasks.resume(task.id) }));
      cell.appendChild(iconButton({ iconName: 'trash', label: t('action.remove'), danger: true, onClick: () => removeTask(task) }));
    } else if (RESUMABLE.includes(status)) {
      cell.appendChild(iconButton({ iconName: 'resume', label: t('action.resume'), onClick: () => window.dm.tasks.resume(task.id) }));
      cell.appendChild(iconButton({ iconName: 'trash', label: t('action.remove'), danger: true, onClick: () => removeTask(task) }));
    } else if (status === 'done') {
      cell.appendChild(iconButton({ iconName: 'open', label: t('action.open'), onClick: () => callOrShow(() => window.dm.tasks.openFile(task.id)) }));
      cell.appendChild(
        iconButton({ iconName: 'folder', label: t('action.openFolder'), onClick: () => callOrShow(() => window.dm.tasks.showInFolder(task.id)) })
      );
      cell.appendChild(iconButton({ iconName: 'trash', label: t('action.remove'), danger: true, onClick: () => removeTask(task) }));
    }
  }

  // ---- detail panel ----

  function copyValue(text) {
    return window.dm.app.copyText(text).then((r) => {
      if (r && r.ok !== false) toast(t('tasks.copied'), 'ok', 1400);
    });
  }

  function detailRow(label, value, copyable) {
    return el(
      'div',
      { class: 'detail-row' },
      el('span', { class: 'detail-label', text: label }),
      el('code', { class: 'detail-value', text: value, title: value }),
      copyable ? iconButton({ iconName: 'copy', label: t('action.copy'), onClick: () => copyValue(value) }) : null
    );
  }

  function renderDetail(entry, task) {
    const box = entry.detail;
    if (!box) return;
    clear(box);
    const full = entry.full || null;
    const url = (full && full.url) || task.url;
    box.appendChild(detailRow(t('tasks.detail.url'), url, true));
    const dir = (full && full.dir) || task.dir;
    if (dir) box.appendChild(detailRow(t('tasks.detail.dir'), dir, true));
    if (full && full.filePath) box.appendChild(detailRow(t('tasks.detail.file'), full.filePath, true));
    const err = task.error && task.error.message ? String(task.error.message) : '';
    if (err) {
      box.appendChild(
        el(
          'div',
          { class: 'detail-row is-error' },
          el('span', { class: 'detail-label', text: t('tasks.detail.error') }),
          el('span', { class: 'detail-value', text: err, title: err })
        )
      );
    }
  }

  async function toggleDetail(entry) {
    if (!entry.detail) {
      entry.detail = el('div', { class: 'task-detail', hidden: 'hidden' });
      entry.main.appendChild(entry.detail);
    }
    const show = entry.detail.hidden;
    entry.detail.hidden = !show;
    entry.name.setAttribute('aria-expanded', String(show));
    if (!show) return;
    const task = tasks.get(entry.id);
    if (task) renderDetail(entry, task);
    if (!entry.detailLoaded) {
      entry.detailLoaded = true;
      const r = await window.dm.tasks.get(entry.id);
      if (r && r.ok) {
        entry.full = r.data;
        if (!entry.detail.hidden) renderDetail(entry, tasks.get(entry.id) || {});
      }
    }
  }

  // ---- list reconciliation (filter + sort + keyed in-place update) ----

  function matches(task) {
    if (query) {
      const hay = `${task.filename || ''} ${task.url || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (statusFilter === 'active') {
      if (!ACTIVE.includes(task.status)) return false;
    } else if (statusFilter === 'done') {
      if (task.status !== 'done') return false;
    } else if (statusFilter === 'error') {
      if (task.status !== 'error') return false;
    }
    if (catFilter === 'other') {
      if (task.category) return false;
    } else if (catFilter !== 'all' && task.category !== catFilter) {
      return false;
    }
    return true;
  }

  function ordered(list) {
    if (sortKey === 'name') {
      return [...list].sort((a, b) => (a.filename || a.url || '').localeCompare(b.filename || b.url || ''));
    }
    if (sortKey === 'size') return [...list].sort((a, b) => (b.totalBytes || 0) - (a.totalBytes || 0));
    if (sortKey === 'progress') return [...list].sort((a, b) => (b.progress || 0) - (a.progress || 0));
    return list;
  }

  function syncRows() {
    emptyEl.hidden = tasks.size > 0;
    for (const task of tasks.values()) {
      let entry = rowEls.get(task.id);
      if (!entry) {
        entry = createRow(task);
        rowEls.set(task.id, entry);
        listEl.appendChild(entry.root);
      }
      updateRow(task, entry);
    }
    for (const [id, entry] of [...rowEls]) {
      if (!tasks.has(id)) {
        entry.root.remove();
        rowEls.delete(id);
        selected.delete(id);
      }
    }

    const visible = ordered([...tasks.values()].filter(matches));
    noMatchEl.hidden = !(tasks.size > 0 && visible.length === 0);
    const visSet = new Set(visible.map((t2) => t2.id));
    for (const [id, entry] of rowEls) entry.root.hidden = !visSet.has(id);

    const sig = visible.map((t2) => t2.id).join(',');
    if (sig !== lastOrderSig) {
      lastOrderSig = sig;
      for (const task of visible) listEl.appendChild(rowEls.get(task.id).root);
    }
    updateBatchBar();
    updateCatCounts();
  }

  function buildCatBar() {
    catItems = [];
    const bar = el('div', { class: 'cat-bar', role: 'tablist', 'aria-label': t('tasks.cat.title') });
    bar.appendChild(el('div', { class: 'cat-head', text: t('tasks.cat.title') }));
    const defs = [
      { key: 'all', label: t('tasks.filter.all') },
      ...CATS.map((c) => ({ key: c, label: t('cat.' + c) })),
      { key: 'other', label: t('cat.other') },
    ];
    for (const def of defs) {
      const count = el('span', { class: 'cat-count', text: '0' });
      const item = el(
        'button',
        {
          type: 'button',
          class: 'cat-item' + (def.key === catFilter ? ' is-active' : ''),
          'data-cat': def.key,
          'aria-pressed': String(def.key === catFilter),
          onclick: () => {
            catFilter = def.key;
            for (const it of catItems) {
              it.el.classList.toggle('is-active', it.key === catFilter);
              it.el.setAttribute('aria-pressed', String(it.key === catFilter));
            }
            syncRows();
          },
        },
        el('span', { class: 'cat-name', text: def.label }),
        count
      );
      catItems.push({ key: def.key, el: item, count });
      bar.appendChild(item);
    }
    return bar;
  }

  function updateCatCounts() {
    if (!catItems) return;
    const counts = { other: 0 };
    for (const c of CATS) counts[c] = 0;
    for (const task of tasks.values()) counts[task.category || 'other']++;
    for (const it of catItems) {
      const n = it.key === 'all' ? tasks.size : counts[it.key] || 0;
      const text = String(n);
      if (it.count.textContent !== text) it.count.textContent = text;
      it.el.classList.toggle('is-empty', n === 0 && it.key !== 'all');
    }
  }

  function updateBatchBar() {
    if (!batchBar) return;
    const n = selected.size;
    batchBar.hidden = n === 0;
    if (n > 0) batchCount.textContent = t('tasks.selected', n);
  }

  function clearSelection() {
    selected.clear();
    for (const entry of rowEls.values()) {
      entry.check.checked = false;
      entry.root.classList.remove('selected');
    }
    updateBatchBar();
  }

  async function batchAct(fn) {
    for (const id of [...selected]) await fn(id);
  }

  async function batchRemove() {
    const ok = await confirmDialog({
      title: t('dialog.remove.title'),
      body: t('dialog.batchRemove.body', selected.size),
      confirmLabel: t('dialog.remove.confirm'),
      danger: true,
    });
    if (!ok) return;
    const ids = [...selected];
    for (const id of ids) await window.dm.tasks.remove(id, false);
    selected.clear();
    await refresh();
  }

  function showError(err) {
    if (!err) {
      errorLine.textContent = '';
      errorLine.title = '';
      return;
    }
    errorLine.textContent = errorText(err);
    errorLine.title = err && typeof err === 'object' && err.message ? String(err.message) : '';
  }

  async function callOrShow(fn) {
    const r = await fn();
    if (!r.ok) showError(r.error);
    return r;
  }

  // ---- dialogs ----

  function confirmDialog({ title, body, confirmLabel, danger }) {
    return new Promise((resolve) => {
      let result = false;
      const confirmBtn = el('button', {
        class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
        type: 'button',
        text: confirmLabel,
        onclick: () => {
          result = true;
          m.close();
        },
      });
      const cancelBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: t('dialog.cancel'), onclick: () => m.close() });
      const box = el(
        'div',
        { class: 'modal' },
        el('h3', { text: title }),
        el('p', { class: 'dialog-msg', text: body }),
        el('div', { class: 'modal-actions' }, cancelBtn, confirmBtn)
      );
      const m = modal(box, { initialFocus: confirmBtn, onClose: () => resolve(result) });
    });
  }

  function openRemoveDialog(task) {
    return new Promise((resolve) => {
      const name = task.filename || task.url;
      let deleteFile = false;
      let choice = null;
      const fileLine =
        task.status === 'done'
          ? el(
              'label',
              { class: 'checkbox-row' },
              el('input', { type: 'checkbox', onchange: (ev) => (deleteFile = ev.target.checked) }),
              el('span', { text: t('dialog.remove.deleteFile') })
            )
          : null;
      const confirmBtn = el('button', {
        class: 'btn btn-danger',
        type: 'button',
        text: t('dialog.remove.confirm'),
        onclick: () => {
          choice = { deleteFile };
          m.close();
        },
      });
      const cancelBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: t('dialog.cancel'), onclick: () => m.close() });
      const box = el(
        'div',
        { class: 'modal' },
        el('h3', { text: t('dialog.remove.title') }),
        el('p', { class: 'dialog-msg', text: t('dialog.remove.body', name) }),
        fileLine,
        el('div', { class: 'modal-actions' }, cancelBtn, confirmBtn)
      );
      const m = modal(box, { initialFocus: confirmBtn, onClose: () => resolve(choice) });
    });
  }

  async function removeTask(task) {
    const choice = await openRemoveDialog(task);
    if (!choice) return;
    await callOrShow(() => window.dm.tasks.remove(task.id, choice.deleteFile));
    await refresh();
  }

  async function clearFinished() {
    const ok = await confirmDialog({
      title: t('dialog.clear.title'),
      body: t('dialog.clear.body'),
      confirmLabel: t('dialog.clear.confirm'),
      danger: true,
    });
    if (!ok) return;
    await window.dm.tasks.clearFinished();
    await refresh();
  }

  // ---- data ----

  async function refreshQueueLine() {
    const r = await window.dm.queue.getState();
    if (r.ok) {
      const active = r.data.active;
      const queued = r.data.queued;
      queueText.textContent = t('queue.line', active, queued);
      queuePill.classList.toggle('idle', active + queued === 0);
    }
  }

  async function refresh() {
    const r = await window.dm.tasks.list();
    if (!r.ok) {
      showError(r.error);
      return;
    }
    tasks = new Map(r.data.map((s) => [s.id, s]));
    syncRows();
    refreshQueueLine();
  }

  function onUpdates(updates) {
    if (!Array.isArray(updates)) return;
    for (const u of updates) {
      if (!u || !u.id) continue;
      const prev = tasks.get(u.id) || {};
      tasks.set(u.id, { ...prev, ...u });
    }
    syncRows();
    refreshQueueLine();
  }

  async function submitAdd() {
    const url = urlInput.value.trim();
    if (!url) return;
    const filename = nameInput.value.trim();
    showError(null);
    const r = await window.dm.tasks.add({ url, filename: filename || undefined });
    if (!r.ok) {
      showError(r.error);
      return;
    }
    urlInput.value = '';
    nameInput.value = '';
    await refresh();
  }

  async function loadDefaultDir() {
    const r = await window.dm.settings.get();
    if (r.ok && dirPath) {
      dirPath.textContent = r.data.defaultDir || '';
      dirPath.title = r.data.defaultDir || '';
    }
  }

  function buildListTools() {
    searchInput = el('input', {
      type: 'search',
      class: 'input search',
      placeholder: t('tasks.search.placeholder'),
      'aria-label': t('tasks.search.placeholder'),
      oninput: (e) => {
        query = e.target.value.trim().toLowerCase();
        syncRows();
      },
    });

    filterBar = el('div', { class: 'filter-chips', role: 'group' });
    for (const key of FILTERS) {
      const b = el('button', {
        type: 'button',
        class: 'fchip' + (key === statusFilter ? ' is-active' : ''),
        text: t('tasks.filter.' + key),
        'data-filter': key,
        onclick: () => {
          statusFilter = key;
          for (const n of filterBar.children) n.classList.toggle('is-active', n.dataset.filter === key);
          syncRows();
        },
      });
      filterBar.appendChild(b);
    }

    sortSelect = select({
      className: 'sort',
      options: SORTS.map((key) => ({ value: key, label: t('tasks.sort.' + key) })),
      value: sortKey,
      onChange: (v) => {
        sortKey = v;
        lastOrderSig = '';
        syncRows();
      },
    });

    return el('div', { class: 'list-tools' }, searchInput, el('span', { class: 'spacer' }), filterBar, sortSelect.el);
  }

  function mount(root) {
    urlInput = el('input', { type: 'text', class: 'input input-lg', id: 'add-url', placeholder: t('tasks.add.urlPlaceholder') });
    nameInput = el('input', { type: 'text', class: 'input', id: 'add-name', placeholder: t('tasks.add.filename') });
    dirPath = el('span', { class: 'dir-path', text: '…' });
    errorLine = el('div', { class: 'error-line', role: 'alert' });

    const dirChip = el(
      'button',
      {
        type: 'button',
        class: 'dir-chip',
        title: t('action.copy'),
        onclick: async () => {
          const v = dirPath.textContent;
          if (!v || v === '…') return;
          const r = await window.dm.app.copyText(v);
          if (r && r.ok !== false) toast(t('tasks.copied'), 'ok', 1400);
        },
      },
      icon('folder', 14),
      dirPath
    );

    const submit = button({ label: t('tasks.add.submit'), iconName: 'download', variant: 'primary', onClick: submitAdd });

    const form = el(
      'div',
      { class: 'card add-card' },
      el('div', { class: 'add-main' }, el('span', { class: 'add-glyph' }, icon('link', 18)), urlInput, submit),
      el('div', { class: 'add-sub' }, nameInput, dirChip),
      errorLine
    );

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdd();
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAdd();
    });

    form.addEventListener('dragover', (e) => {
      e.preventDefault();
      form.classList.add('dragover');
    });
    form.addEventListener('dragleave', (e) => {
      if (!form.contains(e.relatedTarget)) form.classList.remove('dragover');
    });
    form.addEventListener('drop', async (e) => {
      e.preventDefault();
      form.classList.remove('dragover');
      const dt = e.dataTransfer;
      const text = `${dt.getData('text/uri-list') || ''}\n${dt.getData('text/plain') || ''}`;
      const urls = text
        .split(/\s+/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s));
      if (urls.length === 0) {
        showError({ code: 'BAD_URL', message: '' });
        return;
      }
      showError(null);
      for (const u of urls) await window.dm.tasks.add({ url: u });
      await refresh();
    });

    queueText = el('span', { text: '' });
    queuePill = el('div', { class: 'queue-pill idle' }, el('span', { class: 'pulse' }), queueText);

    const toolbarActions = el(
      'div',
      { class: 'toolbar-actions' },
      button({ label: t('action.pauseAll'), variant: 'soft', size: 'sm', iconName: 'pause', onClick: () => window.dm.tasks.pauseAll() }),
      button({ label: t('action.resumeAll'), variant: 'soft', size: 'sm', iconName: 'resume', onClick: () => window.dm.tasks.resumeAll() }),
      button({
        label: t('action.clearFinished'),
        variant: 'soft',
        size: 'sm',
        iconName: 'trash',
        onClick: clearFinished,
      })
    );

    const toolbar = el('div', { class: 'toolbar' }, queuePill, el('span', { class: 'spacer' }), toolbarActions);

    batchCount = el('span', { class: 'batch-count' });
    batchBar = el(
      'div',
      { class: 'batch-bar', hidden: 'hidden' },
      batchCount,
      el('span', { class: 'spacer' }),
      button({ label: t('action.batchResume'), size: 'sm', variant: 'soft', iconName: 'resume', onClick: () => batchAct((id) => window.dm.tasks.resume(id)) }),
      button({ label: t('action.batchPause'), size: 'sm', variant: 'soft', iconName: 'pause', onClick: () => batchAct((id) => window.dm.tasks.pause(id)) }),
      button({ label: t('action.batchRemove'), size: 'sm', variant: 'danger', iconName: 'trash', onClick: batchRemove }),
      button({ label: t('action.clearSelection'), size: 'sm', variant: 'ghost', onClick: clearSelection })
    );

    emptyEl = el(
      'div',
      { class: 'empty' },
      el('div', { class: 'empty-art' }, icon('download', 30)),
      el('div', { class: 'empty-title', text: t('tasks.empty') }),
      el('div', { class: 'empty-sub', text: t('tasks.emptyHint') })
    );
    noMatchEl = el('div', { class: 'empty', hidden: 'hidden' }, el('div', { class: 'empty-title', text: t('tasks.noMatch') }));
    listEl = el('div', { class: 'task-list' });
    lastOrderSig = '';

    catBar = buildCatBar();
    const listMain = el('div', { class: 'list-main' }, emptyEl, noMatchEl, listEl);
    const split = el('div', { class: 'list-split' }, catBar, listMain);

    clear(root);
    root.appendChild(form);
    root.appendChild(el('div', { class: 'card' }, toolbar, batchBar, buildListTools(), split));

    if (unsubscribeTasks) unsubscribeTasks();
    unsubscribeTasks = window.dm.events.onTasks(onUpdates);
    loadDefaultDir();
    refresh();
  }

  window.DM.views = window.DM.views || {};
  window.DM.views.tasks = { mount, refresh, loadDefaultDir };
})();
