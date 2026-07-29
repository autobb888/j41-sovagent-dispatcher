'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { buildHealthDocument, buildInboxSurface, handleCommand } = require('../src/control.js');
const { recordInboxFailure, isDeadLettered } = require('../src/inbox-deadletter.js');

function makeState(overrides = {}) {
  return {
    agents: [{ id: 'agent-1', identity: 'a@' }],
    active: new Map(),
    available: [],
    queue: [],
    seen: new Set(),
    _inboxFailures: new Map(),
    _inboxLastWrite: new Map(),
    _inboxAckFailures: new Map(),
    _agentErrors: new Map(),
    ...overrides,
  };
}

test('health gains a structured inbox block', () => {
  const state = makeState();
  const doc = buildHealthDocument(state, Date.now() - 1000);
  assert.ok(doc.inbox, 'inbox block present');
  assert.deepEqual(doc.inbox.deadLettered, []);
  assert.deepEqual(doc.inbox.retrying, []);
  assert.deepEqual(doc.inbox.pendingWrites, []);
});

test('a dead-lettered item is listed with its agent, type and attempts', () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) {
    recordInboxFailure(state._inboxFailures, 'r1', 'Transaction rejected', undefined, { agentId: 'agent-1', type: 'review' });
  }
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.inbox.deadLettered.length, 1);
  const row = doc.inbox.deadLettered[0];
  assert.strictEqual(row.itemId, 'r1');
  assert.strictEqual(row.agentId, 'agent-1');
  assert.strictEqual(row.type, 'review');
  assert.strictEqual(row.attempts, 5);
});

test('dead letters degrade overall status — silent loss must be visible', () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'r1', 'boom');
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.status, 'degraded');
});

test('a still-retrying item does NOT degrade status', () => {
  const state = makeState();
  recordInboxFailure(state._inboxFailures, 'r1', 'blip');
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.status, 'ok');
  assert.strictEqual(doc.inbox.retrying.length, 1);
});

test('pendingWrites reports the outstanding identity tx with its age', () => {
  const state = makeState();
  state._inboxLastWrite.set('agent-1', { txid: 'abc123', at: Date.now() - 61_000, expiryHeight: 1200 });
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.inbox.pendingWrites.length, 1);
  const pw = doc.inbox.pendingWrites[0];
  assert.strictEqual(pw.agentId, 'agent-1');
  assert.strictEqual(pw.txid, 'abc123');
  assert.ok(pw.ageMs >= 60_000);
  assert.strictEqual(pw.expiryHeight, 1200);
});

test('repeated ack failures are surfaced (they are in no other bucket)', () => {
  const state = makeState();
  state._inboxAckFailures.set('r1', { agentId: 'agent-1', type: 'review', consecutive: 3, lastError: 'timeout' });
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.inbox.ackFailed.length, 1);
  assert.strictEqual(doc.inbox.ackFailed[0].itemId, 'r1');
  assert.strictEqual(doc.inbox.ackFailed[0].consecutive, 3);
});

test('the legacy per-agent lastError string is preserved for back-compat', () => {
  const state = makeState();
  state._agentErrors.set('agent-1', 'something');
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.agents[0].lastError, 'something');
});

test('buildInboxSurface is a pure read model over state', () => {
  const state = makeState();
  recordInboxFailure(state._inboxFailures, 'x', 'e');
  const a = buildInboxSurface(state);
  const b = buildInboxSurface(state);
  assert.deepEqual(a, b, 'no mutation between calls');
});

test('ctl inbox returns the structured surface', async () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'r1', 'boom');
  const out = await handleCommand({ action: 'inbox' }, state, {}, Date.now());
  assert.strictEqual(out.deadLettered.length, 1);
});

test('ctl inbox-redrive clears quarantine and reports the count', async () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'r1', 'boom');
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'r2', 'boom');
  const out = await handleCommand({ action: 'inbox-redrive' }, state, {}, Date.now());
  assert.strictEqual(out.redriven, 2);
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'r1'), false);
});

test('ctl inbox-redrive with an item id touches only that item', async () => {
  const state = makeState();
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'r1', 'boom');
  for (let i = 0; i < 5; i++) recordInboxFailure(state._inboxFailures, 'r2', 'boom');
  const out = await handleCommand({ action: 'inbox-redrive', itemId: 'r1' }, state, {}, Date.now());
  assert.strictEqual(out.redriven, 1);
  assert.strictEqual(isDeadLettered(state._inboxFailures, 'r2'), true);
});

test('inbox surfaces tolerate a state object with no inbox maps at all', () => {
  const doc = buildHealthDocument({ agents: [], active: new Map(), available: [], queue: [], seen: new Set() }, Date.now());
  assert.deepEqual(doc.inbox.deadLettered, []);
  assert.deepEqual(doc.inbox.pendingWrites, []);
});
