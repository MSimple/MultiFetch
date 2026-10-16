#!/usr/bin/env node
'use strict';

// Dev helper: evaluate expressions in the running app's renderer.
// Usage: node tools/cdp-eval.js <port> "<expr>" ["<expr>" ...]

const port = Number(process.argv[2] || 9222);
const exprs = process.argv.slice(3);

(async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
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
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', () => j(new Error('ws failed')));
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  for (const expr of exprs) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      console.log(`${expr}  =>  THROW: ${r.result.exceptionDetails.text} ${JSON.stringify((r.result.exceptionDetails.exception || {}).description || '')}`);
    } else {
      console.log(`${expr}  =>  ${JSON.stringify(r.result && r.result.result ? r.result.result.value : undefined)}`);
    }
  }
  ws.close();
})().catch((e) => {
  console.error('ERR: ' + (e && e.message));
  process.exit(1);
});
