/**
 * spend-policy.js — the extracted outbound-money gate (P1+).
 *
 * Task 1 asserts the move-verbatim preserved the export surface and that cli.js
 * re-exports the SAME function objects (so suites importing from cli.js are
 * unaffected). Later tasks add gateExternalSend / clamp / absolute-cap tests.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Sandbox HOME BEFORE requiring the modules: spend-policy resolves its paths from
// os.homedir() at require time (identical to the old cli.js behaviour).
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-sp-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });

const SP = require('../src/spend-policy.js');
const cli = require('../src/cli.js');

test('spend-policy exports the moved surface', () => {
  for (const n of [
    'loadFinancialAllowlist', 'isAddressInAllowlist', 'addActiveJobToAllowlist',
    'removeActiveJobFromAllowlist', 'addToRefundAllowlist',
    'loadSendHistory', 'saveSendHistory', 'withSendHistoryLock',
    'dispatcherRateLimits', 'checkDispatcherRateLimit', 'recordDispatcherSend',
    '_resetDispatcherRateLimit', 'isFinanciallySuspended', 'setFinancialSuspended',
  ]) {
    assert.equal(typeof SP[n], 'function', `${n} should be an exported function`);
  }
  for (const p of ['ALLOWLIST_PATH', 'SEND_HISTORY_PATH', 'FINANCIAL_SUSPENDED_PATH']) {
    assert.equal(typeof SP[p], 'string', `${p} should be an exported path`);
  }
});

test('cli re-exports the SAME function objects (identity preserved)', () => {
  assert.equal(cli.checkDispatcherRateLimit, SP.checkDispatcherRateLimit);
  assert.equal(cli.recordDispatcherSend, SP.recordDispatcherSend);
  assert.equal(cli.setFinancialSuspended, SP.setFinancialSuspended);
  assert.equal(cli.isFinanciallySuspended, SP.isFinanciallySuspended);
  assert.equal(cli.loadSendHistory, SP.loadSendHistory);
});

test('the limiter still enforces its documented defaults after the move', () => {
  SP._resetDispatcherRateLimit(false);
  // per-job cap default is 3; a 4th send for the same job is terminal-denied.
  for (let i = 0; i < 3; i++) SP.recordDispatcherSend('job-cap', 0.1, Date.now() - (i + 1) * 60_000);
  const r = SP.checkDispatcherRateLimit('job-cap', 0.1, 1);
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false);
});
