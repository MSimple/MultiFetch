'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mintToken,
  timingSafeEqualStr,
  mintPairingCode,
  createSecretBundle,
} = require('../app/main/security/tokens');

test('mintToken: 256-bit hex, unique', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const t = mintToken();
    assert.match(t, /^[0-9a-f]{64}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 100, '100 mints must all differ');
});

test('timingSafeEqualStr: equal/unequal/length-mismatch/non-string', () => {
  const t = mintToken();
  assert.equal(timingSafeEqualStr(t, t), true);
  assert.equal(timingSafeEqualStr(t, mintToken()), false);
  assert.equal(timingSafeEqualStr('short', 'much longer value'), false, 'no throw on length mismatch');
  assert.equal(timingSafeEqualStr('', ''), true);
  assert.equal(timingSafeEqualStr(null, t), false);
  assert.equal(timingSafeEqualStr(t, 42), false);
});

test('mintPairingCode: six digits, low collision over small draws', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const c = mintPairingCode();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size >= 49, `expected ≥49 distinct codes, got ${seen.size}`);
});

test('createSecretBundle: two independent hex tokens', () => {
  const b = createSecretBundle();
  assert.match(b.captureToken, /^[0-9a-f]{64}$/);
  assert.match(b.protocolToken, /^[0-9a-f]{64}$/);
  assert.notEqual(b.captureToken, b.protocolToken);
});
