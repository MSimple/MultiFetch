'use strict';

// Settings view: download defaults, tray/auto-launch/resume toggles, and the
// browser-capture panel (server status, tokens, pairing, paired extensions).
//
// Save model: switches apply immediately (with optimistic revert on failure);
// text/number fields apply on the sticky Save bar. The Save bar is always
// visible so nothing silently goes unsaved.

(function () {
  const { el, clear } = window.DM.dom;
  const { t, errorText } = window.DM.i18n;
  const { button, iconButton, toggle, row, section, toast, select } = window.DM.ui;

  let dirInput = null;
  let concurrentInput = null;
  let segmentsInput = null;
  let speedLimitInput = null;
  let concurrentMsg = null;
  let segmentsMsg = null;
  let speedMsg = null;
  let localeSelect = null;
  let autoLaunchBox = null;
  let closeToTrayBox = null;
  let autoResumeBox = null;
  let autoAddBox = null;
  let autoPairBox = null;
  let taskbarBox = null;

  let serverPill = null;
  let serverText = null;
  let tokenInput = null;
  let protocolTokenInput = null;
  let pairBtn = null;
  let pairingBox = null;
  let pairCodeEl = null;
  let pairExpiresEl = null;
  let pairedListEl = null;
  let pairingTimer = null;

  async function load() {
    const r = await window.dm.settings.get();
    if (!r.ok) return;
    const s = r.data;
    dirInput.value = s.defaultDir || '';
    concurrentInput.value = String(s.maxConcurrent || 3);
    segmentsInput.value = String(s.defaultConnections || 8);
    speedLimitInput.value = String(s.globalSpeedLimit ? Math.round(s.globalSpeedLimit / 1024) : 0);
    autoLaunchBox.input.checked = !!s.autoLaunch;
    closeToTrayBox.input.checked = s.closeToTray !== false;
    autoResumeBox.input.checked = !!s.autoResume;
    taskbarBox.input.checked = s.showProgressOnStart !== false;
    autoAddBox.input.checked = Boolean(s.capture && s.capture.autoAdd);
    autoPairBox.input.checked = !(s.capture && s.capture.autoPair === false);
    validateNumbers();

    const locales = await window.dm.i18n.getLocales();
    const list = locales.ok ? locales.data : ['zh-CN', 'en'];
    localeSelect.setOptions(list.map((loc) => ({ value: loc, label: loc })), s.locale || 'zh-CN');

    await loadCapture();
  }

  async function loadCapture() {
    if (pairingTimer) {
      clearInterval(pairingTimer);
      pairingTimer = null;
    }
    const info = await window.dm.capture.getServerInfo();
    if (info.ok) {
      const d = info.data;
      serverText.textContent = d.running ? t('settings.capture.running', d.port) : t('settings.capture.stopped');
      serverPill.classList.toggle('on', !!d.running);
    }
    const tok = await window.dm.capture.getToken();
    if (tok.ok) tokenInput.value = tok.data;
    const proto = await window.dm.capture.getProtocolToken();
    if (proto.ok) protocolTokenInput.value = proto.data;

    const allow = await window.dm.capture.getAllowlist();
    clear(pairedListEl);
    const origins = allow.ok ? allow.data : [];
    if (origins.length === 0) {
      pairedListEl.appendChild(el('span', { class: 'hint', text: t('settings.capture.none') }));
    } else {
      for (const origin of origins) {
        pairedListEl.appendChild(
          el(
            'div',
            { class: 'pair-row' },
            el('code', { class: 'origin', text: origin }),
            button({
              label: t('settings.capture.revoke'),
              variant: 'ghost',
              size: 'sm',
              onClick: async () => {
                await window.dm.capture.revokeOrigin(origin);
                await loadCapture();
              },
            })
          )
        );
      }
    }
    renderPairing(info.ok ? info.data.pairing : null);
  }

  function renderPairing(pairing) {
    if (pairingTimer) {
      clearInterval(pairingTimer);
      pairingTimer = null;
    }
    if (!pairing) {
      pairingBox.hidden = true;
      pairBtn.hidden = false;
      return;
    }
    pairBtn.hidden = true;
    pairingBox.hidden = false;
    pairCodeEl.textContent = String(pairing.code);
    const tick = () => {
      const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
      pairExpiresEl.textContent = t('settings.capture.expires', left);
      if (left <= 0) {
        clearInterval(pairingTimer);
        pairingTimer = null;
        loadCapture();
      }
    };
    tick();
    pairingTimer = setInterval(tick, 1000);
  }

  async function rotate(tokenFn) {
    await tokenFn();
    toast(t('settings.capture.rotated'), 'ok');
    await loadCapture();
  }

  /** Immediate-save switch: reverts the checked state if the patch is refused. */
  function switchFor(id, key, checked) {
    return toggle({
      id,
      checked,
      onChange: async (e) => {
        const value = e.target.checked;
        const r = await window.dm.settings.patch({ [key]: value });
        if (!r.ok) {
          toast(errorText(r.error), 'err');
          e.target.checked = !value;
        }
      },
    });
  }

  function numberField(input, msg, min, max) {
    input.addEventListener('input', () => validateOne(input, msg, min, max));
    return el('div', { class: 'num-field' }, input, msg);
  }

  function validateOne(input, msg, min, max) {
    const n = Number(input.value);
    const ok = Number.isInteger(n) && n >= min && n <= max;
    input.classList.toggle('invalid', !ok);
    input.setAttribute('aria-invalid', ok ? 'false' : 'true');
    msg.hidden = ok;
    msg.textContent = ok ? '' : t('settings.invalidRange', min, max);
    return ok;
  }

  function validateNumbers() {
    return [
      validateOne(concurrentInput, concurrentMsg, 1, 20),
      validateOne(segmentsInput, segmentsMsg, 1, 64),
      validateOne(speedLimitInput, speedMsg, 0, 1 << 20),
    ].every(Boolean);
  }

  async function save() {
    if (!validateNumbers()) {
      toast(t('settings.invalidRange', 1, 64), 'err');
      return;
    }
    const kb = Number(speedLimitInput.value) || 0;
    const patch = {
      defaultDir: dirInput.value.trim(),
      maxConcurrent: Number(concurrentInput.value),
      defaultConnections: Number(segmentsInput.value),
      globalSpeedLimit: kb > 0 ? kb * 1024 : null,
      locale: localeSelect.value,
    };
    const localeChanged = patch.locale !== window.DM.i18n.current();
    const r = await window.dm.settings.patch(patch);
    if (!r.ok) {
      toast(errorText(r.error), 'err');
      return;
    }
    await window.DM.views.tasks.loadDefaultDir();
    if (localeChanged && window.DM.app) {
      await window.DM.app.applyLocale(patch.locale);
    }
    toast(t('settings.saved'), 'ok');
  }

  async function resetDefaults() {
    if (!window.confirm(t('settings.resetConfirm'))) return;
    await window.dm.settings.reset();
    const s = await window.dm.settings.get();
    if (s.ok && window.DM.app) await window.DM.app.applyLocale(s.data.locale);
    toast(t('settings.resetDone'), 'ok');
    await load();
  }

  function mount(root) {
    dirInput = el('input', { type: 'text', class: 'input', id: 'set-dir' });
    concurrentInput = el('input', { type: 'number', class: 'input', id: 'set-concurrent', min: '1', max: '20' });
    segmentsInput = el('input', { type: 'number', class: 'input', id: 'set-segments', min: '1', max: '64' });
    speedLimitInput = el('input', { type: 'number', class: 'input', id: 'set-speedlimit', min: '0' });
    concurrentMsg = el('span', { class: 'num-msg', hidden: 'hidden' });
    segmentsMsg = el('span', { class: 'num-msg', hidden: 'hidden' });
    speedMsg = el('span', { class: 'num-msg', hidden: 'hidden' });
    localeSelect = select({ id: 'set-locale', className: 'settings-select', options: [], value: 'zh-CN' });
    autoLaunchBox = switchFor('set-autolaunch', 'autoLaunch', false);
    closeToTrayBox = switchFor('set-closetotray', 'closeToTray', true);
    autoResumeBox = switchFor('set-autoresume', 'autoResume', false);
    taskbarBox = switchFor('set-taskbar', 'showProgressOnStart', true);
    autoAddBox = captureSwitch('autoadd', 'autoAdd', false);
    autoPairBox = captureSwitch('autopair', 'autoPair', true);

    const chooseBtn = button({
      label: t('settings.choose'),
      variant: 'soft',
      onClick: async () => {
        const r = await window.dm.dialog.chooseDirectory();
        if (r.ok && r.data) dirInput.value = r.data;
      },
    });

    const downloadCard = section(t('settings.section.download'), [
      row({ label: t('settings.defaultDir'), wide: true, control: [dirInput, chooseBtn] }),
      row({ label: t('settings.maxConcurrent'), control: numberField(concurrentInput, concurrentMsg, 1, 20) }),
      row({ label: t('settings.defaultConnections'), control: numberField(segmentsInput, segmentsMsg, 1, 64) }),
      row({ label: t('settings.speedLimit'), control: numberField(speedLimitInput, speedMsg, 0, 1 << 20) }),
    ]);

    const generalCard = section(t('settings.section.general'), [
      row({ label: t('settings.locale'), control: localeSelect.el }),
      row({ label: t('settings.closeToTray'), control: closeToTrayBox }),
      row({ label: t('settings.autoResume'), control: autoResumeBox }),
      row({ label: t('settings.autoLaunch'), control: autoLaunchBox }),
      row({ label: t('settings.taskbarProgress'), control: taskbarBox }),
    ]);

    serverText = el('span', { text: '…' });
    serverPill = el('div', { class: 'status-pill' }, el('span', { class: 'live' }), serverText);
    tokenInput = el('input', { type: 'text', class: 'input token-input', id: 'set-token', readonly: 'readonly' });
    protocolTokenInput = el('input', { type: 'text', class: 'input token-input', id: 'set-protocol-token', readonly: 'readonly' });
    pairBtn = button({
      label: t('settings.capture.startPairing'),
      iconName: 'key',
      variant: 'soft',
      onClick: async () => {
        const r = await window.dm.capture.startPairing();
        if (r.ok) renderPairing(r.data);
        else toast(errorText(r.error), 'err');
      },
    });
    pairCodeEl = el('code', { class: 'pair-code', text: '' });
    pairExpiresEl = el('span', { class: 'pair-expires', text: '' });
    pairingBox = el(
      'div',
      { class: 'pairing-box', hidden: 'hidden' },
      el('span', { class: 'hint', text: t('settings.capture.code') }),
      pairCodeEl,
      pairExpiresEl,
      button({
        label: t('settings.capture.cancelPairing'),
        variant: 'ghost',
        size: 'sm',
        onClick: async () => {
          await window.dm.capture.cancelPairing();
          await loadCapture();
        },
      })
    );
    pairedListEl = el('div', { class: 'paired-list' });

    const captureCard = el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'card-head' },
        el('h2', { class: 'card-title', text: t('settings.capture.title') }),
        el('span', { class: 'spacer' }),
        serverPill
      ),
      el(
        'div',
        { class: 'section-rows' },
        row({ label: t('settings.capture.pairing'), desc: t('settings.capture.pairingHint'), control: [pairBtn, pairingBox] }),
        row({ label: t('settings.capture.autoAdd'), control: autoAddBox }),
        row({ label: t('settings.capture.autoPair'), control: autoPairBox }),
        row({
          label: t('settings.capture.token'),
          wide: true,
          control: [tokenInput, iconButton({ iconName: 'refresh', label: t('settings.capture.rotate'), onClick: () => rotate(() => window.dm.capture.rotateToken()) })],
        }),
        row({
          label: t('settings.capture.protocolToken'),
          wide: true,
          control: [protocolTokenInput, iconButton({ iconName: 'refresh', label: t('settings.capture.rotate'), onClick: () => rotate(() => window.dm.capture.rotateProtocolToken()) })],
        }),
        row({ label: t('settings.capture.pairedList'), column: true, control: pairedListEl })
      )
    );

    const actions = el(
      'div',
      { class: 'settings-actions' },
      button({ label: t('settings.reset'), iconName: 'refresh', variant: 'ghost', onClick: resetDefaults }),
      el('span', { class: 'spacer' }),
      button({ label: t('settings.save'), iconName: 'check', variant: 'primary', onClick: save })
    );

    clear(root);
    root.appendChild(downloadCard);
    root.appendChild(generalCard);
    root.appendChild(captureCard);
    root.appendChild(actions);
    load();
  }

  /** Switch inside the capture block (merge-patched, so send the whole block). */
  function captureSwitch(id, key, checked) {
    return toggle({
      id,
      checked,
      onChange: async (e) => {
        const value = e.target.checked;
        const cur = await window.dm.settings.get();
        const capture = Object.assign({}, cur.ok ? cur.data.capture : {}, { [key]: value });
        const r = await window.dm.settings.patch({ capture });
        if (!r.ok) {
          toast(errorText(r.error), 'err');
          e.target.checked = !value;
        }
      },
    });
  }

  window.DM.views = window.DM.views || {};
  window.DM.views.settings = { mount };
})();
