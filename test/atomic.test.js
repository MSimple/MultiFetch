'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeFileAtomic, readJsonWithBak, cleanupStaleTmp } = require('../app/main/store/atomic');

async function tmpdir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-atomic-'));
}

test('writeFileAtomic: writes, refreshes .bak, leaves no tmp files', async () => {
  const dir = await tmpdir();
  try {
    const target = path.join(dir, 'data.json');

    await writeFileAtomic(target, '{"v":1}');
    assert.equal(await fs.promises.readFile(target, 'utf8'), '{"v":1}');

    await writeFileAtomic(target, '{"v":2}');
    assert.equal(await fs.promises.readFile(target, 'utf8'), '{"v":2}');
    assert.equal(await fs.promises.readFile(target + '.bak', 'utf8'), '{"v":1}');

    const leftovers = (await fs.promises.readdir(dir)).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('readJsonWithBak: recovers a corrupt main from .bak, null when nothing usable', async () => {
  const dir = await tmpdir();
  try {
    const target = path.join(dir, 'data.json');
    await writeFileAtomic(target, '{"gen":1}');
    await writeFileAtomic(target, '{"gen":2}'); // .bak now holds gen 1

    await fs.promises.writeFile(target, 'not json at all'); // simulate corruption
    const rec = await readJsonWithBak(target);
    assert.ok(rec, 'expected a recovery result');
    assert.equal(rec.value.gen, 1);
    assert.equal(rec.from, target + '.bak');

    const emptyDir = await tmpdir();
    try {
      assert.equal(await readJsonWithBak(path.join(emptyDir, 'missing.json')), null);
    } finally {
      await fs.promises.rm(emptyDir, { recursive: true, force: true });
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('cleanupStaleTmp: removes old tmp debris only', async () => {
  const dir = await tmpdir();
  try {
    const oldTmp = path.join(dir, 'data.json.tmp-1-aaaa');
    const freshTmp = path.join(dir, 'data.json.tmp-2-bbbb');
    const normal = path.join(dir, 'data.json');
    await fs.promises.writeFile(oldTmp, 'x');
    await fs.promises.writeFile(freshTmp, 'x');
    await fs.promises.writeFile(normal, '{}');

    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await fs.promises.utimes(oldTmp, twoHoursAgo, twoHoursAgo);

    const removed = await cleanupStaleTmp(dir, { maxAgeMs: 3600_000 });
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(oldTmp), false);
    assert.equal(fs.existsSync(freshTmp), true);
    assert.equal(fs.existsSync(normal), true);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
