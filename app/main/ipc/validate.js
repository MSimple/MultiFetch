'use strict';

// Declarative payload validation for every IPC channel. The renderer is
// treated as untrusted: unknown fields are rejected, values are type/range
// checked, and header values may never contain CR/LF (header injection).
//
// Schema entries are strings, optionally suffixed with "?" for optional fields:
//   string     non-empty string (trimmed)
//   string0    any string (may be empty)
//   url        http/https URL (urlguard)
//   path       non-empty string, no NUL, <= 512 chars
//   int:a-b    integer within [a, b]
//   bool       boolean
//   enum:a,b   one of the listed literals
//   id         task id, /^t_[0-9a-f]{12}$/
//   locale     language tag, /^[a-z]{2}(-[A-Z]{2})?$/
//   headers    flat string->string object, <= 50 entries, <= 8 KiB, no CR/LF
//   object     plain object, JSON size <= 16 KiB (validated further downstream)

const { isSafeExternalUrl } = require('../security/urlguard');

const TASK_ID_RE = /^t_[0-9a-f]{12}$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function bad(reason) {
  return { ok: false, reason };
}

function checkValue(spec, raw, key) {
  if (spec === 'string') {
    if (typeof raw !== 'string') return bad(`${key}: expected string`);
    const t = raw.trim();
    if (t === '' || t.length > 512) return bad(`${key}: empty or too long`);
    return { ok: true, value: t };
  }
  if (spec === 'string0') {
    if (typeof raw !== 'string' || raw.length > 4096) return bad(`${key}: expected string`);
    return { ok: true, value: raw };
  }
  if (spec === 'url') {
    if (typeof raw !== 'string' || !isSafeExternalUrl(raw)) return bad(`${key}: must be an http/https URL`);
    return { ok: true, value: raw };
  }
  if (spec === 'path') {
    if (typeof raw !== 'string') return bad(`${key}: expected path string`);
    const t = raw.trim();
    if (t === '' || t.length > 512 || t.includes('\u0000')) return bad(`${key}: invalid path`);
    return { ok: true, value: t };
  }
  if (spec === 'bool') {
    if (typeof raw !== 'boolean') return bad(`${key}: expected boolean`);
    return { ok: true, value: raw };
  }
  if (spec === 'id') {
    if (typeof raw !== 'string' || !TASK_ID_RE.test(raw)) return bad(`${key}: invalid task id`);
    return { ok: true, value: raw };
  }
  if (spec === 'locale') {
    if (typeof raw !== 'string' || !LOCALE_RE.test(raw)) return bad(`${key}: invalid locale`);
    return { ok: true, value: raw };
  }
  if (spec.startsWith('int:')) {
    const [a, b] = spec.slice(4).split('-').map(Number);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < a || n > b) return bad(`${key}: expected integer in [${a}, ${b}]`);
    return { ok: true, value: n };
  }
  if (spec.startsWith('enum:')) {
    const allowed = spec.slice(5).split(',').filter(Boolean);
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
      return bad(`${key}: expected one of ${allowed.join('|')}`);
    }
    return { ok: true, value: raw };
  }
  if (spec === 'headers') {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad(`${key}: expected object`);
    const entries = Object.entries(raw);
    if (entries.length > 50) return bad(`${key}: too many headers`);
    let total = 0;
    const out = {};
    for (const [hk, hv] of entries) {
      if (typeof hk !== 'string' || !HEADER_NAME_RE.test(hk)) return bad(`${key}: bad header name`);
      if (typeof hv !== 'string' || /[\r\n\u0000]/.test(hv)) return bad(`${key}: bad header value`);
      total += hk.length + hv.length;
      if (total > 8192) return bad(`${key}: headers too large`);
      out[hk] = hv;
    }
    return { ok: true, value: out };
  }
  if (spec === 'object') {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad(`${key}: expected object`);
    let json;
    try {
      json = JSON.stringify(raw);
    } catch {
      return bad(`${key}: not serializable`);
    }
    if (json.length > 16384) return bad(`${key}: object too large`);
    return { ok: true, value: raw };
  }
  return bad(`${key}: unknown schema type ${spec}`);
}

/**
 * @param {Record<string,string> | null} schema  null = no payload expected
 * @param {unknown} payload
 * @returns {{ok: true, value: any} | {ok: false, reason: string}}
 */
function validate(schema, payload) {
  if (schema === null) return { ok: true, value: undefined };
  if (payload === undefined || payload === null) payload = {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return bad('payload must be an object');
  const out = {};
  for (const [key, entry] of Object.entries(schema)) {
    const optional = entry.endsWith('?');
    const spec = optional ? entry.slice(0, -1) : entry;
    const raw = payload[key];
    if (raw === undefined || raw === null) {
      if (optional) continue;
      return bad(`missing field: ${key}`);
    }
    const r = checkValue(spec, raw, key);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  for (const key of Object.keys(payload)) {
    if (!(key in schema)) return bad(`unknown field: ${key}`);
  }
  return { ok: true, value: out };
}

module.exports = { validate };
