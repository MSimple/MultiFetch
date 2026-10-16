'use strict';

// Retry policy: exponential backoff with jitter + Retry-After support.

const MAX_ATTEMPTS = 5;
const MAX_RETRY_AFTER_MS = 60_000;

/** 1s, 2s, 4s, 8s, 16s (+0..250ms jitter), capped. */
function backoffDelayMs(attempt) {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt), 16_000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Parse a Retry-After header (delta-seconds or HTTP-date).
 * @returns {number|null} milliseconds, capped at 60s
 */
function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) {
    return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(v);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
  }
  return null;
}

module.exports = { MAX_ATTEMPTS, backoffDelayMs, parseRetryAfter };
