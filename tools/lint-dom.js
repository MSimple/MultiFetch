#!/usr/bin/env node
'use strict';

// DOM-safety lint: fails if injection sinks appear in UI code, or if inline
// scripts / event-handler attributes appear in HTML (the strict CSP would
// block them anyway — catching them here keeps failures early and legible).
//
// Scope: app/renderer and extension. Missing directories are skipped.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [path.join(ROOT, 'app', 'renderer'), path.join(ROOT, 'extension')];

const JS_RULES = [
  [/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/, 'DOM injection sink (use textContent / DOM construction)'],
  [/\bdocument\.write\b/, 'document.write is banned'],
  [/\beval\s*\(/, 'eval is banned'],
  [/\bnew\s+Function\b/, 'new Function is banned'],
];

const HTML_RULES = [
  [/<script\b(?![^>]*\bsrc=)/i, 'inline <script> (move code to a .js file)'],
  [/\son[a-z]+\s*=/i, 'inline event handler attribute (use addEventListener)'],
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // directory does not exist yet
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const findings = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const ext = path.extname(file).toLowerCase();
    if (ext !== '.js' && ext !== '.html') continue;
    const rel = path.relative(ROOT, file);
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    const rules = ext === '.html' ? HTML_RULES : JS_RULES;

    // Parse-check renderer JS: a syntax error here means the script silently
    // never runs in the app (caught a real bug once — a `*/` inside a JSDoc).
    if (ext === '.js') {
      try {
        new vm.Script(source, { filename: rel });
      } catch (err) {
        findings.push(`${rel}:1: syntax error — ${err.message}`);
        continue;
      }
    }
    lines.forEach((line, i) => {
      if (ext === '.js') {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      }
      for (const [re, label] of rules) {
        if (re.test(line)) findings.push(`${rel}:${i + 1}: ${label}`);
      }
    });
  }
}

if (findings.length > 0) {
  console.error(`lint-dom: ${findings.length} finding(s) —`);
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}
console.log('lint-dom: OK (no DOM-injection sinks, no inline script/handlers)');
