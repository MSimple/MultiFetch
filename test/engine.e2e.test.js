'use strict';

// End-to-end engine tests against the loopback fixture server:
// multi-segment correctness (SHA-256 exact), no-range fallback, redirects,
// resume across engine instances, 429 Retry-After, cancel cleanup, naming.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFixtureServer, generateBody } = require('../tools/fixture-server');
const { TaskStore } = require('../app/main/store/taskstore');
const { Engine } = require('../app/main/engine/engine');

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 25, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

async function setup(defaults = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-e2e-'));
  const fx = createFixtureServer();
  const port = await fx.listen();
  const store = new TaskStore({ file: path.join(dir, 'tasks.json') });
  await store.load();
  const engine = new Engine({
    store,
    defaults: { maxConcurrent: 2, defaultConnections: 8, maxConnections: 16, ...defaults },
  });
  return {
    dir,
    fx,
    store,
    engine,
    base: `http://127.0.0.1:${port}`,
    dlDir: path.join(dir, 'dl'),
    statusOf: (id) => (store.get(id) || {}).status,
    add(url, extra = {}) {
      const s = store.add({ url, dir: path.join(dir, 'dl'), ...extra });
      engine.kick();
      return s.id;
    },
    async cleanup() {
      engine.dispose();
      store.dispose();
      await fx.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}

test('multi-segment download: exact SHA-256, >=8 segments, scratch cleaned', async () => {
  const env = await setup();
  try {
    const SIZE = 16 * MiB;
    const SEED = 42;
    const id = env.add(`${env.base}/range/file.bin?size=${SIZE}&seed=${SEED}`);

    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), { label: 'terminal state' });
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));

    assert.ok(t.segments.length >= 8, `16MiB -> at least 8 segments, got ${t.segments.length}`);
    assert.ok(t.segments.every((s) => s.state === 'done'));
    assert.equal(t.downloadedBytes, SIZE);
    assert.equal(t.supportsRange, true);

    const buf = await fs.promises.readFile(t.filePath);
    assert.equal(buf.length, SIZE);
    assert.equal(sha256(buf), sha256(generateBody(SIZE, SEED)), 'bit-exact content');

    assert.equal(fs.existsSync(t.partPath), false, 'part file renamed away');
    assert.equal(fs.existsSync(t.sidecarPath), false, 'sidecar removed on success');
    assert.ok(env.fx.stats.bytesServed >= SIZE);
  } finally {
    await env.cleanup();
  }
});

test('configured segment count above 8 (the legacy cap) is honored', async () => {
  const env = await setup({ defaultConnections: 10, maxConnections: 16 });
  try {
    const SIZE = 40 * MiB;
    const SEED = 21;
    const id = env.add(`${env.base}/range/file.bin?size=${SIZE}&seed=${SEED}`);

    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), { label: 'done', timeoutMs: 30_000 });
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));
    assert.ok(t.segments.length >= 10, `expected >=10 segments, got ${t.segments.length}`);
    assert.equal(sha256(await fs.promises.readFile(t.filePath)), sha256(generateBody(SIZE, SEED)));

    // a live settings change must reach the engine for the next task
    env.engine.setLimits({ defaultConnections: 12 });
    const id2 = env.add(`${env.base}/range/file2.bin?size=${SIZE}&seed=${SEED + 1}`);
    await waitFor(() => ['done', 'error'].includes(env.statusOf(id2)), { label: 'done (updated)', timeoutMs: 30_000 });
    const t2 = env.store.get(id2);
    assert.equal(t2.status, 'done', JSON.stringify(t2.error));
    assert.ok(t2.segments.length >= 12, `expected >=12 segments after setLimits, got ${t2.segments.length}`);
  } finally {
    await env.cleanup();
  }
});

test('no-range server: single-stream fallback still exact', async () => {
  const env = await setup();
  try {
    const SIZE = 1 * MiB;
    const SEED = 5;
    const id = env.add(`${env.base}/norange/file.bin?size=${SIZE}&seed=${SEED}`);

    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), { label: 'terminal state' });
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));
    assert.equal(t.supportsRange, false);
    assert.equal(t.segments.length, 1);
    assert.equal(t.resumable, false);

    const buf = await fs.promises.readFile(t.filePath);
    assert.equal(sha256(buf), sha256(generateBody(SIZE, SEED)));
  } finally {
    await env.cleanup();
  }
});

test('redirect chain: resolved finalUrl recorded, bytes land', async () => {
  const env = await setup();
  try {
    const SIZE = 512 * 1024;
    const SEED = 9;
    const id = env.add(`${env.base}/redirect?h=2&size=${SIZE}&seed=${SEED}`);

    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), { label: 'terminal state' });
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));
    assert.match(t.finalUrl, /\/range\//, 'finalUrl reflects the redirect target');

    const buf = await fs.promises.readFile(t.filePath);
    assert.equal(sha256(buf), sha256(generateBody(SIZE, SEED)));
  } finally {
    await env.cleanup();
  }
});

test('pause mid-download -> fresh engine resumes from sidecar (only remainder re-fetched)', async () => {
  const env = await setup({ globalSpeedLimit: 4 * MiB }); // ~4s for the full file
  try {
    const SIZE = 16 * MiB;
    const SEED = 11;
    const id = env.add(`${env.base}/range/file.bin?size=${SIZE}&seed=${SEED}`);

    await waitFor(() => (env.store.get(id).downloadedBytes || 0) >= SIZE / 2, {
      label: 'halfway progress',
      timeoutMs: 20_000,
    });
    env.engine.pause(id);
    await waitFor(() => env.statusOf(id) === 'paused', { label: 'paused' });
    await sleep(300); // let the runner settle: final sidecar write + fh close
    const t1 = env.store.get(id);
    assert.ok(t1.downloadedBytes >= SIZE / 2 - MiB, 'progress recorded before pause');
    assert.equal(fs.existsSync(t1.sidecarPath), true, 'sidecar saved for resume');

    // simulate app restart: new store + new engine on the same files
    const tasksFile = env.store.file;
    env.engine.dispose();
    env.store.dispose();
    env.fx.reset();

    const store2 = new TaskStore({ file: tasksFile });
    await store2.load();
    const engine2 = new Engine({ store: store2 });
    const id2 = store2.list()[0].id;
    assert.equal(store2.get(id2).status, 'paused', 'interrupted task restarts paused');

    engine2.resume(id2);
    await waitFor(() => ['done', 'error'].includes(store2.get(id2).status), {
      label: 'resume completion',
      timeoutMs: 20_000,
    });
    const t2 = store2.get(id2);
    assert.equal(t2.status, 'done', JSON.stringify(t2.error));

    const buf = await fs.promises.readFile(t2.filePath);
    assert.equal(buf.length, SIZE);
    assert.equal(sha256(buf), sha256(generateBody(SIZE, SEED)), 'hash survives resume');
    assert.ok(
      env.fx.stats.bytesServed < SIZE * 0.75,
      `second pass must fetch only the remainder (served ${env.fx.stats.bytesServed} of ${SIZE})`
    );

    engine2.dispose();
    store2.dispose();
  } finally {
    await env.cleanup();
  }
});

test('immediate pause -> resume while the runner settles re-queues instead of stranding', async () => {
  const env = await setup({ globalSpeedLimit: 2 * MiB });
  try {
    const SIZE = 8 * MiB;
    const SEED = 31;
    const id = env.add(`${env.base}/range/file.bin?size=${SIZE}&seed=${SEED}`);
    await waitFor(() => (env.store.get(id).downloadedBytes || 0) > 256 * 1024, { label: 'progress' });

    env.engine.pause(id);
    env.engine.resume(id); // racy by design: the runner is still winding down
    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), {
      label: 'done after re-queue',
      timeoutMs: 30_000,
    });
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));
    assert.equal(sha256(await fs.promises.readFile(t.filePath)), sha256(generateBody(SIZE, SEED)));
  } finally {
    await env.cleanup();
  }
});

test('work stealing: a slow tail segment is split and helped by the idle worker', async () => {
  const env = await setup({ defaultConnections: 2, maxConnections: 2 });
  try {
    const SIZE = 8 * MiB; // /skewed: second half of the file trickles at ~2 MiB/s
    const SEED = 77;
    const started = Date.now();
    const id = env.add(`${env.base}/skewed/file.bin?size=${SIZE}&seed=${SEED}`);

    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), { label: 'done', timeoutMs: 30_000 });
    const elapsed = Date.now() - started;
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));
    assert.equal(
      sha256(await fs.promises.readFile(t.filePath)),
      sha256(generateBody(SIZE, SEED)),
      'hash exact after work stealing'
    );

    // planned as 2 segments; the idle worker must have stolen a slice from the laggard
    assert.ok(t.segments.length >= 3, `expected stolen slices, got ${t.segments.length} segments`);
    // without stealing the tail takes ~2s; with it, ~1.2s (< 1.9s proves the help)
    assert.ok(elapsed < 1900, `expected the steal to shorten the tail (took ${elapsed}ms)`);
  } finally {
    await env.cleanup();
  }
});

test('429 with Retry-After is honored at probe time', async () => {
  const env = await setup();
  try {
    const SIZE = 256 * 1024;
    const SEED = 3;
    const started = Date.now();
    const id = env.add(`${env.base}/ratelimit/file.bin?after=1&size=${SIZE}&seed=${SEED}`);

    await waitFor(() => ['done', 'error'].includes(env.statusOf(id)), { label: 'terminal state' });
    const elapsed = Date.now() - started;
    const t = env.store.get(id);
    assert.equal(t.status, 'done', JSON.stringify(t.error));
    assert.ok(elapsed >= 1900, `expected >= ~2s wait from Retry-After, got ${elapsed}ms`);

    const buf = await fs.promises.readFile(t.filePath);
    assert.equal(sha256(buf), sha256(generateBody(SIZE, SEED)));
  } finally {
    await env.cleanup();
  }
});

test('cancel stops the task and removes scratch + partial files', async () => {
  const env = await setup({ globalSpeedLimit: 2 * MiB });
  try {
    const id = env.add(`${env.base}/range/file.bin?size=${16 * MiB}&seed=13`);
    await waitFor(() => (env.store.get(id).downloadedBytes || 0) > 1 * MiB, { label: 'progress' });

    env.engine.cancel(id);
    await waitFor(() => env.statusOf(id) === 'canceled', { label: 'canceled' });

    const t = env.store.get(id);
    await waitFor(
      () => !fs.existsSync(t.partPath) && !fs.existsSync(t.sidecarPath) && !fs.existsSync(t.filePath),
      { label: 'scratch cleanup' }
    );
  } finally {
    await env.cleanup();
  }
});

test('collision: second download of the same name becomes "name (1).ext"', async () => {
  const env = await setup();
  try {
    const URL = `${env.base}/range/report.bin?size=${128 * 1024}&seed=17`;
    const id1 = env.add(URL);
    await waitFor(() => ['done', 'error'].includes(env.statusOf(id1)), { label: 'first done' });
    const t1 = env.store.get(id1);
    assert.equal(t1.status, 'done', JSON.stringify(t1.error));
    assert.equal(t1.filename, 'report.bin');

    const id2 = env.add(URL);
    await waitFor(() => ['done', 'error'].includes(env.statusOf(id2)), { label: 'second done' });
    const t2 = env.store.get(id2);
    assert.equal(t2.status, 'done', JSON.stringify(t2.error));
    assert.equal(t2.filename, 'report (1).bin');
    assert.equal(fs.existsSync(t1.filePath), true);
    assert.equal(fs.existsSync(t2.filePath), true);
  } finally {
    await env.cleanup();
  }
});
