'use strict';

// Origin policy for the capture API.
//
// Web pages always send an Origin header they cannot forge; extensions send
// chrome-extension://<id>. Native processes send no Origin at all. The API
// therefore accepts: no Origin (native), or an Origin pinned during pairing.
// Any other Origin is refused outright — a hostile web page can reach
// 127.0.0.1, but it can never present a paired extension origin.

const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

function isExtensionOrigin(origin) {
  return typeof origin === 'string' && EXTENSION_ORIGIN_RE.test(origin);
}

/**
 * @param {string|undefined} origin  the request's Origin header (absent for native callers)
 * @param {string[]} allowed         pinned origins from settings
 */
function originAllowed(origin, allowed) {
  if (origin === undefined || origin === null || origin === '') return true; // native/local process
  return Array.isArray(allowed) && allowed.includes(origin);
}

module.exports = { isExtensionOrigin, originAllowed, EXTENSION_ORIGIN_RE };
