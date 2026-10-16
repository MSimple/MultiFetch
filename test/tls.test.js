'use strict';

// Proves TLS certificate verification is ON: the engine MUST refuse to
// download from a server presenting a self-signed certificate. If this test
// ever passes as "done", certificate verification got silently disabled.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFixtureServer } = require('../tools/fixture-server');
const { TaskStore } = require('../app/main/store/taskstore');
const { Engine } = require('../app/main/engine/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 25, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

test('self-signed TLS server: download must FAIL with a TLS error', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-tls-'));
  const fx = createFixtureServer({ tls: true });
  const port = await fx.listen();
  const store = new TaskStore({ file: path.join(dir, 'tasks.json') });
  await store.load();
  const engine = new Engine({ store });

  try {
    const dlDir = path.join(dir, 'dl');
    const s = store.add({ url: `https://127.0.0.1:${port}/range/file.bin?size=4096&seed=1`, dir: dlDir });
    engine.kick();

    await waitFor(() => ['done', 'error'].includes(store.get(s.id).status), { label: 'terminal state' });
    const t = store.get(s.id);
    assert.equal(t.status, 'error', 'self-signed TLS must not succeed');
    assert.match(String(t.error && t.error.code), /^TLS_/, `expected TLS_* code, got ${t.error && t.error.code}`);

    // nothing may have been written
    if (t.filePath) assert.equal(fs.existsSync(t.filePath), false);
    assert.equal(fs.existsSync(dlDir) && fs.readdirSync(dlDir).length > 0, false);
  } finally {
    engine.dispose();
    store.dispose();
    await fx.close();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
