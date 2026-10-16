'use strict';

// Scratch-file handling: .dmpart data file + .dmpart.json resume sidecar.

const fs = require('node:fs');
const { writeFileAtomic, renameWithRetry } = require('../store/atomic');

/** Open (create/truncate) the part file for a fresh run. */
async function openPart(partPath) {
  return fs.promises.open(partPath, 'w+');
}

/** Open an existing part file for resuming (no truncation). */
async function openPartForResume(partPath) {
  return fs.promises.open(partPath, 'r+');
}

async function preallocate(fh, size) {
  if (Number.isFinite(size)) await fh.truncate(size);
}

/** Positional write — safe when several segments share one FileHandle. */
async function writeAt(fh, buf, offset) {
  await fh.write(buf, 0, buf.length, offset);
}

async function saveSidecar(sidecarPath, data) {
  await writeFileAtomic(sidecarPath, JSON.stringify(data));
}

async function readSidecar(sidecarPath) {
  try {
    return JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
  } catch {
    return null;
  }
}

/** fsync + close + atomic rename to the final name. */
async function finalize(fh, partPath, finalPath, log) {
  await fh.sync();
  await fh.close();
  await renameWithRetry(partPath, finalPath, { log });
}

async function unlinkQuiet(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      await fs.promises.unlink(p);
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  openPart,
  openPartForResume,
  preallocate,
  writeAt,
  saveSidecar,
  readSidecar,
  finalize,
  unlinkQuiet,
};
