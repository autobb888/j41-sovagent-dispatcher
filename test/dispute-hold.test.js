'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const { planDisputeHold, jobTimeoutWarningDue } = require('../src/job-agent.js');

const HOUR = 60 * 60 * 1000;
const MAX = 6 * HOUR;
const GRACE = 30 * 60 * 1000;

test('a worker that starts already disputed holds for the deadline', () => {
  const now = 1_000_000;
  const deadline = new Date(now + 2 * HOUR).toISOString();
  const plan = planDisputeHold({
    deadlineIso: deadline,
    now,
    currentSafetyMs: 0,
    maxMs: MAX,
    graceMs: GRACE,
  });
  assert.equal(plan.safetyMs, 2 * HOUR + GRACE);
  assert.equal(plan.holdUntilMs, now + plan.safetyMs);
});

test('a missing deadline uses the cap and a shorter window is not cut', () => {
  const now = 5_000;
  const capped = planDisputeHold({ deadlineIso: null, now, currentSafetyMs: 0, maxMs: MAX, graceMs: GRACE });
  assert.equal(capped.safetyMs, MAX);
  const shorter = planDisputeHold({
    deadlineIso: new Date(now + 10 * 60 * 1000).toISOString(),
    now,
    currentSafetyMs: 90 * 60 * 1000,
    maxMs: MAX,
    graceMs: GRACE,
  });
  assert.equal(shorter, null);
});

test('the hour warning stands down while a dispute hold is armed', () => {
  const now = 50_000;
  assert.equal(jobTimeoutWarningDue(now, now + HOUR), false);
  assert.equal(jobTimeoutWarningDue(now, now), true);
  assert.equal(jobTimeoutWarningDue(now, 0), true);
});
