#!/usr/bin/env node
'use strict';

// Packaging wrapper: builds dist/downloadmgr-win32-x64 from the current tree.
// Uses the locally installed electron version; the platform binary comes from
// @electron/get (cache hit from the dev install, mirror env as fallback).

const fs = require('node:fs');
const path = require('node:path');

async function loadPackager() {
  try {
    const mod = require('@electron/packager');
    return mod.packager || mod.default || mod;
  } catch {
    const mod = await import('@electron/packager');
    return mod.packager || mod.default || mod;
  }
}

(async () => {
  const projectDir = path.resolve(__dirname, '..');
  const outName = process.argv[2] || 'dist'; // e.g. `node tools/package.js dist-next` while dist/ is locked by a running app
  const electronVersion = JSON.parse(
    fs.readFileSync(path.join(projectDir, 'node_modules', 'electron', 'package.json'), 'utf8')
  ).version;

  const packager = await loadPackager();
  const out = await packager({
    dir: projectDir,
    out: path.join(projectDir, outName),
    name: 'downloadmgr',
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    asar: true,
    overwrite: true,
    prune: true,
    icon: path.join(projectDir, 'app', 'renderer', 'assets', 'icon.ico'),
    win32metadata: {
      CompanyName: 'downloadmgr',
      FileDescription: 'downloadmgr — multi-threaded download manager',
      ProductName: 'downloadmgr',
      OriginalFilename: 'downloadmgr.exe',
    },
    ignore: [
      /^\/dist(-[^/]*)?($|\/)/,
      /^\/transfer($|\/)/,
      /^\/deploy-readme\.txt$/,
      /^\/部署说明\.txt$/,
      /^\/test($|\/)/,
      /^\/tools($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.smoke-out($|\/)/,
      /^\/\.gitignore$/,
    ],
  });

  console.log('packaged -> ' + out.join(' , '));
  const exe = path.join(out[0], 'downloadmgr.exe');
  console.log('exe: ' + exe + ' (' + (fs.existsSync(exe) ? fs.statSync(exe).size + ' bytes' : 'MISSING!') + ')');
})().catch((e) => {
  console.error('PACKAGING FAILED: ' + ((e && e.stack) || e));
  process.exit(1);
});
