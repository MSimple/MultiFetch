'use strict';

// Minimal rotating file logger with secret redaction. No dependencies.
// Every line is passed through redact() so tokens and Authorization headers
// can never leak into log files.

const fs = require('node:fs');
const path = require('node:path');

const REDACTION_RULES = [
  [/(x-dm-token["'\s:=]+)[0-9a-fA-F]{16,}/gi, '$1***'],
  [/(authorization["'\s:=]+(?:bearer\s+)?)[^\s"',;]+/gi, '$1***'],
  [/((?:captureToken|protocolToken|token)["'\s:=]+")[^"]+/gi, '$1***'],
];

function redact(text) {
  let out = String(text);
  for (const [re, rep] of REDACTION_RULES) out = out.replace(re, rep);
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {{dir: string, scope?: string, maxBytes?: number, keep?: number}} opts
 */
function createLogger({ dir, scope = 'app', maxBytes = 2 * 1024 * 1024, keep = 3 } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('logger dir is required');
  const file = path.join(dir, 'app.log');
  const debugEnabled = process.env.DM_DEBUG === '1';

  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    try {
      for (let i = keep - 1; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        const to = `${file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
    } catch {
      /* rotation is best-effort; never break logging */
    }
  }

  function write(level, scopeName, args) {
    if (level === 'debug' && !debugEnabled) return;
    if (LEVELS[level] === undefined) level = 'info';
    const line =
      `[${new Date().toISOString()}] [${level}] [${scopeName}] ` +
      redact(args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')) +
      '\n';
    try {
      fs.mkdirSync(dir, { recursive: true });
      rotateIfNeeded();
      fs.appendFileSync(file, line);
    } catch {
      /* logging must never throw into callers */
    }
  }

  const logger = {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
    file,
    /** Derive a scoped child logger (same file). */
    child: (childScope) => createLogger({ dir, scope: `${scope}:${childScope}`, maxBytes, keep }),
  };
  return logger;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { createLogger, redact };
