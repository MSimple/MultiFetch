#!/usr/bin/env node
'use strict';

// Visual check: start a throttled download against the fixture, capture the
// task row (segment strip + ETA) mid-flight, then clean up.
// Usage: node tools/smoke-visual.js <cdpPort> <fixturePort> <out.png>

const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./cdp-client');

(async () => {
  const cdpPort = Number(process.argv[2] || 9222);
  const fixturePort = Number(process.argv[3] || 8099);
  const out = process.argv[4] || 'visual.png';
  const cdp = await connect(cdpPort);
  const outDir = path.join(__dirname, '..', '.smoke-out');
  fs.mkdirSync(outDir, { recursive: true });

  await cdp.evalJs('window.dm.settings.patch({ globalSpeedLimit: 1048576 })');
  const add = await cdp.evalJs(
    `window.dm.tasks.add({ url: ${JSON.stringify(
      `http://127.0.0.1:${fixturePort}/range/visual.bin?size=16777216&seed=5`
    )}, dir: ${JSON.stringify(outDir)} }).then(r => (r.ok ? r.data : r))`
  );
  console.log('task:', add.id);

  await new Promise((r) => setTimeout(r, 4500)); // progress into the segmented phase

  const stats = await cdp.evalJs(`JSON.stringify({
    strips: document.querySelectorAll('.seg-strip .seg').length,
    states: Array.from(document.querySelectorAll('.seg-strip .seg')).map(s => s.className.replace('seg ', '')).slice(0, 12),
    eta: Array.from(document.querySelectorAll('.task .task-speed')).map(e => e.textContent).filter(x => x && x.includes('剩余'))[0] || null,
    speed: (document.querySelector('.task .task-speed') || {}).textContent || null
  })`);
  console.log('ui stats:', stats);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot -> ' + out);

  await cdp.evalJs(`window.dm.tasks.cancel(${JSON.stringify(add.id)})`);
  await new Promise((r) => setTimeout(r, 600));
  await cdp.evalJs(`window.dm.tasks.remove(${JSON.stringify(add.id)}, true)`);
  await cdp.evalJs('window.dm.settings.patch({ globalSpeedLimit: null })');
  cdp.close();
})().catch((e) => {
  console.error('VISUAL SMOKE ERROR: ' + ((e && e.stack) || e));
  process.exit(1);
});
