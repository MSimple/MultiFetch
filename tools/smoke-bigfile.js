#!/usr/bin/env node
'use strict';

// >4 GiB end-to-end check: downloads 4.5 GiB through the real engine against
// the loopback fixture, crossing the 2^32-byte boundary that trips 32-bit
// implementations. The fixture generates bytes deterministically (nothing is
// stored on the "server"); the target is written to a temp dir, spot-verified
// (first / middle / last MiB hashes), then deleted.
//
//   node tools/smoke-bigfile.js

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFixtureServer, bodyByte } = require('./fixture-server');
const { TaskStore } = require('../app/main/store/taskstore');
const { Engine } = require('../app/main/engine/engine');

const SIZE = Math.floor(4.5 * 1024 ** 3); // 4,831,838,208 bytes
const SEED = 99;
const MiB = 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 600_000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function expectedSlice(off, len) {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) b[i] = bodyByte(off + i, SEED);
  return b;
}

async function hashAt(filePath, off, len) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const r = await fh.read(buf, 0, len, off);
    if (r.bytesRead !== len) throw new Error(`short read at ${off}: ${r.bytesRead}`);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } finally {
    await fh.close();
  }
}

(async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-bigfile-'));
  const fx = createFixtureServer();
  const port = await fx.listen();
  const store = new TaskStore({ file: path.join(dir, 'tasks.json') });
  await store.load();
  const engine = new Engine({ store, defaults: { maxConcurrent: 1, defaultConnections: 8, maxConnections: 16 } });

  const url = `http://127.0.0.1:${port}/range/big.bin?size=${SIZE}&seed=${SEED}`;
  console.log(`url : ${url}`);
  console.log(`size: ${SIZE} bytes (4.5 GiB, crosses 2^32)`);
  const started = Date.now();

  try {
    const s = store.add({ url, dir });
    engine.kick();
    await waitFor(() => ['done', 'error'].includes((store.get(s.id) || {}).status), { label: 'terminal state' });
    const t = store.get(s.id);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`status: ${t.status} (${secs}s)${t.error ? ' — ' + JSON.stringify(t.error) : ''}`);
    if (t.status !== 'done') {
      process.exitCode = 1;
      return;
    }

    const st = await fs.promises.stat(t.filePath);
    const sizeOk = st.size === SIZE;
    console.log(`file  : ${t.filePath}`);
    console.log(`size  : ${st.size} ${sizeOk ? '(exact ✓)' : '(MISMATCH ✗)'}`);
    console.log(`segments: ${t.segments.length} · downloadedBytes: ${t.downloadedBytes}`);

    let hashesOk = true;
    for (const [off, label] of [
      [0, 'first MiB'],
      [Math.floor(SIZE / 2 / MiB) * MiB, 'middle MiB'],
      [SIZE - MiB, 'last MiB'],
    ]) {
      const got = await hashAt(t.filePath, off, MiB);
      const want = crypto.createHash('sha256').update(expectedSlice(off, MiB)).digest('hex');
      const ok = got === want;
      hashesOk = hashesOk && ok;
      console.log(`hash ${label} @${off}: ${ok ? 'match ✓' : 'MISMATCH ✗'}`);
    }

    if (sizeOk && hashesOk && t.downloadedBytes === SIZE) {
      console.log('\nBIG-FILE TEST PASSED — no app-side size limit');
    } else {
      console.log('\nBIG-FILE TEST FAILED');
      process.exitCode = 1;
    }
  } finally {
    engine.dispose();
    store.dispose();
    await fx.close();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('BIG-FILE TEST ERROR: ' + ((e && e.stack) || e));
  process.exitCode = 1;
});
