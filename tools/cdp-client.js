'use strict';

// Minimal CDP client for dev tooling: connect to the app's renderer and
// evaluate expressions. No dependencies (global fetch + WebSocket).

async function connect(port, { timeoutMs = 30_000 } = {}) {
  let page = null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = targets.find((t) => t.type === 'page');
      if (page) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!page) throw new Error(`no CDP page target on port ${port}`);

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
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')));
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error(`eval threw: ${d.text} ${(d.exception && d.exception.description) || ''}`);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  return { evalJs, send, close: () => ws.close() };
}

module.exports = { connect };
