#!/usr/bin/env node
'use strict';

// Loopback fixture HTTP(S) server for engine tests and manual verification.
// Deterministic bodies: byte(i) = ((i ^ seed) * 2654435761) >>> 24 & 0xff —
// tests compute the expected SHA-256 with generateBody().
//
// Routes (all bind 127.0.0.1 only):
//   /range/<name>?size=N&seed=S      Range-capable; ETag "fix-<size>-<seed>"
//   /norange/<name>?size=N&seed=S    ignores Range (200 + Accept-Ranges: none)
//   /redirect?h=K&size=N&seed=S      302 chain of K hops, then /range
//   /flaky/<name>?fail=K&size&seed   first K requests -> 503, then /range
//   /ratelimit/<name>?after=K&size&seed  first K requests -> 429 Retry-After: 2
//   /slow/<name>?bps=B&size&seed     paced body (~B bytes/sec)
//   /stats                           JSON counters {requests, bytesServed, byKey}
//
// CLI:  node tools/fixture-server.js [--port 8099] [--tls]
// TLS (--tls) needs test/fixtures/{cert.pem,key.pem} (see README for the
// openssl one-liner); the self-signed cert is intentionally NOT trusted —
// engine TLS tests rely on the download FAILING against it.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

function bodyByte(i, seed) {
  return (Math.imul(i ^ seed, 2654435761) >>> 24) & 0xff;
}

function fillRange(buf, start, seed) {
  for (let i = 0; i < buf.length; i++) buf[i] = bodyByte(start + i, seed);
}

function generateBody(size, seed) {
  const b = Buffer.alloc(size);
  fillRange(b, 0, seed);
  return b;
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number.parseInt(m[1], 10);
  let end = m[2] === '' ? null : Number.parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    // suffix range: last N bytes
    const n = end;
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

function createFixtureServer({ tls = false, certDir = path.join(__dirname, '..', 'test', 'fixtures') } = {}) {
  const stats = { requests: 0, bytesServed: 0, byKey: {} };
  const counters = new Map(); // path+query -> count (flaky/ratelimit)

  function bump(key) {
    stats.requests++;
    stats.byKey[key] = (stats.byKey[key] || 0) + 1;
    return stats.byKey[key];
  }

  // Write a body while counting only what is actually handed to the socket.
  // A client that reads headers and destroys early (the probe does exactly
  // that) must not be billed for the whole body.
  function writeBody(res, buf) {
    return new Promise((resolve) => {
      let off = 0;
      const CH = 64 * 1024;
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      res.on('close', finish);
      const pump = () => {
        while (off < buf.length) {
          const start = off;
          const end = Math.min(off + CH, buf.length);
          stats.bytesServed += end - start;
          off = end;
          if (!res.write(buf.subarray(start, end))) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
        finish();
      };
      pump();
    });
  }

  function sendRange(req, res, size, seed, name) {
    const etag = `"fix-${size}-${seed}"`;
    // If-Range guard: mismatched validator -> full body (resource "changed")
    const ifRange = req.headers['if-range'];
    if (ifRange && ifRange !== etag) {
      const body = generateBody(size, seed);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, ETag: etag, 'Accept-Ranges': 'bytes' });
      void writeBody(res, body);
      return;
    }
    const range = parseRange(req.headers.range, size);
    if (!range) {
      const body = generateBody(size, seed);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename="${name || 'file.bin'}"`,
      });
      void writeBody(res, body);
      return;
    }
    if (range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    const len = range.end - range.start + 1;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': len,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      ETag: etag,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${name || 'file.bin'}"`,
    });
    // Generate the ranged body in 1 MiB chunks instead of one buffer: a
    // multi-gigabyte range (big-file tests) must not be materialized in memory.
    const CH = 1024 * 1024;
    let off = 0;
    const pump = () => {
      while (off < len) {
        if (res.destroyed || res.writableEnded) return;
        const n = Math.min(CH, len - off);
        const buf = Buffer.alloc(n);
        fillRange(buf, range.start + off, seed);
        stats.bytesServed += n;
        off += n;
        if (!res.write(buf)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  }

  function sendNoRange(res, size, seed, name) {
    const body = generateBody(size, seed);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Accept-Ranges': 'none',
      'Content-Disposition': `attachment; filename="${name || 'file.bin'}"`,
    });
    void writeBody(res, body);
  }

  // Range-capable, but bytes in the SECOND half of the file trickle at
  // SLOW_BPS — simulates a real-world slow tail that demands work stealing.
  async function sendSkewed(req, res, size, seed, name) {
    const etag = `"skew-${size}-${seed}"`;
    const range = parseRange(req.headers.range, size);
    if (range && range.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const len = end - start + 1;
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': len,
      ETag: etag,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${name || 'file.bin'}"`,
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    res.on('error', () => {});
    const buf = Buffer.alloc(len);
    fillRange(buf, start, seed);
    const CH = 64 * 1024;
    const SLOW_BPS = 2 * 1024 * 1024;
    try {
      for (let off = 0; off < len; off += CH) {
        if (res.destroyed || res.writableEnded) return;
        const slice = buf.subarray(off, Math.min(off + CH, len));
        stats.bytesServed += slice.length;
        if (!res.write(slice)) await new Promise((r) => res.once('drain', r));
        if (start + off >= size / 2) {
          await new Promise((r) => setTimeout(r, Math.max(10, Math.round((slice.length / SLOW_BPS) * 1000))));
        }
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch {
      /* client went away */
    }
  }

  async function sendSlow(req, res, size, seed, name, bps) {
    const chunk = 64 * 1024;
    const delay = Math.max(10, Math.round((chunk / bps) * 1000));
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Accept-Ranges': 'none',
      'Content-Disposition': `attachment; filename="${name || 'file.bin'}"`,
    });
    const full = generateBody(size, seed);
    for (let off = 0; off < size; off += chunk) {
      const slice = full.subarray(off, Math.min(off + chunk, size));
      stats.bytesServed += slice.length;
      if (!res.write(slice)) {
        await new Promise((r) => res.once('drain', r));
      }
      await new Promise((r) => setTimeout(r, delay));
    }
    res.end();
  }

  const handler = (req, res) => {
    let u;
    try {
      u = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const p = u.pathname;
    const q = u.searchParams;
    const size = Math.max(0, Number.parseInt(q.get('size') || '65536', 10));
    const seed = Number.parseInt(q.get('seed') || '1', 10);
    const key = p + '?' + q.toString();
    const count = bump(key);

    if (p === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    const name = p.split('/')[2] || 'file.bin';

    try {
      if (p.startsWith('/range/')) return sendRange(req, res, size, seed, name);
      if (p.startsWith('/norange/')) return sendNoRange(res, size, seed, name);
      if (p === '/redirect') {
        const hops = Math.max(0, Number.parseInt(q.get('h') || '2', 10));
        if (hops > 0) {
          q.set('h', String(hops - 1));
          res.writeHead(302, { Location: `/redirect?${q.toString()}` });
          res.end();
          return;
        }
        q.delete('h');
        res.writeHead(302, { Location: `/range/file.bin?${q.toString()}` });
        res.end();
        return;
      }
      if (p.startsWith('/flaky/')) {
        const fail = Number.parseInt(q.get('fail') || '2', 10);
        if (count <= fail) {
          res.writeHead(503);
          res.end('flaky');
          return;
        }
        return sendRange(req, res, size, seed, name);
      }
      if (p.startsWith('/ratelimit/')) {
        const after = Number.parseInt(q.get('after') || '1', 10);
        if (count <= after) {
          res.writeHead(429, { 'Retry-After': '2' });
          res.end('slow down');
          return;
        }
        return sendRange(req, res, size, seed, name);
      }
      if (p.startsWith('/slow/')) {
        const bps = Math.max(1024, Number.parseInt(q.get('bps') || '262144', 10));
        return void sendSlow(req, res, size, seed, name, bps);
      }
      if (p.startsWith('/skewed/')) return void sendSkewed(req, res, size, seed, name);
    } catch (err) {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  };

  const server = tls
    ? https.createServer(
        {
          cert: fs.readFileSync(path.join(certDir, 'cert.pem')),
          key: fs.readFileSync(path.join(certDir, 'key.pem')),
        },
        handler
      )
    : http.createServer(handler);

  return {
    server,
    stats,
    reset() {
      stats.requests = 0;
      stats.bytesServed = 0;
      stats.byKey = {};
      counters.clear();
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createFixtureServer, generateBody, bodyByte, parseRange };

if (require.main === module) {
  const args = process.argv.slice(2);
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? Number.parseInt(args[portArg + 1], 10) : 8099;
  const tls = args.includes('--tls');
  const fx = createFixtureServer({ tls });
  fx.server.listen(port, '127.0.0.1', () => {
    console.log(`fixture server on ${tls ? 'https' : 'http'}://127.0.0.1:${port}`);
    console.log('try: /range/file.bin?size=8388608&seed=7  |  /stats');
  });
}
