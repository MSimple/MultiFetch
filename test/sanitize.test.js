'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sanitizeFilename,
  containedPath,
  verifyTargetPath,
  MAX_TOTAL_LEN,
} = require('../app/main/security/sanitize');

// [input, expectedName]
const OK_CASES = [
  // traversal / path furniture -> basename only
  ['..\\..\\Windows\\System32\\evil.exe', 'evil.exe'],
  ['..\\..\\..\\..\\evil.bat', 'evil.bat'],
  ['C:\\x\\y', 'y'],
  ['\\\\srv\\share\\a', 'a'],
  ['/etc/passwd', 'passwd'],
  ['..\\evil', 'evil'],
  ['a\\b', 'b'],
  ['C:', 'C'],
  // forbidden characters
  ['a<b>c|d?e*f', 'abcdef'],
  ['file.txt:ads', 'file.txtads'],
  ['"quoted".txt', 'quoted.txt'],
  // whitespace / trailing dots
  ['"  spaced.  "', 'spaced'],
  ['  .hidden  ', '.hidden'],
  ['name.', 'name'],
  ['name . . ', 'name'],
  ['evil.exe...', 'evil.exe'],
  ['a b c.txt', 'a b c.txt'],
  // control / bidi stripping
  ['a\u0000b', 'ab'],
  ['a\u202Eb', 'ab'],
  ['\u202Egnp.exe', 'gnp.exe'],
  ['\u2066a\u2069', 'a'],
  // reserved device names
  ['CON', '_CON'],
  ['con', '_con'],
  ['CON.txt', '_CON.txt'],
  ['NUL', '_NUL'],
  ['NUL.txt', '_NUL.txt'],
  ['COM9', '_COM9'],
  ['com1', '_com1'],
  ['COM0', '_COM0'],
  ['LPT1.log', '_LPT1.log'],
  ['AUX', '_AUX'],
  ['PRN.m3u8', '_PRN.m3u8'],
  ['CONIN$', '_CONIN$'],
  // unicode
  ['影片.mp4', '影片.mp4'],
  ['cafe\u0301.mp4', 'caf\u00e9.mp4'], // NFC normalization
  ['.gitignore', '.gitignore'],
];

// [input, expectedCode]
const BAD_CASES = [
  ['', 'EMPTY_NAME'],
  ['   ', 'EMPTY_NAME'],
  ['.', 'EMPTY_NAME'],
  ['..', 'EMPTY_NAME'],
  ['  ..  ', 'EMPTY_NAME'],
  ['...', 'EMPTY_NAME'],
  ['\\', 'EMPTY_NAME'],
  [42, 'EMPTY_NAME'],
  [null, 'EMPTY_NAME'],
  [{}, 'EMPTY_NAME'],
];

test('sanitizeFilename: hostile inputs reduce to safe basenames', () => {
  for (const [input, want] of OK_CASES) {
    const r = sanitizeFilename(input);
    assert.equal(r.ok, true, `expected ok for ${JSON.stringify(input)}, got ${JSON.stringify(r)}`);
    assert.equal(r.name, want, `input ${JSON.stringify(input)}`);
    // universal post-conditions
    assert.ok(!r.name.includes('/') && !r.name.includes('\\'), 'no separators survive');
    assert.ok(r.name !== '.' && r.name !== '..');
    assert.ok(Array.from(r.name).length <= MAX_TOTAL_LEN, 'length budget holds');
    assert.doesNotThrow(() => encodeURIComponent(r.name), 'well-formed unicode (no lone surrogate)');
  }
});

test('sanitizeFilename: empty/dot-only/invalid inputs are refused', () => {
  for (const [input, code] of BAD_CASES) {
    const r = sanitizeFilename(input);
    assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(input)}`);
    assert.equal(r.code, code);
  }
});

test('sanitizeFilename: long names truncate by code points, never split surrogates', () => {
  const long = sanitizeFilename('x'.repeat(300) + '.txt');
  assert.equal(long.ok, true);
  assert.ok(long.name.endsWith('.txt'));
  assert.ok(Array.from(long.name).length <= MAX_TOTAL_LEN);
  assert.ok(Array.from(long.name).length >= 100, 'keeps a useful amount of the stem');

  const emoji = sanitizeFilename('\uD83C\uDFAC'.repeat(60) + '.mp4'); // 60 film emoji
  assert.equal(emoji.ok, true);
  assert.doesNotThrow(() => encodeURIComponent(emoji.name));
  assert.ok(emoji.name.endsWith('.mp4'));

  const longExt = sanitizeFilename('a.' + 'b'.repeat(30));
  assert.equal(longExt.ok, true);
  assert.equal(longExt.name.split('.').pop().length, 16, 'extension capped at 16 chars');
});

test('containedPath: refuses escapes, accepts in-dir names, case-insensitive base', () => {
  const sep = path.sep;
  const dir = 'C:\\dl';

  const ok = containedPath(dir, 'ok.txt');
  assert.equal(ok.ok, true);
  assert.equal(ok.path, path.resolve(dir, 'ok.txt'));

  const sub = containedPath(dir, 'sub\\file.bin');
  assert.equal(sub.ok, true, 'subdirectory target stays inside');

  for (const evil of [
    '..' + sep + 'evil.txt',
    '..' + sep + '..' + sep + 'evil.txt',
    'a' + sep + '..' + sep + '..' + sep + 'evil.txt',
    'C:\\other\\x.txt', // absolute path ignores the base
  ]) {
    const r = containedPath(dir, evil);
    assert.equal(r.ok, false, `expected escape refusal for ${evil}`);
    assert.equal(r.code, 'ESCAPES_DIR');
  }

  const self = containedPath(dir, '.');
  assert.equal(self.ok, false);
  assert.equal(self.code, 'UNSAFE_NAME');

  const empty = containedPath(dir, '');
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'EMPTY_NAME');

  const caseInsensitive = containedPath('C:\\DL', 'file.txt');
  assert.equal(caseInsensitive.ok, true);
});

test('verifyTargetPath: refuses existing directories, accepts fresh names', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-sanitize-'));
  try {
    await fs.promises.mkdir(path.join(dir, 'sub'));

    const refused = await verifyTargetPath(dir, 'sub');
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'UNSAFE_NAME');

    const fresh = await verifyTargetPath(dir, 'fresh.txt');
    assert.equal(fresh.ok, true);
    assert.equal(fresh.path, path.join(dir, 'fresh.txt'));

    const esc = await verifyTargetPath(dir, '..' + path.sep + 'outside.txt');
    assert.equal(esc.ok, false);
    assert.equal(esc.code, 'ESCAPES_DIR');

    // symlink (may be unavailable without privileges on Windows; skip then)
    try {
      await fs.promises.symlink(path.join(dir, 'inner.txt'), path.join(dir, 'link.txt'));
      const linked = await verifyTargetPath(dir, 'link.txt');
      assert.equal(linked.ok, false, 'symlink target refused');
    } catch {
      /* EPERM: symlink creation not permitted here — skip */
    }
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
