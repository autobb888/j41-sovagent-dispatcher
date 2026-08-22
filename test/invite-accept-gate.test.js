'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CLI = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');

test('poll and webhook accept call decideAutoAccept before acceptJob', () => {
  const poll = CLI.slice(CLI.indexOf("job.status === 'requested'"), CLI.indexOf('Step 2: Check if ready'));
  assert.match(poll, /decideAutoAccept/);
  assert.match(poll, /acceptJob/);
  const pollAccept = poll.indexOf('acceptJob');
  assert.ok(poll.indexOf('decideAutoAccept') < pollAccept);

  const requested = CLI.slice(CLI.indexOf("case 'job.requested'"), CLI.indexOf("case 'job.started'"));
  assert.match(requested, /decideAutoAccept/);
  const whAccept = requested.indexOf('acceptJob');
  assert.ok(requested.indexOf('decideAutoAccept') < whAccept);
  assert.match(requested, /INVITE/);
  assert.match(requested, /preferAllowlist|hasAllowlistedSibling/);
});
