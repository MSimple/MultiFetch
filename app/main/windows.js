'use strict';

// BrowserWindow factory + hardenings. All windows share the same locked-down
// webPreferences and navigation policy. Window bounds/maximized state persist
// to userData so the window reopens where the user left it.

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, nativeTheme, app, screen } = require('electron');

const HARDENING = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  nodeIntegrationInSubFrames: false,
  spellcheck: false,
});

/** Deny every permission request (camera, geolocation, notifications, ...). */
function applySessionHardening(ses) {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const DEFAULT_BOUNDS = Object.freeze({ width: 1000, height: 640 });
const MIN_BOUNDS = Object.freeze({ width: 760, height: 460 });

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readState() {
  try {
    const v = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** A saved rectangle is only trusted when it still overlaps a connected display. */
function usableBounds(state) {
  if (!state || !Number.isFinite(state.width) || !Number.isFinite(state.height)) return null;
  if (state.width < MIN_BOUNDS.width || state.height < MIN_BOUNDS.height) return null;
  if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) return null;
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height };
  for (const d of screen.getAllDisplays()) {
    const w = d.workArea;
    const overlaps =
      rect.x < w.x + w.width &&
      rect.x + rect.width > w.x &&
      rect.y < w.y + w.height &&
      rect.y + rect.height > w.y;
    if (overlaps) return rect;
  }
  return null;
}

function hardenContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

function createMainWindow({ startHidden = false } = {}) {
  const saved = readState();
  const bounds = usableBounds(saved);

  const win = new BrowserWindow({
    width: bounds ? bounds.width : DEFAULT_BOUNDS.width,
    height: bounds ? bounds.height : DEFAULT_BOUNDS.height,
    x: bounds ? bounds.x : undefined,
    y: bounds ? bounds.y : undefined,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    show: !startHidden,
    title: 'downloadmgr',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181c' : '#f5f6f8',
    webPreferences: {
      ...HARDENING,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setMenuBarVisibility(false);
  hardenContents(win.webContents);

  if (saved && saved.maximized) win.maximize();

  let saveTimer = null;
  const persist = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    try {
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({ ...b, maximized: win.isMaximized() }, null, 2)
      );
    } catch {
      /* best-effort: a window that cannot save its bounds still works */
    }
  };
  const schedule = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    persist();
  });

  win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  return win;
}

module.exports = { createMainWindow, applySessionHardening, hardenContents, HARDENING, RENDERER_DIR };
