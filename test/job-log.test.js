'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveLogRetention, isAbnormalExit, shouldArchiveLog,
  applyLogCap, selectLogsToPrune, VALID_RETENTION,
} = require('../src/job-log.js');

test('resolveLogRetention passes through valid values', () => {
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'off' } }), 'off');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'errors' } }), 'errors');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'all' } }), 'all');
});

test('resolveLogRetention coerces missing/invalid to errors', () => {
  assert.equal(resolveLogRetention({}), 'errors');
  assert.equal(resolveLogRetention(undefined), 'errors');
  assert.equal(resolveLogRetention({ runtime: {} }), 'errors');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 'bogus' } }), 'errors');
  assert.equal(resolveLogRetention({ runtime: { job_log_retention: 3 } }), 'errors');
});

test('VALID_RETENTION lists exactly the three modes', () => {
  assert.deepEqual([...VALID_RETENTION].sort(), ['all', 'errors', 'off']);
});

test('isAbnormalExit truth table', () => {
  assert.equal(isAbnormalExit({ killed: true }), true);
  assert.equal(isAbnormalExit({ exitCode: 1 }), true);
  assert.equal(isAbnormalExit({ exitCode: 137, killed: true }), true);
  assert.equal(isAbnormalExit({ exitCode: 0 }), false);
  assert.equal(isAbnormalExit({}), false);
  assert.equal(isAbnormalExit({ exitCode: null }), false);
  assert.equal(isAbnormalExit(undefined), false);
});

test('shouldArchiveLog respects retention mode', () => {
  assert.equal(shouldArchiveLog('off', { exitCode: 1, killed: true }), false);
  assert.equal(shouldArchiveLog('all', { exitCode: 0 }), true);
  assert.equal(shouldArchiveLog('errors', { exitCode: 1 }), true);
  assert.equal(shouldArchiveLog('errors', { exitCode: 0 }), false);
  assert.equal(shouldArchiveLog('errors', { killed: true }), true);
});

test('applyLogCap writes whole chunk under the cap', () => {
  const r = applyLogCap(0, Buffer.from('hello'), 100);
  assert.equal(r.data.toString(), 'hello');
  assert.equal(r.written, 5);
  assert.equal(r.truncated, false);
});

test('applyLogCap accepts string input', () => {
  const r = applyLogCap(0, 'abc', 100);
  assert.equal(r.data.toString(), 'abc');
  assert.equal(r.written, 3);
});

test('applyLogCap slices the chunk that crosses the cap and flags truncated', () => {
  const r = applyLogCap(8, Buffer.from('abcdef'), 10); // room = 2
  assert.equal(r.data.toString(), 'ab');
  assert.equal(r.written, 10);
  assert.equal(r.truncated, true);
});

test('applyLogCap writes nothing once already at/over the cap', () => {
  const r = applyLogCap(10, Buffer.from('xyz'), 10);
  assert.equal(r.data.length, 0);
  assert.equal(r.written, 10);
  assert.equal(r.truncated, false);

  // over-cap: caller owns the tally, written is not clamped down
  const over = applyLogCap(15, Buffer.from('x'), 10);
  assert.equal(over.data.length, 0);
  assert.equal(over.written, 15);
  assert.equal(over.truncated, false);
});

test('applyLogCap exact-fit boundary is not truncated', () => {
  const r = applyLogCap(7, Buffer.from('abc'), 10); // room = 3, exact
  assert.equal(r.data.toString(), 'abc');
  assert.equal(r.written, 10);
  assert.equal(r.truncated, false);
});

test('selectLogsToPrune returns [] under or at cap', () => {
  assert.deepEqual(selectLogsToPrune([{ id: 'a', mtimeMs: 1 }], 50), []);
  const exactly = Array.from({ length: 50 }, (_, i) => ({ id: `j${i}`, mtimeMs: i }));
  assert.deepEqual(selectLogsToPrune(exactly, 50), []);
});

test('selectLogsToPrune drops oldest-first when over cap', () => {
  const entries = [
    { id: 'new', mtimeMs: 300 },
    { id: 'old', mtimeMs: 100 },
    { id: 'mid', mtimeMs: 200 },
  ];
  assert.deepEqual(selectLogsToPrune(entries, 2), ['old']);
  assert.deepEqual(selectLogsToPrune(entries, 1), ['old', 'mid']);
  // input array is never mutated (sort happens on a copy)
  assert.equal(entries.length, 3);
  assert.equal(entries[0].id, 'new');
});

test('selectLogsToPrune tolerates non-array', () => {
  assert.deepEqual(selectLogsToPrune(undefined, 5), []);
});
