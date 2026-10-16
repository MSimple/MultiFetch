'use strict';

// The single filename sanitizer and path-containment gate for the whole app.
//
// Every filename that can reach the filesystem — user input, server
// Content-Disposition, extension-supplied hints — MUST pass through
// sanitizeFilename(), and every resolved target MUST pass containedPath()
// before any open/write/rename. Defense in depth: both are applied even
// though a sanitized name can never escape.
//
// These functions are pure (no fs, no electron) so they are directly unit
// testable. The optional disk-level check (existing directory / reparse point
// at the target) lives in verifyTargetPath().

const path = require('node:path');
const fs = require('node:fs');

const MAX_TOTAL_LEN = 180; // code points; leaves headroom for ".dmpart.json" style suffixes under MAX_PATH
const MAX_EXT_LEN = 16;
const FALLBACK_STEM = 'file';

// Reserved DOS device names (case-insensitive), checked against the stem
// before the first dot. "CON.txt" is still the CON device.
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
// Bidi override/isolate characters (U+202A-202E, U+2066-2069), built from code
// points so this source file itself contains no raw bidi controls.
const BIDI_RANGES = [[0x202a, 0x202e], [0x2066, 0x2069]];
const BIDI_RE = new RegExp(
  BIDI_RANGES.map(([a, b]) => `[${String.fromCharCode(a)}-${String.fromCharCode(b)}]`).join('|'),
  'g'
);
const FORBIDDEN_RE = /[<>"|?*]/g; // ':' is handled separately (drive prefixes + ADS)
const TRAILING_DOTS_SPACES_RE = /[. ]+$/;

// Truncate by code points so surrogate pairs (emoji, rare CJK) are never split.
function codePointTruncate(s, maxCp) {
  const cps = Array.from(s);
  if (cps.length <= maxCp) return s;
  return cps.slice(0, maxCp).join('');
}

function splitExtension(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' }; // dot at 0 = dotfile, not an extension
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/**
 * Sanitize an untrusted filename into a single safe path segment.
 *
 * @param {unknown} input
 * @returns {{ok: true, name: string} | {ok: false, code: 'EMPTY_NAME' | 'UNSAFE_NAME', detail?: string}}
 */
function sanitizeFilename(input) {
  if (typeof input !== 'string') return { ok: false, code: 'EMPTY_NAME', detail: 'not a string' };

  let name = input
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .trim();

  // Basename only: separators and any ".." path furniture are discarded.
  name = name.replace(/\\/g, '/');
  const slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.slice(slash + 1);

  name = name.replace(/:/g, ''); // kills NTFS ADS ("file.txt:ads") and drive prefixes
  name = name.replace(FORBIDDEN_RE, '');
  name = name.replace(TRAILING_DOTS_SPACES_RE, ''); // trailing dots/spaces alias on Windows
  name = name.trim();

  if (name === '' || name === '.' || name === '..') {
    return { ok: false, code: 'EMPTY_NAME' };
  }

  name = name.normalize('NFC');

  let { stem, ext } = splitExtension(name);
  if (RESERVED.has(stem.toUpperCase())) stem = '_' + stem;

  if (Array.from(ext).length > MAX_EXT_LEN) ext = codePointTruncate(ext, MAX_EXT_LEN);
  const stemBudget = MAX_TOTAL_LEN - (ext ? Array.from(ext).length + 1 : 0);
  stem = codePointTruncate(stem, Math.max(1, stemBudget));
  if (stem === '') stem = FALLBACK_STEM;

  name = ext ? stem + '.' + ext : stem;

  // Post-conditions (defense in depth; must never trigger after the steps above).
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    return { ok: false, code: 'UNSAFE_NAME', detail: 'separator survived sanitization' };
  }
  return { ok: true, name };
}

/**
 * Resolve `name` against `dir` and assert the result stays strictly inside it.
 * Accepts RAW, unsanitized names on purpose — it is the last line of defense.
 *
 * @returns {{ok: true, path: string} | {ok: false, code: 'EMPTY_NAME' | 'UNSAFE_NAME' | 'ESCAPES_DIR'}}
 */
function containedPath(dir, name) {
  if (typeof dir !== 'string' || typeof name !== 'string' || dir === '' || name === '') {
    return { ok: false, code: 'EMPTY_NAME' };
  }
  const base = path.resolve(dir);
  const target = path.resolve(base, name);
  if (target === base) {
    return { ok: false, code: 'UNSAFE_NAME', detail: 'target is the directory itself' };
  }
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  // NTFS is case-insensitive; compare case-insensitively so a differently-cased
  // in-dir path is not misjudged as an escape.
  if (!target.toLowerCase().startsWith(prefix.toLowerCase())) {
    return { ok: false, code: 'ESCAPES_DIR' };
  }
  return { ok: true, path: target };
}

/**
 * Disk-level checks for a would-be target: refuse when the target already
 * exists as a directory or as a symlink / reparse point (which could redirect
 * the write elsewhere).
 */
async function verifyTargetPath(dir, name) {
  const c = containedPath(dir, name);
  if (!c.ok) return c;
  let st = null;
  try {
    st = await fs.promises.lstat(c.path);
  } catch {
    st = null; // does not exist: fine
  }
  if (st) {
    if (st.isDirectory()) {
      return { ok: false, code: 'UNSAFE_NAME', detail: 'a directory already exists at the target' };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, code: 'UNSAFE_NAME', detail: 'symlink/reparse target refused' };
    }
  }
  return { ok: true, path: c.path };
}

module.exports = {
  sanitizeFilename,
  containedPath,
  verifyTargetPath,
  MAX_TOTAL_LEN,
  MAX_EXT_LEN,
  RESERVED,
};
