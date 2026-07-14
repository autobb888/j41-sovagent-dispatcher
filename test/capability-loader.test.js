'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.NODE_ENV = 'test';
const { loadAgentCapabilities } = require('../src/cli.js');

// Minimal state + agentInfo; stub getAgentSession via state._testAgentSession hook (see Task 1 note).
function mkState(session) {
  return {
    capabilities: new Map(),
    disputePolicy: new Map(),
    agentMarkup: new Map(),
    agentSessions: new Map(),
    _testAgentSession: session, // test seam consumed by getAgentSession when NODE_ENV==='test'
  };
}

// Case 1: success — getIdentityRaw succeeds, getAgentServices succeeds
test('loadAgentCapabilities stores capabilities and leaves no _fetchFailed on success', async () => {
  const session = {
    client: {
      getIdentityRaw: async () => ({ data: { identity: { contentmultimap: {} } } }),
      getAgentServices: async () => ({ data: [] }),
    },
  };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-x', iAddress: 'iX', identity: 'x@' });
  assert.strictEqual(ok, true);
  const cap = state.capabilities.get('agent-x');
  assert.ok(cap, 'capabilities stored');
  assert.notStrictEqual(cap._fetchFailed, true, 'no _fetchFailed on success');
});

// Case 2: identity fetch fails → _fetchFailed
test('loadAgentCapabilities marks _fetchFailed on identity fetch error and returns false', async () => {
  const session = {
    client: {
      getIdentityRaw: async () => { throw new Error('Sign-in temporarily unavailable while the chain catches up'); },
      getAgentServices: async () => ({ data: [] }),
    },
  };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-y', iAddress: 'iY', identity: 'y@' });
  assert.strictEqual(ok, false);
  assert.strictEqual(state.capabilities.get('agent-y')._fetchFailed, true);
});

// Case 3: services fetch fails is NON-FATAL — capabilities still stored, no _fetchFailed
test('loadAgentCapabilities treats services fetch failure as non-fatal', async () => {
  const session = {
    client: {
      getIdentityRaw: async () => ({ data: { identity: { contentmultimap: {} } } }),
      getAgentServices: async () => { throw new Error('services API down'); },
    },
  };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-z', iAddress: 'iZ', identity: 'z@' });
  assert.strictEqual(ok, true, 'should still return true when services fetch fails');
  const cap = state.capabilities.get('agent-z');
  assert.ok(cap, 'capabilities stored despite services failure');
  assert.notStrictEqual(cap._fetchFailed, true, 'no _fetchFailed when only services fails');
});
