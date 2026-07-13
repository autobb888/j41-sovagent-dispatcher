'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_INBOX_ATTEMPTS,
  isDeadLettered,
  recordInboxFailure,
  clearInboxFailure,
  pruneInboxFailures,
} = require('../src/inbox-deadletter.js');

test('an item is not dead-lettered until MAX_INBOX_ATTEMPTS failures', () => {
  const f = new Map();
  for (let i = 1; i < MAX_INBOX_ATTEMPTS; i++) {
    const r = recordInboxFailure(f, 'itemA', `boom ${i}`);
    assert.equal(r.attempts, i);
    assert.equal(r.deadLettered, false, `attempt ${i} must not dead-letter yet`);
    assert.equal(isDeadLettered(f, 'itemA'), false);
  }
  const last = recordInboxFailure(f, 'itemA', 'final boom');
  assert.equal(last.attempts, MAX_INBOX_ATTEMPTS);
  assert.equal(last.deadLettered, true, 'the MAX-th failure dead-letters');
  assert.equal(last.justDeadLettered, true, 'transition is reported exactly once');
  assert.equal(isDeadLettered(f, 'itemA'), true);
});

test('justDeadLettered fires only on the transition, so the caller logs once', () => {
  const f = new Map();
  let transitions = 0;
  for (let i = 0; i < MAX_INBOX_ATTEMPTS + 3; i++) {
    if (recordInboxFailure(f, 'x', 'e').justDeadLettered) transitions++;
  }
  assert.equal(transitions, 1, 'exactly one dead-letter transition across many failures');
});

test('a success clears the failure record — the next failure starts fresh', () => {
  const f = new Map();
  recordInboxFailure(f, 'flaky', 'e1');
  recordInboxFailure(f, 'flaky', 'e2');
  assert.equal(f.get('flaky').attempts, 2);

  clearInboxFailure(f, 'flaky');
  assert.equal(isDeadLettered(f, 'flaky'), false);
  assert.equal(f.has('flaky'), false);

  const again = recordInboxFailure(f, 'flaky', 'e3');
  assert.equal(again.attempts, 1, 'counter restarts after a success');
});

test('lastError is captured and bounded', () => {
  const f = new Map();
  recordInboxFailure(f, 'i', 'x'.repeat(1000));
  assert.equal(f.get('i').lastError.length, 300, 'error text is truncated for the health doc');
});

test('prune drops entries no longer pending — but only with a complete view', () => {
  const f = new Map();
  recordInboxFailure(f, 'gone', 'e');   // will no longer be pending
  recordInboxFailure(f, 'still', 'e');  // still pending
  const seen = new Set(['still']);

  // Incomplete view (an agent failed to poll): prune nothing, or we'd wrongly
  // forget a dead-lettered item under the unreachable agent.
  assert.equal(pruneInboxFailures(f, seen, false), 0);
  assert.equal(f.has('gone'), true);

  // Complete view: 'gone' is truly gone from the backend → drop it.
  const pruned = pruneInboxFailures(f, seen, true);
  assert.equal(pruned, 1);
  assert.equal(f.has('gone'), false);
  assert.equal(f.has('still'), true);
});

test('a dead-lettered item survives pruning while it is still pending', () => {
  const f = new Map();
  for (let i = 0; i < MAX_INBOX_ATTEMPTS; i++) recordInboxFailure(f, 'poison', 'bad shape');
  assert.equal(isDeadLettered(f, 'poison'), true);

  // Still appears in the pending set → must NOT be pruned, so we keep skipping it.
  pruneInboxFailures(f, new Set(['poison']), true);
  assert.equal(isDeadLettered(f, 'poison'), true, 'quarantine persists while the item is still pending');
});
