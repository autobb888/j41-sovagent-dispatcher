'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { selfReportAttach, isTerminalAttachError, ATTACH_CONFIRM_BACKOFF_MS } = require('../src/job-agent.js');

const noSleep = () => Promise.resolve();

// behavior.attach: script consumed one-per confirmWorkerAttached call —
//   'ok' → resolve, 'net' → throw a transient error (no statusCode),
//   <number> → throw a J41-style error carrying that statusCode.
//   When the script is exhausted, further calls resolve OK.
// behavior.throwFailed → reportWorkerAttachFailed throws (fail-open check).
function spyAgent(behavior = {}) {
  const calls = { attached: [], failed: [] };
  const script = (behavior.attach || []).slice();
  return {
    calls,
    client: {
      confirmWorkerAttached: async (id) => {
        calls.attached.push(id);
        const step = script.length ? script.shift() : 'ok';
        if (step === 'net') throw new Error('net');
        if (typeof step === 'number') { const e = new Error(`http ${step}`); e.statusCode = step; throw e; }
      },
      reportWorkerAttachFailed: async (id, reason) => {
        calls.failed.push({ id, reason });
        if (behavior.throwFailed) throw new Error('net');
      },
    },
  };
}

test('success path calls confirmWorkerAttached once', async () => {
  const a = spyAgent();
  await selfReportAttach(a, 'j1', { isReconnect: false, sleep: noSleep });
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
  await selfReportAttach(a, 'j1', { isReconnect: true, sleep: noSleep });
  await selfReportAttach(a, 'j1', { isReconnect: true, failed: true, reason: 'x' });
  assert.deepEqual(a.calls.attached, []);
  assert.deepEqual(a.calls.failed, []);
});

test('transient failure retries with backoff, then succeeds', async () => {
  const a = spyAgent({ attach: ['net', 'net', 'ok'] });
  const waits = [];
  await selfReportAttach(a, 'j1', {
    isReconnect: false,
    backoffs: [10, 20, 30],
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
  });
  assert.equal(a.calls.attached.length, 3);   // 1 initial + 2 retries
  assert.deepEqual(waits, [10, 20]);           // two backoffs consumed before success
});

test('fail-open: persistent transient failure exhausts retries and never throws', async () => {
  const a = spyAgent({ attach: ['net', 'net', 'net', 'net', 'net'] });
  await selfReportAttach(a, 'j1', { isReconnect: false, backoffs: [1, 1], sleep: noSleep }); // must not reject
  assert.equal(a.calls.attached.length, 3);   // 1 initial + backoffs.length (2) retries, then gives up
});

test('terminal 409 STATE_CONFLICT stops immediately — no retry, no throw', async () => {
  const a = spyAgent({ attach: [409, 'ok'] });
  await selfReportAttach(a, 'j1', { isReconnect: false, backoffs: [1, 1, 1], sleep: noSleep });
  assert.equal(a.calls.attached.length, 1);   // stopped on terminal; never reached the 'ok'
});

test('failed path is fail-open when the client throws', async () => {
  const a = spyAgent({ throwFailed: true });
  await selfReportAttach(a, 'j1', { isReconnect: false, failed: true, reason: 'x' }); // must not reject
  assert.deepEqual(a.calls.failed, [{ id: 'j1', reason: 'x' }]);
});

test('fail-open against a non-Error thrown value (null) on both paths — never throws', async () => {
  // A client that throws a bare null must not let `e.message` blow up the catch.
  const nullThrower = {
    calls: { attached: [], failed: [] },
    client: {
      confirmWorkerAttached: async (id) => { nullThrower.calls.attached.push(id); throw null; },
      reportWorkerAttachFailed: async (id, r) => { nullThrower.calls.failed.push({ id, r }); throw null; },
    },
  };
  await selfReportAttach(nullThrower, 'j1', { isReconnect: false, backoffs: [1], sleep: noSleep }); // success path
  await selfReportAttach(nullThrower, 'j1', { isReconnect: false, failed: true, reason: 'x' });      // failed path
  assert.equal(nullThrower.calls.attached.length, 2); // 1 initial + 1 retry (null = transient), then gives up, no throw
  assert.equal(nullThrower.calls.failed.length, 1);
});

test('isTerminalAttachError: 4xx-except-429 terminal, else transient', () => {
  for (const sc of [400, 403, 404, 409]) assert.equal(isTerminalAttachError({ statusCode: sc }), true, `${sc} should be terminal`);
  for (const sc of [429, 500, 502, 503]) assert.equal(isTerminalAttachError({ statusCode: sc }), false, `${sc} should be transient`);
  assert.equal(isTerminalAttachError(new Error('net')), false); // no statusCode → transient
  assert.equal(isTerminalAttachError(null), false);
});

test('default backoff schedule gives a meaningful retry budget', () => {
  assert.ok(Array.isArray(ATTACH_CONFIRM_BACKOFF_MS));
  assert.ok(ATTACH_CONFIRM_BACKOFF_MS.length >= 3, 'at least 3 retries budgeted');
  assert.ok(ATTACH_CONFIRM_BACKOFF_MS.every((ms) => Number.isFinite(ms) && ms > 0), 'all backoffs positive');
});
