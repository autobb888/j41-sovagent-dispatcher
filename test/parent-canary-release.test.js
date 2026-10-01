'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * cli.js exits on Node 18 before any command runs, so this file asserts the
 * parent-release wiring from source. The behaviour of the release itself is
 * in job-agent-teardown-behaviour.test.js.
 */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
// Line comments only. A block-comment stripper treats the "/app/*" note in
// startJobContainer as the start of a comment and deletes the next call.
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');

function sliceFn(name) {
  const start = CODE.indexOf(`async function ${name}(`);
  assert.ok(start !== -1, `${name} must exist`);
  const next = CODE.indexOf('\nasync function ', start + 1);
  return CODE.slice(start, next === -1 ? undefined : next);
}

test('both job starts remember the host canary and keep it on the active job', () => {
  assert.strictEqual((CODE.match(/await rememberJobCanary\(state, agentInfo, job\.id, canaryToken\)/g) || []).length, 2);
  assert.strictEqual((CODE.match(/_canaryToken: canaryToken/g) || []).length, 2);
});

test('docker stop releases the canary only after the container is gone, before the job dir is removed', () => {
  const fn = sliceFn('stopJobContainer');
  const releaseAt = fn.indexOf('if (containerGone) await releaseTrackedCanary(state, active, jobId)');
  const rmAt = fn.indexOf('fs.rmSync(jobDir');
  assert.ok(releaseAt !== -1, 'stopJobContainer must release after a confirmed stop');
  assert.ok(rmAt !== -1 && releaseAt < rmAt, 'release must happen while the job dir still exists');
  assert.ok(fn.indexOf("active.kind === 'gpu-rental'") < releaseAt);
  assert.ok(fn.indexOf('return;') < releaseAt);
});

test('local stop releases the canary only after the process has exited', () => {
  const fn = sliceFn('stopJobLocal');
  const releaseAt = fn.indexOf('if (processGone) await releaseTrackedCanary(state, active, jobId)');
  const rmAt = fn.indexOf('fs.rmSync(jobDir');
  assert.ok(releaseAt !== -1, 'stopJobLocal must release after the process exits');
  assert.ok(rmAt !== -1 && releaseAt < rmAt);
  assert.ok(fn.includes("active.process.kill('SIGKILL')"));
});

test('crash recovery releases the canary only after the orphan container is stopped', () => {
  // killOrphanContainer is nested, so a slice at the next async function stops too early.
  const killAt = CODE.indexOf('await killOrphanContainer(jobId)');
  const releaseAt = CODE.indexOf('await releaseTrackedCanary(state, { agentInfo }, jobId)');
  assert.ok(killAt !== -1 && releaseAt > killAt);
  assert.strictEqual(CODE.indexOf('await releaseTrackedCanary(state, { agentInfo }, jobId)', releaseAt + 1), -1);
});
