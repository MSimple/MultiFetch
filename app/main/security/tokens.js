'use strict';

// Token minting and constant-time verification.
//
// Two independent secrets exist so a leak of one does not compromise the other:
//   - captureToken  : authenticates the loopback capture HTTP API (header-only)
//   - protocolToken : authenticates downloadmgr:// URLs (whose command lines are
//                     world-readable on Windows, hence a separate, rotatable value)
// Storage and rotation live in the store layer; this module is pure.

const crypto = require('node:crypto');

const TOKEN_BYTES = 32; // 256-bit tokens, hex-encoded

function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/** Constant-time string compare that never throws on length mismatch. */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Six-digit, cryptographically random pairing code ("000000".."999999"). */
function mintPairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function createSecretBundle() {
  return { captureToken: mintToken(), protocolToken: mintToken() };
}

module.exports = { mintToken, timingSafeEqualStr, mintPairingCode, createSecretBundle, TOKEN_BYTES };
