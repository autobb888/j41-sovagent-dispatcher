'use strict';
/**
 * Back off when the platform is down.
 *
 * Round-3 "also observed", never fixed until now. The 2026-07-31 fleet-wide
 * `503 CHAIN_SYNCING` outage produced ~908 auth failures: getAgentSession does
 * not cache a failed session, so every caller re-authenticated every cycle at
 * ~43 calls/min for 46 minutes, and the platform answered with 429. We turned
 * their degradation into our rate-limit ban, and the 429 outlasted the 503.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRetryableAuthFailure, retryAfterMs, recordAuthFailure, shouldAttemptAuth,
  clearAuthFailure, summarizeAuthBackoff, BASE_DELAY_MS, MAX_DELAY_MS,
} = require('../src/auth-backoff.js');

const mid = () => 0.5; // deterministic jitter: exactly the capped delay

test('waits only for failures that end by themselves', () => {
  for (const e of [
    Object.assign(new Error('x'), { statusCode: 503 }),
    Object.assign(new Error('x'), { statusCode: 502 }),
    Object.assign(new Error('x'), { statusCode: 429 }),
    Object.assign(new Error('x'), { code: 'CHAIN_SYNCING' }),
    new Error('503 CHAIN_SYNCING — try again shortly'),
    new Error('socket hang up'),
  ]) assert.equal(isRetryableAuthFailure(e), true, e.message);
});

test('does NOT wait for a failure that waiting cannot fix', () => {
  // Backing off on a bad key would hide a misconfiguration behind a slow retry
  // loop — the silent-failure pattern this codebase keeps getting bitten by.
  for (const e of [
    Object.assign(new Error('unauthorized'), { statusCode: 401 }),
    Object.assign(new Error('forbidden'), { statusCode: 403 }),
    Object.assign(new Error('bad identity'), { statusCode: 400 }),
    new Error('identity not registered'),
    null, undefined,
  ]) assert.equal(isRetryableAuthFailure(e), false, String(e && e.message));
});

test('a non-retryable failure is recorded but never delays the next attempt', () => {
  const rec = recordAuthFailure(null, Object.assign(new Error('nope'), { statusCode: 401 }), { now: 1000 });
  assert.equal(rec.retryable, false);
  assert.equal(rec.until, 0);
  assert.equal(shouldAttemptAuth(rec, 1000).attempt, true, 'a wrong WIF must fail loudly every cycle');
});

test('delay grows exponentially and then stops at the cap', () => {
  let rec = null;
  const err = Object.assign(new Error('down'), { statusCode: 503 });
  const seen = [];
  for (let i = 0; i < 12; i++) {
    rec = recordAuthFailure(rec, err, { now: 0, rand: mid });
    seen.push(rec.delayMs);
  }
  assert.equal(seen[0], BASE_DELAY_MS, 'first wait is the base delay');
  assert.ok(seen[1] > seen[0] && seen[2] > seen[1], 'it must grow');
  assert.equal(seen[seen.length - 1], MAX_DELAY_MS, 'and then stop growing');
  assert.ok(seen.every((d) => d <= MAX_DELAY_MS), 'nothing may exceed the cap');
});

test('the cap keeps recovery under 5 minutes across a 50-minute outage', () => {
  // The real constraint. An uncapped exponential would still be asleep an hour
  // after the platform came back; the daily window is ~50 minutes.
  let rec = null;
  const err = Object.assign(new Error('down'), { statusCode: 503 });
  let t = 0, attempts = 0;
  const OUTAGE = 50 * 60 * 1000;
  while (t < OUTAGE) {
    rec = recordAuthFailure(rec, err, { now: t, rand: mid });
    t = rec.until;
    attempts++;
    assert.ok(attempts < 100, 'must not spin');
  }
  assert.ok(attempts >= 8 && attempts <= 20,
    `expected ~10 probes across the outage, got ${attempts}`);
  assert.ok(rec.delayMs <= MAX_DELAY_MS,
    'and the fleet is never idle longer than the cap after recovery');
});

test('jitter spreads the fleet so it cannot retry in lockstep', () => {
  // Without this, every agent fails at the same instant and retries at the same
  // instant — the same burst that earned the 429, just less often.
  const err = Object.assign(new Error('down'), { statusCode: 503 });
  const delays = new Set();
  for (let i = 0; i < 50; i++) {
    delays.add(recordAuthFailure({ failures: 5 }, err, { now: 0, rand: Math.random }).delayMs);
  }
  assert.ok(delays.size > 20, `jitter produced only ${delays.size} distinct delays`);
});

test('a server Retry-After is obeyed, and clamped', () => {
  const with_ = (v) => recordAuthFailure(null, Object.assign(new Error('x'), { statusCode: 429, retryAfter: v }), { now: 0, rand: mid });
  assert.equal(with_(30).delayMs, 30000, 'arguing with an explicit Retry-After is how you get banned');
  assert.equal(with_(99999).delayMs, MAX_DELAY_MS, 'but a hostile header cannot park the fleet');
  assert.equal(retryAfterMs({ headers: { 'retry-after': '12' } }), 12000, 'header form too');
  assert.equal(retryAfterMs({}), null);
  assert.equal(retryAfterMs({ retryAfter: 'soon' }), null);
});

test('the gate fails OPEN on a malformed record', () => {
  // A bug in the bookkeeping must never park the fleet permanently. One wasted
  // request is recoverable; a dispatcher that silently stops is not.
  for (const bad of [null, undefined, {}, 'nope', 42, { until: NaN }, { until: 'later' }, { until: -1 }]) {
    assert.equal(shouldAttemptAuth(bad, 1000).attempt, true, `record ${JSON.stringify(bad)} must not block`);
  }
  assert.equal(shouldAttemptAuth({ until: 5000 }, NaN).attempt, true, 'a bad clock must not block either');
});

test('the gate blocks inside the window and releases exactly at it', () => {
  const rec = { failures: 1, until: 10_000, retryable: true };
  assert.equal(shouldAttemptAuth(rec, 9_999).attempt, false);
  assert.equal(shouldAttemptAuth(rec, 9_999).waitMs, 1);
  assert.equal(shouldAttemptAuth(rec, 10_000).attempt, true, 'released at the boundary, not after it');
});

test('success clears the record, so the next outage starts from the base delay', () => {
  const map = new Map();
  map.set('agent-1', recordAuthFailure(null, Object.assign(new Error('x'), { statusCode: 503 }), { now: 0, rand: mid }));
  assert.equal(shouldAttemptAuth(map.get('agent-1'), 0).attempt, false);
  clearAuthFailure(map, 'agent-1');
  assert.equal(map.has('agent-1'), false);
  assert.equal(shouldAttemptAuth(map.get('agent-1'), 0).attempt, true);
});

test('waiting agents are visible, because an outage must not look like a hang', () => {
  const err = Object.assign(new Error('CHAIN_SYNCING'), { statusCode: 503 });
  const map = new Map();
  map.set('agent-1', recordAuthFailure(null, err, { now: 0, rand: mid }));
  map.set('agent-2', recordAuthFailure(null, err, { now: 0, rand: mid }));
  map.set('agent-3', { failures: 2, until: 0, retryable: false });   // not waiting

  const s = summarizeAuthBackoff(map, 100);
  assert.equal(s.waiting, 2);
  assert.equal(s.agents.length, 2);
  assert.ok(s.agents[0].retryInMs > 0);
  assert.match(s.agents[0].lastError, /CHAIN_SYNCING/, 'and it must say why');
  assert.deepEqual(summarizeAuthBackoff(null, 0), { waiting: 0, agents: [] });
  assert.deepEqual(summarizeAuthBackoff({}, 0), { waiting: 0, agents: [] });
});

test('never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, 0, '', 'x', {}, [], NaN, Symbol('s')]) {
    assert.doesNotThrow(() => isRetryableAuthFailure(junk));
    assert.doesNotThrow(() => recordAuthFailure(junk, junk, { now: junk }));
    assert.doesNotThrow(() => shouldAttemptAuth(junk, junk));
    assert.doesNotThrow(() => summarizeAuthBackoff(junk, junk));
  }
});
