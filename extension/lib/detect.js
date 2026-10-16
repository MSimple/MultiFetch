'use strict';

// Resource classification for the sniffer and the download takeover.
// Pure functions — unit-tested under node (test/detect.test.js) and loaded
// into the MV3 service worker via importScripts, hence the UMD wrapper.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DMQ = Object.assign(root.DMQ || {}, { detect: factory() });
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const CATEGORIES = {
    video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'm4v', '3gp', 'mpg', 'mpeg', 'wmv'],
    audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2', 'iso', 'cab'],
    program: ['exe', 'msi', 'apk', 'dmg', 'deb', 'rpm', 'appimage', 'pkg'],
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'epub', 'mobi', 'txt', 'csv'],
    model: ['gguf', 'safetensors', 'ckpt', 'pt', 'pth', 'onnx', 'h5', 'tflite'],
  };
  const CATEGORY_LABELS = {
    video: '视频',
    audio: '音频',
    archive: '压缩包',
    program: '程序/安装包',
    document: '文档',
    model: '大模型',
    image: '图片',
  };

  // Images are sniffed (so the popup can show thumbnails) but are NOT a
  // takeover category by default — they only get intercepted when the user
  // adds the extension to the custom list.
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'tif', 'tiff'];
  const MIN_IMAGE_SIZE = 24 * 1024; // skip icons/sprites/pixels

  const MIN_MEDIA_SIZE = 200 * 1024; // plain media below this is usually a probe/preview
  const BINARY_MIME = /^application\/(octet-stream|x-msdownload|x-msdos-program|zip|x-rar-compressed|x-7z-compressed|gzip|x-tar|pdf|vnd\.android\.package-archive)/i;
  const STREAM_MANIFEST = /\.(m3u8|mpd)(\?|$|#)/i;

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

  function categoryOfExt(ext) {
    if (!ext) return null;
    for (const [cat, list] of Object.entries(CATEGORIES)) {
      if (list.includes(ext)) return cat;
    }
    return null;
  }

  function normalizeExtList(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((e) => String(e).trim().replace(/^\./, '').toLowerCase())
      .filter(Boolean);
  }

  /** @param {string} url @param {string[]} ignoreList hostnames and/or URL substrings */
  function isIgnored(url, ignoreList) {
    if (!Array.isArray(ignoreList) || ignoreList.length === 0) return false;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    const urlLower = String(url).toLowerCase();
    return ignoreList.some((entry) => {
      const e = String(entry || '').trim().toLowerCase();
      if (!e) return false;
      const looksLikeHost = !e.includes('/') && !e.includes(' ') && (e.includes('.') || e === 'localhost');
      if (looksLikeHost) return host === e || host.endsWith('.' + e);
      return urlLower.includes(e);
    });
  }

  function filenameFromDisposition(disp) {
    if (typeof disp !== 'string' || disp === '') return null;
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disp);
    if (star) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
      } catch {
        return star[1].trim();
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disp);
    return plain ? plain[1].trim() : null;
  }

  function filenameFromUrl(url) {
    try {
      const u = new URL(url);
      const base = decodeURIComponent((u.pathname.split('/').pop() || '').trim());
      if (base && base.includes('.')) return base;
      return (base || u.hostname.replace(/^www\./, '')) || 'download';
    } catch {
      return 'download';
    }
  }

  /**
   * Header-sniffing verdict for one observed response.
   * @param {{url: string, mime?: string, size?: number|null, disposition?: string}} info
   * @returns {{capture: false, reason: string} | {capture: true, tag: string, category: string|null}}
   */
  function sniffVerdict({ url, mime, size, disposition } = {}) {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return { capture: false, reason: 'scheme' };
    const mimeL = String(mime || '').toLowerCase().split(';')[0].trim();
    const isAttachment = /attachment/i.test(String(disposition || ''));
    const ext = extOf(url);

    // HLS/DASH manifests are noise until the desktop engine speaks streaming.
    if (!isAttachment && (STREAM_MANIFEST.test(url) || /(mpegurl|dash\+xml)/i.test(mimeL))) {
      return { capture: false, reason: 'stream-unsupported' };
    }
    // Junk filters: media fragments, chunked playback and API noise are never
    // standalone downloads (an explicit attachment always wins over filters).
    if (!isAttachment) {
      if (/\.(ts|m4s)(\?|$)/i.test(url)) return { capture: false, reason: 'fragment' };
      if (/videoplayback|googlevideo\.com/i.test(url)) return { capture: false, reason: 'chunked-playback' };
      if (/[?&](range|sq|rn|rbuf|itag|segment)=/i.test(url) && !ext) {
        return { capture: false, reason: 'ranged-chunk' };
      }
      if (/\/api\/|\.json(\?|$)/i.test(url)) return { capture: false, reason: 'api-noise' };
    }

    const cat = categoryOfExt(ext);
    if (cat) return { capture: true, tag: CATEGORY_LABELS[cat] || '文件', category: cat };

    // Images: only when reasonably large (or explicitly attached) so ordinary
    // page imagery does not flood the list.
    const isImage = IMAGE_EXTS.includes(ext) || /^image\//i.test(mimeL);
    if (isImage && (isAttachment || (size != null && size >= MIN_IMAGE_SIZE))) {
      return { capture: true, tag: CATEGORY_LABELS.image, category: 'image' };
    }

    if (isAttachment) return { capture: true, tag: '文件', category: null };

    if (/^(video|audio)\//i.test(mimeL) && (size == null || size >= MIN_MEDIA_SIZE)) {
      const video = mimeL.startsWith('video/');
      return { capture: true, tag: video ? '视频' : '音频', category: video ? 'video' : 'audio' };
    }
    if (BINARY_MIME.test(mimeL) && size != null && size >= 1024 * 1024) {
      return { capture: true, tag: '文件', category: null };
    }
    return { capture: false, reason: 'unclassified' };
  }

  /**
   * Takeover decision for a download the BROWSER is about to start.
   * (The caller additionally gates on the app being paired and reachable.)
   * @param {{url?: string, filename?: string, mime?: string, size?: number, byExtensionId?: string}} item
   * @param {object} settings
   */
  function shouldIntercept({ url, filename, mime, size, byExtensionId } = {}, settings) {
    if (!settings || settings.takeover !== true) return false;
    if (byExtensionId) return false; // downloads started by other extensions stay theirs
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return false; // blob:, data:, file:
    if (isIgnored(url, settings.ignore)) return false;
    if (settings.minSize > 0 && Number.isFinite(size) && size > 0 && size < settings.minSize * 1024 * 1024) {
      return false;
    }
    const mimeL = String(mime || '').toLowerCase();
    const cats = settings.categories || {};
    if (cats.video !== false && mimeL.startsWith('video/')) return true;
    if (cats.audio !== false && mimeL.startsWith('audio/')) return true;
    const ext = extOf(filename || url);
    if (!ext) return false;
    if (normalizeExtList(settings.customExt).includes(ext)) return true;
    const cat = categoryOfExt(ext);
    if (!cat) return false;
    return cats[cat] !== false;
  }

  return {
    CATEGORIES,
    CATEGORY_LABELS,
    IMAGE_EXTS,
    MIN_IMAGE_SIZE,
    MIN_MEDIA_SIZE,
    extOf,
    categoryOfExt,
    isIgnored,
    filenameFromDisposition,
    filenameFromUrl,
    sniffVerdict,
    shouldIntercept,
    normalizeExtList,
  };
});
