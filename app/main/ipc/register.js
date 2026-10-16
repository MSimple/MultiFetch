'use strict';

// IPC channel table + registration. Every renderer->main channel is declared
// here with its payload schema; registerIpc() wires handlers and enforces the
// schema before the handler runs. Handlers are injected (no electron import)
// so this module and the contract test run under plain node.
//
// Every handler returns raw data; registerIpc wraps it into the uniform
// envelope: {ok:true, data} | {ok:false, error:{code, message}}.

const { validate } = require('./validate');

const CHANNELS = Object.freeze({
  // app
  'dm:app:getInfo': null,
  'dm:app:showWindow': null,
  'dm:app:quit': null,
  'dm:app:openExternal': { url: 'url' },
  'dm:app:copyText': { text: 'string0' },
  'dm:app:getVersions': null,

  // tasks
  'dm:tasks:list': null,
  'dm:tasks:get': { id: 'id' },
  'dm:tasks:add': {
    url: 'url',
    filename: 'string?',
    dir: 'path?',
    connections: 'int:1-64?',
    headers: 'headers?',
    kind: 'enum:http?',
    source: 'enum:ui,extension,protocol?',
  },
  'dm:tasks:remove': { id: 'id', deleteFile: 'bool?' },
  'dm:tasks:pause': { id: 'id' },
  'dm:tasks:resume': { id: 'id' },
  'dm:tasks:cancel': { id: 'id' },
  'dm:tasks:pauseAll': null,
  'dm:tasks:resumeAll': null,
  'dm:tasks:openFile': { id: 'id' },
  'dm:tasks:showInFolder': { id: 'id' },
  'dm:tasks:clearFinished': null,

  // queue
  'dm:queue:getState': null,

  // capture (browser extension bridge)
  'dm:capture:getServerInfo': null,
  'dm:capture:getToken': null,
  'dm:capture:rotateToken': null,
  'dm:capture:getAllowlist': null,
  'dm:capture:revokeOrigin': { origin: 'string' },
  'dm:capture:startPairing': null,
  'dm:capture:cancelPairing': null,
  'dm:capture:getProtocolToken': null,
  'dm:capture:rotateProtocolToken': null,

  // settings
  'dm:settings:get': null,
  'dm:settings:patch': { patch: 'object' },
  'dm:settings:reset': null,

  // dialogs
  'dm:dialog:chooseDirectory': null,

  // i18n
  'dm:i18n:get': { locale: 'locale?' },
  'dm:i18n:getLocales': null,
});

// main -> renderer streams (preload subscribes; not invokable).
const EVENT_CHANNELS = Object.freeze(['dm:evt:tasks', 'dm:evt:settings']);

/**
 * @param {{ipcMain: import('electron').IpcMain, handlers: Record<string, Function>}} deps
 * @returns {{missing: string[]}}
 */
function registerIpc({ ipcMain, handlers }) {
  const missing = [];
  for (const [channel, schema] of Object.entries(CHANNELS)) {
    const handler = handlers[channel];
    if (typeof handler !== 'function') {
      missing.push(channel);
      continue;
    }
    ipcMain.handle(channel, async (_event, payload) => {
      const v = validate(schema, payload);
      if (!v.ok) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: v.reason } };
      }
      try {
        const data = await handler(v.value);
        return { ok: true, data };
      } catch (err) {
        // Handlers may throw with a machine-readable .code; otherwise INTERNAL.
        const code = err && typeof err.code === 'string' ? err.code : 'INTERNAL';
        return { ok: false, error: { code, message: String((err && err.message) || err) } };
      }
    });
  }
  return { missing };
}

module.exports = { CHANNELS, EVENT_CHANNELS, registerIpc };
