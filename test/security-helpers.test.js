'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { liveLogPath, archiveLogPath } = require('../src/job-log.js');
test('liveLogPath builds JOBS_DIR/_live/<id>.log', () => {
  assert.equal(liveLogPath('/j/jobs', 'abc'), '/j/jobs/_live/abc.log');
});
test('archiveLogPath builds JOBS_DIR/_logs/<id>.log', () => {
  assert.equal(archiveLogPath('/j/jobs', 'abc'), '/j/jobs/_logs/abc.log');
});

// ── M3: fallback token budget scales with payment amount ────────────────────
const {
  initialTokenBudget,
  MIN_TOKEN_BUDGET,
  DEFAULT_FALLBACK_TOKEN_BUDGET,
} = require('../src/token-budget.js');

// No-rate env: stamp is missing so getVrscUsdRate returns null → fallback path.
const NO_RATE_ENV = {};

test('M3: tiny amountVrsc gets fewer fallback tokens than large amountVrsc', () => {
  const tiny  = initialTokenBudget({ model: 'claude-sonnet-4-6', amountVrsc: 0.001  }, NO_RATE_ENV);
  const large = initialTokenBudget({ model: 'claude-sonnet-4-6', amountVrsc: 1.0    }, NO_RATE_ENV);
  assert.equal(tiny.basis,  'fallback:no-rate', 'tiny job should use fallback path');
  assert.equal(large.basis, 'fallback:no-rate', 'large job should use fallback path');
  assert.ok(
    tiny.tokens < large.tokens,
    `tiny (${tiny.tokens}) should be < large (${large.tokens}) — fallback must scale with payment`
  );
});

test('M3: fallback tokens never fall below MIN_TOKEN_BUDGET', () => {
  const result = initialTokenBudget({ model: 'claude-sonnet-4-6', amountVrsc: 0.000001 }, NO_RATE_ENV);
  assert.equal(result.basis, 'fallback:no-rate');
  assert.ok(result.tokens >= MIN_TOKEN_BUDGET, `tokens (${result.tokens}) must be >= MIN_TOKEN_BUDGET (${MIN_TOKEN_BUDGET})`);
});

test('M3: amountVrsc at or above FALLBACK_MIN_VRSC gets full DEFAULT_FALLBACK_TOKEN_BUDGET', () => {
  // 0.01 is FALLBACK_MIN_VRSC — at the floor, grant the full budget.
  const result = initialTokenBudget({ model: 'claude-sonnet-4-6', amountVrsc: 0.01 }, NO_RATE_ENV);
  assert.equal(result.basis, 'fallback:no-rate');
  assert.equal(result.tokens, DEFAULT_FALLBACK_TOKEN_BUDGET);
});

// ── M4: shouldRefundOrphan predicate ────────────────────────────────────────
const { shouldRefundOrphan, FINISHED_STATUSES } = require('../src/refund.js');
test('shouldRefundOrphan: terminal states are not refunded', () => {
  for (const s of ['completed','resolved','resolved_rejected','cancelled','delivered'])
    assert.equal(shouldRefundOrphan({ status: s }), false);
});
test('shouldRefundOrphan: non-terminal states are refunded', () => {
  assert.equal(shouldRefundOrphan({ status: 'in_progress' }), true);
  assert.equal(shouldRefundOrphan({ status: 'accepted' }), true);
});
test('shouldRefundOrphan: missing/malformed job not refunded', () => {
  assert.equal(shouldRefundOrphan(null), false);
  assert.equal(shouldRefundOrphan({}), false);
});

// ── isPrivateIp — IPv6 loopback + private address coverage ──────────────────
const { isPrivateIp } = require('../src/proxy-handler.js');
for (const ip of [
  '::1',
  '0:0:0:0:0:0:0:1',
  '0::1',
  '::ffff:7f00:1',
  '::ffff:127.0.0.1',
  '127.0.0.1',
  '169.254.169.254',
  '10.0.0.1',
  '192.168.1.1',
]) {
  test(`isPrivateIp blocks ${ip}`, () => assert.equal(isPrivateIp(ip), true));
}
for (const ip of ['1.1.1.1', '8.8.8.8']) {
  test(`isPrivateIp allows ${ip}`, () => assert.equal(isPrivateIp(ip), false));
}
