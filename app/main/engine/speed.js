'use strict';

// Byte-rate limiting (one shared token bucket) and speed sampling.

/** A global bandwidth limiter. take(n) resolves when n bytes may proceed. */
class TokenBucket {
  /** @param {number|null} ratePerSec  null/0 = unlimited */
  constructor(ratePerSec = null) {
    this.setRate(ratePerSec);
    this._chain = Promise.resolve();
  }

  setRate(ratePerSec) {
    const r = Number(ratePerSec);
    this.rate = Number.isFinite(r) && r > 0 ? r : 0;
    this.capacity = this.rate; // one second of burst
    this.tokens = this.rate;
    this._last = Date.now();
  }

  get unlimited() {
    return this.rate === 0;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this._last) / 1000;
    this._last = now;
    if (elapsed > 0) this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
  }

  /** @param {number} n bytes about to be written */
  take(n) {
    if (this.unlimited) return Promise.resolve();
    // Serialize so concurrent segments share one fair queue.
    const run = this._chain.then(() => this._take(n));
    this._chain = run.catch(() => {});
    return run;
  }

  async _take(n) {
    for (;;) {
      this._refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const waitMs = Math.max(5, Math.ceil((deficit / this.rate) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Sliding-window throughput sampler. */
class SpeedSampler {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    this.samples = []; // [timestamp, bytes]
    this.total = 0;
  }

  add(bytes) {
    const now = Date.now();
    this.samples.push([now, bytes]);
    this.total += bytes;
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0][0] < cutoff) this.samples.shift();
  }

  /** bytes/sec over the sliding window */
  speed() {
    if (this.samples.length === 0) return 0;
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0][0] < cutoff) this.samples.shift();
    let bytes = 0;
    let oldest = now;
    for (const [t, b] of this.samples) {
      bytes += b;
      if (t < oldest) oldest = t;
    }
    const spanSec = Math.max(0.25, (now - Math.min(oldest, cutoff)) / 1000);
    return Math.round(bytes / spanSec);
  }
}

module.exports = { TokenBucket, SpeedSampler };
