'use strict';

// System tray. The Tray instance is held at module level — a GC'd tray icon
// vanishes from the notification area.

const { Tray, Menu, nativeImage } = require('electron');

let trayRef = null;

/**
 * @param {{
 *   iconPath: string,
 *   strings: { tooltip: string, show: string, pauseAll: string, resumeAll: string, quit: string },
 *   onShow: () => void, onPauseAll: () => void, onResumeAll: () => void, onQuit: () => void,
 * }} opts
 */
function createTray({ iconPath, strings, onShow, onPauseAll, onResumeAll, onQuit }) {
  if (trayRef) return trayRef;
  const image = nativeImage.createFromPath(iconPath);
  trayRef = new Tray(image);
  trayRef.setToolTip(strings.tooltip);
  trayRef.setContextMenu(
    Menu.buildFromTemplate([
      { label: strings.show, click: () => onShow() },
      { type: 'separator' },
      { label: strings.pauseAll, click: () => onPauseAll() },
      { label: strings.resumeAll, click: () => onResumeAll() },
      { type: 'separator' },
      { label: strings.quit, click: () => onQuit() },
    ])
  );
  trayRef.on('click', () => onShow());
  return trayRef;
}

function destroyTray() {
  if (trayRef) {
    trayRef.destroy();
    trayRef = null;
  }
}

module.exports = { createTray, destroyTray };
