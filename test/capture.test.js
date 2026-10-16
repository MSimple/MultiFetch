'use strict';

// Capture API acceptance: real HTTP against a loopback-bound server instance
// with injected deps. Raw node:http is used so the Host header can be forged
// in the DNS-rebinding test. Every response is checked to be CORS-header-free.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createCaptureApi } = require('../app/main/capture/routes');
const { createCaptureServer } = require('../app/main/capture/server');
const { SecretsStore } = require('../app/main/store/secrets');
const { SettingsStore } = require('../app/main/store/settings');

const EXT_A = 'chrome-extension://' + 'a'.repeat(32);
const EXT_B = 'chrome-extension://' + 'b'.repeat(32);

async function setup() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dm-capture-'));
  const secrets = new SecretsStore({ file: path.join(dir, 'security.json') });
  await secrets.load();
  const settings = new SettingsStore({ file: path.join(dir, 'settings.json') });
  await settings.load();

  const sinkCalls = [];
  const api = createCaptureApi({
    secrets,
    settings,
    version: 'test',
    getQueueStats: () => ({ active: 0, queued: sinkCalls.length, maxConcurrent: 3 }),
    taskSink: async (item) => {
      sinkCalls.push(item);
      return { taskId: 't_' + String(sinkCalls.length).padStart(12, '0'), status: 'pending-confirm' };
    },
  });
  const srv = createCaptureServer({ handle: api.handle });
  const port = await srv.start(0, 0);

  return {
    dir,
    secrets,
    settings,
    api,
    srv,
    port,
    sinkCalls,
    token: secrets.get().captureToken,
    async cleanup() {
      await srv.stop();
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}

function request(port, { method = 'GET', path: reqPath = '/v1/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (payload) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* non-JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const auth = (env, extra = {}) => ({ 'X-DM-Token': env.token, ...extra });

test('health is open, leak-free, and every response is CORS-header-free', async () => {
  const env = await setup();
  try {
    const r = await request(env.port, { path: '/v1/health' });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.data.app, 'downloadmgr');
    assert.equal(r.json.data.paired, false);
    assert.equal('token' in r.json.data, false);
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no ACAO ever');
    assert.equal(r.headers['access-control-allow-headers'], undefined);

    // even error responses stay CORS-free
    const r2 = await request(env.port, { path: '/v1/nope' });
    assert.equal(r2.headers['access-control-allow-origin'], undefined);
  } finally {
    await env.cleanup();
  }
});

test('auth: token required, native callers allowed, unlisted origins refused', async () => {
  const env = await setup();
  try {
    assert.equal((await request(env.port, { path: '/v1/status' })).status, 401);
    assert.equal(
      (await request(env.port, { path: '/v1/status', headers: { 'X-DM-Token': 'nope' } })).status,
      401
    );
    assert.equal((await request(env.port, { path: '/v1/status', headers: auth(env) })).status, 200);

    const evil = await request(env.port, {
      path: '/v1/status',
      headers: auth(env, { Origin: 'https://evil.example' }),
    });
    assert.equal(evil.status, 403);
    assert.equal(evil.json.error.code, 'FORBIDDEN_ORIGIN');

    const extUnpinned = await request(env.port, { path: '/v1/status', headers: auth(env, { Origin: EXT_A }) });
    assert.equal(extUnpinned.status, 403, 'extension origin is not allowed until paired');
  } finally {
    await env.cleanup();
  }
});

test('pairing: code + extension origin required, single-use, then items flow', async () => {
  const env = await setup();
  try {
    // no live code yet
    const noSession = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_A },
      body: { code: '123456' },
    });
    assert.equal(noSession.status, 403);
    assert.equal(noSession.json.error.code, 'BAD_PAIRING_CODE');

    // web-page origins can never pair
    const { code } = env.api.startPairing();
    const webOrigin = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: 'https://evil.example' },
      body: { code },
    });
    assert.equal(webOrigin.status, 403);
    assert.equal(webOrigin.json.error.code, 'BAD_ORIGIN');

    // wrong code
    const wrong = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_A },
      body: { code: code === '000000' ? '111111' : '000000' },
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.json.error.code, 'BAD_PAIRING_CODE');

    // correct code pins the origin and returns the token
    const good = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_A },
      body: { code },
    });
    assert.equal(good.status, 200);
    assert.equal(good.json.data.token, env.token);
    assert.equal(good.json.data.protocolToken, env.secrets.get().protocolToken, 'cold-launch token handed over');
    assert.deepEqual(env.settings.get().capture.allowedOrigins, [EXT_A]);

    // single use
    const again = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_B },
      body: { code },
    });
    assert.equal(again.status, 403, 'a burned code cannot pair a second extension');

    // items flow with the paired origin
    const item = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: auth(env, { Origin: EXT_A }),
      body: { url: 'https://example.com/video.mp4', filename: '影片.mp4', size: 12345 },
    });
    assert.equal(item.status, 202);
    assert.equal(item.json.data.status, 'pending-confirm');
    assert.equal(env.sinkCalls.length, 1);
    assert.equal(env.sinkCalls[0].url, 'https://example.com/video.mp4');

    // dedupe: same url within the window
    const dupe = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: auth(env, { Origin: EXT_A }),
      body: { url: 'https://example.com/video.mp4' },
    });
    assert.equal(dupe.status, 202);
    assert.equal(dupe.json.data.status, 'deduped');
    assert.equal(dupe.json.data.taskId, item.json.data.taskId);
    assert.equal(env.sinkCalls.length, 1, 'dedupe never reaches the task sink');

    // the other extension origin stays locked out
    const other = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: auth(env, { Origin: EXT_B }),
      body: { url: 'https://example.com/b.bin' },
    });
    assert.equal(other.status, 403);

    // recent list + status
    const recent = await request(env.port, { path: '/v1/items?limit=5', headers: auth(env, { Origin: EXT_A }) });
    assert.equal(recent.status, 200);
    assert.equal(recent.json.data.items.length, 1);
    const status = await request(env.port, { path: '/v1/status', headers: auth(env, { Origin: EXT_A }) });
    assert.equal(status.json.data.queue.queued, 1);

    // revoke kills the origin immediately
    env.api.revokeOrigin(EXT_A);
    const revoked = await request(env.port, { path: '/v1/status', headers: auth(env, { Origin: EXT_A }) });
    assert.equal(revoked.status, 403);
  } finally {
    await env.cleanup();
  }
});

test('pairing: absent Origin (extension SW fetch) accepted via asserted extensionOrigin', async () => {
  const env = await setup();
  try {
    const { code } = env.api.startPairing();
    // No Origin header at all + body assertion = extension SW path.
    const r = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      body: { code, extensionOrigin: EXT_B },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(env.settings.get().capture.allowedOrigins, [EXT_B]);

    // absent Origin + garbage assertion stays refused
    const { code: code2 } = env.api.startPairing();
    const bad = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      body: { code: code2, extensionOrigin: 'https://evil.example' },
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error.code, 'BAD_ORIGIN');
  } finally {
    await env.cleanup();
  }
});

test('auto-pair: extensions pair without a code; web pages never can', async () => {
  const env = await setup();
  try {
    const auto = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_A },
      body: { auto: true },
    });
    assert.equal(auto.status, 200);
    assert.equal(auto.json.data.auto, true);
    assert.equal(auto.json.data.token, env.token);
    assert.deepEqual(env.settings.get().capture.allowedOrigins, [EXT_A]);

    // a web-page origin with the auto flag is refused at the origin gate
    const web = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: 'https://evil.example' },
      body: { auto: true },
    });
    assert.equal(web.status, 403);
    assert.equal(web.json.error.code, 'BAD_ORIGIN');

    // SW-style fetch (no Origin header, asserted extension origin) also pairs
    const sw = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      body: { auto: true, extensionOrigin: EXT_B },
    });
    assert.equal(sw.status, 200);
    assert.equal(env.settings.get().capture.allowedOrigins.length, 2);

    // switching auto pairing off in the app refuses further auto pairs
    env.settings.patch({ capture: { ...env.settings.get().capture, autoPair: false } });
    const off = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: 'chrome-extension://' + 'c'.repeat(32) },
      body: { auto: true },
    });
    assert.equal(off.status, 403);
    assert.equal(off.json.error.code, 'AUTO_PAIR_DISABLED');
  } finally {
    await env.cleanup();
  }
});

test('revoked origin is blocked from auto-pair; a manual code re-admits it', async () => {
  const env = await setup();
  try {
    const auto = (origin) =>
      request(env.port, { method: 'POST', path: '/v1/pair', headers: { Origin: origin }, body: { auto: true } });

    assert.equal((await auto(EXT_A)).status, 200);
    env.api.revokeOrigin(EXT_A);
    const cap = env.settings.get().capture;
    assert.deepEqual(cap.allowedOrigins, []);
    assert.ok(cap.blockedOrigins.includes(EXT_A), 'revocation is remembered');

    const blocked = await auto(EXT_A);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'ORIGIN_BLOCKED', 'auto-pair cannot undo a revoke');

    // manual code pairing is an explicit decision and clears the block
    const { code } = env.api.startPairing();
    const manual = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_A },
      body: { code },
    });
    assert.equal(manual.status, 200);
    const after = env.settings.get().capture;
    assert.ok(after.allowedOrigins.includes(EXT_A));
    assert.ok(!after.blockedOrigins.includes(EXT_A));
  } finally {
    await env.cleanup();
  }
});

test('auto-pair stops at the origin cap', async () => {
  const env = await setup();
  try {
    for (const ch of 'abcdefghij') {
      const origin = 'chrome-extension://' + ch.repeat(32);
      const r = await request(env.port, {
        method: 'POST',
        path: '/v1/pair',
        headers: { Origin: origin },
        body: { auto: true },
      });
      assert.equal(r.status, 200, origin);
    }
    const extra = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: 'chrome-extension://' + 'k'.repeat(32) },
      body: { auto: true },
    });
    assert.equal(extra.status, 403);
    assert.equal(extra.json.error.code, 'TOO_MANY_ORIGINS');
  } finally {
    await env.cleanup();
  }
});

test('pairing code expires', async () => {
  const env = await setup();
  try {
    const { code } = env.api.startPairing(1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 20));
    const r = await request(env.port, {
      method: 'POST',
      path: '/v1/pair',
      headers: { Origin: EXT_A },
      body: { code },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'BAD_PAIRING_CODE');
    assert.equal(env.settings.get().capture.allowedOrigins.length, 0);
  } finally {
    await env.cleanup();
  }
});

test('item validation: schemes, unknown fields, batch limits', async () => {
  const env = await setup();
  try {
    const H = auth(env); // native caller: no Origin header at all
    const badScheme = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: H,
      body: { url: 'file:///C:/evil.exe' },
    });
    assert.equal(badScheme.status, 400);

    const unknownField = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: H,
      body: { url: 'https://example.com/a.bin', bogus: 1 },
    });
    assert.equal(unknownField.status, 400);

    const crlfHeader = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: H,
      body: { url: 'https://example.com/a.bin', headers: { 'X-A': 'b\r\nInjected: 1' } },
    });
    assert.equal(crlfHeader.status, 400, 'CRLF header injection refused');

    const bigBatch = await request(env.port, {
      method: 'POST',
      path: '/v1/items/batch',
      headers: H,
      body: { items: Array.from({ length: 51 }, (_, i) => ({ url: 'https://example.com/' + i })) },
    });
    assert.equal(bigBatch.status, 400);

    const okBatch = await request(env.port, {
      method: 'POST',
      path: '/v1/items/batch',
      headers: H,
      body: {
        items: [
          { url: 'https://example.com/one.bin' },
          { url: 'https://example.com/two.bin' },
        ],
      },
    });
    assert.equal(okBatch.status, 202);
    assert.equal(okBatch.json.data.results.length, 2);
    assert.equal(env.sinkCalls.length, 2);
  } finally {
    await env.cleanup();
  }
});

test('limits: 64 KiB body cap (413), per-token rate limit (429 + Retry-After)', async () => {
  const env = await setup();
  try {
    const huge = await request(env.port, {
      method: 'POST',
      path: '/v1/items',
      headers: auth(env),
      body: '{"url":"https://example.com/x","title":"' + 'x'.repeat(70_000) + '"}',
    });
    assert.equal(huge.status, 413);
    assert.equal(huge.json.error.code, 'TOO_LARGE');

    let last = null;
    for (let i = 0; i < 31; i++) {
      last = await request(env.port, { path: '/v1/status', headers: auth(env) });
    }
    assert.equal(last.status, 429);
    assert.equal(last.json.error.code, 'RATE_LIMITED');
    assert.ok(Number(last.headers['retry-after']) >= 1, 'Retry-After present');
  } finally {
    await env.cleanup();
  }
});

test('Host header forgery refused; token rotation invalidates immediately', async () => {
  const env = await setup();
  try {
    const forged = await request(env.port, {
      path: '/v1/status',
      headers: auth(env, { Host: 'evil.example' }),
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.json.error.code, 'HOST_NOT_ALLOWED');

    assert.equal((await request(env.port, { path: '/v1/status', headers: auth(env) })).status, 200);
    await env.secrets.rotate('capture');
    assert.equal((await request(env.port, { path: '/v1/status', headers: auth(env) })).status, 401);
  } finally {
    await env.cleanup();
  }
});
