'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  classifyInboxFailure,
  shouldDeferForPendingWrite,
  recordBatchFailure,
  clearBatchFailure,
  batchCompositionKey,
  redriveDeadLetters,
  listInboxFailures,
  recordInboxFailure,
  isDeadLettered,
  MAX_BATCH_FAILURES,
} = require('../src/inbox-deadletter.js');

// ---------------------------------------------------------------------------
// classifyInboxFailure — contention must never burn the dead-letter budget
// ---------------------------------------------------------------------------

test('classifies the live-observed broadcast rejection as contention', () => {
  const e = new Error('Transaction rejected by the network');
  assert.strictEqual(classifyInboxFailure(e), 'contention');
});

test('classifies a machine code TX_REJECTED as contention even if the prose changes', () => {
  const e = Object.assign(new Error('some reworded message'), { code: 'TX_REJECTED' });
  assert.strictEqual(classifyInboxFailure(e), 'contention');
});

test('classifies network/5xx/timeout as transient (uncounted, but not contention)', () => {
  assert.strictEqual(classifyInboxFailure(Object.assign(new Error('boom'), { statusCode: 503 })), 'transient');
  assert.strictEqual(classifyInboxFailure(Object.assign(new Error('boom'), { statusCode: 429 })), 'transient');
  assert.strictEqual(classifyInboxFailure(new Error('socket hang up')), 'transient');
  assert.strictEqual(classifyInboxFailure(new Error('request to https://x timed out')), 'transient');
  assert.strictEqual(classifyInboxFailure(new Error('ECONNREFUSED 1.2.3.4:443')), 'transient');
});

test('classifies a 4xx (other than 429) as hard — retrying cannot help', () => {
  assert.strictEqual(classifyInboxFailure(Object.assign(new Error('nope'), { statusCode: 400 })), 'hard');
  assert.strictEqual(classifyInboxFailure(Object.assign(new Error('nope'), { statusCode: 403 })), 'hard');
});

test('an unrecognised error defaults to hard, not silently transient', () => {
  assert.strictEqual(classifyInboxFailure(new Error('inbox vdxfData contained no review.* keys')), 'hard');
});

test('a non-Error throw does not break classification', () => {
  assert.strictEqual(classifyInboxFailure(null), 'hard');
  assert.strictEqual(classifyInboxFailure('a string'), 'hard');
});

// ---------------------------------------------------------------------------
// shouldDeferForPendingWrite — height-based, NOT a wall-clock guess
// ---------------------------------------------------------------------------

test('defers while the last broadcast txid has not become the confirmed prevOutput', () => {
  const lw = { txid: 'aa', at: 1000, expiryHeight: 500 };
  const r = shouldDeferForPendingWrite(lw, 'old-prevout', 400, 1000 + 60_000);
  assert.strictEqual(r.defer, true);
});

test('releases as soon as prevOutput matches our broadcast txid', () => {
  const lw = { txid: 'aa', at: 1000, expiryHeight: 500 };
  const r = shouldDeferForPendingWrite(lw, 'aa', 400, 1000 + 60_000);
  assert.strictEqual(r.defer, false);
  assert.strictEqual(r.reason, 'confirmed');
});

test('AUDIT FIX 3: releases on blockHeight past expiryHeight — the tx is provably dead', () => {
  const lw = { txid: 'aa', at: 1000, expiryHeight: 500 };
  const r = shouldDeferForPendingWrite(lw, 'other', 501, 1000 + 60_000);
  assert.strictEqual(r.defer, false);
  assert.strictEqual(r.reason, 'expired');
});

test('AUDIT FIX 3: does NOT release at 30min while the tx is still valid (would double-spend)', () => {
  // 200 blocks ~= 3h20m. A 30-minute wall-clock release would resume into a live
  // mempool tx and rebuild a double-spend — the original bug.
  const lw = { txid: 'aa', at: 0, expiryHeight: 500 };
  const r = shouldDeferForPendingWrite(lw, 'other', 400, 31 * 60_000);
  assert.strictEqual(r.defer, true, 'still valid on-chain → must keep deferring');
});

test('backstop releases far past any plausible expiry (concurrent-writer case)', () => {
  // Another writer confirmed on top of ours, so the txid match can never fire.
  const lw = { txid: 'aa', at: 0, expiryHeight: 500 };
  const r = shouldDeferForPendingWrite(lw, 'someone-elses', 400, 5 * 60 * 60_000);
  assert.strictEqual(r.defer, false);
  assert.strictEqual(r.reason, 'backstop');
});

test('no pending write → never defers', () => {
  assert.strictEqual(shouldDeferForPendingWrite(null, 'x', 1, 1).defer, false);
  assert.strictEqual(shouldDeferForPendingWrite(undefined, 'x', 1, 1).defer, false);
});

test('a missing expiryHeight (e.g. restored across restart) still relies on the backstop', () => {
  const lw = { txid: 'aa', at: 0 };
  assert.strictEqual(shouldDeferForPendingWrite(lw, 'other', 9_999_999, 1000).defer, true);
  assert.strictEqual(shouldDeferForPendingWrite(lw, 'other', 9_999_999, 5 * 60 * 60_000).defer, false);
});

// ---------------------------------------------------------------------------
// Bounded batch-failure counter — "uncounted" must not mean "unbounded"
// ---------------------------------------------------------------------------

test('batchCompositionKey is order-independent and stable', () => {
  assert.strictEqual(batchCompositionKey(['b', 'a']), batchCompositionKey(['a', 'b']));
  assert.notStrictEqual(batchCompositionKey(['a']), batchCompositionKey(['a', 'b']));
});

test('AUDIT FIX 1: repeated identical-composition non-contention failures escalate', () => {
  const m = new Map();
  const ids = ['i1', 'i2'];
  let r;
  for (let i = 0; i < MAX_BATCH_FAILURES; i++) r = recordBatchFailure(m, 'agent-1', ids, 'hard');
  assert.strictEqual(r.consecutive, MAX_BATCH_FAILURES);
  assert.strictEqual(r.escalate, true);
});

test('AUDIT FIX 1: contention never escalates, however long it persists', () => {
  const m = new Map();
  let r;
  for (let i = 0; i < MAX_BATCH_FAILURES * 3; i++) r = recordBatchFailure(m, 'agent-1', ['i1'], 'contention');
  assert.strictEqual(r.escalate, false, 'waiting for confirmation is correct and self-resolving');
});

test('a changed batch composition resets the counter', () => {
  const m = new Map();
  recordBatchFailure(m, 'agent-1', ['i1', 'i2'], 'hard');
  recordBatchFailure(m, 'agent-1', ['i1', 'i2'], 'hard');
  const r = recordBatchFailure(m, 'agent-1', ['i3'], 'hard');
  assert.strictEqual(r.consecutive, 1);
  assert.strictEqual(r.escalate, false);
});

test('success clears the batch-failure record', () => {
  const m = new Map();
  recordBatchFailure(m, 'agent-1', ['i1'], 'hard');
  clearBatchFailure(m, 'agent-1');
  assert.strictEqual(m.has('agent-1'), false);
});

test('batch failures are tracked per agent, not globally', () => {
  const m = new Map();
  recordBatchFailure(m, 'agent-1', ['i1'], 'hard');
  const r = recordBatchFailure(m, 'agent-2', ['i1'], 'hard');
  assert.strictEqual(r.consecutive, 1);
});

// ---------------------------------------------------------------------------
// Redrive + surfacing
// ---------------------------------------------------------------------------

test('redrive clears all dead-lettered records and reports the count', () => {
  const f = new Map();
  for (let i = 0; i < 5; i++) recordInboxFailure(f, 'x1', 'boom');
  for (let i = 0; i < 5; i++) recordInboxFailure(f, 'x2', 'boom');
  recordInboxFailure(f, 'x3', 'boom'); // still retrying, not dead-lettered
  assert.strictEqual(redriveDeadLetters(f), 2);
  assert.strictEqual(isDeadLettered(f, 'x1'), false);
  assert.strictEqual(isDeadLettered(f, 'x2'), false);
  assert.ok(f.has('x3'), 'a still-retrying item is left alone');
});

test('redrive of a single item touches only that item', () => {
  const f = new Map();
  for (let i = 0; i < 5; i++) recordInboxFailure(f, 'x1', 'boom');
  for (let i = 0; i < 5; i++) recordInboxFailure(f, 'x2', 'boom');
  assert.strictEqual(redriveDeadLetters(f, 'x1'), 1);
  assert.strictEqual(isDeadLettered(f, 'x1'), false);
  assert.strictEqual(isDeadLettered(f, 'x2'), true);
});

test('redrive gives a fresh full budget, not a one-off retry', () => {
  const f = new Map();
  for (let i = 0; i < 5; i++) recordInboxFailure(f, 'x1', 'boom');
  redriveDeadLetters(f, 'x1');
  const r = recordInboxFailure(f, 'x1', 'boom');
  assert.strictEqual(r.attempts, 1);
  assert.strictEqual(r.deadLettered, false);
});

test('listInboxFailures splits dead-lettered from retrying and carries meta', () => {
  const f = new Map();
  for (let i = 0; i < 5; i++) recordInboxFailure(f, 'x1', 'boom', undefined, { agentId: 'agent-1', type: 'review' });
  recordInboxFailure(f, 'x2', 'later', undefined, { agentId: 'agent-2', type: 'attestation' });
  const out = listInboxFailures(f);
  assert.strictEqual(out.deadLettered.length, 1);
  assert.strictEqual(out.retrying.length, 1);
  assert.strictEqual(out.deadLettered[0].itemId, 'x1');
  assert.strictEqual(out.deadLettered[0].agentId, 'agent-1');
  assert.strictEqual(out.deadLettered[0].type, 'review');
  assert.strictEqual(out.deadLettered[0].attempts, 5);
  assert.strictEqual(out.retrying[0].itemId, 'x2');
});

test('meta is optional — existing 3-arg callers keep working unchanged', () => {
  const f = new Map();
  const r = recordInboxFailure(f, 'x1', 'boom');
  assert.strictEqual(r.attempts, 1);
  const out = listInboxFailures(f);
  assert.strictEqual(out.retrying[0].agentId, null);
});
