'use strict';
// Tests for the inter-process send lock helpers: acquireSendLock / releaseSendLock.
// Uses a sandbox HOME so REFUND_LOCKS_DIR resolves inside the temp dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-refund-lock-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const j41Dir = path.join(TEST_HOME, '.j41');
const dispDir = path.join(j41Dir, 'dispatcher');
fs.mkdirSync(dispDir, { recursive: true });

const { acquireSendLock, releaseSendLock } = require('../src/cli.js');

const LOCKS_DIR = path.join(dispDir, 'refund-locks');

// ── Test 1: acquireSendLock('j') succeeds ────────────────────────────────────
test('acquireSendLock: first acquire on a clean jobId returns true', () => {
  const jobId = 'job-lock-t1';
  const acquired = acquireSendLock(jobId);
  assert.equal(acquired, true, 'first acquire must return true');
  // cleanup
  releaseSendLock(jobId);
});

// ── Test 2: second acquire while held returns false (not stale) ───────────────
test('acquireSendLock: second acquire while lock is held returns false', () => {
  const jobId = 'job-lock-t2';
  const first = acquireSendLock(jobId);
  assert.equal(first, true, 'first acquire must succeed');

  const second = acquireSendLock(jobId);
  assert.equal(second, false, 'second acquire while held must return false');

  // cleanup
  releaseSendLock(jobId);
});

// ── Test 3: stale lock (old timestamp) is stolen ─────────────────────────────
test('acquireSendLock: lock file with old timestamp (>120s) is stolen and returns true', () => {
  const jobId = 'job-lock-t3';
  fs.mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 });
  const lockPath = path.join(LOCKS_DIR, `${jobId}.lock`);
  // Write a stale lock (200 seconds ago)
  const staleTs = Date.now() - 200000;
  fs.writeFileSync(lockPath, `99999:${staleTs}`);

  const acquired = acquireSendLock(jobId);
  assert.equal(acquired, true, 'stale lock must be stolen and acquire returns true');

  // cleanup
  releaseSendLock(jobId);
});

// ── Test 4: releaseSendLock removes the lock file ────────────────────────────
test('releaseSendLock: removes the lock file', () => {
  const jobId = 'job-lock-t4';
  const acquired = acquireSendLock(jobId);
  assert.equal(acquired, true);

  const lockPath = path.join(LOCKS_DIR, `${jobId}.lock`);
  assert.ok(fs.existsSync(lockPath), 'lock file must exist before release');

  releaseSendLock(jobId);
  assert.ok(!fs.existsSync(lockPath), 'lock file must be removed after release');
});

// ── Test 5: releaseSendLock is idempotent (no throw if file already gone) ────
test('releaseSendLock: does not throw when lock file does not exist', () => {
  assert.doesNotThrow(() => releaseSendLock('job-lock-nonexistent'));
});
