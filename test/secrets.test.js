'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SecretsStore } = require('../app/main/store/secrets');

async function tmpdir() {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-secrets-'));
}

const HEX64 = /^[0-9a-f]{64}$/;

test('secrets: created on first load, persisted, verified, rotatable', async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, 'security.json');

    const s1 = new SecretsStore({ file });
    await s1.load();
    const first = s1.get();
    assert.match(first.captureToken, HEX64);
    assert.match(first.protocolToken, HEX64);
    assert.notEqual(first.captureToken, first.protocolToken);
    assert.equal(s1.verifyCapture(first.captureToken), true);
    assert.equal(s1.verifyCapture(first.protocolToken), false, 'tokens are not interchangeable');
    assert.equal(s1.verifyProtocol(first.protocolToken), true);
    assert.equal(s1.verifyProtocol(''), false);

    const s2 = new SecretsStore({ file });
    await s2.load();
    assert.deepEqual(s2.get(), first, 'tokens persist across loads');

    await s2.rotate('protocol');
    const rotated = s2.get();
    assert.notEqual(rotated.protocolToken, first.protocolToken);
    assert.equal(rotated.captureToken, first.captureToken, 'rotating one token leaves the other');
    assert.equal(s2.verifyProtocol(first.protocolToken), false, 'old token invalid immediately');

    const s3 = new SecretsStore({ file });
    await s3.load();
    assert.deepEqual(s3.get(), rotated, 'rotation persists');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('secrets: corrupt file regenerates; partial file heals only what is missing', async () => {
  const dir = await tmpdir();
  try {
    const file = path.join(dir, 'security.json');

    await fs.promises.writeFile(file, 'total garbage not json');
    const s1 = new SecretsStore({ file });
    await s1.load();
    assert.match(s1.get().captureToken, HEX64);
    assert.match(s1.get().protocolToken, HEX64);

    const keptCapture = s1.get().captureToken;
    await fs.promises.writeFile(file, JSON.stringify({ captureToken: keptCapture }));
    const s2 = new SecretsStore({ file });
    await s2.load();
    assert.equal(s2.get().captureToken, keptCapture, 'valid half survives');
    assert.match(s2.get().protocolToken, HEX64, 'missing half regenerates');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
