'use strict';

// Segment planning and resume validation. Pure math — unit tested in
// test/plan.test.js.

const MIN_CHUNK_BYTES = 1 * 1024 * 1024; // 1 MiB floor per segment: mid-size files still get real parallelism
const DEFAULT_MAX_SEGMENTS = 8;

/**
 * @param {number|null} totalBytes
 * @param {boolean} supportsRange
 * @param {{segmentsPerTask?: number, segmentSize?: number, maxSegments?: number}} [opts]
 * @returns {Array<{i:number,start:number,end:number|null,done:number,state:string}>}
 */
function planSegments(totalBytes, supportsRange, opts = {}) {
  const minChunk = opts.minChunkBytes || MIN_CHUNK_BYTES;
  const maxSegments = opts.maxSegments || DEFAULT_MAX_SEGMENTS;

  if (!supportsRange || totalBytes == null || totalBytes <= 0) {
    return [{ i: 0, start: 0, end: totalBytes != null ? totalBytes - 1 : null, done: 0, state: 'pending' }];
  }
  if (totalBytes < 2 * minChunk) {
    return [{ i: 0, start: 0, end: totalBytes - 1, done: 0, state: 'pending' }];
  }

  const wanted = Math.max(1, Math.floor(opts.segmentsPerTask || 8));
  const count = Math.max(1, Math.min(wanted, maxSegments, Math.ceil(totalBytes / minChunk)));
  const chunk = Math.ceil(totalBytes / count);

  const segments = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunk;
    if (start >= totalBytes) break;
    const end = Math.min(start + chunk - 1, totalBytes - 1);
    segments.push({ i: segments.length, start, end, done: 0, state: 'pending' });
  }
  return segments;
}

/**
 * Merge resume-sidecar progress into fresh segments. Progress applies only
 * when the segment layout is identical (same i/start/end); mismatches reset.
 * @returns {{segments: Array, resumedBytes: number, layoutMatched: boolean}}
 */
function applyResume(fresh, sidecarSegments) {
  if (!Array.isArray(sidecarSegments) || sidecarSegments.length === 0) {
    return { segments: fresh, resumedBytes: 0, layoutMatched: false };
  }
  const sameLayout =
    fresh.length === sidecarSegments.length &&
    fresh.every((s, idx) => {
      const o = sidecarSegments[idx];
      return o && o.i === idx && o.start === s.start && o.end === s.end;
    });
  if (!sameLayout) return { segments: fresh, resumedBytes: 0, layoutMatched: false };

  let resumedBytes = 0;
  for (let idx = 0; idx < fresh.length; idx++) {
    const length = fresh[idx].end - fresh[idx].start + 1;
    const done = Math.max(0, Math.min(length, Math.floor(sidecarSegments[idx].done || 0)));
    fresh[idx].done = done;
    fresh[idx].state = done >= length ? 'done' : 'pending';
    resumedBytes += done;
  }
  return { segments: fresh, resumedBytes, layoutMatched: true };
}

/**
 * Rebuild a resume plan from recorded sidecar rows. Validates that the ranges
 * are non-overlapping and exactly cover [0, totalBytes). This lets resume
 * work with ANY segmentation (including work-stolen layouts), unlike a
 * layout-match against a fresh equal-chunk plan.
 * @returns {Array|null} null when the recorded layout is unusable
 */
function rebuildFromSidecar(rows, totalBytes) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 64) return null;
  const parts = [];
  for (const r of rows) {
    if (!r || !Number.isInteger(r.start) || !Number.isInteger(r.end)) return null;
    if (r.start < 0 || r.end < r.start || r.end >= totalBytes) return null;
    const len = r.end - r.start + 1;
    const done = Math.max(0, Math.min(len, Math.floor(Number(r.done) || 0)));
    parts.push({ start: r.start, end: r.end, done });
  }
  parts.sort((a, b) => a.start - b.start);
  let expect = 0;
  for (const p of parts) {
    if (p.start !== expect) return null;
    expect = p.end + 1;
  }
  if (expect !== totalBytes) return null;
  return parts.map((p, idx) => {
    const len = p.end - p.start + 1;
    return { i: idx, start: p.start, end: p.end, done: p.done, state: p.done >= len ? 'done' : 'pending' };
  });
}

function segmentLength(seg) {
  return seg.end != null ? seg.end - seg.start + 1 : null;
}

function segmentsComplete(segments) {
  return segments.every((s) => {
    const len = segmentLength(s);
    return len != null && s.done >= len;
  });
}

function totalDone(segments) {
  return segments.reduce((a, s) => a + Math.max(0, Math.min(s.done, segmentLength(s) ?? s.done)), 0);
}

module.exports = {
  planSegments,
  applyResume,
  rebuildFromSidecar,
  segmentLength,
  segmentsComplete,
  totalDone,
  MIN_CHUNK_BYTES,
  DEFAULT_MAX_SEGMENTS,
};
