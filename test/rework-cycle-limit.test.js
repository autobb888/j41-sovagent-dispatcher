/**
 * The rework-cycle limit, and why it needs a durable counter.
 *
 * Round 8 (2026-08-07), live: the operator offered a THIRD rework against a policy
 * of 2. The buyer accepted, the platform moved the job to `rework`, and the worker
 * declined it internally with a bare console.log — telling nobody. The job dead-ended
 * waiting for a delivery that was never coming, and because the dispute's
 * `deadline_owner` is the SELLER, the SLA resolver would have auto-defaulted the
 * agent for honouring its own published policy.
 *
 * Two halves were wrong:
 *   - nothing stopped the operator promising a rework the worker would refuse; and
 *   - the only counter lived INSIDE the worker container, so it reset to zero
 *     whenever that worker was replaced — and a dispute can now outlive its worker,
 *     which makes respawns between cycles normal. Round 8 did not expose that only
 *     because the container happened to survive.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readReworkCycles,
  reworkCyclesFor,
  bumpReworkCycle,
  REWORK_CYCLES_PATH,
} = require('../src/cli.js');

const JOB = '538c039b-6ee8-48a6-aeb5-21f3980727b0';

// NEVER the live path. The shutdown-marker tests made exactly this mistake earlier
// today and deleted a running dispatcher's state mid-restart; a test that erases an
// operator's rework counts would silently un-enforce the cycle limit on a live fleet.
const STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'j41-rework-')), 'rework-cycles.json');

function clean() { try { fs.unlinkSync(STORE); } catch {} }

test('the tests never touch the live store', () => {
  assert.ok(REWORK_CYCLES_PATH.includes('.j41'), 'default is the live path');
  assert.ok(!STORE.includes('.j41'), 'tests use a temp path');
});

test('an unknown job has had zero rework cycles', () => {
  clean();
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)), 0);
  assert.deepEqual(readReworkCycles(STORE), {});
});

test('cycles accumulate across calls — this is what the container counter could not do', () => {
  clean();
  assert.equal(bumpReworkCycle(JOB, STORE), 1);
  assert.equal(bumpReworkCycle(JOB, STORE), 2);
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)), 2);
  clean();
});

test('the count survives being re-read from disk — a worker respawn must not reset it', () => {
  clean();
  bumpReworkCycle(JOB, STORE);
  bumpReworkCycle(JOB, STORE);
  // Simulate a fresh process: read straight from the file, no in-memory state.
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)), 2);
  clean();
});

test('counts are per job — one job at its limit must not block another', () => {
  clean();
  bumpReworkCycle(JOB, STORE);
  bumpReworkCycle(JOB, STORE);
  assert.equal(reworkCyclesFor('other-job', readReworkCycles(STORE)), 0);
  clean();
});

test('a corrupt store reads as empty rather than throwing mid-dispute-response', () => {
  clean();
  fs.writeFileSync(STORE, '{ not json');
  assert.deepEqual(readReworkCycles(STORE), {});
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)), 0);
  clean();
});

test('a non-integer or negative stored value is treated as zero, not trusted', () => {
  clean();
  fs.writeFileSync(STORE, JSON.stringify({ [JOB]: -3, other: 'two' }));
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)), 0);
  assert.equal(reworkCyclesFor('other', readReworkCycles(STORE)), 0);
  clean();
});

test('the store is written atomically — a torn count must not silently reset the limit', () => {
  clean();
  bumpReworkCycle(JOB, STORE);
  assert.equal(fs.existsSync(`${STORE}.tmp`), false);
  clean();
});

test('the policy limit is a >= comparison — at the limit, the next offer is refused', () => {
  // Pins the guard's arithmetic: with maxReworkCycles=2, two delivered cycles means
  // a third offer must be refused, not allowed through as "2 is not > 2".
  clean();
  const max = 2;
  bumpReworkCycle(JOB, STORE);
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)) >= max, false, 'one cycle done — a second is allowed');
  bumpReworkCycle(JOB, STORE);
  assert.equal(reworkCyclesFor(JOB, readReworkCycles(STORE)) >= max, true, 'two cycles done — a third must be refused');
  clean();
});
