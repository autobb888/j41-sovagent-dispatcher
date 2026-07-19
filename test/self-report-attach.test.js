'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { selfReportAttach } = require('../src/job-agent.js');

function spyAgent(opts = {}) {
  const calls = { attached: [], failed: [] };
  return {
    calls,
    client: {
      confirmWorkerAttached: async (id) => { calls.attached.push(id); if (opts.throw) throw new Error('net'); },
      reportWorkerAttachFailed: async (id, reason) => { calls.failed.push({ id, reason }); if (opts.throw) throw new Error('net'); },
    },
  };
}

test('success path calls confirmWorkerAttached only', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: false });
  assert.deepEqual(a.calls.attached, ['j1']);
  assert.deepEqual(a.calls.failed, []);
});

test('failed path calls reportWorkerAttachFailed with the reason', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: false, failed: true, reason: 'chat-connect-failed: x' });
  assert.deepEqual(a.calls.failed, [{ id: 'j1', reason: 'chat-connect-failed: x' }]);
  assert.deepEqual(a.calls.attached, []);
});

test('isReconnect calls NEITHER (avoids backend 409 on disputed/delivered respawn)', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: true });
  await selfReportAttach(a, 'j1', { isReconnect: true, failed: true, reason: 'x' });
  assert.deepEqual(a.calls.attached, []);
  assert.deepEqual(a.calls.failed, []);
});

test('fail-open: a throwing client is swallowed (no throw)', async () => {
  const a = spyAgent({ throw: true });
  await selfReportAttach(a, 'j1', { isReconnect: false });                 // must not reject
  await selfReportAttach(a, 'j1', { isReconnect: false, failed: true });   // must not reject
  assert.ok(true);
});
