'use strict';

// Ranged-GET probe: learns total size, Range support, final (post-redirect)
// URL, validators and a server-suggested filename.
//
// Uses node:http/https directly (NOT fetch): we need byte-exact control of
// headers and must never have responses transparently decompressed, because
// segment offsets are raw byte positions in the file on disk.
// TLS verification is always on — no option anywhere disables it.

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { EngineError, classifyHttp } = require('./errors');
const { parseRetryAfter } = require('./retry');

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 15_000;

const DEFAULT_HEADERS = Object.freeze({
  'User-Agent': 'downloadmgr/0.1',
  Accept: '*/*',
  'Accept-Encoding': 'identity', // never gzip: offsets must be exact
});

const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function mergeHeaders(user) {
  const h = { ...DEFAULT_HEADERS };
  if (user) {
    for (const k of Object.keys(user)) {
      const existing = Object.keys(h).find((x) => x.toLowerCase() === k.toLowerCase());
      if (existing) delete h[existing];
      h[k] = user[k];
    }
  }
  return h;
}

function mapNetError(err) {
  if (err instanceof EngineError) return err;
  if (err && err.name === 'AbortError') return new EngineError('ABORTED', 'aborted');
  const code = (err && err.code) || 'UNKNOWN';
  if (TLS_ERROR_CODES.has(code)) {
    return new EngineError(`TLS_${code}`, `TLS verification failed: ${code}`, { retryable: false });
  }
  const retryable = /^ECONN|^ETIMEDOUT|^EAI_|^EPIPE|^ECONNRESET/.test(code) || code === 'UND_ERR_SOCKET';
  return new EngineError(`NET_${code}`, err.message || String(err), { retryable });
}

/** Single request; resolves with the live IncomingMessage (caller drains it). */
function requestOnce(u, headers, { signal, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, signal }, resolve);
    req.setTimeout(CONNECT_TIMEOUT_MS, () => {
      req.destroy(new EngineError('TIMEOUT', 'connection timeout', { retryable: true }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Parse Content-Disposition (RFC 6266 + RFC 5987 filename*). */
function parseContentDisposition(cd) {
  if (typeof cd !== 'string' || cd === '') return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : null;
}

/**
 * @param {string} rawUrl
 * @param {Record<string,string>|null} userHeaders
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{url:string, finalUrl:string, totalBytes:number|null,
 *   supportsRange:boolean, etag:string|null, lastModified:string|null,
 *   filenameHint:string|null}>}
 */
async function probe(rawUrl, userHeaders, { signal } = {}) {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      throw new EngineError('BAD_URL', `invalid URL: ${current}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new EngineError('BAD_URL', `unsupported scheme: ${u.protocol}`);
    }

    let res;
    try {
      res = await requestOnce(u, { ...mergeHeaders(userHeaders), Range: 'bytes=0-' }, { signal });
    } catch (err) {
      throw mapNetError(err);
    }

    const status = res.statusCode || 0;
    const headers = res.headers;
    const etag = headers.etag || null;
    const lastModified = headers['last-modified'] || null;
    const filenameHint = parseContentDisposition(headers['content-disposition']);

    if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
      res.resume();
      current = new URL(headers.location, u).toString();
      continue;
    }

    if (status === 416) {
      res.resume();
      // Server rejects ranges for this resource: re-probe as a plain GET.
      return probeNoRange(u, userHeaders, { signal, etag, lastModified, filenameHint });
    }

    if (status >= 400) {
      res.resume();
      const e = classifyHttp(status, u.hostname);
      if (status === 429) e.retryAfterMs = parseRetryAfter(headers['retry-after']);
      throw e;
    }

    let totalBytes = null;
    let supportsRange = false;
    if (status === 206) {
      const m = /\/(\d+)\s*$/.exec(headers['content-range'] || '');
      if (m) totalBytes = Number.parseInt(m[1], 10);
      else if (headers['content-length'] != null) totalBytes = Number.parseInt(headers['content-length'], 10);
      supportsRange = true;
    } else {
      // 200: the server ignored our Range.
      if (headers['content-length'] != null) totalBytes = Number.parseInt(headers['content-length'], 10);
      supportsRange = headers['accept-ranges'] === 'bytes' && totalBytes != null;
    }

    res.destroy();
    return {
      url: rawUrl,
      finalUrl: u.toString(),
      totalBytes,
      supportsRange,
      etag,
      lastModified,
      filenameHint,
    };
  }
  throw new EngineError('TOO_MANY_REDIRECTS', 'redirect limit exceeded');
}

async function probeNoRange(u, userHeaders, { signal, etag, lastModified, filenameHint }) {
  let res;
  try {
    res = await requestOnce(u, mergeHeaders(userHeaders), { signal });
  } catch (err) {
    throw mapNetError(err);
  }
  const status = res.statusCode || 0;
  if (status >= 400) {
    res.resume();
    throw classifyHttp(status, u.hostname);
  }
  const totalBytes = res.headers['content-length'] != null ? Number.parseInt(res.headers['content-length'], 10) : null;
  res.destroy();
  return {
    url: u.toString(),
    finalUrl: u.toString(),
    totalBytes,
    supportsRange: false,
    etag,
    lastModified,
    filenameHint,
  };
}

module.exports = { probe, mergeHeaders, parseContentDisposition, mapNetError, DEFAULT_HEADERS };
