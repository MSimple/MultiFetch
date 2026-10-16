'use strict';

// One segment: an HTTP(S) GET writing at file offsets, with bounded retries.
// Emits progress through onProgress(bytes); mutates seg.done / seg.state.
//
// Fatal, engine-level signals thrown here:
//   SERVER_IGNORED_RANGE — a ranged request answered 200; the engine re-plans
//   RANGE_NOT_SATISFIABLE — 416 on resume; the engine re-plans from scratch

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { EngineError, classifyHttp } = require('./errors');
const { mapNetError, mergeHeaders } = require('./probe');
const { MAX_ATTEMPTS, backoffDelayMs, parseRetryAfter } = require('./retry');
const { writeAt } = require('./writer');

const SOCKET_TIMEOUT_MS = 30_000;

function abortedError() {
  return new EngineError('ABORTED', 'aborted');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortedError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * @param {{
 *   url: string, headers: Record<string,string>|null, seg: any,
 *   fh: import('node:fs/promises').FileHandle, signal: AbortSignal,
 *   limiter: {take(n:number): Promise<void>} | null,
 *   onProgress: (bytes:number) => void, log?: (msg:string)=>void,
 * }} ctx
 */
async function downloadSegment(ctx) {
  const { seg, signal } = ctx;
  const length = seg.end != null ? seg.end - seg.start + 1 : null;
  if (length != null && seg.done >= length) {
    seg.state = 'done';
    return;
  }

  let attempt = 0;
  for (;;) {
    if (signal.aborted) throw abortedError();
    try {
      await attemptOnce(ctx);
      seg.state = 'done';
      return;
    } catch (err) {
      const e = err instanceof EngineError ? err : mapNetError(err);
      if (e.code === 'ABORTED') throw e;
      if (e.code === 'SERVER_IGNORED_RANGE' || e.code === 'RANGE_NOT_SATISFIABLE') throw e;

      if (e.code === 'HTTP_429') {
        // Rate limited: wait Retry-After (or 2s), does NOT consume an attempt.
        const waitMs = e.retryAfterMs != null ? e.retryAfterMs : 2000;
        if (ctx.log) ctx.log(`segment ${seg.i}: 429, waiting ${waitMs}ms`);
        await sleep(Math.min(waitMs, 60_000), signal);
        continue;
      }
      if (!e.retryable || attempt >= MAX_ATTEMPTS) throw e;
      const delay = backoffDelayMs(attempt);
      if (ctx.log) ctx.log(`segment ${seg.i}: retry ${attempt + 1}/${MAX_ATTEMPTS} in ${delay}ms (${e.message})`);
      await sleep(delay, signal);
      attempt++;
    }
  }
}

async function attemptOnce({ url, headers, seg, fh, signal, limiter, onProgress, log, ranged }) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;

  const from = seg.start + seg.done;
  const hdrs = mergeHeaders(headers);
  hdrs['Accept-Encoding'] = 'identity';
  if (ranged) {
    hdrs.Range = seg.end != null ? `bytes=${from}-${seg.end}` : `bytes=${from}-`;
  } else if (from > 0) {
    // Non-range downloads always restart at 0; a positive offset here is a bug.
    throw new EngineError('SERVER_IGNORED_RANGE', 'cannot resume a non-range download', { retryable: false });
  }

  let res;
  try {
    res = await new Promise((resolve, reject) => {
      const req = lib.request(u, { method: 'GET', headers: hdrs, signal }, resolve);
      req.setTimeout(SOCKET_TIMEOUT_MS, () => {
        req.destroy(new EngineError('TIMEOUT', 'socket timeout', { retryable: true }));
      });
      req.on('error', reject);
      req.end();
    });
  } catch (err) {
    throw mapNetError(err);
  }

  const status = res.statusCode || 0;

  if (status === 429) {
    const ra = parseRetryAfter(res.headers['retry-after']);
    res.resume();
    const e = classifyHttp(429);
    e.retryAfterMs = ra;
    throw e;
  }
  if (status === 416) {
    res.resume();
    throw new EngineError('RANGE_NOT_SATISFIABLE', 'HTTP 416', { retryable: false, status: 416 });
  }
  if (status === 200 && ranged && (seg.end != null || from > 0)) {
    // We asked for a byte range and got the whole object: either the server
    // ignores Range or the resource changed under us. Never write it at an
    // offset — hand it back to the engine to re-plan.
    res.resume();
    throw new EngineError('SERVER_IGNORED_RANGE', 'HTTP 200 for a ranged request', { retryable: false, status: 200 });
  }
  if (status >= 400 || (status !== 200 && status !== 206)) {
    res.resume();
    throw classifyHttp(status);
  }

  seg.state = 'active';
  let pos = from;
  try {
    for await (const chunk of res) {
      if (signal.aborted) throw abortedError();
      // Work stealing may have shrunk seg.end under this in-flight request.
      // Everything through the (new) end is already on disk, so stop early;
      // breaking destroys the response via the iterator protocol.
      if (seg.end != null && pos > seg.end) break;
      if (limiter) await limiter.take(chunk.length);
      await writeAt(fh, chunk, pos);
      pos += chunk.length;
      seg.done = pos - seg.start;
      onProgress(chunk.length);
    }
  } catch (err) {
    res.destroy();
    throw err instanceof EngineError ? err : mapNetError(err);
  }

  if (seg.end != null && pos <= seg.end) {
    if (log) log(`segment ${seg.i}: short read at ${pos} (expected through ${seg.end})`);
    throw new EngineError('SHORT_READ', `short read: got ${pos}, expected through ${seg.end}`, { retryable: true });
  }
}

module.exports = { downloadSegment, sleep };
