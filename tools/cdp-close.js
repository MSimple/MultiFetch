#!/usr/bin/env node
'use strict';

// Dev helper: gracefully close the dev app that exposes a debugging port.
// Usage: node tools/cdp-close.js [port]

(async () => {
  const port = Number(process.argv[2] || 9222);
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  if (!v.webSocketDebuggerUrl) throw new Error('no browser websocket URL');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('ws connect failed')));
  });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise((r) => setTimeout(r, 1500));
  try {
    ws.close();
  } catch {
    /* app may already be gone */
  }
  console.log('Browser.close sent to port ' + port);
})().catch((e) => {
  console.error('ERR: ' + (e && e.message));
  process.exit(1);
});
