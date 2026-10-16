'use strict';

// Task classification by file extension. Pure — mirrors the extension's
// category lists (extension/lib/detect.js) so the app and the browser agree on
// what a "video" or "archive" is. Electron-free and unit-tested.

const CATEGORIES = {
  video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'm4v', '3gp', 'mpg', 'mpeg', 'wmv', 'ts', 'm2ts'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'tif', 'tiff', 'heic'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff', 'ape'],
  program: ['exe', 'msi', 'apk', 'dmg', 'deb', 'rpm', 'appimage', 'pkg', 'appx', 'msix'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'iso', 'cab', 'tgz'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'mobi', 'txt', 'csv', 'rtf', 'md'],
  model: ['gguf', 'safetensors', 'ckpt', 'pt', 'pth', 'onnx', 'h5', 'tflite', 'bin'],
};

const CATEGORY_ORDER = ['image', 'video', 'audio', 'program', 'archive', 'document', 'model'];

/** Extension (lowercase, no dot) of a file name or URL path. */
function extOf(nameOrUrl) {
  if (typeof nameOrUrl !== 'string') return '';
  let pathname = nameOrUrl;
  try {
    pathname = new URL(nameOrUrl).pathname;
  } catch {
    /* plain path */
  }
  const base = pathname.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** @returns {string|null} a CATEGORY key, or null when it cannot be classified. */
function categoryOf(nameOrUrl) {
  const ext = extOf(nameOrUrl);
  if (!ext) return null;
  for (const [cat, list] of Object.entries(CATEGORIES)) {
    if (list.includes(ext)) return cat;
  }
  return null;
}

/** First non-null classification among the given names (e.g. filename, then URL). */
function categoryOfAny(...names) {
  for (const n of names) {
    if (!n) continue;
    const c = categoryOf(n);
    if (c) return c;
  }
  return null;
}

module.exports = { CATEGORIES, CATEGORY_ORDER, extOf, categoryOf, categoryOfAny };
