'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { surfaceDispute } = require('../src/job-agent.js');

function fakeAgent(dispute) {
  const sent = [];
  let handlerArgs = null;
  return {
    sent, getHandlerArgs: () => handlerArgs,
    handler: { onJobDisputed: async (j, r, d) => { handlerArgs = { j: j.id, r, d }; } },
    sendChatMessage: async (jobId, text) => { sent.push({ jobId, text }); },
    client: {
      getDispute: async () => dispute,
      getJob: async () => ({ id: 'job-1', status: 'disputed' }),
      respondToDispute: async () => { throw new Error('surface-only must NOT respond'); },
    },
  };
}

test('surfaces reason + deadline to operator, fires handler, never responds', async () => {
  const agent = fakeAgent({ reason: 'incomplete', deadline_at: '2026-07-21T00:00:00Z', deadline_owner: 'seller' });
  const r = await surfaceDispute({ id: 'job-1' }, agent);
  assert.equal(r.surfaced, true);
  assert.equal(r.deadline_at, '2026-07-21T00:00:00Z');
  assert.equal(agent.sent.length, 1);
  assert.match(agent.sent[0].text, /2026-07-21/);
  assert.match(agent.sent[0].text, /incomplete/);
  const h = agent.getHandlerArgs();
  assert.deepEqual(h, { j: 'job-1', r: 'incomplete', d: '2026-07-21T00:00:00Z' });
});

test('tolerates a null deadline', async () => {
  const agent = fakeAgent({ reason: 'x', deadline_at: null, deadline_owner: null });
  const r = await surfaceDispute({ id: 'job-1' }, agent);
  assert.equal(r.surfaced, true);
  assert.equal(agent.sent.length, 1);
});
