#!/usr/bin/env node
'use strict';

// M4/M5 GUI acceptance: drives the live app through the same API surface the
// buttons use — real download against the loopback fixture, pause/resume with
// a live speed limit, protocol URL handoff (good token accepted, bad ignored),
// autolaunch registry toggle — then cleans up after itself.
//
// Usage: node tools/cdp-smoke-ops.js [--cdp 9222] [--fixture 8099]
// Preconditions: fixture server on --fixture, app running with --cdp.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { connect } = require('./cdp-client');
const { generateBody } = require('./fixture-server');

const argv = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dflt;
};

const cdpPort = Number(get('--cdp', '9222'));
const fixturePort = Number(get('--fixture', '8099'));
const projectDir = path.resolve(__dirname, '..');
const outDir = path.join(projectDir, '.smoke-out');
const electronExe = path.join(projectDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const appData = path.join(process.env.APPDATA || '', 'downloadmgr');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const cdp = await connect(cdpPort);

  const listTasks = () => cdp.evalJs('window.dm.tasks.list().then(r => (r.ok ? r.data : []))');
  const waitStatus = async (id, statuses, timeoutMs = 45_000) => {
    const start = Date.now();
    for (;;) {
      const list = await listTasks();
      const t = list.find((x) => x.id === id);
      if (t && statuses.includes(t.status)) return t;
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting ${id} -> ${statuses.join('/')}`);
      await sleep(300);
    }
  };

  // ---- 1. segmented download through the real IPC path ----
  const SIZE = 2 * 1024 * 1024;
  const SEED = 21;
  const url = `http://127.0.0.1:${fixturePort}/range/ops.bin?size=${SIZE}&seed=${SEED}`;
  const addR = await cdp.evalJs(
    `window.dm.tasks.add({ url: ${JSON.stringify(url)}, dir: ${JSON.stringify(outDir)} }).then(r => (r.ok ? r.data : r))`
  );
  check('add via IPC returns summary', addR && addR.id, JSON.stringify(addR));
  const done = await waitStatus(addR.id, ['done', 'error']);
  check('task completes', done.status === 'done', done.error ? JSON.stringify(done.error) : '');
  const filePath = path.join(outDir, done.filename);
  const body = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  check('file exists at expected path', Boolean(body), filePath);
  check('content SHA-256 exact', Boolean(body) && sha256(body) === sha256(generateBody(SIZE, SEED)));

  // ---- 2. row actions rendered for a finished task ----
  const btnLabels = await cdp.evalJs(
    'Array.from(document.querySelectorAll("#tasks-view .task-list .task .task-actions button")).map(b => b.getAttribute("aria-label"))'
  );
  check(
    'done row offers open / show-in-folder / remove',
    Array.isArray(btnLabels) && btnLabels.includes('打开目录') && btnLabels.length >= 3,
    JSON.stringify(btnLabels)
  );

  // ---- 3. speed limit -> pause -> resume (the exact calls the buttons make) ----
  await cdp.evalJs(`window.dm.settings.patch({ globalSpeedLimit: ${512 * 1024} })`);
  const url2 = `http://127.0.0.1:${fixturePort}/range/ops2.bin?size=${SIZE}&seed=${SEED + 1}`;
  const add2 = await cdp.evalJs(
    `window.dm.tasks.add({ url: ${JSON.stringify(url2)}, dir: ${JSON.stringify(outDir)} }).then(r => (r.ok ? r.data : r))`
  );
  await waitStatus(add2.id, ['downloading']);
  await sleep(1200); // let some bytes flow under the 512 KiB/s cap
  await cdp.evalJs(`window.dm.tasks.pause(${JSON.stringify(add2.id)})`);
  const paused = await waitStatus(add2.id, ['paused']);
  check('pause takes effect', paused.status === 'paused');
  const chips = await cdp.evalJs(
    'Array.from(document.querySelectorAll("#tasks-view .task-list .task .chip")).map(c => c.textContent).join("|")'
  );
  check('localized status chips render', /已暂停|下载中|已完成|排队中/.test(String(chips)), chips);
  await cdp.evalJs(`window.dm.tasks.resume(${JSON.stringify(add2.id)})`);
  const done2 = await waitStatus(add2.id, ['done', 'error'], 60_000);
  check('resume completes', done2.status === 'done', done2.error ? JSON.stringify(done2.error) : '');
  await cdp.evalJs('window.dm.settings.patch({ globalSpeedLimit: null })');

  // ---- 4. protocol URL handoff: valid token accepted, invalid ignored ----
  const secrets = JSON.parse(fs.readFileSync(path.join(appData, 'security.json'), 'utf8'));
  const beforeCount = (await listTasks()).length;

  const goodTarget = `http://127.0.0.1:${fixturePort}/range/proto.bin?size=65536&seed=3`;
  const goodUrl = `downloadmgr://add?url=${encodeURIComponent(goodTarget)}&token=${secrets.protocolToken}`;
  execFileSync(electronExe, [projectDir, goodUrl], { stdio: 'ignore', timeout: 20_000 });
  await sleep(1500);
  let list = await listTasks();
  check('valid-token protocol URL creates a task', list.length === beforeCount + 1, `count ${beforeCount} -> ${list.length}`);
  check('protocol task source recorded', list.some((t) => t.source === 'protocol'));

  const badUrl = `downloadmgr://add?url=${encodeURIComponent('https://example.com/evil.bin')}&token=${'0'.repeat(64)}`;
  execFileSync(electronExe, [projectDir, badUrl], { stdio: 'ignore', timeout: 20_000 });
  await sleep(1500);
  list = await listTasks();
  check('invalid-token protocol URL ignored', list.length === beforeCount + 1, `count ${list.length}`);

  const badSchemeUrl = `downloadmgr://add?url=${encodeURIComponent('file:///C:/Windows/System32/calc.exe')}&token=${secrets.protocolToken}`;
  execFileSync(electronExe, [projectDir, badSchemeUrl], { stdio: 'ignore', timeout: 20_000 });
  await sleep(1500);
  list = await listTasks();
  check('file: target via protocol refused', list.length === beforeCount + 1, `count ${list.length}`);

  // ---- 5. autolaunch toggles the HKCU Run entry ----
  const regQuery = () => {
    try {
      return execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'], {
        encoding: 'utf8',
      });
    } catch (e) {
      return String((e && e.stdout) || '');
    }
  };
  await cdp.evalJs('window.dm.settings.patch({ autoLaunch: true })');
  await sleep(500);
  const regOn = regQuery();
  check('autolaunch on: Run entry present', /electron|downloadmgr/i.test(regOn),
    regOn.split('\n').filter((l) => /electron|downloadmgr/i.test(l)).join(' ').trim());
  await cdp.evalJs('window.dm.settings.patch({ autoLaunch: false })');
  await sleep(500);
  const regOff = regQuery();
  check('autolaunch off: Run entry removed', !/downloadmgr/i.test(regOff) && !/electron\.exe/i.test(regOff));
  check(
    'settings changed event kept autoLaunch=false',
    (await cdp.evalJs('window.dm.settings.get().then(r => (r.ok ? r.data.autoLaunch : "n/a"))')) === false
  );

  // ---- 6. cleanup: remove smoke tasks (records + files) ----
  for (const t of await listTasks()) {
    await cdp.evalJs(`window.dm.tasks.remove(${JSON.stringify(t.id)}, true)`);
  }
  await sleep(800);
  const remaining = (await listTasks()).length;
  check('smoke tasks removed with their files', remaining === 0, 'remaining=' + remaining);

  cdp.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('OPS SMOKE ERROR: ' + ((e && e.stack) || e));
  process.exit(1);
});
