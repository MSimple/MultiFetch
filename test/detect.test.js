'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldIntercept,
  sniffVerdict,
  isIgnored,
  extOf,
  categoryOfExt,
  filenameFromDisposition,
  filenameFromUrl,
} = require('../extension/lib/detect');

const MiB = 1024 * 1024;

const BASE_SETTINGS = {
  takeover: true,
  categories: { video: true, audio: true, archive: true, program: true, document: true, model: true },
  customExt: [],
  minSize: 0,
  ignore: [],
};

test('extOf / categoryOfExt: extensions map to categories', () => {
  assert.equal(extOf('https://x.com/f.zip?token=1'), 'zip');
  assert.equal(extOf('C:\\Users\\a\\File.MP4'), 'mp4');
  assert.equal(extOf('noext'), '');
  assert.equal(categoryOfExt('mp4'), 'video');
  assert.equal(categoryOfExt('exe'), 'program');
  assert.equal(categoryOfExt('gguf'), 'model');
  assert.equal(categoryOfExt('ts'), null, 'ts is a stream fragment, not a video category');
  assert.equal(categoryOfExt('xyz'), null);
});

test('sniffVerdict: known extensions and attachments are captured', () => {
  for (const [url, tag] of [
    ['https://cdn.example.com/video.mp4', '视频'],
    ['https://example.com/setup.exe', '程序/安装包'],
    ['https://example.com/archive.zip?x=1', '压缩包'],
    ['https://example.com/book.pdf', '文档'],
    ['https://example.com/model.gguf', '大模型'],
  ]) {
    const v = sniffVerdict({ url, mime: 'application/octet-stream' });
    assert.equal(v.capture, true, url);
    assert.equal(v.tag, tag);
  }
  const att = sniffVerdict({ url: 'https://example.com/blob', disposition: 'attachment; filename="a.bin"' });
  assert.equal(att.capture, true);
  assert.equal(att.tag, '文件');
});

test('sniffVerdict: junk filters — fragments, chunked playback, API noise, streams', () => {
  assert.equal(sniffVerdict({ url: 'https://x.com/seg-1.ts?p=1' }).reason, 'fragment');
  assert.equal(sniffVerdict({ url: 'https://x.com/v/seg.m4s' }).reason, 'fragment');
  assert.equal(sniffVerdict({ url: 'https://rr1---sn.googlevideo.com/videoplayback?itag=137' }).reason, 'chunked-playback');
  assert.equal(sniffVerdict({ url: 'https://x.com/media?range=0-1024' }).reason, 'ranged-chunk');
  assert.equal(sniffVerdict({ url: 'https://x.com/api/session.json' }).reason, 'api-noise');
  assert.equal(sniffVerdict({ url: 'https://x.com/stream/master.m3u8', mime: 'application/vnd.apple.mpegurl' }).reason, 'stream-unsupported');
  assert.equal(sniffVerdict({ url: 'https://x.com/manifest.mpd' }).reason, 'stream-unsupported');
  assert.equal(sniffVerdict({ url: 'ftp://x.com/a.mp4' }).reason, 'scheme');
  // an explicit attachment always wins over the junk filters
  const att = sniffVerdict({ url: 'https://x.com/v/track.ts', disposition: 'attachment' });
  assert.equal(att.capture, true);
});

test('sniffVerdict: images captured only when large or explicitly attached', () => {
  assert.equal(sniffVerdict({ url: 'https://x.com/photo.jpg', size: 100 * 1024 }).category, 'image');
  assert.equal(sniffVerdict({ url: 'https://x.com/i', mime: 'image/png', size: 64 * 1024 }).category, 'image');
  assert.equal(sniffVerdict({ url: 'https://x.com/thumb.jpg', size: 4096 }).reason, 'unclassified', 'tiny image skipped');
  assert.equal(sniffVerdict({ url: 'https://x.com/p.jpg' }).reason, 'unclassified', 'unknown-size image skipped');
  const att = sniffVerdict({ url: 'https://x.com/pic.png', disposition: 'attachment', size: 1024 });
  assert.equal(att.capture, true);
  assert.equal(att.category, 'image', 'attached image is captured even below the floor');
});

test('sniffVerdict: mime + size heuristics', () => {
  assert.equal(sniffVerdict({ url: 'https://x.com/v', mime: 'video/mp4', size: 5 * MiB }).capture, true);
  assert.equal(sniffVerdict({ url: 'https://x.com/v', mime: 'video/mp4', size: null }).capture, true, 'unknown size still counts');
  assert.equal(
    sniffVerdict({ url: 'https://x.com/probe', mime: 'video/mp4', size: 64 * 1024 }).reason,
    'unclassified',
    'tiny media is usually a probe'
  );
  assert.equal(sniffVerdict({ url: 'https://x.com/blob', mime: 'application/octet-stream', size: 2 * MiB }).capture, true);
  assert.equal(
    sniffVerdict({ url: 'https://x.com/blob', mime: 'application/octet-stream', size: 512 * 1024 }).reason,
    'unclassified'
  );
  assert.equal(sniffVerdict({ url: 'https://x.com/page', mime: 'text/html', size: 10 * MiB }).reason, 'unclassified');
});

test('shouldIntercept: takeover gates', () => {
  const okVideo = { url: 'https://x.com/a.mp4', mime: 'video/mp4', filename: 'a.mp4' };
  assert.equal(shouldIntercept(okVideo, BASE_SETTINGS), true);

  assert.equal(shouldIntercept(okVideo, { ...BASE_SETTINGS, takeover: false }), false, 'master switch');
  assert.equal(
    shouldIntercept({ ...okVideo, url: 'blob:https://x.com/123' }, BASE_SETTINGS),
    false,
    'blob URLs never intercepted'
  );
  assert.equal(
    shouldIntercept({ ...okVideo, byExtensionId: 'abc' }, BASE_SETTINGS),
    false,
    'other extensions keep their downloads'
  );
  assert.equal(
    shouldIntercept(okVideo, { ...BASE_SETTINGS, categories: { ...BASE_SETTINGS.categories, video: false } }),
    false,
    'disabled category'
  );
  assert.equal(
    shouldIntercept({ url: 'https://x.com/f.bin', filename: 'f.bin' }, BASE_SETTINGS),
    false,
    'unknown extension not intercepted'
  );
  assert.equal(
    shouldIntercept({ url: 'https://x.com/f.psd', filename: 'f.psd' }, { ...BASE_SETTINGS, customExt: ['psd'] }),
    true,
    'custom extension intercepted'
  );
  assert.equal(
    shouldIntercept({ ...okVideo, size: 100 * 1024 }, { ...BASE_SETTINGS, minSize: 1 }),
    false,
    'below the size floor'
  );
  assert.equal(
    shouldIntercept(okVideo, { ...BASE_SETTINGS, ignore: ['x.com'] }),
    false,
    'ignored host'
  );
  assert.equal(
    shouldIntercept({ url: 'https://y.com/a.mp3', mime: 'audio/mpeg' }, BASE_SETTINGS),
    true,
    'audio mime shortcut'
  );
});

test('isIgnored: hostname suffix rules, no substring false-positives for hosts', () => {
  assert.equal(isIgnored('https://cdn.example.com/x.bin', ['example.com']), true);
  assert.equal(isIgnored('https://evil-example.com.attacker.net/x', ['example.com']), false);
  assert.equal(isIgnored('https://cdn.example.com/track/collect', ['track']), true, 'non-host entries are substrings');
  assert.equal(isIgnored('https://other.org/x', ['example.com']), false);
  assert.equal(isIgnored('https://anything/x', []), false);
});

test('filename helpers', () => {
  assert.equal(filenameFromDisposition('attachment; filename="影片.mp4"'), '影片.mp4');
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E7%89%87.mp4"), '片.mp4');
  assert.equal(filenameFromDisposition('inline'), null);
  assert.equal(filenameFromUrl('https://x.com/a/b/setup.exe?token=1'), 'setup.exe');
  assert.equal(filenameFromUrl('https://x.com/'), 'x.com');
});
