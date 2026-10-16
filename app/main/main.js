'use strict';

// Entry point — the wiring layer. This and the other app/main/*.js wiring
// modules are the only places where Electron APIs meet the electron-free core
// (store / security / engine / capture / util).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, ipcMain, dialog, session, shell, Notification, clipboard } = require('electron');

const { createLogger } = require('./util/log');
const { TaskStore } = require('./store/taskstore');
const { SettingsStore } = require('./store/settings');
const { ensureUsableDir } = require('./store/paths');
const { cleanupStaleTmp } = require('./store/atomic');
const { sanitizeFilename } = require('./security/sanitize');
const { registerIpc } = require('./ipc/register');
const { isHiddenLaunch, extractProtocolUrls } = require('./argv');
const { createMainWindow, applySessionHardening } = require('./windows');
const { openExternal } = require('./external');
const { Engine } = require('./engine/engine');
const { SecretsStore } = require('./store/secrets');
const { parseProtocolUrl, registerProtocolClient } = require('./protocol');
const { applyAutoLaunch } = require('./autolaunch');
const { createTray } = require('./tray');
const { createCaptureApi } = require('./capture/routes');
const { createCaptureServer } = require('./capture/server');
const { isExtensionOrigin } = require('./capture/auth');

const I18N_DIR = path.join(__dirname, '..', 'shared', 'i18n');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit(); // another instance owns the lock
} else {
  boot();
}

function boot() {
  let win = null;
  let log = null;
  let taskStore = null;
  let settingsStore = null;
  let engine = null;
  let secrets = null;
  let capture = null;
  let captureServer = null;
  let tray = null;
  let isQuitting = false;

  app.on('second-instance', (_event, argv) => {
    surfaceWindow();
    dispatchProtocolUrls(argv);
  });

  app.on('window-all-closed', () => {
    // Tray residency: with closeToTray the window only hides, so this fires
    // just on real quits; without it, closing the window ends the app.
    if (!settingsStore || !settingsStore.get().closeToTray) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (engine) engine.dispose();
    if (captureServer) void captureServer.stop();
    if (taskStore) {
      taskStore.dispose();
      void taskStore.flush();
    }
    if (settingsStore) {
      settingsStore.dispose();
      void settingsStore.flush();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('downloadmgr');

    const userData = app.getPath('userData');
    log = createLogger({ dir: path.join(userData, 'logs') });
    await cleanupStaleTmp(userData);

    settingsStore = new SettingsStore({
      file: path.join(userData, 'settings.json'),
      log: log.child('settings'),
    });
    await settingsStore.load();
    if (!settingsStore.get().defaultDir) {
      settingsStore.patch({ defaultDir: safeDefaultDownloadDir() });
    }

    taskStore = new TaskStore({
      file: path.join(userData, 'tasks.json'),
      log: log.child('tasks'),
    });
    await taskStore.load();

    secrets = new SecretsStore({
      file: path.join(userData, 'security.json'),
      log: log.child('secrets'),
    });
    await secrets.load();

    engine = new Engine({
      store: taskStore,
      log: log.child('engine'),
      defaults: {
        maxConcurrent: settingsStore.get().maxConcurrent,
        defaultConnections: settingsStore.get().defaultConnections,
        maxConnections: settingsStore.get().maxConnections,
        globalSpeedLimit: settingsStore.get().globalSpeedLimit,
      },
    });

    capture = createCaptureApi({
      secrets,
      settings: settingsStore,
      version: app.getVersion(),
      log: log.child('capture'),
      getQueueStats: () => {
        const list = taskStore.list();
        return {
          active: list.filter((t) => ['connecting', 'downloading'].includes(t.status)).length,
          queued: list.filter((t) => t.status === 'queued').length,
          maxConcurrent: settingsStore.get().maxConcurrent,
        };
      },
      taskSink: async (item) => {
        const dirRes = await ensureUsableDir(settingsStore.get().defaultDir);
        if (!dirRes.ok) throw new Error(`download directory unusable (${dirRes.code})`);
        const s = taskStore.add({
          url: item.url,
          dir: dirRes.dir,
          filename: item.filename || null,
          headers: item.headers || null,
          source: 'extension',
        });
        const autoAdd = settingsStore.get().capture.autoAdd;
        if (autoAdd) engine.kick();
        else taskStore.update(s.id, { status: 'awaiting' }); // waits for the user to confirm
        return { taskId: s.id, status: autoAdd ? 'queued' : 'awaiting' };
      },
    });
    captureServer = createCaptureServer({
      handle: capture.handle,
      port: settingsStore.get().capture.port,
      log: log.child('capture'),
    });
    try {
      await captureServer.start();
    } catch (e) {
      log.warn(`capture server failed to start: ${e.message}`);
    }

    applySessionHardening(session.defaultSession);

    win = createMainWindow({ startHidden: isHiddenLaunch(process.argv) });
    win.on('close', (e) => {
      if (!isQuitting && settingsStore.get().closeToTray) {
        e.preventDefault();
        win.hide();
        maybeShowTrayHint();
      }
    });

    const m = readLang(settingsStore.get().locale);
    tray = createTray({
      iconPath: path.join(__dirname, '..', 'renderer', 'assets', 'tray.png'),
      strings: {
        tooltip: m['tray.tooltip'] || 'downloadmgr',
        show: m['tray.show'] || 'Show window',
        pauseAll: m['tray.pauseAll'] || 'Pause all',
        resumeAll: m['tray.resumeAll'] || 'Resume all',
        quit: m['tray.quit'] || 'Quit',
      },
      onShow: () => surfaceWindow(),
      onPauseAll: () => engine && engine.pauseAll(),
      onResumeAll: () => engine && engine.resumeAll(),
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
    });

    registerProtocolClient(app, { isPackaged: app.isPackaged });
    applyAutoLaunch(app, settingsStore.get().autoLaunch);
    if (settingsStore.get().autoResume) engine.resumeAll();

    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };
    const lastStatus = new Map();
    taskStore.on('tasks-changed', (updates) => {
      send('dm:evt:tasks', updates);
      notifyTransitions(updates, lastStatus);
      updateTaskbarProgress();
    });
    taskStore.on('removed', ({ id }) => lastStatus.delete(id));
    settingsStore.on('settings-changed', (values) => {
      send('dm:evt:settings', values);
      engine.setLimits({
        maxConcurrent: values.maxConcurrent,
        maxConnections: values.maxConnections,
        defaultConnections: values.defaultConnections,
        globalSpeedLimit: values.globalSpeedLimit,
      });
      applyAutoLaunch(app, values.autoLaunch);
      updateTaskbarProgress();
    });

    const { missing } = registerIpc({ ipcMain, handlers: buildHandlers() });
    if (missing.length > 0) log.error(`IPC handlers missing: ${missing.join(', ')}`);

    engine.kick(); // continue tasks left queued from a previous session
    dispatchProtocolUrls(process.argv);

    log.info('downloadmgr ready');
  });

  function surfaceWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // Shown once, the first time the window is hidden to the tray, so users do
  // not mistake "close" for "quit".
  function maybeShowTrayHint() {
    try {
      if (settingsStore.get().trayHintShown) return;
      const m = readLang(settingsStore.get().locale);
      const title = m['notify.tray.title'] || 'downloadmgr';
      const body = m['notify.tray.body'] || 'Still running in the background.';
      if (tray && typeof tray.displayBalloon === 'function') {
        tray.displayBalloon({ title, content: body, iconType: 'info' });
      } else if (Notification.isSupported()) {
        new Notification({ title, body }).show();
      }
      settingsStore.patch({ trayHintShown: true });
    } catch (e) {
      if (log) log.warn(`tray hint failed: ${e.message}`);
    }
  }

  // A task's first-seen status is never alerted (that would fire for tasks
  // already present at startup); only a genuine transition into `done` is.
  function notifyTransitions(updates, lastStatus) {
    for (const u of updates) {
      if (!u || !u.id) continue;
      const prev = lastStatus.get(u.id);
      lastStatus.set(u.id, u.status);
      if (prev === undefined) continue;
      if (u.status === 'done' && prev !== 'done') showDoneNotification(u);
    }
  }

  function showDoneNotification(task) {
    try {
      if (!Notification.isSupported()) return;
      const m = readLang(settingsStore.get().locale);
      const n = new Notification({
        title: m['notify.done.title'] || 'Download complete',
        body: String(task.filename || task.url || ''),
        icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
      });
      n.on('click', () => surfaceWindow());
      n.show();
    } catch (e) {
      if (log) log.warn(`notification failed: ${e.message}`);
    }
  }

  // Reflect aggregate active-download progress on the Windows taskbar button.
  function updateTaskbarProgress() {
    if (!win || win.isDestroyed()) return;
    try {
      if (!settingsStore.get().showProgressOnStart) {
        win.setProgressBar(-1);
        return;
      }
      const active = taskStore.list().filter((t) => t.status === 'connecting' || t.status === 'downloading');
      if (active.length === 0) {
        win.setProgressBar(-1);
        return;
      }
      let done = 0;
      let total = 0;
      let unknown = false;
      for (const t of active) {
        if (Number.isFinite(t.totalBytes) && t.totalBytes > 0) {
          done += Math.min(t.downloadedBytes || 0, t.totalBytes);
          total += t.totalBytes;
        } else {
          unknown = true;
        }
      }
      if (total > 0) win.setProgressBar(Math.max(0, Math.min(1, done / total)));
      else if (unknown) win.setProgressBar(2); // indeterminate
      else win.setProgressBar(-1);
    } catch {
      /* taskbar progress is cosmetic; never let it break the app */
    }
  }

  function dispatchProtocolUrls(argv) {
    if (!engine || !secrets) return;
    for (const raw of extractProtocolUrls(argv)) {
      const r = parseProtocolUrl(raw, secrets.get().protocolToken);
      if (!r.ok) {
        if (log) log.warn(`protocol URL ignored: ${r.code}`);
        continue;
      }
      if (r.action === 'open') {
        if (log) log.info('protocol: open requested (app launch by extension)');
        continue;
      }
      const s = taskStore.add({ url: r.url, dir: settingsStore.get().defaultDir, source: 'protocol' });
      engine.kick();
      if (log) log.info(`protocol URL accepted -> task ${s.id}`);
    }
  }

  function requireTask(id) {
    const t = taskStore.get(id);
    if (!t) throw Object.assign(new Error('no such task'), { code: 'NOT_FOUND' });
    return t;
  }

  async function openTaskPath(id, mode) {
    const t = requireTask(id);
    if (!t.filePath || !fs.existsSync(t.filePath)) {
      throw Object.assign(new Error('task file missing'), { code: 'NO_FILE' });
    }
    if (mode === 'open') {
      const err = await shell.openPath(t.filePath);
      if (err) throw Object.assign(new Error(err), { code: 'OPEN_FAILED' });
    } else {
      shell.showItemInFolder(t.filePath);
    }
    return true;
  }

  function buildHandlers() {
    return {
      // ---- app ----
      'dm:app:getInfo': () => ({
        name: 'downloadmgr',
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
      }),
      'dm:app:getVersions': () => ({ ...process.versions }),
      'dm:app:showWindow': () => {
        surfaceWindow();
        return true;
      },
      'dm:app:quit': () => {
        app.quit();
        return true;
      },
      'dm:app:openExternal': ({ url }) => {
        const r = openExternal(url);
        if (!r.ok) throw Object.assign(new Error('scheme blocked'), { code: r.code });
        return true;
      },
      'dm:app:copyText': ({ text }) => {
        clipboard.writeText(String(text == null ? '' : text));
        return true;
      },

      // ---- tasks ----
      'dm:tasks:list': () => taskStore.list().map((t) => taskStore.summary(t)),
      'dm:tasks:get': ({ id }) => {
        const t = taskStore.get(id);
        if (!t) throw Object.assign(new Error('no such task'), { code: 'NOT_FOUND' });
        return t;
      },
      'dm:tasks:add': async (v) => {
        const dirRaw = v.dir || settingsStore.get().defaultDir;
        const dirRes = await ensureUsableDir(dirRaw);
        if (!dirRes.ok) {
          throw Object.assign(new Error(`download directory unusable (${dirRes.code})`), { code: 'BAD_DIR' });
        }
        let filename = null;
        if (v.filename) {
          const s = sanitizeFilename(v.filename);
          if (!s.ok) {
            throw Object.assign(new Error(`unsafe file name (${s.code})`), { code: s.code });
          }
          filename = s.name;
        }
        const summary = taskStore.add({
          url: v.url,
          dir: dirRes.dir,
          filename,
          headers: v.headers || null,
          kind: v.kind || 'http',
          source: v.source || 'ui',
        });
        engine.kick();
        return summary;
      },
      'dm:tasks:remove': async ({ id, deleteFile }) => {
        if (!taskStore.get(id)) {
          throw Object.assign(new Error('no such task'), { code: 'NOT_FOUND' });
        }
        await engine.remove(id, { deleteFile: !!deleteFile });
        return true;
      },
      'dm:tasks:pause': ({ id }) => {
        requireTask(id);
        engine.pause(id);
        return true;
      },
      'dm:tasks:resume': ({ id }) => {
        requireTask(id);
        engine.resume(id);
        return true;
      },
      'dm:tasks:cancel': ({ id }) => {
        requireTask(id);
        engine.cancel(id);
        return true;
      },
      'dm:tasks:pauseAll': () => {
        engine.pauseAll();
        return true;
      },
      'dm:tasks:resumeAll': () => {
        engine.resumeAll();
        return true;
      },
      'dm:tasks:openFile': ({ id }) => openTaskPath(id, 'open'),
      'dm:tasks:showInFolder': ({ id }) => openTaskPath(id, 'folder'),
      'dm:tasks:clearFinished': () => ({ removed: taskStore.clearFinished() }),
      'dm:queue:getState': () => {
        const list = taskStore.list();
        return {
          active: list.filter((t) => ['connecting', 'downloading'].includes(t.status)).length,
          queued: list.filter((t) => t.status === 'queued').length,
          maxConcurrent: settingsStore.get().maxConcurrent,
          globalSpeedLimit: settingsStore.get().globalSpeedLimit,
        };
      },

      // ---- capture / pairing ----
      'dm:capture:getServerInfo': () => ({
        running: Boolean(captureServer && captureServer.port),
        port: captureServer ? captureServer.port : null,
        pairedOrigins: settingsStore.get().capture.allowedOrigins.length,
        pairing: capture ? capture.getPairing() : null,
        autoAdd: settingsStore.get().capture.autoAdd,
      }),
      'dm:capture:getToken': () => secrets.get().captureToken,
      'dm:capture:rotateToken': async () => {
        await secrets.rotate('capture');
        return true;
      },
      'dm:capture:getAllowlist': () => settingsStore.get().capture.allowedOrigins,
      'dm:capture:revokeOrigin': ({ origin }) => {
        if (!isExtensionOrigin(origin)) {
          throw Object.assign(new Error('bad origin'), { code: 'BAD_REQUEST' });
        }
        if (!capture.revokeOrigin(origin)) {
          throw Object.assign(new Error('revoke failed'), { code: 'INTERNAL' });
        }
        return settingsStore.get().capture.allowedOrigins;
      },
      'dm:capture:startPairing': () => capture.startPairing(),
      'dm:capture:cancelPairing': () => {
        capture.cancelPairing();
        return true;
      },
      'dm:capture:getProtocolToken': () => secrets.get().protocolToken,
      'dm:capture:rotateProtocolToken': async () => {
        await secrets.rotate('protocol');
        return true;
      },

      // ---- settings ----
      'dm:settings:get': () => settingsStore.get(),
      'dm:settings:patch': ({ patch }) => {
        const r = settingsStore.patch(patch);
        if (!r.ok) {
          throw Object.assign(new Error(`rejected settings: ${r.rejected.join(', ')}`), {
            code: 'INVALID_SETTING',
          });
        }
        return r.values;
      },
      'dm:settings:reset': async () => {
        await settingsStore.reset();
        return settingsStore.get();
      },

      // ---- dialogs ----
      'dm:dialog:chooseDirectory': async () => {
        const r = await dialog.showOpenDialog(win || undefined, {
          properties: ['openDirectory', 'createDirectory'],
        });
        return r.canceled ? null : r.filePaths[0] || null;
      },

      // ---- i18n ----
      'dm:i18n:get': (v) => {
        const want = (v && v.locale) || settingsStore.get().locale || 'zh-CN';
        return { locale: want, strings: readLang(want), fallback: readLang('en') };
      },
      'dm:i18n:getLocales': () => listLocales(),
    };
  }
}

function safeDefaultDownloadDir() {
  try {
    const p = app.getPath('downloads');
    if (p) return p;
  } catch {
    /* some machines throw (redirected profiles, broken known folders) */
  }
  try {
    return path.join(app.getPath('home') || os.homedir(), 'Downloads');
  } catch {
    return os.homedir();
  }
}

function readLang(locale) {
  try {
    return JSON.parse(fs.readFileSync(path.join(I18N_DIR, `${locale}.json`), 'utf8'));
  } catch {
    return {};
  }
}

function listLocales() {
  try {
    return fs
      .readdirSync(I18N_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  } catch {
    return ['zh-CN', 'en'];
  }
}
