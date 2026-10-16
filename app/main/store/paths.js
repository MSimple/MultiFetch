'use strict';

// Directory sanity helpers. Windows specifics handled here:
//  - volume roots ("F:\\") cannot be created (EPERM) — accept only if they exist
//  - drive-RELATIVE paths ("C:foo") resolve against that drive's current
//    directory, which is unpredictable — refuse them
//  - MAX_PATH budget for dir + filename + sidecar suffixes

const fs = require('node:fs');
const path = require('node:path');

const BUDGET = 250; // chars for dir + separator + filename + suffix, under MAX_PATH 260

const DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/;

function isFilesystemRoot(p) {
  const resolved = path.resolve(p);
  return resolved.toLowerCase() === path.parse(resolved).root.toLowerCase();
}

/**
 * @returns {Promise<{ok: true, dir: string, root?: true} | {ok: false, code: 'EMPTY_DIR'|'DRIVE_RELATIVE'|'DRIVE_ROOT'|'DIR_UNUSABLE', detail?: string}>}
 */
async function ensureUsableDir(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, code: 'EMPTY_DIR' };
  const raw = dir.trim();
  if (DRIVE_RELATIVE_RE.test(raw)) return { ok: false, code: 'DRIVE_RELATIVE' };

  const resolved = path.resolve(raw);
  if (isFilesystemRoot(resolved)) {
    // Never attempt to create a volume root; use it only if it already exists.
    try {
      const st = await fs.promises.stat(resolved);
      if (st.isDirectory()) return { ok: true, dir: resolved, root: true };
    } catch {
      /* fall through */
    }
    return { ok: false, code: 'DRIVE_ROOT' };
  }

  try {
    await fs.promises.mkdir(resolved, { recursive: true });
  } catch (err) {
    let st = null;
    try {
      st = await fs.promises.stat(resolved);
    } catch {
      /* ignore */
    }
    if (!st || !st.isDirectory()) return { ok: false, code: 'DIR_UNUSABLE', detail: err.code };
  }
  return { ok: true, dir: resolved };
}

/** MAX_PATH headroom check for dir + filename (+ sidecar suffix length). */
function pathBudgetOk(dir, filename, suffixLen = 0) {
  const total = path.resolve(dir).length + 1 + filename.length + suffixLen;
  return total <= BUDGET;
}

module.exports = { ensureUsableDir, isFilesystemRoot, pathBudgetOk, BUDGET };
