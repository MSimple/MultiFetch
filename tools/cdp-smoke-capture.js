#!/usr/bin/env node
'use strict';

// M6 live acceptance against the running app: pairing -> item -> task in the
// UI -> revoke closes the door. Plays the extension's role over real HTTP.

const { connect } = require('./cdp-client');

const EXT = 'chrome-extension://' + 'a'.repeat(32);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cdp = await connect(9222);

  const info = await cdp.evalJs('window.dm.capture.getServerInfo().then(r => (r.ok ? r.data : r))');
  check('capture server running', info && info.running, JSON.stringify(info));
  const port = info.port;

  const health = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
  check('health reachable, leak-free', health.ok === true && health.data.app === 'downloadmgr', JSON.stringify(health.data));

  const pairing = await cdp.evalJs('window.dm.capture.startPairing().then(r => (r.ok ? r.data : r))');
  check('pairing code minted', /^\d{6}$/.test(String(pairing.code)), JSON.stringify(pairing));

  const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: EXT },
    body: JSON.stringify({ code: pairing.code }),
  }).then((r) => r.json());
  check('pair succeeds with extension origin', pairRes.ok === true && typeof pairRes.data.token === 'string');
  const token = pairRes.data.token;

  const itemRes = await fetch(`http://127.0.0.1:${port}/v1/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: EXT, 'X-DM-Token': token },
    body: JSON.stringify({ url: 'https://example.com/captured-by-extension.bin', filename: 'captured.bin' }),
  }).then((r) => r.json());
  check('item accepted as pending-confirm', itemRes.ok === true && itemRes.data.status === 'pending-confirm', JSON.stringify(itemRes));

  await sleep(600);
  const list = await cdp.evalJs('window.dm.tasks.list().then(r => (r.ok ? r.data : []))');
  const task = list.find((t) => t.id === itemRes.data.taskId);
  check(
    'task in UI: source=extension, paused awaiting confirmation',
    Boolean(task) && task.source === 'extension' && task.status === 'paused',
    JSON.stringify(task && { status: task.status, source: task.source })
  );

  const allow = await cdp.evalJs('window.dm.capture.getAllowlist().then(r => (r.ok ? r.data : []))');
  check('origin pinned in settings', Array.isArray(allow) && allow.includes(EXT), JSON.stringify(allow));

  const cardCount = await cdp.evalJs('document.querySelectorAll("#settings-view .card").length');
  check('settings capture card mounted', Number(cardCount) >= 2, 'cards=' + cardCount);

  await cdp.evalJs(`window.dm.capture.revokeOrigin(${JSON.stringify(EXT)})`);
  const revoked = await fetch(`http://127.0.0.1:${port}/v1/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: EXT, 'X-DM-Token': token },
    body: JSON.stringify({ url: 'https://example.com/after-revoke.bin' }),
  });
  check('revoked origin refused (403)', revoked.status === 403);

  await cdp.evalJs(`window.dm.tasks.remove(${JSON.stringify(itemRes.data.taskId)}, true)`);
  await sleep(400);

  cdp.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CAPTURE SMOKE ERROR: ' + ((e && e.stack) || e));
  process.exit(1);
});
