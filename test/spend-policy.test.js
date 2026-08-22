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

// ── Task 2: the gateExternalSend / recordSendOutcome funnel ──
function seedAllowlist(addr, jobId = 'seed') {
  const list = SP.loadFinancialAllowlist();
  if (!list.permanent.some(e => e.address === addr)) list.permanent.push({ address: addr, jobId });
  fs.writeFileSync(SP.ALLOWLIST_PATH, JSON.stringify(list));
}

test('refund gate: allows an allowlisted address within limits', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iBUYER1');
  const r = SP.gateExternalSend({ jobId: 'g1', toAddress: 'iBUYER1', amount: 1, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, true);
  assert.equal(r.checks.counterparty, 'pass');
});

test('refund gate: denies a non-allowlisted address (terminal)', () => {
  SP._resetDispatcherRateLimit(false);
  const r = SP.gateExternalSend({ jobId: 'g2', toAddress: 'iSTRANGER', amount: 1, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false);
  assert.equal(r.checks.counterparty, 'fail');
});

test('payment gate: destination must be in expectedRecipients', () => {
  SP._resetDispatcherRateLimit(false);
  const ok = SP.gateExternalSend({ jobId: 'p1', toAddress: 'iAGENT', amount: 1, jobPrice: 1, kind: 'payment', expectedRecipients: ['iAGENT', 'iFEE'] });
  assert.equal(ok.allowed, true);
  const bad = SP.gateExternalSend({ jobId: 'p2', toAddress: 'iEVIL', amount: 1, jobPrice: 1, kind: 'payment', expectedRecipients: ['iAGENT', 'iFEE'] });
  assert.equal(bad.allowed, false);
  assert.equal(bad.checks.counterparty, 'fail');
});

test('fleet_transfer gate: skips counterparty + value checks', () => {
  SP._resetDispatcherRateLimit(false);
  const r = SP.gateExternalSend({ jobId: null, toAddress: 'iOWN', amount: 5, jobPrice: 0, kind: 'fleet_transfer' });
  assert.equal(r.allowed, true);
  assert.equal(r.checks.counterparty, 'skip');
  assert.equal(r.checks.valueCeiling, 'skip');
});

test('refund gate: value ceiling is preserved (terminal)', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iBUYER3');
  const r = SP.gateExternalSend({ jobId: 'g3', toAddress: 'iBUYER3', amount: 100, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false);
  assert.equal(r.checks.valueCeiling, 'fail');
});

// ── Task 5: compiled hard ceilings + absolute per-tx cap ──
test('effectiveLimits clamps raw config above the hard ceilings, records the key', () => {
  const lim = SP.effectiveLimits({ maxSendsPerJob: 999, maxValueMultiplier: 9, maxSendsPerHour: 99999, cooldownMs: 30000 });
  assert.ok(lim.maxValueMultiplier <= SP.HARD_MAX_VALUE_MULTIPLIER);
  assert.ok(lim.maxSendsPerJob <= SP.HARD_MAX_SENDS_PER_JOB);
  assert.ok(lim.maxSendsPerHour <= SP.HARD_MAX_SENDS_PER_HOUR);
  assert.ok(SP._clampedKeys().includes('max_value_multiplier'));
  assert.ok(SP._clampedKeys().includes('max_sends_per_job'));
});

test('effectiveLimits leaves within-ceiling config unchanged', () => {
  const lim = SP.effectiveLimits({ maxSendsPerJob: 3, maxValueMultiplier: 1.1, maxSendsPerHour: 10, cooldownMs: 30000 });
  assert.equal(lim.maxValueMultiplier, 1.1);
  assert.equal(lim.maxSendsPerJob, 3);
  assert.equal(lim.maxSendsPerHour, 10);
});

test('absolute per-tx cap denies an external send over 1000 VRSC (terminal)', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iBIG');
  // jobPrice 2000 keeps the value ceiling from firing first (2000*1.1=2200 > 1001).
  const r = SP.gateExternalSend({ jobId: 'big', toAddress: 'iBIG', amount: 1001, jobPrice: 2000, kind: 'refund' });
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false);
  assert.equal(r.checks.absoluteCap, 'fail');
});

test('absolute per-tx cap is ADVISORY for fee_sweep (never denies)', () => {
  SP._resetDispatcherRateLimit(false);
  const r = SP.gateExternalSend({ jobId: null, toAddress: 'iOWN', amount: 5000, jobPrice: 0, kind: 'fee_sweep' });
  assert.equal(r.allowed, true);
  assert.equal(r.checks.absoluteCap, 'warn');
});

test('an in-cap external send passes the absolute cap', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iSMALL');
  const r = SP.gateExternalSend({ jobId: 'small', toAddress: 'iSMALL', amount: 5, jobPrice: 10, kind: 'refund' });
  assert.equal(r.allowed, true);
  assert.equal(r.checks.absoluteCap, 'pass');
});

// ── Audit-fix regressions (would have caught the fail-open defects) ──

test('B1: a huge amount above parseVrscAmount ceiling is DENIED, not silently skipped', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iHuge');
  // 12M VRSC — above parseVrscAmount's 2^50-sat ceiling; the exploit that slipped the cap.
  const r = SP.gateExternalSend({ jobId: 'huge', toAddress: 'iHuge', amount: 12000000, jobPrice: 20000000, kind: 'refund' });
  assert.equal(r.allowed, false);
  assert.equal(r.checks.absoluteCap, 'fail');
});

test('B1: float-dust amounts are rounded and cap-checked (over → deny, under → pass, never skipped)', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iDustOver');
  const over = SP.gateExternalSend({ jobId: 'dustover', toAddress: 'iDustOver', amount: 1000.1999999999999, jobPrice: 2000, kind: 'refund' });
  assert.equal(over.allowed, false);
  assert.equal(over.checks.absoluteCap, 'fail');

  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iDustUnder');
  const under = SP.gateExternalSend({ jobId: 'dustunder', toAddress: 'iDustUnder', amount: 0.1 + 0.2, jobPrice: 1, kind: 'refund' });
  assert.equal(under.allowed, true);
  assert.equal(under.checks.absoluteCap, 'pass'); // evaluated, not skipped
});

test('Finding 3: an uninterpretable external amount fails CLOSED', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iBad');
  for (const bad of [NaN, -5, 0, 'not-a-number', Infinity]) {
    const r = SP.gateExternalSend({ jobId: 'bad', toAddress: 'iBad', amount: bad, jobPrice: 1, kind: 'refund' });
    assert.equal(r.allowed, false, `amount ${bad} must be denied`);
  }
});

test('Finding 2: an unknown/typo\'d kind fails CLOSED (never default-allow)', () => {
  SP._resetDispatcherRateLimit(false);
  for (const k of [undefined, 'pay', 'Payment', '', 'transfer']) {
    const r = SP.gateExternalSend({ jobId: 'k', toAddress: 'iX', amount: 999999, jobPrice: 1, kind: k });
    assert.equal(r.allowed, false, `kind ${String(k)} must be denied`);
  }
});

test('B2: a payment does not deplete the same job\'s refund budget', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iBuyerB2');
  // Three payments to the job — would exhaust the per-job cap (3) if the budget were shared.
  for (let i = 0; i < 3; i++) {
    SP.recordSendOutcome({ kind: 'payment', jobId: 'sharedjob', toAddress: 'iAgent', amount: 1, amountSats: 100000000, txid: `p${i}`, now: Date.now() - (i + 1) * 60000 });
  }
  const r = SP.gateExternalSend({ jobId: 'sharedjob', toAddress: 'iBuyerB2', amount: 0.5, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, true, 'the refund budget must be independent of payments to the same job');
});
