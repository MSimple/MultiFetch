'use strict';

// Auto-launch at login. openAtLogin writes the HKCU Run entry (verifiable via
// `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run`); openAsHidden
// is macOS-only, so both dev and packaged builds pass --hidden explicitly.

const path = require('node:path');

function applyAutoLaunch(app, enabled) {
  try {
    const args = ['--hidden'];
    if (!app.isPackaged) args.unshift(path.resolve(process.argv[1] || '.'));
    app.setLoginItemSettings({ openAtLogin: enabled === true, args });
    return true;
  } catch {
    return false;
  }
}

function isAutoLaunchEnabled(app) {
  try {
    return app.getLoginItemSettings().openAtLogin === true;
  } catch {
    return false;
  }
}

module.exports = { applyAutoLaunch, isAutoLaunchEnabled };
