#!/usr/bin/env node
'use strict';

// Danger-API lint. Fails on:
//   1. TLS verification ever being disabled (rejectUnauthorized / env override)
//   2. shell.openExternal anywhere except app/main/external.js
//   3. Access-Control-Allow-Origin anywhere in app/ (capture API is CORS-free by design)
//   4. require('electron') inside the electron-free core dirs
//      (engine | store | security | capture | util)

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const CORE_DIRS = ['engine', 'store', 'security', 'capture', 'util'].map((d) =>
  path.join(APP, 'main', d) + path.sep
);
const ALLOWED_OPEN_EXTERNAL = new Set([path.join(APP, 'main', 'external.js')]);

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const findings = [];
for (const file of walk(APP)) {
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const inCore = CORE_DIRS.some((d) => file.startsWith(d));
  lines.forEach((line, i) => {
    const trimmed = line.trimStart();
    // Pure-comment lines are skipped: documentation may legitimately NAME a
    // banned API while explaining why it is banned.
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const loc = `${rel}:${i + 1}`;
    if (/rejectUnauthorized/.test(line)) {
      findings.push(`${loc}: rejectUnauthorized is banned — TLS verification must stay on`);
    }
    if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(line)) {
      findings.push(`${loc}: NODE_TLS_REJECT_UNAUTHORIZED is banned`);
    }
    if (/shell\.openExternal/.test(line) && !ALLOWED_OPEN_EXTERNAL.has(file)) {
      findings.push(`${loc}: shell.openExternal allowed only in app/main/external.js`);
    }
    if (/Access-Control-Allow-Origin/i.test(line)) {
      findings.push(`${loc}: ACAO headers are banned — capture API must stay CORS-free`);
    }
    if (inCore && /require\(\s*['"]electron['"]\s*\)/.test(line)) {
      findings.push(`${loc}: require('electron') forbidden in electron-free core dirs`);
    }
  });
}

if (findings.length > 0) {
  console.error(`lint-danger: ${findings.length} finding(s) —`);
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}
console.log('lint-danger: OK (TLS on, openExternal confined, CORS-free, core electron-free)');
