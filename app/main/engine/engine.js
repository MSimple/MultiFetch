'use strict';

// EngineHost — the download engine. Electron-free: it mutates the task store
// and emits nothing itself (the store's coalesced events drive the UI).
//
// Lifecycle: queued -> connecting -> downloading -> done | paused | error | canceled.
// A task occupies one of `maxConcurrent` slots; its segments compete for the
// shared connection budget and the global byte-rate limiter.
//
// Resume: a .dmpart data file plus a .dmpart.json sidecar. A resume is only
// honored when the fresh probe matches the sidecar (same total size, and
// matching validators when the server provides them).

const path = require('node:path');
const { EventEmitter } = require('node:events');

const { probe } = require('./probe');
const { planSegments, rebuildFromSidecar, totalDone } = require('./plan');
const { downloadSegment, sleep } = require('./segment');
const { EngineError } = require('./errors');
const { backoffDelayMs } = require('./retry');
const { TokenBucket, SpeedSampler } = require('./speed');
const { uniqueName, scratchPaths } = require('./naming');
const writer = require('./writer');

const { sanitizeFilename, containedPath, verifyTargetPath } = require('../security/sanitize');
const { ensureUsableDir, pathBudgetOk } = require('../store/paths');

const MAX_REPLANS = 1;
const SIDECAR_SUFFIX_LEN = '.dmpart.json'.length;
const MIN_STEAL_REMAINING_BYTES = 2 * 1024 * 1024; // only split a donor with more than this left
const MAX_TOTAL_SEGMENTS = 64; // planned + stolen slices

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const w = this.waiters.shift();
    if (w) {
      w(); // hand the slot straight over; `active` stays the same
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  setLimit(n) {
    this.limit = Math.max(1, n | 0);
    while (this.active < this.limit && this.waiters.length > 0) {
      this.active++;
      this.waiters.shift()();
    }
  }
}

function segSnapshot(segments) {
  return segments.map((s) => ({ i: s.i, start: s.start, end: s.end, done: s.done, state: s.state }));
}

function basenameFromUrl(url) {
  try {
    const base = path.basename(new URL(url).pathname);
    return decodeURIComponent(base) || null;
  } catch {
    return null;
  }
}

/** Shrink a name so dir + name + ".dmpart.json" stays within the path budget. */
function fitName(dir, name) {
  if (pathBudgetOk(dir, name, SIDECAR_SUFFIX_LEN)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const cps = Array.from(stem);
  for (let len = cps.length - 8; len >= 8; len -= 8) {
    const candidate = cps.slice(0, len).join('') + ext;
    if (pathBudgetOk(dir, candidate, SIDECAR_SUFFIX_LEN)) return candidate;
  }
  return `dl-${Date.now()}${ext}`;
}

class Engine extends EventEmitter {
  constructor({ store, log = null, defaults = {} }) {
    super();
    this.store = store;
    this.log = log;
    this.maxConcurrent = Math.max(1, defaults.maxConcurrent || 3);
    this.defaultConnections = Math.max(1, defaults.defaultConnections || 8);
    this.connSem = new Semaphore(defaults.maxConnections || 16);
    this.bucket = new TokenBucket(defaults.globalSpeedLimit != null ? defaults.globalSpeedLimit : null);
    this.runners = new Map();
    this.disposed = false;
  }

  setLimits({ maxConcurrent, maxConnections, defaultConnections, globalSpeedLimit }) {
    if (Number.isFinite(maxConcurrent)) this.maxConcurrent = Math.max(1, maxConcurrent | 0);
    if (Number.isFinite(maxConnections)) this.connSem.setLimit(maxConnections);
    if (Number.isFinite(defaultConnections)) this.defaultConnections = Math.max(1, defaultConnections | 0);
    if (globalSpeedLimit !== undefined) this.bucket.setRate(globalSpeedLimit);
    this.kick();
  }

  /** Start any queued tasks while slots are free. */
  kick() {
    if (this.disposed) return;
    for (const t of this.store.list()) {
      if (this.runners.size >= this.maxConcurrent) break;
      if (t.status !== 'queued') continue;
      this._start(t.id);
    }
  }

  _start(id) {
    const ctx = {
      id,
      abort: new AbortController(),
      pauseRequested: false,
      canceled: false,
      failure: null,
      forceNoRange: false,
    };
    this.runners.set(id, ctx);
    this.store.update(id, { status: 'connecting', error: null, speedBps: 0 });
    this._runTask(ctx)
      .catch(() => {})
      .finally(() => {
        this.runners.delete(id);
        this.kick();
      });
  }

  pause(id) {
    const ctx = this.runners.get(id);
    if (ctx) {
      ctx.pauseRequested = true;
      ctx.abort.abort();
    }
    this.store.update(id, { status: 'paused', speedBps: 0 });
  }

  resume(id) {
    const t = this.store.get(id);
    if (!t) return false;
    const ctx = this.runners.get(id);
    if (ctx) {
      // A runner is still winding down (pause()/cancel() set the status
      // synchronously but the abort settles a moment later). Mark it to
      // re-queue on settle — silently dropping the resume would strand the task.
      ctx.resumeAfterSettle = true;
      this.store.update(id, { status: 'queued', error: null });
      return true;
    }
    this.store.update(id, { status: 'queued', error: null });
    this.kick();
    return true;
  }

  cancel(id) {
    const ctx = this.runners.get(id);
    if (ctx) {
      ctx.canceled = true;
      ctx.abort.abort();
    }
    this.store.update(id, { status: 'canceled', speedBps: 0, error: null });
    if (!ctx) {
      // not running: clean up scratch immediately
      const t = this.store.get(id);
      if (t) void writer.unlinkQuiet([t.partPath, t.sidecarPath]);
    }
  }

  /** Stop (if running), remove the record, optionally delete the final file. */
  async remove(id, { deleteFile = false } = {}) {
    const t = this.store.get(id);
    this.cancel(id);
    if (t && deleteFile && t.filePath) {
      await writer.unlinkQuiet([t.filePath]);
    }
    this.store.remove(id);
  }

  async resumeAll() {
    for (const s of this.store.list()) {
      if (s.status === 'paused') this.resume(s.id);
    }
  }

  async pauseAll() {
    for (const s of this.store.list()) {
      if (['queued', 'connecting', 'downloading'].includes(s.status)) this.pause(s.id);
    }
  }

  dispose() {
    this.disposed = true;
    for (const ctx of this.runners.values()) {
      ctx.canceled = true;
      ctx.abort.abort();
    }
  }

  async _runTask(ctx) {
    const { id } = ctx;
    let replans = 0;
    let probeRetries = 0;

    for (;;) {
      const task = this.store.get(id);
      if (!task || this.disposed) return;
      let fh = null;

      try {
        const probeRes = await probe(task.url, task.requestHeaders, { signal: ctx.abort.signal });

        const dirRes = await ensureUsableDir(task.dir);
        if (!dirRes.ok) throw new EngineError('BAD_DIR', `download directory unusable (${dirRes.code})`);

        const isResume = typeof task.filePath === 'string' && task.filePath !== '';
        let finalName;
        if (isResume) {
          finalName = path.basename(task.filePath);
        } else {
          const candidate =
            task.filename ||
            probeRes.filenameHint ||
            basenameFromUrl(probeRes.finalUrl) ||
            `download-${Date.now()}`;
          const clean = sanitizeFilename(candidate);
          if (!clean.ok) throw new EngineError('UNSAFE_NAME', `unsafe file name (${clean.code})`);
          finalName = uniqueName(dirRes.dir, fitName(dirRes.dir, clean.name));
        }

        const target = containedPath(dirRes.dir, finalName);
        if (!target.ok) throw new EngineError('UNSAFE_NAME', `target escapes directory (${target.code})`);
        const v = await verifyTargetPath(dirRes.dir, finalName);
        if (!v.ok) throw new EngineError('UNSAFE_NAME', `unsafe target (${v.code})`);

        const finalPath = target.path;
        const { partPath, sidecarPath } = scratchPaths(finalPath);

        this.store.update(id, {
          status: 'downloading',
          finalUrl: probeRes.finalUrl,
          filename: finalName,
          filePath: finalPath,
          partPath,
          sidecarPath,
          totalBytes: probeRes.totalBytes,
          etag: probeRes.etag,
          lastModified: probeRes.lastModified,
          supportsRange: probeRes.supportsRange,
          error: null,
        });

        const supportsRange = probeRes.supportsRange && !ctx.forceNoRange;

        // ---- resume decision ----
        // Resume rebuilds the EXACT recorded segmentation (work-stolen layouts
        // included) after validator checks — a fresh equal-chunk plan would not
        // match a stolen layout and would throw the progress away.
        let segments = null;
        if (isResume && supportsRange && probeRes.totalBytes != null) {
          const sidecar = await writer.readSidecar(sidecarPath);
          const matches =
            sidecar &&
            sidecar.totalBytes === probeRes.totalBytes &&
            (!probeRes.etag || !sidecar.etag || sidecar.etag === probeRes.etag) &&
            (!probeRes.lastModified || !sidecar.lastModified || sidecar.lastModified === probeRes.lastModified);
          if (matches) {
            const rebuilt = rebuildFromSidecar(sidecar.segments, probeRes.totalBytes);
            if (rebuilt) {
              fh = await writer.openPartForResume(partPath).catch(() => null);
              if (fh) {
                segments = rebuilt;
                const st = await fh.stat();
                if (st.size < probeRes.totalBytes) await writer.preallocate(fh, probeRes.totalBytes);
                else if (st.size > probeRes.totalBytes) await fh.truncate(probeRes.totalBytes);
                if (this.log) this.log.info(`task ${id}: resumed with ${totalDone(segments)} bytes on disk`);
              }
            }
          }
        }
        if (!segments) {
          if (fh) {
            await fh.close().catch(() => {});
            fh = null;
          }
          await writer.unlinkQuiet([sidecarPath]);
          fh = await writer.openPart(partPath);
          segments = planSegments(probeRes.totalBytes, supportsRange, {
            segmentsPerTask: this.defaultConnections,
            maxSegments: MAX_TOTAL_SEGMENTS,
          });
          await writer.preallocate(fh, probeRes.totalBytes);
        }

        this.store.update(id, {
          segments: segSnapshot(segments),
          downloadedBytes: totalDone(segments),
          resumable: supportsRange,
        });

        // ---- run ----
        const sampler = new SpeedSampler();
        const sidecarDoc = () => ({
          schemaVersion: 1,
          taskId: id,
          url: task.url,
          finalUrl: probeRes.finalUrl,
          totalBytes: probeRes.totalBytes,
          etag: probeRes.etag,
          lastModified: probeRes.lastModified,
          segments: segSnapshot(segments).map(({ i, start, end, done }) => ({ i, start, end, done })),
          savedAt: Date.now(),
        });
        const speedTimer = setInterval(() => {
          this.store.update(id, {
            speedBps: sampler.speed(),
            downloadedBytes: totalDone(segments),
            segments: segSnapshot(segments),
          });
        }, 700);
        const sidecarTimer = setInterval(() => {
          void writer.saveSidecar(sidecarPath, sidecarDoc()).catch(() => {});
        }, 1000);

        // A worker owns one segment at a time. When it finishes, it tries to
        // steal: split the largest remaining segment's tail in half and take
        // it — "the slow segment gets extra threads", so one laggard cannot
        // drag the whole tail of the download.
        const runWorker = async (initialSeg) => {
          let seg = initialSeg;
          for (;;) {
            await this.connSem.acquire();
            try {
              await downloadSegment({
                url: probeRes.finalUrl,
                headers: task.requestHeaders,
                seg,
                fh,
                signal: ctx.abort.signal,
                limiter: this.bucket,
                ranged: supportsRange,
                onProgress: (n) => sampler.add(n),
                log: this.log ? (m) => this.log.debug(m) : undefined,
              });
            } catch (err) {
              // First fatal segment failure aborts its siblings.
              if (!ctx.failure && err && err.code && err.code !== 'ABORTED') {
                ctx.failure = err;
                ctx.abort.abort();
              }
              throw err;
            } finally {
              this.connSem.release();
            }

            if (seg.end != null) {
              // A shrunk donor may have overshot its new end (its in-flight
              // response kept streaming; the duplicate bytes are identical).
              seg.done = Math.min(seg.done, seg.end - seg.start + 1);
            }
            seg.state = 'done';

            if (ctx.abort.signal.aborted) return;
            if (!supportsRange || segments.length >= MAX_TOTAL_SEGMENTS) return;

            let donor = null;
            let donorRemaining = 0;
            for (const s of segments) {
              if (s === seg || s.state === 'done' || s.end == null) continue;
              const remaining = s.end - s.start + 1 - s.done;
              if (remaining > donorRemaining) {
                donorRemaining = remaining;
                donor = s;
              }
            }
            if (!donor || donorRemaining <= MIN_STEAL_REMAINING_BYTES) return;

            const steal = Math.floor(donorRemaining / 2);
            const oldEnd = donor.end;
            donor.end = oldEnd - steal;
            const slice = { i: segments.length, start: donor.end + 1, end: oldEnd, done: 0, state: 'pending' };
            segments.push(slice);
            this.store.update(id, { segments: segSnapshot(segments) });
            if (this.log) {
              this.log.debug(`task ${id}: stole ${steal} bytes [${slice.start}-${slice.end}] from segment ${donor.i}`);
            }
            seg = slice;
          }
        };

        try {
          await Promise.all(segments.filter((s) => s.state !== 'done').map((s) => runWorker(s)));
        } finally {
          clearInterval(speedTimer);
          clearInterval(sidecarTimer);
          await writer.saveSidecar(sidecarPath, sidecarDoc()).catch(() => {});
        }

        if (ctx.abort.signal.aborted) throw new EngineError('ABORTED', 'aborted');

        // ---- completeness ----
        if (probeRes.totalBytes != null) {
          const done = totalDone(segments);
          if (done !== probeRes.totalBytes) {
            throw new EngineError('INCOMPLETE', `incomplete: ${done}/${probeRes.totalBytes}`, { retryable: true });
          }
          const st = await fh.stat();
          if (st.size !== probeRes.totalBytes) {
            throw new EngineError('SIZE_MISMATCH', `size mismatch: ${st.size} != ${probeRes.totalBytes}`);
          }
        } else if (segments.some((s) => s.state !== 'done')) {
          throw new EngineError('INCOMPLETE', 'stream incomplete', { retryable: true });
        }

        await writer.finalize(fh, partPath, finalPath, this.log);
        fh = null; // closed by finalize()
        await writer.unlinkQuiet([sidecarPath]);
        this.store.update(id, {
          status: 'done',
          downloadedBytes: probeRes.totalBytes != null ? probeRes.totalBytes : totalDone(segments),
          speedBps: 0,
          segments: segSnapshot(segments),
        });
        if (this.log) this.log.info(`task ${id} done: ${finalName}`);
        return;
      } catch (rawErr) {
        let e =
          rawErr instanceof EngineError
            ? rawErr
            : new EngineError('INTERNAL', (rawErr && rawErr.message) || String(rawErr));
        // Translate the classic big-file environment failures into actionable
        // errors: FAT32's 4 GiB single-file ceiling and a full disk.
        const diskHay = `${(rawErr && rawErr.code) || ''} ${e.code} ${e.message}`;
        if (/EFBIG/.test(diskHay)) {
          e = new EngineError(
            'DISK_FILE_LIMIT',
            '目标磁盘不支持超过 4GB 的单文件（常见于 FAT32 分区）。请更换保存目录，或改用 NTFS/exFAT 分区'
          );
        } else if (/ENOSPC/.test(diskHay)) {
          e = new EngineError('DISK_FULL', '磁盘空间不足。请清理空间或更换保存目录');
        }
        if (fh) {
          await fh.close().catch(() => {});
          fh = null;
        }

        const requeue = ctx.resumeAfterSettle === true;
        if (ctx.canceled && !requeue) {
          const t = this.store.get(id);
          if (t) await writer.unlinkQuiet([t.partPath, t.sidecarPath]);
          this.store.update(id, { status: 'canceled', speedBps: 0 });
          return;
        }
        if (ctx.pauseRequested && !requeue) {
          this.store.update(id, { status: 'paused', speedBps: 0 });
          return;
        }
        if (requeue) {
          // pause/cancel was immediately followed by resume: settle as queued
          // and let the finally-block's kick() start the task again.
          this.store.update(id, { status: 'queued', error: null, speedBps: 0 });
          return;
        }
        if (ctx.failure) {
          this.store.update(id, {
            status: 'error',
            speedBps: 0,
            error: { code: ctx.failure.code, message: ctx.failure.message },
          });
          return;
        }
        if ((e.code === 'HTTP_429' || e.code === 'HTTP_503') && probeRetries < 3) {
          // Rate-limited at probe time: cool down and re-probe instead of failing.
          probeRetries++;
          const waitMs = e.retryAfterMs != null ? e.retryAfterMs : backoffDelayMs(probeRetries - 1);
          if (this.log) this.log.warn(`task ${id}: probe ${e.code}, retry ${probeRetries}/3 in ${waitMs}ms`);
          this.store.update(id, { status: 'connecting', error: null });
          await sleep(waitMs, ctx.abort.signal).catch(() => {});
          continue;
        }
        if ((e.code === 'SERVER_IGNORED_RANGE' || e.code === 'RANGE_NOT_SATISFIABLE') && replans < MAX_REPLANS) {
          replans++;
          ctx.forceNoRange = true;
          const t = this.store.get(id);
          if (t) await writer.unlinkQuiet([t.partPath, t.sidecarPath]);
          this.store.update(id, { status: 'connecting', downloadedBytes: 0, segments: [], error: null });
          continue; // re-probe and re-plan (single stream)
        }
        if (e.code === 'ABORTED') return; // aborted without a request: leaving state as-is

        this.store.update(id, {
          status: 'error',
          speedBps: 0,
          error: { code: e.code, message: e.message },
        });
        if (this.log) this.log.warn(`task ${id} failed: ${e.code} ${e.message}`);
        return;
      }
    }
  }
}

module.exports = { Engine, Semaphore, fitName };
