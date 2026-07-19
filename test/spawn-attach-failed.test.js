'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { reportSpawnAttachFailed } = require('../src/cli.js');

function deps(opts = {}) {
  const calls = [];
  return {
    calls,
    getAgentSession: async () => ({
      client: { reportWorkerAttachFailed: async (id, reason) => { calls.push({ id, reason }); if (opts.throw) throw new Error('net'); } },
    }),
  };
}

test('non-reconnect status reports attach-failed', async () => {
  const d = deps();
  await reportSpawnAttachFailed({}, { id: 'a1' }, { id: 'j1', status: 'accepted' }, 'spawn-error: boom', d);
  assert.deepEqual(d.calls, [{ id: 'j1', reason: 'spawn-error: boom' }]);
});

test('disputed/delivered status reports NOTHING (would 409)', async () => {
  for (const status of ['disputed', 'delivered']) {
    const d = deps();
    await reportSpawnAttachFailed({}, { id: 'a1' }, { id: 'j1', status }, 'spawn-error', d);
    assert.deepEqual(d.calls, [], `status ${status} must not report`);
  }
});

test('fail-open: a throwing session is swallowed', async () => {
  const d = deps({ throw: true });
  await reportSpawnAttachFailed({}, { id: 'a1' }, { id: 'j1', status: 'in_progress' }, 'spawn-error', d); // must not reject
  assert.ok(true);
});
