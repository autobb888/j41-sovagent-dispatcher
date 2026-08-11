/**
 * M3 — the outbound-money rate limit that did not exist.
 *
 * README §"Financial Allowlists" has promised, since the security section was
 * written: "max 3 sends/job, max value = job price + 10%, max 10 sends/hour, 30s
 * cooldown" and "suspends all sends if API unreachable for 30 min".
 *
 * `checkDispatcherRateLimit` and `recordDispatcherSend` implemented all of that and
 * had ZERO callers. `attemptPendingRefund` — the single place VRSC leaves the host —
 * never consulted either, and `dispatcherFinancialSuspended` was written by the
 * allowlist sweep and read by nobody. Every one of those four guarantees was
 * documentation only.
 *
 * These tests cover the limiter's decisions. The wiring itself (that
 * attemptPendingRefund calls it before markRefundInflight, and records only after a
 * successful broadcast) is asserted in refund-rate-limit-wiring.test.js.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

// Sandbox HOME BEFORE requiring cli.js. The rate limiter is now backed by a file
// under DISPATCHER_DIR, which cli.js resolves from os.homedir() at require time —
// so without this the suite writes to (and truncates) the LIVE dispatcher's
// send-history.json. It did exactly that once before this line existed.
const TEST_HOME = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'j41-ratelimit-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
fs.mkdirSync(nodePath.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });

const {
  checkDispatcherRateLimit,
  recordDispatcherSend,
  _resetDispatcherRateLimit,
  setFinancialSuspended,
  SEND_HISTORY_PATH,
} = require('../src/cli');

const T0 = 1_700_000_000_000; // fixed clock — no wall-clock flake

test('a first refund at the job price is allowed', () => {
  _resetDispatcherRateLimit();
  assert.equal(checkDispatcherRateLimit('job-a', 1.0, 1.0, T0).allowed, true);
});

test('per-job cap: a 4th send is refused and is NOT retryable', () => {
  _resetDispatcherRateLimit();
  // Three tiny sends against a large price so the value ceiling can't be what fires.
  for (let i = 0; i < 3; i++) recordDispatcherSend('job-b', 0.001, T0 + i * 60_000);
  const r = checkDispatcherRateLimit('job-b', 0.001, 100, T0 + 300_000);
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false, 'waiting cannot fix a lifetime cap — a human must look');
  assert.match(r.reason, /Max sends per job/);
});

test('value ceiling: cumulative refunds above price + 10% are refused', () => {
  _resetDispatcherRateLimit();
  recordDispatcherSend('job-c', 1.0, T0);
  // 1.0 already sent, 0.2 more = 1.2 > 1.1 ceiling on a 1.0 job.
  const r = checkDispatcherRateLimit('job-c', 0.2, 1.0, T0 + 120_000);
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false);
  assert.match(r.reason, /exceeds job price/);
});

test('value ceiling: exactly at price + 10% is still allowed', () => {
  _resetDispatcherRateLimit();
  recordDispatcherSend('job-c2', 1.0, T0);
  assert.equal(checkDispatcherRateLimit('job-c2', 0.1, 1.0, T0 + 120_000).allowed, true,
    'the ceiling is inclusive — a boundary refusal would strand a legitimate top-up');
});

test('a missing job price does not silently disable the value ceiling', () => {
  // `undefined * 1.1` is NaN and every `> NaN` is false, so the old expression
  // passed the check for exactly the malformed entries it should have caught.
  _resetDispatcherRateLimit();
  recordDispatcherSend('job-d', 5.0, T0);
  const r = checkDispatcherRateLimit('job-d', 5.0, undefined, T0 + 120_000);
  assert.equal(r.allowed, false, 'a price-less entry must still be bounded');
  assert.match(r.reason, /exceeds job price/);
});

test('a first send with no known price is allowed at its own size', () => {
  // Falling back to the amount itself means one send passes and a second is caught
  // by the per-job cap — bounded without blocking a legitimate crash refund whose
  // orphan record lost its amount.
  _resetDispatcherRateLimit();
  assert.equal(checkDispatcherRateLimit('job-d2', 5.0, undefined, T0).allowed, true);
  assert.equal(checkDispatcherRateLimit('job-d2', 5.0, null, T0).allowed, true);
  assert.equal(checkDispatcherRateLimit('job-d2', 5.0, NaN, T0).allowed, true);
});

test('cooldown: a second send for the same job inside 30s is deferred, not dropped', () => {
  _resetDispatcherRateLimit();
  recordDispatcherSend('job-e', 0.01, T0);
  const soon = checkDispatcherRateLimit('job-e', 0.01, 100, T0 + 10_000);
  assert.equal(soon.allowed, false);
  assert.equal(soon.retryable, true, 'the next drain must retry this');
  assert.match(soon.reason, /Cooldown/);

  assert.equal(checkDispatcherRateLimit('job-e', 0.01, 100, T0 + 31_000).allowed, true,
    'past the cooldown it proceeds');
});

test('hourly cap is fleet-wide across DIFFERENT jobs, and is retryable', () => {
  _resetDispatcherRateLimit();
  for (let i = 0; i < 10; i++) recordDispatcherSend(`job-f${i}`, 0.01, T0 + i * 1000);
  const r = checkDispatcherRateLimit('job-f-new', 0.01, 100, T0 + 20_000);
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, true);
  assert.match(r.reason, /Hourly global limit/);
});

test('the hourly window slides — sends older than an hour stop counting', () => {
  _resetDispatcherRateLimit();
  for (let i = 0; i < 10; i++) recordDispatcherSend(`job-g${i}`, 0.01, T0 + i * 1000);
  assert.equal(checkDispatcherRateLimit('job-g-new', 0.01, 100, T0 + 3_600_001 + 9000).allowed, true);
});

test('an API outage suspends every send, and it is retryable', () => {
  // The allowlist sweep sets this after 30 min of an unreachable platform. It was
  // written and never read, so the documented kill switch did nothing.
  _resetDispatcherRateLimit(true);
  const r = checkDispatcherRateLimit('job-h', 0.01, 100, T0);
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, true, 'the platform coming back must unblock the queue');
  assert.match(r.reason, /suspended/);

  _resetDispatcherRateLimit(false);
  assert.equal(checkDispatcherRateLimit('job-h', 0.01, 100, T0).allowed, true);
});

test('the per-job counter is NOT expired by the hourly prune', () => {
  // The global list is pruned to back the sliding window. If perJob were pruned with
  // it, "max 3 sends per job" would silently become "3 per hour" and a job already
  // paid three times could take a fourth an hour later.
  _resetDispatcherRateLimit();
  for (let i = 0; i < 3; i++) recordDispatcherSend('job-i', 0.001, T0 + i * 1000);
  // Push the global window well past an hour with unrelated traffic.
  recordDispatcherSend('job-unrelated', 0.001, T0 + 7_200_000);
  const r = checkDispatcherRateLimit('job-i', 0.001, 100, T0 + 7_200_000);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Max sends per job/);
});

// ── F6: the limits must be FLEET-WIDE, not per-process ──────────────────────
//
// The first version kept the counters and the suspension flag in process memory.
// The operator's documented workflow is to drive the daemon out-of-band with a
// second CLI process, so "two independent 10/hour budgets" was the normal case.
// Worse, the API-outage suspension is only ever SET by the daemon's sweep, so a
// CLI `refunds approve` sent freely through an outage that had already suspended
// the daemon — the one guarantee whose entire purpose is to stop sending when the
// platform cannot be reached.

const { execFileSync } = require('node:child_process');

/** Run a snippet in a SEPARATE node process against the same sandboxed HOME. */
function inAnotherProcess(js) {
  const cli = nodePath.join(__dirname, '..', 'src', 'cli.js');
  return execFileSync(process.execPath, ['-e', `
    process.env.NODE_ENV = 'test';
    const m = require(${JSON.stringify(cli)});
    ${js}
  `], { encoding: 'utf8', env: { ...process.env, HOME: TEST_HOME, NODE_ENV: 'test' } }).trim();
}

test('a send recorded in one process counts against the cap in another', () => {
  _resetDispatcherRateLimit();
  for (let i = 0; i < 10; i++) recordDispatcherSend(`job-x${i}`, 0.01);

  const verdict = inAnotherProcess(`
    const r = m.checkDispatcherRateLimit('job-fresh', 0.01, 100);
    console.log(JSON.stringify(r));
  `);
  const r = JSON.parse(verdict);
  assert.equal(r.allowed, false, 'a second process must see the first process’s sends');
  assert.match(r.reason, /Hourly global limit/);
});

test('the outage suspension set by the daemon blocks a separate CLI process', () => {
  _resetDispatcherRateLimit(true);

  const verdict = inAnotherProcess(`
    const r = m.checkDispatcherRateLimit('job-any', 0.01, 100);
    console.log(JSON.stringify(r));
  `);
  const r = JSON.parse(verdict);
  assert.equal(r.allowed, false, 'the suspension must reach every process, not just the daemon');
  assert.match(r.reason, /suspended/);
});

test('lifting the suspension in one process unblocks another', () => {
  _resetDispatcherRateLimit(true);
  setFinancialSuspended(false);

  const verdict = inAnotherProcess(`
    console.log(JSON.stringify(m.checkDispatcherRateLimit('job-any2', 0.01, 100)));
  `);
  assert.equal(JSON.parse(verdict).allowed, true);
});

test('the per-job lifetime cap survives a restart', () => {
  // Process-local counters made "max 3 sends per job" mean "3 per process".
  _resetDispatcherRateLimit();
  for (let i = 0; i < 3; i++) recordDispatcherSend('job-persist', 0.001);

  const verdict = inAnotherProcess(`
    console.log(JSON.stringify(m.checkDispatcherRateLimit('job-persist', 0.001, 100)));
  `);
  const r = JSON.parse(verdict);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Max sends per job/);
});

test('a corrupt history file fails OPEN, not closed', () => {
  // This file bounds damage; it does not authorise anything. Refusing to send on an
  // unreadable counter would strand every owed refund behind a one-byte corruption.
  const fs = require('node:fs');
  _resetDispatcherRateLimit();
  fs.writeFileSync(SEND_HISTORY_PATH, '{not json');
  assert.equal(checkDispatcherRateLimit('job-corrupt', 0.01, 100).allowed, true);
});
