/**
 * spend-ledger.jsonl — the unified append-only audit ledger (P3).
 *
 * Every gate decision (allow AND deny) and every broadcast outcome lands one JSON
 * line. A pre-broadcast append failure denies the send RETRYABLE (fail-closed) —
 * a full disk must never strand an owed refund, and must never let an unrecorded
 * send go out.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-ledger-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });

const SP = require('../src/spend-policy.js');

function readLedger() {
  if (!fs.existsSync(SP.SPEND_LEDGER_PATH)) return [];
  return fs.readFileSync(SP.SPEND_LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function seedAllowlist(addr) {
  const list = SP.loadFinancialAllowlist();
  if (!list.permanent.some(e => e.address === addr)) list.permanent.push({ address: addr, jobId: 'seed' });
  fs.writeFileSync(SP.ALLOWLIST_PATH, JSON.stringify(list));
}

test('SPEND_LEDGER_PATH is exported and lives under the dispatcher dir', () => {
  assert.equal(typeof SP.SPEND_LEDGER_PATH, 'string');
  assert.match(SP.SPEND_LEDGER_PATH, /spend-ledger\.jsonl$/);
});

test('a denied send leaves a gate_decision line with allowed:false + reason', () => {
  SP._resetDispatcherRateLimit(false);
  SP.gateExternalSend({ jobId: 'led-deny', toAddress: 'iSTRANGER', amount: 1, jobPrice: 1, kind: 'refund' });
  const l = readLedger().find(x => x.jobId === 'led-deny' && x.event === 'gate_decision');
  assert.ok(l, 'a gate_decision line was written');
  assert.equal(l.allowed, false);
  assert.ok(l.reason);
  assert.equal(l.checks.counterparty, 'fail');
});

test('an allowed send + recorded outcome leave both a decision and an outcome line', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iLEDGER1');
  const r = SP.gateExternalSend({ jobId: 'led-ok', toAddress: 'iLEDGER1', amount: 1, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, true);
  SP.recordSendOutcome({ kind: 'refund', jobId: 'led-ok', toAddress: 'iLEDGER1', amount: 1, txid: 'TX-led-ok' });
  const lines = readLedger().filter(x => x.jobId === 'led-ok');
  assert.ok(lines.some(x => x.event === 'gate_decision' && x.allowed === true));
  const outcome = lines.find(x => x.event === 'broadcast_outcome');
  assert.ok(outcome, 'an outcome line was written');
  assert.equal(outcome.txid, 'TX-led-ok');
  assert.equal(outcome.amountSats, '100000000'); // 1 VRSC in sats, as a string
});

test('fleet-internal sends are ledgered and NEVER blocked by the absolute cap', () => {
  SP._resetDispatcherRateLimit(false);
  // A huge self-directed sweep: recorded + advisory-warned, never denied.
  SP.recordSendOutcome({ kind: 'fee_sweep', jobId: 'agent-x', toAddress: 'iOWN', amountSats: 500000000000, txid: 'TX-sweep-big' });
  const l = readLedger().find(x => x.txid === 'TX-sweep-big');
  assert.ok(l, 'a fee_sweep outcome line was written');
  assert.equal(l.event, 'broadcast_outcome');
  assert.equal(l.kind, 'fee_sweep');
  assert.equal(l.amountSats, '500000000000');
});

test('a fleet_transfer outcome does NOT consume the refund limiter budget', () => {
  SP._resetDispatcherRateLimit(false);
  const before = SP.loadSendHistory().global.length;
  SP.recordSendOutcome({ kind: 'fleet_transfer', jobId: null, toAddress: 'iOWN2', amountSats: 100000000, txid: 'TX-fleet' });
  assert.equal(SP.loadSendHistory().global.length, before, 'self-directed sends must not deplete the refund budget');
});

test('fail-closed: an unwritable ledger denies an otherwise-allowed send RETRYABLE', () => {
  SP._resetDispatcherRateLimit(false);
  seedAllowlist('iLEDGER2');
  // Force appendLedger to fail: replace the ledger file path with a directory.
  fs.rmSync(SP.SPEND_LEDGER_PATH, { force: true });
  fs.mkdirSync(SP.SPEND_LEDGER_PATH, { recursive: true });
  try {
    const r = SP.gateExternalSend({ jobId: 'led-failclosed', toAddress: 'iLEDGER2', amount: 1, jobPrice: 1, kind: 'refund' });
    assert.equal(r.allowed, false, 'an unrecordable go-ahead must not be allowed');
    assert.equal(r.retryable, true, 'it is retryable — the refund is still owed');
  } finally {
    fs.rmSync(SP.SPEND_LEDGER_PATH, { recursive: true, force: true });
  }
});
