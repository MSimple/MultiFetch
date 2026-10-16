'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isSafeExternalUrl, openExternalSafe } = require('../app/main/security/urlguard');

const ALLOWED = [
  'https://example.com',
  'https://example.com/path?q=1#frag',
  'http://127.0.0.1:8080/x',
  'HTTPS://EXAMPLE.COM', // scheme case is normalized by URL
];

const BLOCKED = [
  '',
  'file:///C:/Windows/System32/cmd.exe',
  'C:\\Windows\\notepad.exe',
  '\\\\server\\share\\file',
  '//host/path',
  'mailto:someone@example.com',
  'javascript:alert(1)',
  'data:text/html,<b>x</b>',
  'vbscript:msgbox(1)',
  'ms-msdt:/id PCWDiagnostic',
  'ftp://example.com/x',
  'https://',
  'http://',
  'not a url',
  'https://example.com/\u0000x',
  'https://example.com/\nInjected',
  null,
  42,
  {},
  'https://' + 'a'.repeat(3000), // over the length cap
];

test('isSafeExternalUrl: https/http only', () => {
  for (const u of ALLOWED) assert.equal(isSafeExternalUrl(u), true, `expected allow: ${u}`);
  for (const u of BLOCKED) assert.equal(isSafeExternalUrl(u), false, `expected block: ${JSON.stringify(u)}`);
});

test('openExternalSafe: opener is only invoked for allowed URLs', () => {
  const calls = [];
  const opener = (u) => calls.push(u);

  const good = openExternalSafe('https://example.com/a', opener);
  assert.deepEqual(good, { ok: true });
  assert.deepEqual(calls, ['https://example.com/a']);

  const bad = openExternalSafe('file:///C:/evil.exe', opener);
  assert.deepEqual(bad, { ok: false, code: 'BLOCKED_SCHEME' });
  assert.equal(calls.length, 1, 'opener not called for blocked scheme');

  assert.throws(() => openExternalSafe('https://example.com', 'not-a-function'), TypeError);
});
