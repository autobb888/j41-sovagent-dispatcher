'use strict';
/**
 * loadDeposits must always return a reversed[] array.
 *
 * A missing or unreadable deposits.json used to omit `reversed`. Callers
 * (_recheckReversals, reconcileMeterAgainstLedger, listDepositAnomaliesForAgent)
 * iterate it with no fallback, so the first model-deposit credit on a new
 * agent threw.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-dep-load-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const dw = require('../src/deposit-watcher.js');

function depositsFile(agentId) {
  return path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
}

function writeDeposits(agentId, data) {
  const p = depositsFile(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function assertNormalizedEmpty(d) {
  assert.deepEqual(d.processed, []);
  assert.deepEqual(d.pending, []);
  assert.deepEqual(d.reversed, []);
  assert.deepEqual(d.creditedTxids, []);
  assert.doesNotThrow(() => {
    for (const r of d.reversed) void r;
  });
}

test('loadDeposits is exported', () => {
  assert.equal(typeof dw.loadDeposits, 'function');
});

test('missing deposits.json returns reversed:[] so iterating it cannot throw', () => {
  const d = dw.loadDeposits('agent-never-existed');
  assertNormalizedEmpty(d);
});

test('malformed deposits.json also normalizes reversed to []', () => {
  const agentId = 'agent-malformed';
  const p = depositsFile(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not json', { mode: 0o600 });
  assertNormalizedEmpty(dw.loadDeposits(agentId));
});

test('unreadable deposits.json (directory at the path) also normalizes', () => {
  const agentId = 'agent-unreadable';
  fs.mkdirSync(depositsFile(agentId), { recursive: true });
  assertNormalizedEmpty(dw.loadDeposits(agentId));
});

test('existing file without a reversed key is normalized to []', () => {
  const agentId = 'agent-no-reversed-key';
  writeDeposits(agentId, { processed: [], pending: [], creditedTxids: [] });
  assertNormalizedEmpty(dw.loadDeposits(agentId));
});

test('_recheckReversals on a missing ledger does not throw', async () => {
  const n = await dw._recheckReversals('agent-no-ledger', {
    async getTxStatus() { return { confirmations: 0 }; },
  });
  assert.equal(n, 0);
});

test('reconcileMeterAgainstLedger on a missing ledger does not throw', () => {
  const row = dw.reconcileMeterAgainstLedger('agent-no-ledger-2', 'buyer@');
  assert.equal(row.expectedTotalDeposited, 0);
  assert.equal(row.actualTotalDeposited, null);
});

test('listDepositAnomaliesForAgent on a malformed existing file does not throw', () => {
  const agentId = 'agent-anom-malformed';
  const p = depositsFile(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '<<<', { mode: 0o600 });
  const v = dw.listDepositAnomaliesForAgent(agentId);
  assert.deepEqual(v.reversed, []);
  assert.deepEqual(v.needsOperator, []);
  assert.deepEqual(v.open, []);
});
