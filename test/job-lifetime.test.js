'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  jobTimeoutStillOwns,
  assignJobTimeout,
  clearJobTimeout,
  shouldReviveStrandedJob,
  MAX_STRANDED_REVIVES,
} = require('../src/job-lifetime');

const S2 = '85c060c2-e785-43da-97ff-a0bed0038ccf';

function seenWith(id) {
  return new Map([[id, Date.now()]]);
}

function stranded(over = {}) {
  return {
    id: S2,
    status: 'in_progress',
    delivery: null,
    serviceType: null,
    ...over,
  };
}

test('a timer owns only the container it was stored on', () => {
  const first = {};
  const timer = setTimeout(() => {}, 60_000);
  timer.unref();
  assert.equal(assignJobTimeout(first, timer, 1), true);
  assert.equal(jobTimeoutStillOwns(first, 1), true);
  assert.equal(jobTimeoutStillOwns(first, 2), false);
  clearJobTimeout(first);
  assert.equal(first._timeoutTimer, null);
  assert.equal(jobTimeoutStillOwns(first, 1), false);

  const resumed = {};
  const later = setTimeout(() => {}, 60_000);
  later.unref();
  assignJobTimeout(resumed, later, 2);
  assert.equal(jobTimeoutStillOwns(resumed, 1), false);
  assert.equal(jobTimeoutStillOwns(resumed, 2), true);
  assert.equal(jobTimeoutStillOwns(null, 2), false);
  clearJobTimeout(resumed);
});

test('a dropped entry does not keep an unstored timer', () => {
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 20);
  timer.unref();
  assert.equal(assignJobTimeout(null, timer, 1), false);
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(fired, false);
      resolve();
    }, 40);
  });
});

test('a paid in-progress job with no worker and no delivery is started again', () => {
  const verdict = shouldReviveStrandedJob(stranded(), {
    seen: seenWith(S2),
    active: new Map(),
    inQueue: false,
    inReactivation: false,
    attempts: 0,
  });
  assert.equal(verdict.revive, true);
});

test('a paused job, a live worker, a delivery, and a closed status stay put', () => {
  const base = { seen: seenWith(S2), active: new Map(), inQueue: false, inReactivation: false, attempts: 0 };
  assert.equal(shouldReviveStrandedJob(stranded(), { ...base, inReactivation: true }).revive, false);
  assert.equal(shouldReviveStrandedJob(stranded(), { ...base, active: new Map([[S2, {}]]) }).why, 'worker is live');
  assert.equal(shouldReviveStrandedJob(stranded(), { ...base, inQueue: true }).why, 'waiting in the start queue');
  assert.equal(shouldReviveStrandedJob(stranded({ delivery: { hash: 'abc' } }), base).why, 'already delivered');
  assert.equal(shouldReviveStrandedJob(stranded({ status: 'delivered' }), base).revive, false);
  assert.equal(shouldReviveStrandedJob(stranded({ status: 'disputed' }), base).revive, false);
  assert.equal(shouldReviveStrandedJob(stranded({ status: 'paused' }), base).revive, false);
  assert.equal(shouldReviveStrandedJob(stranded({ serviceType: 'gpu-rental' }), base).why, 'not a labour job');
  assert.equal(shouldReviveStrandedJob(stranded({ serviceType: 'dataset' }), base).revive, false);
  assert.equal(shouldReviveStrandedJob(stranded(), { ...base, seen: new Map() }).why, 'not seen');
});

test('three starts is the cap, and a row with no delivery field asks for the full job', () => {
  const base = { seen: seenWith(S2), active: new Map(), inQueue: false, inReactivation: false };
  const capped = shouldReviveStrandedJob(stranded(), { ...base, attempts: MAX_STRANDED_REVIVES });
  assert.equal(capped.revive, false);
  assert.match(capped.why, /revive cap 3/);
  const thin = { id: S2, status: 'in_progress' };
  const confirm = shouldReviveStrandedJob(thin, { ...base, attempts: 0 });
  assert.equal(confirm.revive, false);
  assert.equal(confirm.confirm, true);
});

test('the parent clears the timer on pause and will not kill across a resume', () => {
  const parent = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(parent, /clearJobTimeout\(info\)/);
  assert.ok((parent.match(/jobTimeoutStillOwns/g) || []).length >= 2);
  assert.ok((parent.match(/assignJobTimeout/g) || []).length >= 2);
  assert.match(parent, /async function openStrandedInProgress/);
  assert.match(parent, /revivedStrandedThisPoll/);
});
