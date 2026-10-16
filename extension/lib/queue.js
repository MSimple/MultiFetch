'use strict';

// Persistent retry queue for captures made while the app is down.
// Retries are driven by chrome.alarms (service workers do not stay alive for
// setTimeout), with capped exponential backoff in the stored queue itself.

(function (root) {
  const MAX_ATTEMPTS = 10;
  const BASE_DELAY_MS = 5000;
  const MAX_DELAY_MS = 120_000;

  async function enqueue(item) {
    const q = await DMQ.storage.getQueue();
    q.push({ item, attempts: 0, nextAt: Date.now() + BASE_DELAY_MS });
    await DMQ.storage.setQueue(q);
    chrome.alarms.create('dmq-flush', { periodInMinutes: 0.5 });
  }

  async function flush() {
    const q = await DMQ.storage.getQueue();
    if (q.length === 0) return { flushed: 0, remaining: 0 };

    const now = Date.now();
    const rest = [];
    let flushed = 0;

    for (const entry of q) {
      if (entry.nextAt > now) {
        rest.push(entry);
        continue;
      }
      const r = await DMQ.client.sendItem(entry.item);
      if (r.state === 'ok') {
        flushed++;
        await DMQ.storage.pushRecent({ url: entry.item.url, at: Date.now(), status: r.data.status });
        continue;
      }
      if (r.state === 'unauthorized' || r.state === 'forbidden') {
        continue; // dropped: needs re-pairing, retrying will not help
      }
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) continue; // give up quietly
      entry.nextAt = now + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** entry.attempts);
      rest.push(entry);
    }

    await DMQ.storage.setQueue(rest);
    return { flushed, remaining: rest.length };
  }

  root.DMQ = root.DMQ || {};
  root.DMQ.queue = { enqueue, flush };
})(typeof self !== 'undefined' ? self : globalThis);
