'use strict';

// Renderer-side formatting helpers (mirror of app/main/util/bytes.js).

(function () {
  const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    let v = n;
    let u = 0;
    while (v >= 1024 && u < UNITS.length - 1) {
      v /= 1024;
      u++;
    }
    const digits = u === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return `${v.toFixed(digits)} ${UNITS[u]}`;
  }

  function formatPercent(progress) {
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    return `${Math.round(p * 100)}%`;
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.round(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  window.DM = window.DM || {};
  window.DM.format = { formatBytes, formatPercent, formatEta };
})();
