'use strict';
/**
 * control.test.js — integration test for the field-name handshake between
 * buildAgents(state) (src/control.js) and the pure diagnoseAgent projection
 * (src/agent-status.js). The live review flagged this seam as untested:
 * buildAgents reads from hand-maintained Maps (platformStatus/capabilities)
 * and re-maps diagnoseAgent's output into the control-surface field names
 * (hireable/reason/platformStatus/statusAge/activeServices). These tests use a
 * hand-built fake `state` (no network, no SDK) to lock that contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAgents } = require('../src/control.js');

// Minimal-but-realistic fake state. Real Maps; empty `active` Map (no busy
// jobs); network 'verustest' → diagnoseAgent resolves native currency VRSCTEST.
function makeState({ agents, platformStatus = new Map(), capabilities = new Map() }) {
  return {
    agents,
    active: new Map(),
    capabilities,
    platformStatus,
    network: 'verustest',
  };
}

test('buildAgents: active agent with a VRSCTEST-priced active service is hireable', () => {
  const state = makeState({
    agents: [{ id: 'agent-1', identity: 'alice@' }],
    platformStatus: new Map([['agent-1', { status: 'active', at: Date.now() }]]),
    capabilities: new Map([
      ['agent-1', { services: [{ status: 'active', currency: 'VRSCTEST', price: 5 }] }],
    ]),
  });

  const { agents } = buildAgents(state);
  assert.equal(agents.length, 1);
  const e = agents[0];
  assert.equal(e.id, 'agent-1');
  assert.equal(e.hireable, true);
  assert.equal(e.reason, null);
  assert.equal(e.platformStatus, 'active');
  assert.equal(e.activeServices, 1);
  assert.equal(typeof e.statusAge, 'number');
  assert.ok(e.statusAge >= 0, 'statusAge should be a small non-negative number');
  assert.ok(e.statusAge < 60000, 'statusAge should be small (just-seeded)');
});

test('buildAgents: inactive platform status blocks with agent_inactive', () => {
  const state = makeState({
    agents: [{ id: 'agent-2', identity: 'bob@' }],
    platformStatus: new Map([['agent-2', { status: 'inactive', at: Date.now() }]]),
    capabilities: new Map([
      ['agent-2', { services: [{ status: 'active', currency: 'VRSCTEST', price: 5 }] }],
    ]),
  });

  const { agents } = buildAgents(state);
  const e = agents[0];
  assert.equal(e.hireable, false);
  assert.equal(e.reason, 'agent_inactive');
  assert.equal(e.platformStatus, 'inactive');
});

test('buildAgents: missing platformStatus entry yields no verdict (null), never false', () => {
  const state = makeState({
    agents: [{ id: 'agent-3', identity: 'carol@' }],
    // No platformStatus entry for agent-3 — the poller never seeded it.
    platformStatus: new Map(),
    capabilities: new Map([
      ['agent-3', { services: [{ status: 'active', currency: 'VRSCTEST', price: 5 }] }],
    ]),
  });

  const { agents } = buildAgents(state);
  const e = agents[0];
  assert.equal(e.hireable, null);
  assert.equal(e.reason, null);
  assert.equal(e.platformStatus, null);
  assert.equal(e.statusAge, null);
});
