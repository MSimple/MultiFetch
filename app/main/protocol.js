'use strict';

// downloadmgr:// URL handling — parsing is pure (testable, electron-free);
// registration receives `app` by injection.
//
// Grammar:
//   downloadmgr://add?url=<urlencoded http(s) URL>&token=<hex64>   — queue a download
//   downloadmgr://open?token=<hex64>                               — launch/focus the app only
// Any URL without a valid protocol token is ignored — a custom scheme is
// invocable by any web page, so the token is the only gate that matters.

const path = require('node:path');
const { timingSafeEqualStr } = require('./security/tokens');
const { isSafeExternalUrl } = require('./security/urlguard');

const SCHEME = 'downloadmgr:';
const MAX_INPUT_LEN = 4096;

/**
 * @param {string} raw
 * @param {string} expectedToken  current protocolToken
 * @returns {{ok:true, action:'add', url:string} | {ok:false, code:'BAD_PAYLOAD'|'UNKNOWN_ACTION'|'BAD_TOKEN'|'BAD_URL'}}
 */
function parseProtocolUrl(raw, expectedToken) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_INPUT_LEN) {
    return { ok: false, code: 'BAD_PAYLOAD' };
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: 'BAD_PAYLOAD' };
  }
  if (u.protocol !== SCHEME) return { ok: false, code: 'BAD_PAYLOAD' };

  const token = u.searchParams.get('token') || '';
  if (typeof expectedToken !== 'string' || !timingSafeEqualStr(token, expectedToken)) {
    return { ok: false, code: 'BAD_TOKEN' };
  }

  if (u.hostname === 'open') {
    return { ok: true, action: 'open', url: null };
  }
  if (u.hostname !== 'add') return { ok: false, code: 'UNKNOWN_ACTION' };
  const url = u.searchParams.get('url') || '';
  if (!isSafeExternalUrl(url)) return { ok: false, code: 'BAD_URL' };
  return { ok: true, action: 'add', url };
}

/** Register the scheme. Dev builds must point at the electron binary + app path. */
function registerProtocolClient(app, { isPackaged = false } = {}) {
  try {
    if (isPackaged) {
      app.setAsDefaultProtocolClient('downloadmgr');
    } else {
      app.setAsDefaultProtocolClient('downloadmgr', process.execPath, [
        path.resolve(process.argv[1] || '.'),
      ]);
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { parseProtocolUrl, registerProtocolClient, SCHEME, MAX_INPUT_LEN };
