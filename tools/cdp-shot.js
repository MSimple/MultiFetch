#!/usr/bin/env node
'use strict';

// Dev helper: screenshot the running app's renderer via CDP.
// Usage: node tools/cdp-shot.js <port> <out.png>

const fs = require('node:fs');
const { connect } = require('./cdp-client');

(async () => {
  const port = Number(process.argv[2] || 9222);
  const out = process.argv[3] || 'shot.png';
  const cdp = await connect(port);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const data = r && r.result && r.result.data;
  if (!data) throw new Error('no screenshot data: ' + JSON.stringify(r).slice(0, 200));
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  console.log('saved ' + out + ' (' + fs.statSync(out).size + ' bytes)');
  cdp.close();
})().catch((e) => {
  console.error('SHOT FAILED: ' + ((e && e.message) || e));
  process.exit(1);
});
