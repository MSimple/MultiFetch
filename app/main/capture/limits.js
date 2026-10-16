'use strict';

// Sliding-window rate limiting for the capture API. One limiter per rule
// (per-token and global); all state stays in memory — windows are short.

class RateLimiter {
  /**
   * @param {{windowMs: number, max: number}} opts
   */
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> number[] (timestamps within the window)
  }

  /**
   * @param {string} key
   * @param {number} [now]
   * @returns {{ok: true} | {ok: false, retryAfterMs: number}}
   */
  check(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (now - arr[0])) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true };
  }

  reset() {
    this.hits.clear();
  }
}

module.exports = { RateLimiter };
