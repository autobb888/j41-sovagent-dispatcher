/**
 * B1 — /health must reflect whether the PLATFORM still considers an agent online.
 *
 * Live failure 2026-08-06: a routine restart left all nine agents `inactive` on the
 * platform. Every dispatcher surface — /health, /metrics, ctl status, the control API
 * — reported `status: ok` with all agents `available`, because agent status was
 * derived purely from local job assignment and platform state was never queried at
 * all (zero references in control.js). A monitoring endpoint that stays green through
 * a total outage is worse than no endpoint: it actively suppresses the alarm.
 *
 * `unknown` deliberately does NOT degrade — it means "not checked yet", and treating
 * absence of information as failure would make every cold start look broken.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHealthDocument } = require('../src/control');

function stateWith(agents) {
  return {
    agents,
    active: new Map(),
    available: [],
    queue: [],
    reactivationQueue: [],
    seen: new Map(),
    _agentErrors: new Map(),
    _containerCrashes: new Map(),
    _inboxFailures: new Map(),
    startedAt: Date.now() - 1000,
  };
}

test('an agent the platform considers inactive is visible in the health document', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'inactive' },
  ]), Date.now() - 1000);

  assert.equal(doc.agents[0].platformStatus, 'inactive');
});

test('an inactive agent degrades the whole document — it cannot receive work', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active' },
    { id: 'agent-2', identity: 'a2@', platformStatus: 'inactive' },
  ]), Date.now() - 1000);

  assert.equal(doc.status, 'degraded',
    'this is the exact 2026-08-06 state that reported ok');
});

test('a disabled agent degrades too', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'disabled' },
  ]), Date.now() - 1000);
  assert.equal(doc.status, 'degraded');
});

test('a fully active fleet is ok', () => {
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@', platformStatus: 'active' },
    { id: 'agent-2', identity: 'a2@', platformStatus: 'active' },
  ]), Date.now() - 1000);
  assert.equal(doc.status, 'ok');
});

test('unknown does not degrade — "not checked yet" is not "broken"', () => {
  // A cold start, or a start with the platform-status check skipped, must not look
  // like an outage. Only a positive inactive/disabled reading is a fault.
  const doc = buildHealthDocument(stateWith([
    { id: 'agent-1', identity: 'a1@' },                          // no field at all
    { id: 'agent-2', identity: 'a2@', platformStatus: 'unknown' },
  ]), Date.now() - 1000);

  assert.equal(doc.agents[0].platformStatus, 'unknown', 'absent reads as unknown, never as active');
  assert.equal(doc.status, 'ok');
});
