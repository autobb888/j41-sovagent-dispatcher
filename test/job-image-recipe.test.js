'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('the job image copies the modules the worker loads at startup', () => {
  const root = path.join(__dirname, '..');
  const docker = fs.readFileSync(path.join(root, 'Dockerfile.job-agent'), 'utf8');
  const build = fs.readFileSync(path.join(root, 'scripts/build-image.sh'), 'utf8');
  for (const name of ['chat-outbox.js', 'job-id.js']) {
    assert.match(docker, new RegExp(`COPY src/${name.replace('.', '\\.')} \\./`));
    assert.match(build, new RegExp(`src/${name.replace('.', '\\.')}`));
    assert.equal(fs.existsSync(path.join(root, 'src', name)), true);
  }
  const worker = fs.readFileSync(path.join(root, 'src/job-agent.js'), 'utf8');
  assert.match(worker, /require\('\.\/chat-outbox'\)/);
  const outbox = fs.readFileSync(path.join(root, 'src/chat-outbox.js'), 'utf8');
  const teardown = fs.readFileSync(path.join(root, 'src/job-agent-teardown.js'), 'utf8');
  assert.match(outbox, /require\('\.\/job-id'\)/);
  assert.match(teardown, /require\('\.\/job-id'\)/);
});
