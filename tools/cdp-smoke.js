#!/usr/bin/env node
'use strict';

// Dev smoke test: connects to the running app's renderer via the Chrome
// DevTools Protocol and asserts the hardened-window invariants end to end.
//
// Usage:
//   1) start the app:  electron . --remote-debugging-port=9222
//   2) node tools/cdp-smoke.js 9222 [readonly]
//
// readonly: skip adding the fake task, only read state (restart check).

const port = Number(process.argv[2] || 9222);
const readonly = process.argv[3] === 'readonly';

async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json();
}

(async () => {
  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await getJson('/json');
      if (Array.isArray(targets) && targets.some((t) => t.type === 'page')) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const page = (targets || []).find((t) => t.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) {
    console.error('SMOKE FAIL: no page target behind the debugging port');
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let seq = 0;

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('ws connect failed')));
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error('eval failed: ' + JSON.stringify(r.result.exceptionDetails.exception || {}));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const out = {};
  out.title = await evalJs('document.title');
  out.lang = await evalJs('document.documentElement.lang');
  out.requireType = await evalJs('typeof window.require');
  out.processType = await evalJs('typeof window.process');
  out.dmType = await evalJs('typeof window.dm');
  out.cards = await evalJs('document.querySelectorAll("#tasks-view .card").length');
  out.settingsCardHidden = await evalJs('document.getElementById("settings-view").hidden');

  if (!readonly) {
    out.addEnvelope = await evalJs(
      'window.dm.tasks.add({ url: "https://example.com/smoke-test.bin" }).then(r => ({ ok: r.ok, id: r.ok ? r.data.id : null, err: r.ok ? null : r.error.code }))'
    );
    await new Promise((r) => setTimeout(r, 500));
    out.rowsAfterAdd = await evalJs('document.querySelectorAll("#tasks-view .task-list .task").length');
    out.statusChip = await evalJs(
      '(document.querySelector("#tasks-view .task-list .task .chip") || { textContent: null }).textContent'
    );
  }
  out.listCount = await evalJs('window.dm.tasks.list().then(r => (r.ok ? r.data.length : -1))');

  console.log(JSON.stringify(out, null, 2));

  const failures = [];
  if (out.requireType !== 'undefined') failures.push('window.require leaked');
  if (out.processType !== 'undefined') failures.push('window.process leaked');
  if (out.dmType !== 'object') failures.push('window.dm missing');
  if (!(out.cards >= 1)) failures.push('tasks view not mounted (CSP or script failure)');
  if (!readonly && (!out.addEnvelope || out.addEnvelope.ok !== true)) failures.push('IPC add failed');
  if (!readonly && !(out.rowsAfterAdd >= 1)) failures.push('task row not rendered');

  ws.close();
  if (failures.length > 0) {
    console.error('SMOKE FAIL: ' + failures.join('; '));
    process.exit(1);
  }
  console.log('SMOKE OK');
})().catch((e) => {
  console.error('SMOKE FAIL: ' + (e && e.message));
  process.exit(1);
});
