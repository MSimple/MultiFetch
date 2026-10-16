'use strict';

// Tiny i18n: locale map + en fallback + key fallback. No framework.

(function () {
  let strings = {};
  let fallback = {};
  let locale = 'zh-CN';

  async function init(preferred) {
    const r = await window.dm.i18n.get(preferred || undefined);
    if (r.ok && r.data) {
      locale = r.data.locale || locale;
      strings = r.data.strings || {};
      fallback = r.data.fallback || {};
    }
    document.documentElement.lang = locale;
    return locale;
  }

  /** t('key') or t('key', arg0, arg1) with {0}/{1} placeholders */
  function t(key, ...args) {
    let s = key in strings ? strings[key] : key in fallback ? fallback[key] : key;
    args.forEach((a, i) => {
      s = s.split(`{${i}}`).join(String(a));
    });
    return s;
  }

  /** Fill every element carrying data-i18n="key". */
  function fillStatic(root) {
    for (const node of (root || document).querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.getAttribute('data-i18n'));
    }
  }

  /**
   * Localize an IPC error object {code, message}. Falls back to family
   * prefixes (HTTP_404 / NET_* / TLS_*) and finally to "CODE: raw message".
   * @param {{code?: string, message?: string}|string|null} err
   */
  function errorText(err) {
    if (!err) return '';
    if (typeof err === 'string') return err;
    const code = String(err.code || '');
    const lookup = (key) => (key in strings ? strings[key] : key in fallback ? fallback[key] : null);
    const http = /^HTTP_(\d{3})$/.exec(code);
    let s = code ? lookup('error.' + code) : null;
    if (!s && http) s = lookup('error.HTTP_CODE');
    if (!s && /^NET_/.test(code)) s = lookup('error.NET');
    if (!s && /^TLS_/.test(code)) s = lookup('error.TLS');
    if (s) return http ? s.split('{0}').join(http[1]) : s;
    return code ? `${code}: ${err.message || ''}`.trim() : String(err.message || '');
  }

  function current() {
    return locale;
  }

  window.DM = window.DM || {};
  window.DM.i18n = { init, t, fillStatic, errorText, current };
})();
