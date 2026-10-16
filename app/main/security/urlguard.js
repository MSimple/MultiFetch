'use strict';

// Scheme allowlist for anything that leaves the app for the OS or a browser.
// `openExternalSafe` is the only sanctioned path; `app/main/external.js` binds
// it to Electron's shell (and is the only file allowed to touch shell.openExternal).

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const MAX_URL_LEN = 2048;

/** @param {unknown} url */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LEN) return false;
  if (/[\u0000-\u001F\u007F]/.test(url)) return false; // control chars never belong in a URL
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_SCHEMES.has(parsed.protocol);
}

/**
 * @param {unknown} url
 * @param {(u: string) => void} opener  e.g. shell.openExternal
 * @returns {{ok: true} | {ok: false, code: 'BLOCKED_SCHEME'}}
 */
function openExternalSafe(url, opener) {
  if (typeof opener !== 'function') throw new TypeError('opener must be a function');
  if (!isSafeExternalUrl(url)) return { ok: false, code: 'BLOCKED_SCHEME' };
  opener(url);
  return { ok: true };
}

module.exports = { isSafeExternalUrl, openExternalSafe, ALLOWED_SCHEMES };
