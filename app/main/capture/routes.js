'use strict';

// Capture API logic: pure request -> response handling over injected deps.
// The HTTP plumbing (loopback bind, Host check, body cap) lives in server.js.
// Envelope: {ok:true,data} | {ok:false,error:{code,message}}.
//
// Hard invariants (lint-enforced): no Access-Control-Allow-* header is ever
// emitted; the token compare is constant-time; pairing requires both a live
// code and a real chrome-extension:// origin.

const { validate } = require('../ipc/validate');
const { mintPairingCode, timingSafeEqualStr } = require('../security/tokens');
const { originAllowed, isExtensionOrigin } = require('./auth');
const { RateLimiter } = require('./limits');

const PAIRING_TTL_MS = 5 * 60_000;
const DEDUPE_WINDOW_MS = 10_000;
const RECENT_LIMIT = 100;
const MAX_AUTO_PINNED = 10; // upper bound for origin auto-pairing

const ITEM_SCHEMA = {
  url: 'url',
  filename: 'string?',
  size: 'int:0-9007199254740991?',
  kind: 'enum:http?',
  headers: 'headers?',
  referer: 'url?',
  title: 'string?',
};

function ok(data, status = 200) {
  return { status, body: { ok: true, data } };
}

function fail(status, code, message, extra = {}) {
  return { status, body: { ok: false, error: { code, message } }, ...extra };
}

/**
 * @param {{
 *   secrets: import('../store/secrets').SecretsStore,
 *   settings: import('../store/settings').SettingsStore,
 *   taskSink: (item: object) => Promise<{taskId: string, status: string}>,
 *   getQueueStats: () => object,
 *   version?: string,
 *   log?: any,
 * }} deps
 */
function createCaptureApi({ secrets, settings, taskSink, getQueueStats, version = '0.0.0', log = null }) {
  const perToken = new RateLimiter({ windowMs: 10_000, max: 30 });
  const globalLimiter = new RateLimiter({ windowMs: 60_000, max: 200 });
  const recent = []; // {id, url, filename, status, at}
  const dedupe = new Map(); // url -> {taskId, at}
  let pairing = null; // {code, expiresAt}

  function startPairing(ttlMs = PAIRING_TTL_MS) {
    pairing = { code: mintPairingCode(), expiresAt: Date.now() + ttlMs };
    return { code: pairing.code, expiresAt: pairing.expiresAt };
  }

  function cancelPairing() {
    pairing = null;
  }

  function getPairing() {
    if (pairing && Date.now() >= pairing.expiresAt) pairing = null;
    return pairing ? { code: pairing.code, expiresAt: pairing.expiresAt } : null;
  }

  function pinOrigin(origin) {
    const cur = settings.get().capture;
    const next = [...new Set([...cur.allowedOrigins, origin])];
    const r = settings.patch({ capture: { ...cur, allowedOrigins: next } });
    return r.ok;
  }

  function revokeOrigin(origin) {
    const cur = settings.get().capture;
    const next = cur.allowedOrigins.filter((o) => o !== origin);
    // Revocation must be sticky: without this, the extension would just
    // auto-pair again on its next attempt and the user's revoke would be moot.
    const blocked = [...new Set([...(cur.blockedOrigins || []), origin])];
    const r = settings.patch({ capture: { ...cur, allowedOrigins: next, blockedOrigins: blocked } });
    return r.ok;
  }

  function tokenPayload(extra = {}) {
    // The protocol token lets the extension cold-launch the app later
    // (downloadmgr://open); both tokens live in extension storage, never in a page.
    return ok({
      token: secrets.get().captureToken,
      protocolToken: secrets.get().protocolToken,
      api: 1,
      ...extra,
    });
  }

  async function handlePair(req, origin) {
    // Web pages always send an Origin header and can never forge one, so a
    // present-but-non-extension Origin is refused outright — that is the
    // security boundary that matters. Extension service workers doing
    // host_permissions-granted fetches MAY omit Origin entirely; in that case
    // the body must assert a well-formed chrome-extension:// origin (a page
    // cannot turn its own Origin into an extension one).
    let pinOriginValue = origin;
    if (pinOriginValue === undefined || pinOriginValue === '') {
      const asserted = req.body && typeof req.body.extensionOrigin === 'string' ? req.body.extensionOrigin : '';
      if (isExtensionOrigin(asserted)) pinOriginValue = asserted;
    }
    if (!isExtensionOrigin(pinOriginValue)) {
      return fail(403, 'BAD_ORIGIN', 'pairing requires a chrome-extension:// origin');
    }

    const cur = settings.get().capture;

    // ---- auto pairing: no code, for extensions only, while the app runs ----
    if (req.body && req.body.auto === true) {
      if (cur.autoPair === false) {
        return fail(403, 'AUTO_PAIR_DISABLED', 'auto pairing is disabled in the app settings');
      }
      if ((cur.blockedOrigins || []).includes(pinOriginValue)) {
        return fail(403, 'ORIGIN_BLOCKED', 'this extension was revoked; pair manually with a code');
      }
      if (!cur.allowedOrigins.includes(pinOriginValue) && cur.allowedOrigins.length >= MAX_AUTO_PINNED) {
        return fail(403, 'TOO_MANY_ORIGINS', `at most ${MAX_AUTO_PINNED} extensions may auto-pair`);
      }
      if (!pinOrigin(pinOriginValue)) {
        return fail(500, 'INTERNAL', 'could not pin origin');
      }
      if (log) log.info(`capture: auto-paired extension ${pinOriginValue}`);
      return tokenPayload({ auto: true });
    }

    // ---- manual pairing: live single-use code ----
    const live = getPairing();
    const code = req.body && typeof req.body.code === 'string' ? req.body.code.trim() : '';
    if (!live || !timingSafeEqualStr(code, live.code)) {
      return fail(403, 'BAD_PAIRING_CODE', 'no live pairing code or wrong code');
    }
    if (!pinOrigin(pinOriginValue)) {
      return fail(500, 'INTERNAL', 'could not pin origin');
    }
    // An explicit manual pairing clears a previous revoke.
    const after = settings.get().capture;
    if ((after.blockedOrigins || []).includes(pinOriginValue)) {
      settings.patch({
        capture: { ...after, blockedOrigins: after.blockedOrigins.filter((o) => o !== pinOriginValue) },
      });
    }
    pairing = null; // single use
    if (log) log.info(`capture: paired extension origin ${pinOriginValue}`);
    return tokenPayload();
  }

  async function handleItem(rawItem, origin) {
    const v = validate(ITEM_SCHEMA, rawItem);
    if (!v.ok) return fail(400, 'BAD_REQUEST', v.reason);
    const item = v.value;

    const now = Date.now();
    for (const [u, rec] of dedupe) if (now - rec.at > DEDUPE_WINDOW_MS) dedupe.delete(u);
    const dup = dedupe.get(item.url);
    if (dup) {
      return ok({ taskId: dup.taskId, status: 'deduped' }, 202);
    }

    let res;
    try {
      res = await taskSink(item);
    } catch (e) {
      if (log) log.warn(`capture: task sink failed: ${(e && e.message) || e}`);
      return fail(500, 'INTERNAL', 'could not create task');
    }
    dedupe.set(item.url, { taskId: res.taskId, at: now });
    recent.push({ id: res.taskId, url: item.url, filename: item.filename || null, status: res.status, at: now });
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
    if (log) log.info(`capture: item from ${origin || 'native'} -> task ${res.taskId} (${res.status})`);
    return ok(res, 202);
  }

  /**
   * @param {{method: string, path: string, query: URLSearchParams, headers: object, body: any}} req
   */
  async function handle(req) {
    const g = globalLimiter.check('global');
    if (!g.ok) {
      return fail(429, 'RATE_LIMITED', 'too many requests', {
        retryAfterSec: Math.ceil(g.retryAfterMs / 1000),
      });
    }

    const origin = req.headers.origin;

    // Unauthenticated: health (no secrets) and pairing (code + extension origin).
    if (req.method === 'GET' && req.path === '/v1/health') {
      const s = settings.get();
      return ok({
        app: 'downloadmgr',
        api: 1,
        version,
        paired: s.capture.allowedOrigins.length > 0,
        pairing: Boolean(getPairing()),
      });
    }
    if (req.method === 'POST' && req.path === '/v1/pair') {
      return handlePair(req, origin);
    }

    // Everything below requires: allowed origin + valid token.
    const allowed = settings.get().capture.allowedOrigins;
    if (!originAllowed(origin, allowed)) {
      return fail(403, 'FORBIDDEN_ORIGIN', 'origin is not paired');
    }
    const token = req.headers['x-dm-token'];
    if (typeof token !== 'string' || !secrets.verifyCapture(token)) {
      return fail(401, 'UNAUTHORIZED', 'missing or invalid token');
    }
    const rl = perToken.check(token);
    if (!rl.ok) {
      return fail(429, 'RATE_LIMITED', 'slow down', { retryAfterSec: Math.ceil(rl.retryAfterMs / 1000) });
    }

    if (req.method === 'POST' && req.path === '/v1/items') {
      return handleItem(req.body, origin);
    }
    if (req.method === 'POST' && req.path === '/v1/items/batch') {
      const items = req.body && Array.isArray(req.body.items) ? req.body.items : null;
      if (!items || items.length === 0 || items.length > 50) {
        return fail(400, 'BAD_REQUEST', 'items must be an array of 1..50');
      }
      const results = [];
      for (const it of items) {
        const r = await handleItem(it, origin);
        results.push(r.body);
      }
      return ok({ results }, 202);
    }
    if (req.method === 'GET' && req.path === '/v1/items') {
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.get('limit') || '20', 10) || 20));
      return ok({ items: recent.slice(-limit).reverse() });
    }
    if (req.method === 'GET' && req.path === '/v1/status') {
      return ok({ queue: getQueueStats(), version });
    }

    return fail(404, 'NOT_FOUND', 'unknown endpoint');
  }

  return {
    handle,
    startPairing,
    cancelPairing,
    getPairing,
    revokeOrigin,
    _recent: recent, // test/debug visibility
  };
}

module.exports = { createCaptureApi, ITEM_SCHEMA, PAIRING_TTL_MS, DEDUPE_WINDOW_MS };
