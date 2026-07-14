'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.NODE_ENV = 'test';
const { loadAgentCapabilities } = require('../src/cli.js');

// Minimal state + agentInfo; stub getAgentSession via state._testSession hook (see Task 1 note).
function mkState(session) {
  return {
    capabilities: new Map(),
    disputePolicy: new Map(),
    agentMarkup: new Map(),
    agentSessions: new Map(),
    _testAgentSession: session, // test seam consumed by getAgentSession when NODE_ENV==='test'
  };
}

test('loadAgentCapabilities stores capabilities and leaves no _fetchFailed on success', async () => {
  const session = {
    client: {
      getAgentServices: async () => ({ data: [] }),
      getMyIdentity: async () => ({ contentmultimap: {} }),
    },
  };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-x', iAddress: 'iX', identity: 'x@' });
  assert.strictEqual(ok, true);
  const cap = state.capabilities.get('agent-x');
  assert.ok(cap, 'capabilities stored');
  assert.notStrictEqual(cap._fetchFailed, true, 'no _fetchFailed on success');
});

test('loadAgentCapabilities marks _fetchFailed on fetch error and returns false', async () => {
  const session = { client: {
    getAgentServices: async () => { throw new Error('Sign-in temporarily unavailable while the chain catches up'); },
    getMyIdentity: async () => ({ contentmultimap: {} }),
  } };
  const state = mkState(session);
  const ok = await loadAgentCapabilities(state, { id: 'agent-y', iAddress: 'iY', identity: 'y@' });
  assert.strictEqual(ok, false);
  assert.strictEqual(state.capabilities.get('agent-y')._fetchFailed, true);
});
