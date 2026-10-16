'use strict';

// Pure argv helpers (no electron): hidden-launch detection and protocol URL
// extraction. Token validation of protocol URLs happens in protocol.js (M5).

const PROTOCOL_RE = /^downloadmgr:\/\//i;

function isHiddenLaunch(argv) {
  return Array.isArray(argv) && argv.includes('--hidden');
}

function extractProtocolUrls(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter((a) => typeof a === 'string' && PROTOCOL_RE.test(a));
}

module.exports = { isHiddenLaunch, extractProtocolUrls, PROTOCOL_RE };
