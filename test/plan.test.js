'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planSegments,
  applyResume,
  rebuildFromSidecar,
  segmentLength,
  segmentsComplete,
  totalDone,
} = require('../app/main/engine/plan');

const MiB = 1024 * 1024;

test('planSegments: splits by the 1 MiB floor, capped at segmentsPerTask', () => {
  // 16 MiB with 8 connections -> 8 equal 2 MiB segments
  const segs = planSegments(16 * MiB, true, { segmentsPerTask: 8 });
  assert.equal(segs.length, 8);
  assert.deepEqual(
    segs.map((s) => [s.start, s.end]),
    Array.from({ length: 8 }, (_, i) => [i * 2 * MiB, (i + 1) * 2 * MiB - 1])
  );
  assert.ok(segs.every((s) => s.done === 0 && s.state === 'pending'));

  // mid-size file still gets real parallelism now: 8 MiB -> 8 x 1 MiB
  assert.equal(planSegments(8 * MiB, true, { segmentsPerTask: 8 }).length, 8);

  // last segment absorbs the remainder
  const odd = planSegments(10 * MiB + 123, true, { segmentsPerTask: 4 });
  const total = odd.reduce((a, s) => a + (s.end - s.start + 1), 0);
  assert.equal(total, 10 * MiB + 123);
  assert.equal(odd[odd.length - 1].end, 10 * MiB + 122);
});

test('planSegments: small files, unknown sizes and no-range servers are single-stream', () => {
  assert.equal(planSegments(1 * MiB, true).length, 1, 'below 2x segment size');
  assert.equal(planSegments(null, true).length, 1);
  assert.equal(planSegments(null, false)[0].end, null, 'unknown length: open-ended segment');
  const noRange = planSegments(100 * MiB, false);
  assert.equal(noRange.length, 1);
  assert.equal(noRange[0].end, 100 * MiB - 1);
  const zero = planSegments(0, true);
  assert.equal(zero.length, 1);
});

test('planSegments: segment count respects the global cap', () => {
  const segs = planSegments(1 << 30, true, { segmentsPerTask: 64, maxSegments: 8 });
  assert.equal(segs.length, 8);
});

test('planSegments: honors segmentsPerTask above the legacy default when the cap allows', () => {
  const segs = planSegments(100 * MiB, true, { segmentsPerTask: 10, maxSegments: 64 });
  assert.equal(segs.length, 10);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[9].end, 100 * MiB - 1);
});

test('applyResume: matching layout merges progress with clamping', () => {
  const fresh = [
    { i: 0, start: 0, end: 99, done: 0, state: 'pending' },
    { i: 1, start: 100, end: 199, done: 0, state: 'pending' },
  ];
  const r = applyResume(fresh, [
    { i: 0, start: 0, end: 99, done: 50 },
    { i: 1, start: 100, end: 199, done: 999 }, // overshoot clamps to length
  ]);
  assert.equal(r.layoutMatched, true);
  assert.equal(r.resumedBytes, 150);
  assert.equal(fresh[0].done, 50);
  assert.equal(fresh[0].state, 'pending');
  assert.equal(fresh[1].done, 100);
  assert.equal(fresh[1].state, 'done');
});

test('applyResume: mismatched or empty sidecar resets to a fresh plan', () => {
  const fresh = [{ i: 0, start: 0, end: 99, done: 0, state: 'pending' }];
  const mismatched = applyResume(fresh, [{ i: 0, start: 0, end: 49, done: 10 }]);
  assert.equal(mismatched.layoutMatched, false);
  assert.equal(mismatched.resumedBytes, 0);
  assert.equal(fresh[0].done, 0);

  const empty = applyResume(fresh, []);
  assert.equal(empty.layoutMatched, false);

  const nullSidecar = applyResume(fresh, null);
  assert.equal(nullSidecar.layoutMatched, false);
});

test('rebuildFromSidecar: accepts stolen layouts, rejects gaps/overlaps/out-of-range', () => {
  const total = 8 * MiB;
  const good = rebuildFromSidecar(
    [
      { start: 0, end: 2 * MiB - 1, done: 2 * MiB },
      { start: 2 * MiB, end: 5 * MiB - 1, done: 1024 },
      { start: 5 * MiB, end: total - 1, done: 0 },
    ],
    total
  );
  assert.equal(good.length, 3);
  assert.equal(good[0].state, 'done');
  assert.equal(good[1].state, 'pending');
  assert.equal(good[2].done, 0);

  // out-of-order input gets sorted and reindexed
  const sorted = rebuildFromSidecar(
    [
      { start: 5 * MiB, end: total - 1, done: 0 },
      { start: 0, end: 5 * MiB - 1, done: 0 },
    ],
    total
  );
  assert.equal(sorted[0].start, 0);
  assert.equal(sorted[0].i, 0);
  assert.equal(sorted[1].start, 5 * MiB);

  // gap in coverage
  assert.equal(
    rebuildFromSidecar(
      [
        { start: 0, end: 2 * MiB - 1, done: 0 },
        { start: 3 * MiB, end: total - 1, done: 0 },
      ],
      total
    ),
    null
  );
  // overlap
  assert.equal(
    rebuildFromSidecar(
      [
        { start: 0, end: 3 * MiB - 1, done: 0 },
        { start: 2 * MiB, end: total - 1, done: 0 },
      ],
      total
    ),
    null
  );
  // runs past the total
  assert.equal(rebuildFromSidecar([{ start: 0, end: total, done: 0 }], total), null);
  // empty / garbage
  assert.equal(rebuildFromSidecar([], total), null);
  assert.equal(rebuildFromSidecar(null, total), null);
  // non-numeric done is coerced to 0
  assert.equal(rebuildFromSidecar([{ start: 0, end: 1, done: 'x' }], 2)[0].done, 0);
});

test('segmentsComplete / totalDone / segmentLength', () => {
  const segs = [
    { i: 0, start: 0, end: 9, done: 10, state: 'done' },
    { i: 1, start: 10, end: 19, done: 3, state: 'active' },
  ];
  assert.equal(segmentsComplete(segs), false);
  assert.equal(totalDone(segs), 13);
  segs[1].done = 10;
  segs[1].state = 'done';
  assert.equal(segmentsComplete(segs), true);
  assert.equal(totalDone(segs), 20);
  assert.equal(segmentLength({ start: 0, end: null }), null);
  assert.equal(segmentsComplete([{ start: 0, end: null, done: 500, state: 'done' }]), false, 'unknown length never "complete" by count');
});
