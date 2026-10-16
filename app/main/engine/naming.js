'use strict';

// Collision-free naming, NTFS-aware (case-insensitive) and aware of our own
// scratch files (.dmpart / .dmpart.json) so a new task never clobbers the
// resume state of an in-flight one.

const fs = require('node:fs');
const path = require('node:path');

const MAX_TRIES = 9999;

function splitExt(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * @param {string} dir
 * @param {string} name  ALREADY sanitized (security/sanitize.js)
 * @returns {string} name or "stem (n).ext" that is free on disk
 */
function uniqueName(dir, name) {
  let taken;
  try {
    taken = new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
  } catch {
    return name; // unreadable dir: let the open() fail loudly later
  }
  const isFree = (candidate) => {
    const c = candidate.toLowerCase();
    return !taken.has(c) && !taken.has(c + '.dmpart') && !taken.has(c + '.dmpart.json');
  };

  if (isFree(name)) return name;
  const { stem, ext } = splitExt(name);
  for (let i = 1; i <= MAX_TRIES; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (isFree(candidate)) return candidate;
  }
  const fallback = `${stem} (${Date.now()})${ext}`;
  return fallback;
}

/** Reserved scratch paths derived from a final filename. */
function scratchPaths(finalPath) {
  const partPath = finalPath + '.dmpart';
  return { partPath, sidecarPath: partPath + '.json' };
}

module.exports = { uniqueName, scratchPaths };
