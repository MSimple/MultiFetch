'use strict';

// The ONLY module allowed to reference Electron's shell.openExternal.
// Everything goes through the urlguard allowlist (https? only).
// tools/lint-danger.js enforces both invariants.

const { shell } = require('electron');
const { openExternalSafe } = require('./security/urlguard');

/**
 * Open an external URL in the OS default handler.
 * @param {unknown} url
 * @returns {{ok: true} | {ok: false, code: 'BLOCKED_SCHEME'}}
 */
function openExternal(url) {
  return openExternalSafe(url, (u) => {
    shell.openExternal(u);
  });
}

module.exports = { openExternal };
