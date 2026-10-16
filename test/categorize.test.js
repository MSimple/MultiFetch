'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { categoryOf, extOf, categoryOfAny } = require('../app/main/util/categorize');

test('extOf: last extension, lowercased, from name or URL path', () => {
  assert.equal(extOf('a/b/c.TAR.GZ'), 'gz');
  assert.equal(extOf('https://host/dir/file.zip?token=1#frag'), 'zip');
  assert.equal(extOf('name'), '');
  assert.equal(extOf('.hidden'), '');
  assert.equal(extOf(''), '');
  assert.equal(extOf(null), '');
});

test('categoryOf: maps extensions to categories (query strings included)', () => {
  assert.equal(categoryOf('movie.mkv'), 'video');
  assert.equal(categoryOf('https://cdn.example.com/v/planet-earth-2160p.MP4'), 'video');
  assert.equal(categoryOf('song.flac'), 'audio');
  assert.equal(categoryOf('https://x/y/Pack.RAR?token=1'), 'archive');
  assert.equal(categoryOf('setup.exe'), 'program');
  assert.equal(categoryOf('installer.APK'), 'program');
  assert.equal(categoryOf('notes.pdf'), 'document');
  assert.equal(categoryOf('model.safetensors'), 'model');
  assert.equal(categoryOf('photo.JPG'), 'image');
  assert.equal(categoryOf('https://x/a/pic.webp?w=200'), 'image');
});

test('categoryOfAny: filename first, then URL fallback', () => {
  assert.equal(categoryOfAny('', 'https://x/a/photo.jpg?token=1'), 'image');
  assert.equal(categoryOfAny('file.unknown', 'https://x/m.gguf'), 'model');
  assert.equal(categoryOfAny('clip', 'https://x/clip.mp4'), 'video');
  assert.equal(categoryOfAny(null, undefined, ''), null);
});

test('categoryOf: unknown / no extension is null', () => {
  assert.equal(categoryOf('weird.zzz'), null);
  assert.equal(categoryOf('noext'), null);
  assert.equal(categoryOf(''), null);
  assert.equal(categoryOf(undefined), null);
});
