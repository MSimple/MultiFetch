'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CHANNELS, EVENT_CHANNELS } = require('../app/main/ipc/register');
const { validate } = require('../app/main/ipc/validate');

const PRELOAD = path.join(__dirname, '..', 'app', 'main', 'preload.js');

test('preload channel names match the IPC table exactly (both directions)', () => {
  const src = fs.readFileSync(PRELOAD, 'utf8');
  const invokeChannels = new Set([...src.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
  const subscribeChannels = new Set([...src.matchAll(/subscribe\('([^']+)'/g)].map((m) => m[1]));

  assert.deepEqual(
    [...invokeChannels].sort(),
    Object.keys(CHANNELS).sort(),
    'every invokable channel in preload must exist in CHANNELS and vice versa'
  );
  assert.deepEqual(
    [...subscribeChannels].sort(),
    [...EVENT_CHANNELS].sort(),
    'event subscriptions must match EVENT_CHANNELS'
  );
  for (const ch of EVENT_CHANNELS) {
    assert.equal(ch in CHANNELS, false, 'event channels are not invokable');
  }
});

test('every channel declares a well-formed schema', () => {
  for (const [ch, schema] of Object.entries(CHANNELS)) {
    assert.ok(schema === null || (typeof schema === 'object' && !Array.isArray(schema)), ch);
    if (schema) {
      for (const v of Object.values(schema)) {
        assert.equal(typeof v, 'string', `${ch}: schema entries are type strings`);
      }
    }
  }
});

test('validate: accepts good payloads, rejects unknowns/types/injection', () => {
  const add = CHANNELS['dm:tasks:add'];

  assert.equal(validate(add, { url: 'https://example.com/a.zip' }).ok, true);
  assert.equal(validate(add, { url: 'https://example.com/a.zip', connections: 8, source: 'ui' }).ok, true);
  assert.equal(validate(add, { url: 'https://example.com/a.zip', filename: '影片.mp4' }).ok, true);

  assert.equal(validate(add, { url: 'file:///C:/evil.exe' }).ok, false, 'non-http scheme');
  assert.equal(validate(add, {}).ok, false, 'missing url');
  assert.equal(validate(add, { url: 'https://example.com/a.zip', bogus: 1 }).ok, false, 'unknown field');
  assert.equal(validate(add, { url: 'https://example.com/a.zip', connections: 0 }).ok, false, 'range');
  assert.equal(validate(add, { url: 'https://example.com/a.zip', connections: 65 }).ok, false, 'range');
  assert.equal(validate(add, { url: 'https://example.com/a.zip', kind: 'hls' }).ok, false, 'enum (v1: http only)');
  assert.equal(
    validate(add, { url: 'https://example.com/a.zip', headers: { 'X-A': 'b\r\nInjected: 1' } }).ok,
    false,
    'CRLF header injection refused'
  );
  assert.equal(
    validate(add, { url: 'https://example.com/a.zip', headers: { 'Bad Name': 'x' } }).ok,
    false,
    'invalid header token refused'
  );

  const get = CHANNELS['dm:tasks:get'];
  assert.equal(validate(get, { id: 't_0123456789ab' }).ok, true);
  assert.equal(validate(get, { id: 'nope' }).ok, false);
  assert.equal(validate(get, {}).ok, false);

  // null schema = no payload expected; anything is ignored, never forwarded
  assert.equal(validate(null, undefined).ok, true);
  assert.equal(validate(null, { injected: true }).ok, true);

  // non-object payloads refused when a schema exists
  assert.equal(validate(add, 'https://example.com/a.zip').ok, false, 'raw string is not an object');
  assert.equal(validate(add, ['x']).ok, false);
});
