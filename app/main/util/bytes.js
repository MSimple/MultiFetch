'use strict';

// Byte / speed / ETA formatting for main-side surfaces (tray tooltip, notifications).

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

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSecond)}/s`;
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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

module.exports = { formatBytes, formatSpeed, formatEta, clampInt };
