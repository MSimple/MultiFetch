'use strict';

// Settings store: defaults + whitelisted patch + debounced atomic persist.

const { EventEmitter } = require('node:events');
const { writeFileAtomic, readJsonWithBak } = require('./atomic');

const SCHEMA_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 500;

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  locale: 'zh-CN',
  defaultDir: '',
  maxConcurrent: 3, // simultaneous active tasks
  defaultConnections: 8, // segments per task
  maxConnections: 16, // global connection ceiling
  globalSpeedLimit: null, // bytes/sec, null = unlimited
  autoLaunch: false,
  autoResume: false,
  closeToTray: true,
  showProgressOnStart: true,
  trayHintShown: false, // one-time "still running in the tray" hint after first close
  capture: {
    port: 8787,
    autoAdd: false,
    autoPair: true, // extensions pair themselves while the app is running (web pages never can)
    allowedOrigins: [], // pinned chrome-extension:// origins, filled by pairing
    blockedOrigins: [], // revoked origins: excluded from auto-pairing until a manual code re-admits them
  },
});

// patch() only accepts known keys with validated value shapes.
const PATCHERS = {
  locale: (v) => (typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v) ? v : undefined),
  defaultDir: (v) => (typeof v === 'string' ? v : undefined),
  maxConcurrent: (v) => intIn(v, 1, 20),
  defaultConnections: (v) => intIn(v, 1, 64),
  maxConnections: (v) => intIn(v, 1, 64),
  globalSpeedLimit: (v) => (v === null ? null : intIn(v, 1024, 1 << 30)),
  autoLaunch: (v) => bool(v),
  autoResume: (v) => bool(v),
  closeToTray: (v) => bool(v),
  showProgressOnStart: (v) => bool(v),
  trayHintShown: (v) => bool(v),
  // Capture/extension block. Deep-merged against the current value; the
  // origin allowlist only ever contains real extension origins.
  capture: (v, current) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const cur =
      current && typeof current === 'object'
        ? current
        : { port: 8787, autoAdd: false, autoPair: true, allowedOrigins: [], blockedOrigins: [] };
    const out = {
      ...cur,
      allowedOrigins: Array.isArray(cur.allowedOrigins) ? [...cur.allowedOrigins] : [],
      blockedOrigins: Array.isArray(cur.blockedOrigins) ? [...cur.blockedOrigins] : [],
    };
    if (v.port !== undefined) {
      const p = intIn(v.port, 1, 65535);
      if (p === undefined) return undefined;
      out.port = p;
    }
    if (v.autoAdd !== undefined) {
      const b = bool(v.autoAdd);
      if (b === undefined) return undefined;
      out.autoAdd = b;
    }
    if (v.autoPair !== undefined) {
      const b = bool(v.autoPair);
      if (b === undefined) return undefined;
      out.autoPair = b;
    }
    const validOriginList = (list) =>
      Array.isArray(list) &&
      list.length <= 50 &&
      list.every((o) => typeof o === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(o));
    if (v.allowedOrigins !== undefined) {
      if (!validOriginList(v.allowedOrigins)) return undefined;
      out.allowedOrigins = [...new Set(v.allowedOrigins)];
    }
    if (v.blockedOrigins !== undefined) {
      if (!validOriginList(v.blockedOrigins)) return undefined;
      out.blockedOrigins = [...new Set(v.blockedOrigins)];
    }
    return out;
  },
};

function intIn(v, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}
function bool(v) {
  return typeof v === 'boolean' ? v : undefined;
}

class SettingsStore extends EventEmitter {
  constructor({ file, log = null }) {
    super();
    this.file = file;
    this.log = log;
    this.values = { ...DEFAULTS, capture: { ...DEFAULTS.capture } };
    this._persistTimer = null;
    this._dirty = false;
  }

  async load() {
    const res = await readJsonWithBak(this.file);
    if (res && res.value && typeof res.value === 'object') {
      if (this.log && res.from !== this.file) this.log.warn(`settings: recovered from ${res.from}`);
      this.values = mergeKnown(DEFAULTS, res.value);
    }
    return this;
  }

  get() {
    return structuredClone(this.values);
  }

  /** @returns {{ok: true, values: object} | {ok: false, rejected: string[]}} */
  patch(partial) {
    if (!partial || typeof partial !== 'object') return { ok: false, rejected: ['<payload>'] };
    const rejected = [];
    for (const [k, v] of Object.entries(partial)) {
      const patcher = PATCHERS[k];
      if (!patcher) {
        rejected.push(k); // unknown keys are rejected, never merged blindly
        continue;
      }
      const parsed = patcher(v, this.values[k]);
      if (parsed === undefined) {
        rejected.push(k);
        continue;
      }
      this.values[k] = parsed;
    }
    if (rejected.length > 0) return { ok: false, rejected };
    this._schedulePersist();
    this.emit('settings-changed', this.get());
    return { ok: true, values: this.get() };
  }

  async reset() {
    this.values = { ...DEFAULTS, capture: { ...DEFAULTS.capture } };
    await this.flush();
    this.emit('settings-changed', this.get());
  }

  _schedulePersist() {
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.flush().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
  }

  async flush() {
    if (!this._dirty) return;
    this._dirty = false;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    await writeFileAtomic(this.file, JSON.stringify({ ...this.values, savedAt: Date.now() }, null, 2), {
      log: this.log,
    });
  }

  dispose() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = null;
  }
}

function mergeKnown(defaults, loaded) {
  const out = { ...defaults, capture: { ...defaults.capture } };
  for (const k of Object.keys(defaults)) {
    if (!(k in loaded)) continue;
    if (k === 'capture') {
      const c = loaded.capture;
      if (c && typeof c === 'object') {
        if (Number.isInteger(c.port) && c.port >= 1 && c.port <= 65535) out.capture.port = c.port;
        if (typeof c.autoAdd === 'boolean') out.capture.autoAdd = c.autoAdd;
        if (typeof c.autoPair === 'boolean') out.capture.autoPair = c.autoPair;
        const originOk = (o) => typeof o === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(o);
        if (Array.isArray(c.allowedOrigins)) out.capture.allowedOrigins = c.allowedOrigins.filter(originOk);
        if (Array.isArray(c.blockedOrigins)) out.capture.blockedOrigins = c.blockedOrigins.filter(originOk);
      }
      continue;
    }
    out[k] = loaded[k];
  }
  out.schemaVersion = SCHEMA_VERSION;
  return out;
}

module.exports = { SettingsStore, DEFAULTS };
