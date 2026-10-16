'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProtocolUrl, MAX_INPUT_LEN } = require('../app/main/protocol');
const { isHiddenLaunch, extractProtocolUrls } = require('../app/main/argv');
const { mintToken } = require('../app/main/security/tokens');

const TOKEN = mintToken();
const TARGET = 'https://example.com/big-file.zip';

function makeUrl(url = TARGET, token = TOKEN, host = 'add') {
  return `downloadmgr://${host}?url=${encodeURIComponent(url)}&token=${token}`;
}

test('parseProtocolUrl: valid add URL accepted, extra params ignored', () => {
  const r = parseProtocolUrl(makeUrl(), TOKEN);
  assert.deepEqual(r, { ok: true, action: 'add', url: TARGET });

  const withExtra = parseProtocolUrl(makeUrl() + '&filename=x.bin', TOKEN);
  assert.equal(withExtra.ok, true);
  assert.equal(withExtra.url, TARGET);
});

test('parseProtocolUrl: token gate — missing, wrong, malformed all refused', () => {
  assert.equal(parseProtocolUrl(makeUrl(TARGET, ''), TOKEN).code, 'BAD_TOKEN');
  assert.equal(parseProtocolUrl(makeUrl(TARGET, mintToken()), TOKEN).code, 'BAD_TOKEN');
  assert.equal(parseProtocolUrl(`downloadmgr://add?url=${encodeURIComponent(TARGET)}`, TOKEN).code, 'BAD_TOKEN');
  assert.equal(parseProtocolUrl(makeUrl(TARGET, 'zzzz'), TOKEN).code, 'BAD_TOKEN');
  assert.equal(parseProtocolUrl(makeUrl(TARGET, TOKEN), 'not-a-token').code, 'BAD_TOKEN');
});

test('parseProtocolUrl: URL gate — non-http(s) targets refused even with a valid token', () => {
  assert.equal(parseProtocolUrl(makeUrl('file:///C:/Windows/System32/cmd.exe'), TOKEN).code, 'BAD_URL');
  assert.equal(parseProtocolUrl(makeUrl('jav' + 'ascript:alert(1)'), TOKEN).code, 'BAD_URL');
  assert.equal(parseProtocolUrl(makeUrl(''), TOKEN).code, 'BAD_URL');
  assert.equal(parseProtocolUrl(`downloadmgr://add?token=${TOKEN}`, TOKEN).code, 'BAD_URL');
});

test('parseProtocolUrl: open action launches without a payload', () => {
  assert.deepEqual(parseProtocolUrl(`downloadmgr://open?token=${TOKEN}`, TOKEN), {
    ok: true,
    action: 'open',
    url: null,
  });
  assert.equal(parseProtocolUrl('downloadmgr://open', TOKEN).code, 'BAD_TOKEN');
  assert.equal(parseProtocolUrl(`downloadmgr://open?token=${mintToken()}`, TOKEN).code, 'BAD_TOKEN');
});

test('parseProtocolUrl: unknown actions and malformed payloads refused', () => {
  assert.equal(parseProtocolUrl(makeUrl(TARGET, TOKEN, 'delete'), TOKEN).code, 'UNKNOWN_ACTION');
  assert.equal(parseProtocolUrl('downloadmgr://', TOKEN).code, 'BAD_TOKEN');
  assert.equal(parseProtocolUrl('https://example.com/?token=' + TOKEN, TOKEN).code, 'BAD_PAYLOAD');
  assert.equal(parseProtocolUrl('not a url at all', TOKEN).code, 'BAD_PAYLOAD');
  assert.equal(parseProtocolUrl('x'.repeat(MAX_INPUT_LEN + 1), TOKEN).code, 'BAD_PAYLOAD');
  assert.equal(parseProtocolUrl(null, TOKEN).code, 'BAD_PAYLOAD');
  assert.equal(parseProtocolUrl(42, TOKEN).code, 'BAD_PAYLOAD');
});

test('argv helpers: hidden flag and protocol URL extraction', () => {
  assert.equal(isHiddenLaunch(['electron', '.', '--hidden']), true);
  assert.equal(isHiddenLaunch(['electron', '.']), false);
  assert.equal(isHiddenLaunch(null), false);

  const urls = extractProtocolUrls([
    'electron',
    '.',
    'downloadmgr://add?url=x&token=y',
    '--hidden',
    'DOWNLOADMGR://add?url=x&token=y',
    'https://not-protocol.example',
    42,
  ]);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith('downloadmgr://'));
});
