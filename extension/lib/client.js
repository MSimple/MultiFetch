'use strict';

// Talks to the downloadmgr app on 127.0.0.1. Port discovery: try the
// configured port, then sweep the standard range once. Requests never leave
// the loopback interface; all calls happen in the service worker, so the
// tokens are never exposed to web pages.

(function (root) {
  const PORT_START = 8787;
  const PORT_END = 8807;
  let cachedPort = null;

  async function health(port, timeoutMs = 1200) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return j && j.ok && j.data && j.data.app === 'downloadmgr' ? j.data : null;
    } catch {
      return null;
    }
  }

  async function findApp(preferred) {
    if (cachedPort) {
      const h = await health(cachedPort);
      if (h) return { port: cachedPort, health: h };
      cachedPort = null;
    }
    const start = Number.isInteger(preferred) && preferred >= PORT_START && preferred <= PORT_END ? preferred : PORT_START;
    const order = [];
    for (let p = start; p <= PORT_END; p++) order.push(p);
    for (let p = PORT_START; p < start; p++) order.push(p);
    for (const p of order) {
      const h = await health(p);
      if (h) {
        cachedPort = p;
        return { port: p, health: h };
      }
    }
    return null;
  }

  async function post(port, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-DM-Token'] = token;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json };
  }

  /** @returns {{state:'ok',data:object,port:number}|{state:'app_offline'}|{state:'unauthorized'}|{state:'forbidden'}|{state:'error',status:number}} */
  async function sendItem(item) {
    const s = await DMQ.storage.getSettings();
    if (!s.token) return { state: 'unauthorized' };
    const found = await findApp(s.port);
    if (!found) return { state: 'app_offline' };
    try {
      const r = await post(found.port, '/v1/items', item, s.token);
      if (r.status === 202 && r.json && r.json.ok) return { state: 'ok', data: r.json.data, port: found.port };
      if (r.status === 401) return { state: 'unauthorized' };
      if (r.status === 403) return { state: 'forbidden' };
      return { state: 'error', status: r.status };
    } catch {
      return { state: 'app_offline' };
    }
  }

  /** Exchange a pairing code; stores both tokens on success. */
  async function pair(code) {
    const s = await DMQ.storage.getSettings();
    const found = await findApp(s.port);
    if (!found) return { ok: false, error: 'app_offline' };
    try {
      const r = await post(
        found.port,
        '/v1/pair',
        { code: String(code || '').trim(), extensionOrigin: 'chrome-extension://' + chrome.runtime.id },
        ''
      );
      if (r.json && r.json.ok && r.json.data && typeof r.json.data.token === 'string') {
        await DMQ.storage.setSettings({
          token: r.json.data.token,
          protocolToken: typeof r.json.data.protocolToken === 'string' ? r.json.data.protocolToken : '',
          port: found.port,
        });
        return { ok: true, port: found.port };
      }
      return { ok: false, error: (r.json && r.json.error && r.json.error.code) || 'http_' + r.status };
    } catch {
      return { ok: false, error: 'app_offline' };
    }
  }

  /**
   * Zero-interaction pairing: succeeds whenever the app is running (the
   * server refuses non-extension origins, so web pages can never use this).
   */
  async function autoPair() {
    const s = await DMQ.storage.getSettings();
    const found = await findApp(s.port);
    if (!found) return { ok: false, error: 'app_offline' };
    try {
      const r = await post(
        found.port,
        '/v1/pair',
        { auto: true, extensionOrigin: 'chrome-extension://' + chrome.runtime.id },
        ''
      );
      if (r.json && r.json.ok && r.json.data && typeof r.json.data.token === 'string') {
        await DMQ.storage.setSettings({
          token: r.json.data.token,
          protocolToken: typeof r.json.data.protocolToken === 'string' ? r.json.data.protocolToken : '',
          port: found.port,
        });
        return { ok: true, port: found.port };
      }
      return { ok: false, error: (r.json && r.json.error && r.json.error.code) || 'http_' + r.status };
    } catch {
      return { ok: false, error: 'app_offline' };
    }
  }

  /**
   * @param {{force?: boolean}} [opts] force re-pairs even when a token is
   *   already stored (recovers from token rotation or a revoked origin).
   */
  async function ensurePaired({ force = false } = {}) {
    const s = await DMQ.storage.getSettings();
    if (!force && s.token) return { ok: true, cached: true };
    return autoPair();
  }

  async function checkStatus() {
    const s = await DMQ.storage.getSettings();
    const found = await findApp(s.port);
    if (!found) return { app: false, paired: Boolean(s.token) };
    return { app: true, port: found.port, paired: Boolean(s.token), health: found.health };
  }

  /**
   * Cold-launch the app through its protocol handler (token-gated server side).
   * Payload-free by design: tasks are delivered by the retry queue once the
   * app is up, so nothing can be delivered twice.
   */
  async function launchApp() {
    const s = await DMQ.storage.getSettings();
    if (!s.protocolToken) return false;
    const url = `downloadmgr://open?token=${encodeURIComponent(s.protocolToken)}`;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      setTimeout(() => {
        try {
          chrome.tabs.remove(tab.id);
        } catch {
          /* already gone */
        }
      }, 1500);
      return true;
    } catch {
      return false;
    }
  }

  root.DMQ = root.DMQ || {};
  root.DMQ.client = { sendItem, pair, autoPair, ensurePaired, checkStatus, findApp, launchApp, PORT_START, PORT_END };
})(typeof self !== 'undefined' ? self : globalThis);
