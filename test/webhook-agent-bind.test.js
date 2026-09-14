'use strict';
/**
 * T3 — an authenticated webhook may only cancel jobs owned by that agent.
 *
 * agent-2 presenting a valid secret for /webhook/agent-2 must not yank
 * agent-1's active GPU rental or queued labour. The bind lives inside
 * case 'job.cancelled' only — job.requested / job.started have no local
 * job yet, so a preamble that refuses a locally absent job would break
 * accept.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-webhook-bind-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
process.env.NODE_ENV = 'test';

const CLI = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
const { handleWebhookEvent } = require('../src/cli.js');

function bindState() {
  const released = [];
  const agent1 = { id: 'agent-1', identity: 'agent-1@', address: 'R1' };
  const agent2 = { id: 'agent-2', identity: 'agent-2@', address: 'R2' };
  const container = { stop: async () => { throw new Error('container.stop must not run'); } };
  const lease = { id: 'home:1', jobId: 'gpu-job-1', state: 'ready', expiresAt: 9e15 };
  const gpuJob = {
    kind: 'gpu-rental',
    leaseId: 'home:1',
    agentId: 'agent-1',
    agentInfo: agent1,
    container,
  };
  const queuedLabour = {
    id: 'labour-job-1',
    assignedAgent: agent1,
    amount: 2,
  };
  const state = {
    agents: [agent1, agent2],
    active: new Map([['gpu-job-1', gpuJob]]),
    available: [agent2],
    queue: [queuedLabour],
    seen: new Map(),
    retries: new Map(),
    pendingPayment: new Map(),
    _lastSentStatus: new Map(),
    _pendingWorkspace: new Map(),
    emitEvent() {},
    computeSupply: {
      getLeases() { return [lease]; },
      async releaseLease(l) { released.push(l.id); l.state = 'released'; },
    },
  };
  return { state, released, agent1, agent2, gpuJob, queuedLabour, lease };
}

test('handleWebhookEvent has no preamble that refuses a locally absent job', () => {
  const start = CLI.indexOf('async function handleWebhookEvent');
  assert.ok(start > -1);
  const sw = CLI.indexOf('switch (event)', start);
  assert.ok(sw > start);
  const preamble = CLI.slice(start, sw);
  assert.doesNotMatch(preamble, /ownsActive|ownsQueued|assignedAgent/,
    'ownership bind must not live in the preamble — job.requested/job.started have no local job yet');
  assert.doesNotMatch(preamble, /state\.active\.(get|has)\(jobId\)/,
    'preamble must not refuse a locally absent job');
});

test('job.cancelled bind lives inside the case, not as a preamble', () => {
  const start = CLI.indexOf("case 'job.cancelled'");
  const end = CLI.indexOf("case 'job.delivery_rejected'");
  const block = CLI.slice(start, end);
  assert.match(block, /assignedAgent/, 'queued labour is bound via assignedAgent.id');
  assert.match(block, /agentInfo\?\.id === agentInfo\.id|agentId === agentInfo\.id/,
    'active jobs are bound to the authenticating agent');
});

test('agent-2 cannot cancel agent-1 active GPU rental', async () => {
  const { state, released } = bindState();
  await handleWebhookEvent(state, 'agent-2', {
    event: 'job.cancelled',
    data: { jobId: 'gpu-job-1' },
  });
  assert.equal(state.active.has('gpu-job-1'), true, 'agent-1 GPU must stay active');
  assert.equal(released.length, 0, 'lease must not be released');
  assert.equal(state.seen.has('gpu-job-1'), false, 'refusing must not mark the job seen');
  assert.equal(state.queue.length, 1, 'queue must be untouched');
  assert.equal(state.queue[0].id, 'labour-job-1');
});

test('agent-2 cannot cancel agent-1 queued labour', async () => {
  const { state, released } = bindState();
  await handleWebhookEvent(state, 'agent-2', {
    event: 'job.cancelled',
    data: { jobId: 'labour-job-1' },
  });
  assert.equal(state.queue.length, 1, 'agent-1 queued labour must stay queued');
  assert.equal(state.queue[0].id, 'labour-job-1');
  assert.equal(state.queue[0].assignedAgent.id, 'agent-1');
  assert.equal(state.active.has('gpu-job-1'), true);
  assert.equal(released.length, 0);
  assert.equal(state.seen.has('labour-job-1'), false);
});

test('agent-1 can cancel its own active GPU rental', async () => {
  const { state, released } = bindState();
  await handleWebhookEvent(state, 'agent-1', {
    event: 'job.cancelled',
    data: { jobId: 'gpu-job-1' },
  });
  assert.equal(state.active.has('gpu-job-1'), false);
  assert.deepEqual(released, ['home:1']);
  assert.equal(state.queue.length, 1, 'unrelated queued labour must stay');
});

test('agent-1 can cancel its own queued labour without touching the GPU', async () => {
  const { state, released } = bindState();
  await handleWebhookEvent(state, 'agent-1', {
    event: 'job.cancelled',
    data: { jobId: 'labour-job-1' },
  });
  assert.equal(state.queue.length, 0);
  assert.equal(state.active.has('gpu-job-1'), true);
  assert.equal(released.length, 0);
  assert.equal(state.seen.has('labour-job-1'), true);
});

test('job.cancelled for a job that is neither active nor queued does not filter the queue', async () => {
  const { state, released } = bindState();
  await handleWebhookEvent(state, 'agent-2', {
    event: 'job.cancelled',
    data: { jobId: 'stranger-job' },
  });
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].id, 'labour-job-1');
  assert.equal(state.active.has('gpu-job-1'), true);
  assert.equal(released.length, 0);
  assert.equal(state.seen.has('stranger-job'), false);
});
