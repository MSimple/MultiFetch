'use strict';

(async () => {
  const $ = (id) => document.getElementById(id);

  await DMQ.i18n.init();
  DMQ.i18n.fill(document);
  const t = DMQ.i18n.t;

  const CATS = ['video', 'audio', 'archive', 'program', 'document', 'model'];
  let localeValue = 'auto';

  function buildCatBoxes(selected) {
    const box = $('cats');
    box.textContent = '';
    for (const key of CATS) {
      const on = selected[key] !== false;
      const lab = document.createElement('label');
      lab.className = 'cat-chip' + (on ? ' on' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.cat = key;
      cb.checked = on;
      cb.addEventListener('change', () => lab.classList.toggle('on', cb.checked));
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(t('cat.' + key)));
      box.appendChild(lab);
    }
  }

  function buildLocaleSelect(current) {
    const root = $('locale');
    root.textContent = '';
    root.classList.add('sel');
    const opts = [
      { value: 'auto', label: t('options.locale.auto') },
      { value: 'zh-CN', label: '中文' },
      { value: 'en', label: 'English' },
    ];
    localeValue = current || 'auto';

    const label = document.createElement('span');
    label.className = 'sel-label';
    const caret = document.createElement('span');
    caret.className = 'sel-caret';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sel-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(label);
    btn.appendChild(caret);
    const list = document.createElement('div');
    list.className = 'sel-list';
    list.setAttribute('role', 'listbox');
    root.appendChild(btn);
    root.appendChild(list);

    const syncLabel = () => {
      const cur = opts.find((o) => o.value === localeValue);
      label.textContent = cur ? cur.label : '';
    };
    const renderList = () => {
      list.textContent = '';
      for (const o of opts) {
        const d = document.createElement('div');
        d.className = 'sel-opt' + (o.value === localeValue ? ' is-selected' : '');
        d.setAttribute('role', 'option');
        d.setAttribute('aria-selected', String(o.value === localeValue));
        d.textContent = o.label;
        d.addEventListener('click', () => {
          localeValue = o.value;
          syncLabel();
          close();
        });
        list.appendChild(d);
      }
    };
    let open = false;
    let elevated = null;
    const docDown = (e) => {
      if (!root.contains(e.target)) close();
    };
    function openMenu() {
      if (open) return;
      open = true;
      root.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      elevated = root.closest('.card');
      if (elevated) elevated.classList.add('is-elevated');
      renderList();
      document.addEventListener('mousedown', docDown, true);
    }
    function close() {
      if (!open) return;
      open = false;
      root.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (elevated) {
        elevated.classList.remove('is-elevated');
        elevated = null;
      }
      document.removeEventListener('mousedown', docDown, true);
    }
    btn.addEventListener('click', () => (open ? close() : openMenu()));
    syncLabel();
  }

  async function load() {
    const s = await DMQ.storage.getSettings();
    $('port').min = String(DMQ.client.PORT_START);
    $('port').max = String(DMQ.client.PORT_END);
    $('port-hint').textContent = t('options.pair.portHint', DMQ.client.PORT_START, DMQ.client.PORT_END);
    $('port').value = String(s.port);
    $('token').value = s.token || '';
    $('takeover').checked = s.takeover !== false;
    buildCatBoxes(s.categories || {});
    buildLocaleSelect(s.locale || 'auto');
    $('custom-ext').value = Array.isArray(s.customExt) ? s.customExt.join(', ') : '';
    $('min-size').value = String(s.minSize || 0);
    $('ignore').value = (s.ignore || []).join('\n');

    const st = await DMQ.client.checkStatus();
    $('pair-status').textContent = st.app
      ? t('options.status.online', st.port) +
        (st.paired ? t('options.status.pairedSuffix') : t('options.status.unpairedSuffix'))
      : t('options.status.offline');
  }

  $('auto-connect').addEventListener('click', async () => {
    $('auto-connect').disabled = true;
    const r = await DMQ.client.ensurePaired({ force: true });
    $('auto-connect').disabled = false;
    $('pair-status').textContent = r.ok
      ? t('options.connected', r.port)
      : r.error === 'app_offline'
        ? t('options.status.offline')
        : r.error === 'ORIGIN_BLOCKED'
          ? t('options.revoked')
          : r.error === 'AUTO_PAIR_DISABLED'
            ? t('options.autopairDisabled')
            : t('options.connectFailed', r.error);
    if (r.ok) await load();
  });

  $('pair').addEventListener('click', async () => {
    const code = $('code').value.trim();
    if (!/^\d{6}$/.test(code)) {
      $('pair-status').textContent = t('options.needCode');
      return;
    }
    $('pair').disabled = true;
    const r = await DMQ.client.pair(code);
    $('pair').disabled = false;
    if (r.ok) {
      $('pair-status').textContent = t('options.paired', r.port);
      $('code').value = '';
      await load();
    } else {
      $('pair-status').textContent =
        r.error === 'app_offline'
          ? t('options.status.offline')
          : r.error === 'BAD_PAIRING_CODE'
            ? t('options.badCode')
            : t('options.pairFailed', r.error);
    }
  });

  function flashSaved() {
    $('save-status').textContent = t('options.saved');
    setTimeout(() => {
      $('save-status').textContent = '';
    }, 2000);
  }

  $('save').addEventListener('click', async () => {
    const categories = {};
    document.querySelectorAll('#cats input[data-cat]').forEach((cb) => {
      categories[cb.dataset.cat] = cb.checked;
    });
    const customExt = $('custom-ext')
      .value.split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean)
      .slice(0, 100);
    const ignore = $('ignore')
      .value.split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 100);
    const locale = localeValue;
    await DMQ.storage.setSettings({
      port: Number($('port').value) || DMQ.client.PORT_START,
      token: $('token').value.trim(),
      takeover: $('takeover').checked,
      categories,
      customExt,
      minSize: Math.max(0, Number($('min-size').value) || 0),
      ignore,
      locale,
    });
    DMQ.i18n.setLocale(DMQ.i18n.pick(locale)); // applies immediately
    DMQ.i18n.fill(document);
    await load();
    flashSaved();
  });

  $('restore').addEventListener('click', async () => {
    if (!window.confirm(t('options.restoreConfirm'))) return;
    const d = DMQ.storage.DEFAULTS;
    await DMQ.storage.setSettings({
      takeover: d.takeover,
      categories: { ...d.categories },
      customExt: [],
      minSize: d.minSize,
      ignore: [],
      locale: 'auto',
    });
    DMQ.i18n.setLocale(DMQ.i18n.pick('auto'));
    DMQ.i18n.fill(document);
    await load();
    flashSaved();
  });

  document.title = t('options.title');
  await load();
})();
