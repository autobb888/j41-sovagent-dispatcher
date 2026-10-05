'use strict';
// Atomic-write regression for the active-jobs ledger (money-path audit, 2026-07-13).
// A torn bare writeFileSync used to leave a truncated file that the loader absorbed
// as empty, losing the crash-recovery refund input. The writer now goes tmp→rename.
// These tests prove the rename completes (no orphaned .tmp) and the content round-trips.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-atomic-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { persistActiveJobs, loadActiveJobs, ACTIVE_JOBS_PATH } = require('../src/config');

test('persistActiveJobs writes atomically, round-trips, and leaves no .tmp', () => {
  const map = new Map([
    ['job-1', { agentId: 'a1', pid: 123, startedAt: 1, jobAmount: 2.5, buyerPayAddress: 'iBuyer', currency: 'VRSCTEST', agentInfoId: 'ai1', reworkCount: 0 }],
  ]);
  persistActiveJobs(map);

  assert.equal(fs.existsSync(ACTIVE_JOBS_PATH + '.tmp'), false, 'no orphaned .tmp after write');
  const loaded = loadActiveJobs();
  assert.equal(loaded['job-1'].jobAmount, 2.5, 'crash-recovery fields round-trip');
  assert.equal(loaded['job-1'].buyerPayAddress, 'iBuyer');
});

test('a subsequent write cleanly replaces the prior file (no corruption)', () => {
  persistActiveJobs(new Map([['job-A', { agentId: 'x', startedAt: 1 }]]));
  persistActiveJobs(new Map([['job-B', { agentId: 'y', startedAt: 2 }]]));
  const loaded = loadActiveJobs();
  assert.equal(loaded['job-A'], undefined, 'old entry fully replaced');
  assert.equal(loaded['job-B'].agentId, 'y');
  assert.equal(fs.existsSync(ACTIVE_JOBS_PATH + '.tmp'), false);
});
