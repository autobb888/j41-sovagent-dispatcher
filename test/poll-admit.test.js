'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

test('a capacity-queued or swallowed labour start is not persisted as seen', () => {
  const start = CLI.indexOf('Mark seen in memory BEFORE starting');
  const end = CLI.indexOf('Surface SovGuard', start);
  assert.ok(start > 0 && end > start);
  const block = CLI.slice(start, end);
  const queueAt = block.indexOf('Queueing (max capacity');
  assert.ok(queueAt > 0);
  assert.equal(block.slice(0, queueAt).includes('saveSeenJobs'), false,
    'persisting seen before the job is active makes a restart skip a paid job for 7 days');
  assert.match(block, /did not start/);
  assert.match(block, /state\.active\.has\(job\.id\)/);
});
