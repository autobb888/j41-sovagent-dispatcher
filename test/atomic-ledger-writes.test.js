'use strict';
// Atomic-write regression for the financial ledgers (money-path audit, 2026-07-13).
// A torn bare writeFileSync used to leave a truncated file that the loader absorbed
// as empty — zeroing prepaid balances, wiping the double-credit dedup guard, or
// losing the crash-recovery refund input. The writers now go tmp→rename. These
// tests prove the rename completes (no orphaned .tmp) and the content round-trips.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-atomic-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { persistActiveJobs, loadActiveJobs, ACTIVE_JOBS_PATH } = require('../src/config');
const { creditDeposit, getBalance } = require('../src/credit-meter');

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

test('saveMeters (via creditDeposit) round-trips a balance and leaves no .tmp', () => {
  const AGENT = 'agent-atomic';
  creditDeposit(AGENT, 'iBuyerZ', 5.0);
  assert.equal(getBalance(AGENT, 'iBuyerZ'), 5.0, 'prepaid balance persisted');

  // The meters file lives under ~/.junction41-dispatcher/agents/<agent>/... — assert
  // no *.tmp residue anywhere under the test home (the rename must have completed).
  const strays = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.tmp')) strays.push(full);
    }
  };
  walk(TEST_HOME);
  assert.deepEqual(strays, [], `no orphaned .tmp files: ${strays.join(', ')}`);
});
