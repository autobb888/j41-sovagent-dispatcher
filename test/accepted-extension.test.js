'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { labourExtensionClosed, requestBudgetExtension } = require('../src/job-agent');

test('an accepted labour job does not ask for an extension', async () => {
  assert.equal(labourExtensionClosed('accepted'), true);
  assert.equal(labourExtensionClosed('in_progress'), false);
  assert.equal(labourExtensionClosed('paused'), false);

  const calls = [];
  const executor = {};
  const agent = {
    client: { async getJob() { return { status: 'accepted' }; } },
    async requestBudget() { calls.push('budget'); },
  };
  const job = { id: 'job-accepted', status: 'accepted', currency: 'VRSCTEST' };
  const usage = { totalTokens: 10, promptTokens: 4, completionTokens: 6, llmCalls: 1 };
  await requestBudgetExtension(job, agent, executor, usage, 1000);
  await requestBudgetExtension(job, agent, executor, usage, 1000);
  assert.deepEqual(calls, []);
  assert.equal(executor._extensionClosedLogged, true);
  assert.equal(executor._extensionRequested, undefined);
});
