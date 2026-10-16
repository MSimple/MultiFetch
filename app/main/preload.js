'use strict';

// Context bridge. The renderer sees exactly `window.dm` — nothing else.
// Runs under sandbox:true, so this file must stay self-contained (no local
// requires): only the electron module is available here.
//
// Channel names here are the contract; test/ipc-contract.test.js asserts they
// all exist in app/main/ipc/register.js and vice versa.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

function subscribe(channel, cb) {
  const handler = (_event, data) => {
    try {
      cb(data);
    } catch {
      /* a broken listener must not break the bridge */
    }
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const dm = {
  app: {
    getInfo: () => invoke('dm:app:getInfo'),
    getVersions: () => invoke('dm:app:getVersions'),
    showWindow: () => invoke('dm:app:showWindow'),
    quit: () => invoke('dm:app:quit'),
    openExternal: (url) => invoke('dm:app:openExternal', { url }),
    copyText: (text) => invoke('dm:app:copyText', { text }),
  },
  tasks: {
    list: () => invoke('dm:tasks:list'),
    get: (id) => invoke('dm:tasks:get', { id }),
    add: (spec) => invoke('dm:tasks:add', spec),
    remove: (id, deleteFile) => invoke('dm:tasks:remove', { id, deleteFile: !!deleteFile }),
    pause: (id) => invoke('dm:tasks:pause', { id }),
    resume: (id) => invoke('dm:tasks:resume', { id }),
    cancel: (id) => invoke('dm:tasks:cancel', { id }),
    pauseAll: () => invoke('dm:tasks:pauseAll'),
    resumeAll: () => invoke('dm:tasks:resumeAll'),
    openFile: (id) => invoke('dm:tasks:openFile', { id }),
    showInFolder: (id) => invoke('dm:tasks:showInFolder', { id }),
    clearFinished: () => invoke('dm:tasks:clearFinished'),
  },
  queue: {
    getState: () => invoke('dm:queue:getState'),
  },
  capture: {
    getServerInfo: () => invoke('dm:capture:getServerInfo'),
    getToken: () => invoke('dm:capture:getToken'),
    rotateToken: () => invoke('dm:capture:rotateToken'),
    getAllowlist: () => invoke('dm:capture:getAllowlist'),
    revokeOrigin: (origin) => invoke('dm:capture:revokeOrigin', { origin }),
    startPairing: () => invoke('dm:capture:startPairing'),
    cancelPairing: () => invoke('dm:capture:cancelPairing'),
    getProtocolToken: () => invoke('dm:capture:getProtocolToken'),
    rotateProtocolToken: () => invoke('dm:capture:rotateProtocolToken'),
  },
  settings: {
    get: () => invoke('dm:settings:get'),
    patch: (patch) => invoke('dm:settings:patch', { patch }),
    reset: () => invoke('dm:settings:reset'),
  },
  dialog: {
    chooseDirectory: () => invoke('dm:dialog:chooseDirectory'),
  },
  i18n: {
    get: (locale) => invoke('dm:i18n:get', locale ? { locale } : {}),
    getLocales: () => invoke('dm:i18n:getLocales'),
  },
  events: {
    onTasks: (cb) => subscribe('dm:evt:tasks', cb),
    onSettings: (cb) => subscribe('dm:evt:settings', cb),
  },
};

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

contextBridge.exposeInMainWorld('dm', deepFreeze(dm));
