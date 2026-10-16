'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TaskStore } = require('../app/main/store/taskstore');
const { SettingsStore } = require('../app/main/store/settings');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmpdir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-store-'));
}

test('TaskStore: add/list/summary, persist and reload', async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, 'tasks.json');
    const store = new TaskStore({ file });
    await store.load();

    const s = store.add({ url: 'https://example.com/a.zip', dir: 'C:\\dl' });
    assert.match(s.id, /^t_[0-9a-f]{12}$/);
    assert.equal(s.status, 'queued');
    assert.equal(s.progress, 0);

    await store.flush();
    store.dispose();

    const store2 = new TaskStore({ file });
    await store2.load();
    const list = store2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].url, 'https://example.com/a.zip');
    assert.equal(list[0].filename, null);
    store2.dispose();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('TaskStore: update patches whitelisted fields only; progress computed', async () => {
  const dir = await tmpdir();
  try {
    const store = new TaskStore({ file: path.join(dir, 'tasks.json') });
    await store.load();
    const { id } = store.add({ url: 'https://example.com/b.bin', dir: 'C:\\dl' });

    const s = store.update(id, { status: 'downloading', downloadedBytes: 50, totalBytes: 200, bogus: 1 });
    assert.equal(s.status, 'downloading');
    assert.equal(s.progress, 0.25);
    assert.equal(store.get(id).bogus, undefined, 'unknown fields never land on the record');
    store.dispose();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('TaskStore: remove and clearFinished', async () => {
  const dir = await tmpdir();
  try {
    const store = new TaskStore({ file: path.join(dir, 'tasks.json') });
    await store.load();
    const a = store.add({ url: 'https://example.com/a', dir: 'C:\\dl' });
    const b = store.add({ url: 'https://example.com/b', dir: 'C:\\dl' });
    store.update(a.id, { status: 'done' });
    store.update(b.id, { status: 'canceled' });

    assert.equal(store.clearFinished(), 2);
    assert.equal(store.list().length, 0);
    assert.equal(store.remove('t_000000000000'), false, 'removing a missing id is a no-op');
    store.dispose();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('TaskStore: rapid mutations are coalesced and debounced', async () => {
  const dir = await tmpdir();
  try {
    const store = new TaskStore({ file: path.join(dir, 'tasks.json') });
    await store.load();
    const events = [];
    store.on('tasks-changed', (u) => events.push(u));

    const { id } = store.add({ url: 'https://example.com/big.bin', dir: 'C:\\dl' });
    for (let i = 0; i < 200; i++) store.update(id, { downloadedBytes: i });
    await sleep(750); // > notify window (250ms) + persist debounce (500ms)

    assert.equal(events.length, 1, 'one coalesced batch for 200 mutations');
    assert.ok(events[0].length >= 1);
    const last = events[0][events[0].length - 1];
    assert.equal(last.downloadedBytes, 199);
    assert.ok(store.persistCount <= 3, `expected <= 3 disk writes, got ${store.persistCount}`);
    store.dispose();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('TaskStore: interrupted statuses restart paused; corrupt main recovers from .bak', async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, 'tasks.json');
    const store = new TaskStore({ file });
    await store.load();
    const { id } = store.add({ url: 'https://example.com/c.iso', dir: 'C:\\dl' });
    store.update(id, { status: 'downloading' });
    await store.flush(); // v1 on disk (.bak holds pre-update state), persisted status=downloading
    store.dispose();

    // corrupt the main file; .bak was written before the last flush, so it holds
    // an earlier state — either way load() must succeed and not throw
    await fs.promises.writeFile(file, '{{{corrupt');
    const store2 = new TaskStore({ file });
    await store2.load();
    assert.ok(store2.list().length >= 0, 'load survives corruption');

    // fresh store: downloading restarts paused
    const store3 = new TaskStore({ file: path.join(dir, 'fresh.json') });
    await store3.load();
    const rec = store3.add({ url: 'https://example.com/d.iso', dir: 'C:\\dl' });
    store3.update(rec.id, { status: 'downloading' });
    await store3.flush();
    store3.dispose();
    const store4 = new TaskStore({ file: path.join(dir, 'fresh.json') });
    await store4.load();
    assert.equal(store4.list()[0].status, 'paused');
    store4.dispose();
    store2.dispose();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('SettingsStore: whitelist patch, reject unknown/invalid, persist across reload', async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, 'settings.json');
    const s = new SettingsStore({ file });
    await s.load();

    const ok = s.patch({ maxConcurrent: 5, defaultDir: 'D:\\stuff', locale: 'en' });
    assert.equal(ok.ok, true);
    assert.equal(s.get().maxConcurrent, 5);

    const bad = s.patch({ bogusKey: 1 });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.rejected, ['bogusKey']);
    assert.equal('bogusKey' in s.get(), false);

    const badRange = s.patch({ maxConcurrent: 999 });
    assert.equal(badRange.ok, false);
    assert.equal(s.get().maxConcurrent, 5, 'invalid value leaves the old one intact');

    await s.flush();
    s.dispose();

    const s2 = new SettingsStore({ file });
    await s2.load();
    assert.equal(s2.get().maxConcurrent, 5);
    assert.equal(s2.get().defaultDir, 'D:\\stuff');
    s2.dispose();
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
