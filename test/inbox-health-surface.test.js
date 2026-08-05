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

// ── fee-tank surface ────────────────────────────────────────────────────────
// The R-address pays every on-chain write and only ever drains. When it empties
// the agent goes silently mute on-chain while still holding earnings — which is
// how 2026-08-05 went unnoticed: there was no balance anywhere in /health.

test('a state with no _feeTankLast at all reports feeTank: null (never a zero)', () => {
  // A dispatcher that has not run a sweep cycle yet, or an older state object.
  // A zero here would read as "empty tank" and trigger a pointless funding run.
  const doc = buildHealthDocument(makeState(), Date.now());
  assert.strictEqual(doc.agents[0].feeTank, null);
  assert.strictEqual(doc.summary.fee_tanks_empty, 0);
});

test('an agent the sweep loop has not sampled yet reports feeTank: null', () => {
  const state = makeState({ agents: [{ id: 'agent-1', identity: 'a@' }, { id: 'agent-2', identity: 'b@' }] });
  state._feeTankLast = new Map([['agent-1', { feeSats: 13490000, writes: 1349, sweepableSats: 0, reason: 'above-floor', at: Date.now() }]]);
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.agents[0].feeTank.feeSats, 13490000);
  assert.strictEqual(doc.agents[1].feeTank, null, 'unsampled agent is null, not 0');
});

test('a sampled tank surfaces balance, writes, sweepable, reason and sample age', () => {
  const state = makeState();
  state._feeTankLast = new Map([['agent-1', {
    feeSats: 13490000, writes: 1349, sweepableSats: 49990000, reason: 'above-floor', at: Date.now() - 61_000,
  }]]);
  const doc = buildHealthDocument(state, Date.now());
  const t = doc.agents[0].feeTank;
  assert.strictEqual(t.feeSats, 13490000);
  assert.strictEqual(t.writes, 1349);
  assert.strictEqual(t.sweepableSats, 49990000);
  assert.strictEqual(t.reason, 'above-floor');
  assert.ok(t.ageMs >= 60_000, 'age of the sample, so a stale one is detectable');
});

test('writes are derived from the balance when the sample lacks a count', () => {
  const state = makeState();
  state._feeTankLast = new Map([['agent-1', { feeSats: 25000, sweepableSats: 0, reason: 'below-floor', at: Date.now() }]]);
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.agents[0].feeTank.writes, 2, '25000 sats / 10000 fee, floored');
});

test('a malformed sample degrades to nulls rather than emitting junk numbers', () => {
  const state = makeState();
  state._feeTankLast = new Map([['agent-1', { feeSats: NaN, writes: '1349', sweepableSats: undefined, at: 'yesterday' }]]);
  const doc = buildHealthDocument(state, Date.now());
  const t = doc.agents[0].feeTank;
  assert.strictEqual(t.feeSats, null);
  assert.strictEqual(t.writes, null);
  assert.strictEqual(t.sweepableSats, null);
  assert.strictEqual(t.ageMs, null);
  assert.strictEqual(doc.summary.fee_tanks_empty, 0, 'unknown is not empty');
});

test('summary.fee_tanks_empty counts only tanks that cannot afford one write', () => {
  const state = makeState({
    agents: [{ id: 'agent-1' }, { id: 'agent-2' }, { id: 'agent-3' }, { id: 'agent-4' }],
  });
  state._feeTankLast = new Map([
    ['agent-1', { feeSats: 0, writes: 0, sweepableSats: 0, reason: 'needs-external-funding', at: Date.now() }],
    ['agent-2', { feeSats: 9999, writes: 0, sweepableSats: 500000, reason: 'below-floor', at: Date.now() }],
    ['agent-3', { feeSats: 10000, writes: 1, sweepableSats: 0, reason: 'below-floor', at: Date.now() }],
    // agent-4 never sampled
  ]);
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.summary.fee_tanks_empty, 2);
});

test('an empty fee tank does NOT degrade global status', () => {
  // _agentErrors already carries FEE TANK EMPTY into agents[].lastError, and an
  // empty tank on a freshly-created agent is normal onboarding, not a degraded
  // dispatcher. Pinned so nobody "helpfully" folds it into status later.
  const state = makeState();
  state._feeTankLast = new Map([['agent-1', { feeSats: 0, writes: 0, sweepableSats: 0, reason: 'needs-external-funding', at: Date.now() }]]);
  state._agentErrors.set('agent-1', 'FEE TANK EMPTY and nothing to sweep — fund RAbc externally');
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.status, 'ok');
  assert.strictEqual(doc.summary.fee_tanks_empty, 1);
  assert.match(doc.agents[0].lastError, /FEE TANK EMPTY/);
});

test('the fee-tank read model is pure — repeated builds agree and state is untouched', () => {
  const state = makeState();
  const sample = { feeSats: 13490000, writes: 1349, sweepableSats: 0, reason: 'above-floor', at: Date.now() };
  state._feeTankLast = new Map([['agent-1', sample]]);
  buildHealthDocument(state, Date.now());
  const b = buildHealthDocument(state, Date.now());
  assert.deepEqual(state._feeTankLast.get('agent-1'), sample, 'sample not mutated');
  assert.strictEqual(b.agents[0].feeTank.feeSats, 13490000);
});

test('a non-Map _feeTankLast (e.g. a deserialized plain object) is tolerated', () => {
  const state = makeState();
  state._feeTankLast = { 'agent-1': { feeSats: 1 } };
  const doc = buildHealthDocument(state, Date.now());
  assert.strictEqual(doc.agents[0].feeTank, null);
});
