'use strict';

// In-memory task list with debounced atomic persistence.
//
// The store is the single source of truth for task records; the download
// engine (M3) mutates tasks through update(). Change notifications are
// coalesced (~4 Hz) into summary batches so the UI and tray can never be
// flooded by segment-level progress events.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { writeFileAtomic, readJsonWithBak } = require('./atomic');
const { categoryOfAny } = require('../util/categorize');

const SCHEMA_VERSION = 1;
const MAX_FINISHED = 5000;
const PERSIST_DEBOUNCE_MS = 500;
const NOTIFY_WINDOW_MS = 250;

const FINISHED = new Set(['done', 'canceled']);

// Fields the engine/UI may patch through update().
const PATCHABLE = new Set([
  'status', 'finalUrl', 'filename', 'dir', 'filePath', 'partPath', 'sidecarPath',
  'totalBytes', 'downloadedBytes', 'supportsRange', 'resumable', 'etag', 'lastModified',
  'segments', 'speedBps', 'priority', 'error', 'checksum', 'kind',
]);

class TaskStore extends EventEmitter {
  /**
   * @param {{file: string, log?: any, maxFinished?: number}} opts
   */
  constructor({ file, log = null, maxFinished = MAX_FINISHED }) {
    super();
    this.file = file;
    this.log = log;
    this.maxFinished = maxFinished;
    this.tasks = new Map();
    this.order = [];
    this._persistTimer = null;
    this._notifyTimer = null;
    this._pendingNotifications = new Map();
    this._dirty = false;
  }

  /** Test/diagnostics hook: count real disk writes. */
  get persistCount() {
    return this._persists || 0;
  }

  async load() {
    const res = await readJsonWithBak(this.file);
    if (!res) return this;
    if (this.log && res.from !== this.file) this.log.warn(`task store: recovered from ${res.from}`);
    const doc = res.value;
    const list = Array.isArray(doc && doc.tasks) ? doc.tasks : [];
    for (const rec of list) {
      try {
        const task = normalizeRecord(rec);
        if (!task) continue;
        this.tasks.set(task.id, task);
      } catch {
        /* drop unusable record rather than failing the whole load */
      }
    }
    const savedOrder = Array.isArray(doc && doc.order) ? doc.order : [];
    this.order = savedOrder.filter((id) => this.tasks.has(id));
    for (const id of this.tasks.keys()) if (!this.order.includes(id)) this.order.push(id);
    this._pruneFinished();
    return this;
  }

  list() {
    return this.order.map((id) => this.tasks.get(id)).filter(Boolean);
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  summary(task) {
    return {
      id: task.id,
      status: task.status,
      kind: task.kind,
      url: task.url,
      filename: task.filename,
      dir: task.dir,
      category: categoryOfAny(task.filename, task.url),
      totalBytes: task.totalBytes,
      downloadedBytes: task.downloadedBytes,
      speedBps: task.speedBps,
      progress: task.totalBytes ? Math.min(1, task.downloadedBytes / task.totalBytes) : 0,
      error: task.error ? { code: task.error.code, message: task.error.message } : null,
      source: task.source,
      createdAt: task.createdAt,
      // Per-segment view for the UI (small: <= 64 entries, coalesced updates).
      segments: Array.isArray(task.segments)
        ? task.segments.map((s) => ({ i: s.i, start: s.start, end: s.end, done: s.done, state: s.state }))
        : [],
    };
  }

  add(spec) {
    const now = Date.now();
    const task = {
      id: 't_' + crypto.randomBytes(6).toString('hex'),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      kind: spec.kind || 'http',
      url: spec.url,
      finalUrl: null,
      dir: spec.dir,
      filename: spec.filename || null,
      filePath: null,
      partPath: null,
      sidecarPath: null,
      totalBytes: null,
      downloadedBytes: 0,
      supportsRange: null,
      resumable: true,
      etag: null,
      lastModified: null,
      segments: [],
      speedBps: 0,
      priority: 0,
      source: spec.source || 'ui',
      requestHeaders: spec.headers || null,
      error: null,
      checksum: null,
    };
    this.tasks.set(task.id, task);
    this.order.push(task.id);
    this._touch(task);
    return this.summary(task);
  }

  update(id, patch) {
    const task = this.tasks.get(id);
    if (!task) return null;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) continue;
      if (JSON.stringify(task[k]) !== JSON.stringify(v)) {
        task[k] = v;
        changed = true;
      }
    }
    if (!changed) return this.summary(task);
    this._touch(task);
    return this.summary(task);
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this._pendingNotifications.delete(id);
    this._schedulePersist();
    this.emit('removed', { id });
    return true;
  }

  clearFinished() {
    let n = 0;
    for (const id of [...this.order]) {
      const t = this.tasks.get(id);
      if (t && FINISHED.has(t.status)) {
        this.remove(id);
        n++;
      }
    }
    return n;
  }

  _touch(task) {
    task.updatedAt = Date.now();
    this._pendingNotifications.set(task.id, this.summary(task));
    this._schedulePersist();
    this._scheduleNotify();
  }

  _schedulePersist() {
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.flush().catch(() => {});
    }, PERSIST_DEBOUNCE_MS);
  }

  _scheduleNotify() {
    if (this._notifyTimer) return;
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null;
      const updates = [...this._pendingNotifications.values()];
      this._pendingNotifications.clear();
      if (updates.length > 0) this.emit('tasks-changed', updates);
    }, NOTIFY_WINDOW_MS);
  }

  _pruneFinished() {
    const finished = this.order.filter((id) => {
      const t = this.tasks.get(id);
      return t && FINISHED.has(t.status);
    });
    const excess = finished.length - this.maxFinished;
    if (excess <= 0) return;
    // finished[] is in insertion order; drop the oldest excess
    for (const id of finished.slice(0, excess)) {
      this.tasks.delete(id);
      this.order = this.order.filter((x) => x !== id);
      this._dirty = true;
    }
  }

  /** Force an immediate persist (quit path, tests). */
  async flush() {
    if (!this._dirty) return;
    this._dirty = false;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      order: this.order,
      tasks: this.list(),
    };
    await writeFileAtomic(this.file, JSON.stringify(doc, null, 2), { log: this.log });
    this._persists = (this._persists || 0) + 1;
  }

  /** Stop timers (tests / shutdown). */
  dispose() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    if (this._notifyTimer) clearTimeout(this._notifyTimer);
    this._persistTimer = null;
    this._notifyTimer = null;
  }
}

function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (typeof rec.id !== 'string' || rec.id === '') return null;
  if (typeof rec.url !== 'string' || rec.url === '') return null;
  const task = {
    id: rec.id,
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : Date.now(),
    updatedAt: Number.isFinite(rec.updatedAt) ? rec.updatedAt : Date.now(),
    status: typeof rec.status === 'string' ? rec.status : 'paused',
    kind: typeof rec.kind === 'string' ? rec.kind : 'http',
    url: rec.url,
    finalUrl: typeof rec.finalUrl === 'string' ? rec.finalUrl : null,
    dir: typeof rec.dir === 'string' ? rec.dir : '',
    filename: typeof rec.filename === 'string' ? rec.filename : null,
    filePath: typeof rec.filePath === 'string' ? rec.filePath : null,
    partPath: typeof rec.partPath === 'string' ? rec.partPath : null,
    sidecarPath: typeof rec.sidecarPath === 'string' ? rec.sidecarPath : null,
    totalBytes: Number.isFinite(rec.totalBytes) ? rec.totalBytes : null,
    downloadedBytes: Number.isFinite(rec.downloadedBytes) ? rec.downloadedBytes : 0,
    supportsRange: rec.supportsRange === true ? true : rec.supportsRange === false ? false : null,
    resumable: rec.resumable !== false,
    etag: typeof rec.etag === 'string' ? rec.etag : null,
    lastModified: typeof rec.lastModified === 'string' ? rec.lastModified : null,
    segments: Array.isArray(rec.segments) ? rec.segments : [],
    speedBps: Number.isFinite(rec.speedBps) ? rec.speedBps : 0,
    priority: Number.isFinite(rec.priority) ? rec.priority : 0,
    source: typeof rec.source === 'string' ? rec.source : 'ui',
    requestHeaders: rec.requestHeaders && typeof rec.requestHeaders === 'object' ? rec.requestHeaders : null,
    error: rec.error && typeof rec.error === 'object' ? rec.error : null,
    checksum: typeof rec.checksum === 'string' ? rec.checksum : null,
  };
  // Tasks interrupted mid-flight restart paused (engine resumes on demand).
  if (['connecting', 'downloading', 'merging'].includes(task.status)) task.status = 'paused';
  return task;
}

module.exports = { TaskStore, SCHEMA_VERSION, FINISHED };
