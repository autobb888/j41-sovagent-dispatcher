'use strict';
/**
 * M4 chunk 3 — the deposit read surface.
 *
 * Every `needsOperator` state the reconciler writes was write-only: four write
 * sites and a single console.error between them. That is the shape of the
 * 2026-08-05 fee-tank failure, where an agent silently lost the ability to write
 * on-chain while every surface reported healthy. A flag nobody can read is not a
 * safety mechanism, it is a comment.
 *
 * Two things here are load-bearing and easy to get subtly wrong, both named by
 * review as mutations the planned tests would have missed:
 *
 *  - `needsOperator` lives in TWO structurally different places — on a
 *    `processed` record and on a `reversed[]` entry. A reader that scans one is
 *    the "guard at one of two sites" bug, and it passes any test that happens to
 *    seed the other shape.
 *  - The count must exclude resolved entries, or /health degrades forever after
 *    a successful resolution and the signal is worth nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-depsurface-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const { listDepositAnomalies } = require('../src/deposit-watcher.js');
const { buildHealthDocument, buildDepositSurface, handleCommand } = require('../src/control.js');

function writeDeposits(agentId, data) {
  const p = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', agentId, 'deposits.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function makeState(agentIds = ['agent-1']) {
  return {
    agents: agentIds.map((id) => ({ id, identity: `${id}@` })),
    active: new Map(),
    available: [],
    queue: [],
    seen: new Set(),
    _inboxFailures: new Map(),
    _inboxLastWrite: new Map(),
    _inboxAckFailures: new Map(),
    _agentErrors: new Map(),
    startupComplete: true,
    startedAt: Date.now(),
  };
}

const OPEN_CREDIT = {
  txid: 'tx_open_1', buyerVerusId: 'buyer-a@', amount: 1.5, confirmations: 0,
  unconfirmed: true, creditedAtMs: Date.now(), misses: 2, creditedAt: new Date().toISOString(),
};

test('an agent with nothing to report yields empty lists and zero counters', () => {
  const surface = listDepositAnomalies(['agent-none']);
  assert.deepEqual(surface.agents[0].open, []);
  assert.deepEqual(surface.agents[0].needsOperator, []);
  assert.equal(surface.summary.deposits_needs_operator, 0);
  assert.equal(surface.summary.deposits_unconfirmed_open, 0);
});

test('needsOperator is found in BOTH of its homes, not just one', () => {
  // Seeding only one shape is how a half-blind reader passes its tests.
  writeDeposits('agent-both', {
    processed: [{ txid: 'tx_p', buyerVerusId: 'b1@', amount: 1, confirmations: 3, needsOperator: 'reversal state was ambiguous' }],
    pending: [],
    reversed: [{ txid: 'tx_r', buyerVerusId: 'b2@', amount: 2, reversedAt: new Date().toISOString(), debited: false, needsOperator: 'reversed without a certain debit' }],
    creditedTxids: ['tx_p'],
  });

  const s = listDepositAnomalies(['agent-both']);
  assert.equal(s.summary.deposits_needs_operator, 2,
    'a reader that scans only `processed` or only `reversed` reports 1 and looks correct');
  const wheres = s.agents[0].needsOperator.map((n) => n.where).sort();
  assert.deepEqual(wheres, ['processed', 'reversed']);
  assert.ok(s.agents[0].needsOperator.every((n) => n.reason), 'each entry carries why');
});

test('a resolved anomaly stops counting, so health can go green again', () => {
  writeDeposits('agent-resolved', {
    processed: [{ txid: 'tx_p', buyerVerusId: 'b1@', amount: 1, confirmations: 3, needsOperator: 'was ambiguous', resolvedAt: new Date().toISOString(), resolvedBy: 'operator' }],
    pending: [],
    reversed: [{ txid: 'tx_r', buyerVerusId: 'b2@', amount: 2, reversedAt: new Date().toISOString(), needsOperator: 'was ambiguous', resolvedAt: new Date().toISOString() }],
    creditedTxids: [],
  });

  const s = listDepositAnomalies(['agent-resolved']);
  assert.equal(s.summary.deposits_needs_operator, 0,
    'without the resolvedAt term /health degrades forever after a successful resolution');
});

test('open 0-conf credits are counted, and mid-credit records count as open', () => {
  writeDeposits('agent-open', {
    processed: [
      OPEN_CREDIT,
      { txid: 'tx_stuck', buyerVerusId: 'b3@', amount: 0.5, crediting: true, intentAt: new Date().toISOString() },
      { txid: 'tx_done', buyerVerusId: 'b4@', amount: 9, confirmations: 6, creditedAt: new Date().toISOString() },
    ],
    pending: [], reversed: [], creditedTxids: ['tx_open_1', 'tx_done'],
  });

  const s = listDepositAnomalies(['agent-open']);
  assert.equal(s.summary.deposits_unconfirmed_open, 2, 'settled records are not open');
  const states = s.agents[0].open.map((o) => o.state).sort();
  assert.deepEqual(states, ['crediting', 'unconfirmed']);
  assert.equal(s.agents[0].open.find((o) => o.txid === 'tx_open_1').misses, 2);
});

test('the read model does not serve a stale answer after the file changes', () => {
  // It is cached on mtime+size because /health is polled continuously and these
  // files are large. A cache that misses a write would hide the very anomaly it
  // exists to surface.
  writeDeposits('agent-cache', { processed: [], pending: [], reversed: [], creditedTxids: [] });
  assert.equal(listDepositAnomalies(['agent-cache']).summary.deposits_needs_operator, 0);

  writeDeposits('agent-cache', {
    processed: [{ txid: 'tx_new', buyerVerusId: 'b@', amount: 1, confirmations: 2, needsOperator: 'appeared later' }],
    pending: [], reversed: [], creditedTxids: [],
  });
  assert.equal(listDepositAnomalies(['agent-cache']).summary.deposits_needs_operator, 1,
    'the cache must invalidate when the file is rewritten');
});

// ── /health ─────────────────────────────────────────────────────────────────

test('health publishes both deposit counters', () => {
  writeDeposits('agent-1', {
    processed: [OPEN_CREDIT, { txid: 'tx_amb', buyerVerusId: 'b@', amount: 1, confirmations: 2, needsOperator: 'ambiguous' }],
    pending: [], reversed: [], creditedTxids: ['tx_open_1'],
  });
  const doc = buildHealthDocument(makeState(), Date.now() - 1000);
  assert.equal(doc.summary.deposits_unconfirmed_open, 1);
  assert.equal(doc.summary.deposits_needs_operator, 1);
  assert.ok(doc.deposits, 'the structured block is present too');
});

test('a deposit needing an operator degrades health', () => {
  writeDeposits('agent-1', {
    processed: [{ txid: 'tx_amb', buyerVerusId: 'b@', amount: 1, confirmations: 2, needsOperator: 'ambiguous' }],
    pending: [], reversed: [], creditedTxids: [],
  });
  const doc = buildHealthDocument(makeState(), Date.now() - 1000);
  assert.equal(doc.status, 'degraded',
    'a buyer\'s balance may be wrong and only a human can say — that is worse than a dead letter');
});

test('open 0-conf credits alone do NOT degrade health', () => {
  // They are the normal resting state of a small deposit. Degrading on them
  // would make the signal fire constantly and mean nothing.
  writeDeposits('agent-1', { processed: [OPEN_CREDIT], pending: [], reversed: [], creditedTxids: ['tx_open_1'] });
  const doc = buildHealthDocument(makeState(), Date.now() - 1000);
  assert.equal(doc.summary.deposits_unconfirmed_open, 1);
  assert.equal(doc.status, 'ok');
});

test('health survives an unreadable deposits file rather than failing to answer', () => {
  const p = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', 'agent-1', 'deposits.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{ this is not json');
  const doc = buildHealthDocument(makeState(), Date.now() - 1000);
  assert.equal(doc.summary.deposits_needs_operator, 0);
  assert.ok(doc.status === 'ok' || doc.status === 'degraded', 'a read model must never take /health down');
});

// ── transports agree ────────────────────────────────────────────────────────

test('ctl deposits and the builder return the same document', async () => {
  writeDeposits('agent-1', {
    processed: [{ txid: 'tx_amb', buyerVerusId: 'b@', amount: 1, confirmations: 2, needsOperator: 'ambiguous' }],
    pending: [], reversed: [], creditedTxids: [],
  });
  const state = makeState();
  const viaSocket = await handleCommand({ action: 'deposits' }, state, {}, Date.now());
  assert.deepEqual(viaSocket, buildDepositSurface(state),
    'one builder, every transport — or `ctl deposits` and /v1/deposits drift');
  assert.equal(viaSocket.summary.deposits_needs_operator, 1);
});
