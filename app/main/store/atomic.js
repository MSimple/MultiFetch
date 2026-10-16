'use strict';

// Atomic JSON/file persistence: write to a temp file, fsync, keep the previous
// good copy as .bak, then rename into place (same-volume NTFS rename is
// atomic). Rename/delete can transiently fail with EPERM/EBUSY/EACCES while
// antivirus scanners hold fresh files, so those get bounded retries.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function renameWithRetry(from, to, { retries = 5, delayMs = 200, log } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= retries) throw err;
      if (log) log.warn(`rename retry ${attempt + 1}/${retries} (${err.code}): ${path.basename(from)}`);
      await sleep(delayMs);
    }
  }
}

/**
 * @param {string} target   final file path
 * @param {string|Buffer} data
 */
async function writeFileAtomic(target, data, opts = {}) {
  const dir = path.dirname(target);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

  let fh = null;
  try {
    fh = await fs.promises.open(tmp, 'w');
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    if (fh) await fh.close();
  }

  // Keep the previous good copy for recovery. Best-effort: absent on first write.
  try {
    await fs.promises.copyFile(target, target + '.bak');
  } catch {
    /* no previous file, or copy blocked — main path still safe */
  }

  await renameWithRetry(tmp, target, opts);
}

/**
 * Read JSON from `target`, falling back to `target.bak` when the main file is
 * missing or unparsable.
 * @returns {Promise<{value: any, from: string} | null>}
 */
async function readJsonWithBak(target) {
  for (const p of [target, target + '.bak']) {
    let text;
    try {
      text = await fs.promises.readFile(p, 'utf8');
    } catch {
      continue;
    }
    try {
      return { value: JSON.parse(text), from: p };
    } catch {
      continue;
    }
  }
  return null;
}

/** Remove leftover .tmp-* files older than maxAgeMs (crash debris from previous runs). */
async function cleanupStaleTmp(dir, { maxAgeMs = 3600_000 } = {}) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!name.includes('.tmp-')) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.promises.stat(p);
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(p);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

module.exports = { writeFileAtomic, renameWithRetry, readJsonWithBak, cleanupStaleTmp };
