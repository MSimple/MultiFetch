'use strict';

// Loopback HTTP plumbing for the capture API: bind 127.0.0.1 ONLY, enforce a
// strict Host header (DNS-rebinding defense) and a 64 KiB body cap, then hand
// off to the route handler. This module never emits Access-Control-* headers —
// the extension reaches the API via host_permissions, so no CORS is needed
// and none is granted.

const http = require('node:http');

const BODY_LIMIT = 64 * 1024;

function createCaptureServer({ handle, host = '127.0.0.1', port = 8787, portScan = 20, log = null }) {
  let actualPort = null;

  const server = http.createServer((req, res) => {
    const reply = (status, body, extraHeaders) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) });
      res.end(JSON.stringify(body));
    };

    (async () => {
      // DNS-rebinding defense: only the exact loopback authority is accepted.
      const hostHeader = String(req.headers.host || '');
      if (actualPort && hostHeader !== `${host}:${actualPort}`) {
        return reply(403, { ok: false, error: { code: 'HOST_NOT_ALLOWED', message: 'bad Host header' } });
      }

      let url;
      try {
        url = new URL(req.url, `http://${host}:${actualPort}`);
      } catch {
        return reply(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'bad request URL' } });
      }

      // Body with a hard cap: stop reading the moment it is exceeded.
      let raw = '';
      let size = 0;
      let tooLarge = false;
      await new Promise((resolve) => {
        req.on('data', (chunk) => {
          if (tooLarge) return;
          size += chunk.length;
          if (size > BODY_LIMIT) {
            tooLarge = true;
            resolve();
            return;
          }
          raw += chunk;
        });
        req.on('end', resolve);
        req.on('error', resolve);
      });
      if (tooLarge) {
        // Respond with Connection: close and keep draining (the data listener
        // stays attached) so the client can still read the 413 instead of
        // getting a connection reset mid-upload.
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        res.end(JSON.stringify({ ok: false, error: { code: 'TOO_LARGE', message: 'body over 64 KiB' } }));
        return;
      }

      let body = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          return reply(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'invalid JSON' } });
        }
      }

      const out = await handle({
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      });
      const extra = out.retryAfterSec != null ? { 'Retry-After': String(out.retryAfterSec) } : undefined;
      reply(out.status, out.body, extra);
    })().catch((e) => {
      if (log) log.error(`capture server: ${(e && e.stack) || e}`);
      try {
        reply(500, { ok: false, error: { code: 'INTERNAL', message: 'internal error' } });
      } catch {
        /* socket already gone */
      }
    });
  });

  return {
    server,
    get port() {
      return actualPort;
    },
    /** Try port..port+portScan on 127.0.0.1; returns the bound port. */
    async start(preferred = port, scan = portScan) {
      for (let p = preferred; p <= preferred + scan; p++) {
        try {
          await new Promise((resolve, reject) => {
            const onError = (e) => {
              server.removeListener('listening', onListening);
              reject(e);
            };
            const onListening = () => {
              server.removeListener('error', onError);
              resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(p, host);
          });
          actualPort = server.address().port; // resolves ephemeral (port 0) correctly
          if (log) log.info(`capture server on http://${host}:${actualPort}`);
          return actualPort;
        } catch (e) {
          if (e.code !== 'EADDRINUSE') throw e;
        }
      }
      throw new Error(`no free capture port in ${preferred}..${preferred + scan}`);
    },
    stop() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { createCaptureServer, BODY_LIMIT };
