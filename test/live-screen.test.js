const test = require('node:test');
const assert = require('node:assert/strict');
const { renderActiveJobs } = require('../src/tui/live-screen');

// Strip ANSI so assertions are about content, not color.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('renderActiveJobs: empty list shows "No active jobs" and queue 0', () => {
  const out = plain(renderActiveJobs({ jobs: { active: [], queue: 0 } }));
  assert.match(out, /Live Jobs/);
  assert.match(out, /No active jobs\./);
  assert.match(out, /Queue: 0 pending/);
});

test('renderActiveJobs: one running job shows id, agent, runtime, tokens', () => {
  const data = {
    jobs: { active: [{ jobId: '0bf75391-aaaa', agentId: 'agent-5', runningFor: '3m', paused: false, workspace: false, tokens: { total: 1234 } }], queue: 0 },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /0bf75391/);
  assert.match(out, /agent-5/);
  assert.match(out, /3m/);
  assert.match(out, /1234/);
  assert.match(out, /running/);
});

test('renderActiveJobs: paused job and [WS] flag render', () => {
  const data = {
    jobs: { active: [{ jobId: 'deadbeef-1', agentId: 'agent-2', runningFor: '1m', paused: true, workspace: true, tokens: null }], queue: 2 },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /paused/);
  assert.match(out, /\[WS\]/);
  assert.match(out, /Queue: 2 pending/);
});

test('renderActiveJobs: per-job memMB from resources is shown', () => {
  const data = {
    jobs: { active: [{ jobId: '0bf75391-aaaa', agentId: 'agent-5', runningFor: '3m', paused: false, workspace: false, tokens: null }], queue: 0 },
    resources: { jobs: [{ jobId: '0bf75391', memMB: 512, agentId: 'agent-5' }] },
  };
  const out = plain(renderActiveJobs(data));
  assert.match(out, /512MB/);
});

test('renderActiveJobs: error state shows the message and retry hint', () => {
  const out = plain(renderActiveJobs({ error: 'Dispatcher is not running (no control socket)' }));
  assert.match(out, /Dispatcher is not running/);
  assert.match(out, /press q to go back/);
});
