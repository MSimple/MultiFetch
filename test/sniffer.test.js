'use strict';

// sniffer.js is a chrome-API module; stub the few APIs it touches so the
// semantics that matter (owner stamping, pruning) are pinned by tests.

const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.chrome = {
  tabs: { onRemoved: { addListener() {} } },
  action: {
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor() {},
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => {},
    },
  },
};

require('../extension/lib/sniffer.js');
const sniffer = globalThis.DMQ.sniffer;

test('prune keeps unknown-owner entries, drops only entries of OTHER pages', async () => {
  await sniffer.clear(1);
  // same page, owner stamped from the page URL
  sniffer.add(1, { url: 'https://cdn.x/a.mp4', pageUrl: 'https://page.x/watch', filename: 'a.mp4' });
  // unknown owner (e.g. restored after a worker restart before the page was known)
  sniffer.add(1, { url: 'https://cdn.x/b.mp4', filename: 'b.mp4' });
  // a resource from a different page
  sniffer.add(1, { url: 'https://cdn.x/c.mp4', pageUrl: 'https://other.x/page' });

  await sniffer.pruneToPage(1, 'https://page.x/watch');
  const urls = (await sniffer.getAll(1)).map((r) => r.url).sort();
  assert.deepEqual(urls, ['https://cdn.x/a.mp4', 'https://cdn.x/b.mp4']);
});

test('owner stamping uses the PAGE url, never the resource url', async () => {
  await sniffer.clear(3);
  sniffer.add(3, { url: 'https://cdn.x/v.mp4', pageUrl: 'https://page.x/watch' });
  const [entry] = await sniffer.getAll(3);
  assert.equal(entry.ownerPage, 'https://page.x/watch');
  // pruning against the resource's own URL must NOT be what keeps it alive
  await sniffer.pruneToPage(3, 'https://page.x/watch');
  assert.equal((await sniffer.getAll(3)).length, 1);
});

test('dedupe with late size backfill; clear empties the tab', async () => {
  await sniffer.clear(2);
  sniffer.add(2, { url: 'https://cdn.x/a.mp4' });
  sniffer.add(2, { url: 'https://cdn.x/a.mp4', size: 1234 });
  const items = await sniffer.getAll(2);
  assert.equal(items.length, 1);
  assert.equal(items[0].size, 1234);

  await sniffer.clear(2);
  assert.deepEqual(await sniffer.getAll(2), []);
});

test('tab-less beacons are ignored', () => {
  assert.equal(sniffer.add(-1, { url: 'https://x/a.bin' }), false);
});
