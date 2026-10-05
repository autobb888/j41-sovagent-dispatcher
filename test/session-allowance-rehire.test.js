'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-session-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;

const {
  sessionReserveDecision,
  createSessionIfAbsent,
  closeSession,
  reserveForChat,
  settleSession,
  releaseStartupReservations,
  readSession,
  sessionErrorBody,
  estimateCostSats,
  assertSessionJobId,
  sessionFilePath,
  sessionLockPath,
} = require('../src/session-allowance');
const { satsOf } = require('../src/dataset-price');
const { assertPaysListing, serviceAmountCeiling } = require('../src/listing-price');
const { assertExtendOpen } = require('../src/buyer-extend');
const { acquireFileLockSync, releaseFileLock } = require('../src/file-lock');

const AGENT = 'seller-window';
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const JOB_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const JOB_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function openPaid(agentId, jobId, amountSats, estimate) {
  const created = createSessionIfAbsent({ agentId, jobId });
  assert.equal(created.ok, true);
  return reserveForChat({
    agentId,
    jobId,
    status: 'in_progress',
    jobAmountSats: amountSats,
    estimatedCostSats: estimate,
    paymentReady: true,
  });
}

test('a closed window is not spendable and the next hire starts at its own payment', () => {
  const meterDir = path.join(TEST_HOME, '.j41', 'dispatcher', 'agents', AGENT);
  fs.mkdirSync(meterDir, { recursive: true });
  fs.writeFileSync(path.join(meterDir, 'credit-meters.json'), JSON.stringify({
    buyers: { buyer: { balance: 5 } },
  }));
  const p1 = satsOf('0.20400000').sats;
  const first = openPaid(AGENT, JOB_A, p1, 1000);
  assert.equal(first.ok, true);
  settleSession({
    agentId: AGENT, jobId: JOB_A, estimatedCostSats: 1000, actualSats: 1000, jobAmountSats: p1,
  });
  const closed = closeSession({ agentId: AGENT, jobId: JOB_A });
  assert.equal(closed.session.closed, true);
  const again = sessionReserveDecision({
    jobAmountSats: p1,
    spentSats: closed.session.spentSats,
    reservedSats: 0,
    estimatedCostSats: 1000,
    status: 'completed',
    closed: true,
  });
  assert.equal(again.code, 'SESSION_CLOSED');
  assert.equal(again.remainingSats, undefined);

  const p2 = satsOf('0.05000000').sats;
  const second = openPaid(AGENT, JOB_B, p2, 1000);
  assert.equal(second.ok, true);
  assert.equal(readSession(AGENT, JOB_B).spentSats, 0);
  assert.equal(second.remainingSats, p2 - 1000);
  assert.ok(second.remainingSats < p2);
  const src = fs.readFileSync(require.resolve('../src/session-allowance.js'), 'utf8');
  assert.doesNotMatch(src, /credit-meters/);
  const mode = fs.statSync(sessionFilePath(AGENT, JOB_B)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('reserve refuses while remaining is still positive, and settle does not clamp', () => {
  const amount = 5000;
  const held = openPaid(AGENT, JOB_C, amount, 2000);
  assert.equal(held.ok, true);
  const short = reserveForChat({
    agentId: AGENT, jobId: JOB_C, status: 'in_progress',
    jobAmountSats: amount, estimatedCostSats: 4000, paymentReady: true,
  });
  assert.equal(short.code, 'SESSION_EXHAUSTED');
  assert.ok(short.remainingSats > 0);
  const settled = settleSession({
    agentId: AGENT, jobId: JOB_C, estimatedCostSats: 2000, actualSats: 9000, jobAmountSats: amount,
  });
  assert.equal(settled.session.spentSats, 9000);
  assert.equal(settled.session.reservedSats, 0);
  const next = reserveForChat({
    agentId: AGENT, jobId: JOB_C, status: 'in_progress',
    jobAmountSats: amount, estimatedCostSats: 1, paymentReady: true,
  });
  assert.equal(next.code, 'SESSION_EXHAUSTED');
});

test('a second create does not zero a reservation, and close survives a later settle', () => {
  const amount = satsOf('0.01000000').sats;
  const first = openPaid(AGENT, JOB_D, amount, 1000);
  assert.equal(first.session.reservedSats, 1000);
  const again = createSessionIfAbsent({ agentId: AGENT, jobId: JOB_D });
  assert.equal(again.created, false);
  assert.equal(again.session.reservedSats, 1000);
  const closed = closeSession({ agentId: AGENT, jobId: JOB_D });
  assert.equal(closed.session.closed, true);
  const settled = settleSession({
    agentId: AGENT, jobId: JOB_D, estimatedCostSats: 1000, actualSats: 250, jobAmountSats: amount,
  });
  assert.equal(settled.session.closed, true);
  assert.equal(settled.session.spentSats, 250);
});

test('startup release returns the reservation to the same job', () => {
  const amount = satsOf('0.02000000').sats;
  const held = openPaid(AGENT, JOB_E, amount, 4000);
  assert.equal(held.session.reservedSats, 4000);
  const released = releaseStartupReservations(AGENT);
  assert.equal(released.ok, true);
  assert.equal(readSession(AGENT, JOB_E).reservedSats, 0);
  assert.equal(readSession(AGENT, JOB_E).spentSats, 0);
  const next = reserveForChat({
    agentId: AGENT, jobId: JOB_E, status: 'in_progress',
    jobAmountSats: amount, estimatedCostSats: 4000, paymentReady: true,
  });
  assert.equal(next.ok, true);
  assert.equal(next.remainingSats, amount - 4000);
});

test('disputed does not create a session, rework without a file does not grant, resolved tombstones', () => {
  const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const disputed = reserveForChat({
    agentId: AGENT, jobId: missing, status: 'disputed',
    jobAmountSats: 100000, estimatedCostSats: 1, paymentReady: true,
  });
  assert.equal(disputed.code, 'SESSION_NOT_OPEN');
  assert.equal(fs.existsSync(sessionFilePath(AGENT, missing)), false);

  const reworkId = '11111111-1111-4111-8111-111111111111';
  const rework = reserveForChat({
    agentId: AGENT, jobId: reworkId, status: 'rework',
    jobAmountSats: 100000, estimatedCostSats: 1, paymentReady: true,
  });
  assert.equal(rework.code, 'SESSION_STATE_MISSING');
  assert.equal(fs.existsSync(sessionFilePath(AGENT, reworkId)), false);
  const reworkBody = sessionErrorBody({ code: 'SESSION_EXHAUSTED', status: 'rework', jobId: reworkId });
  assert.equal(reworkBody.code, 'SESSION_EXHAUSTED');
  assert.doesNotMatch(JSON.stringify(reworkBody), /extend/i);
  const openBody = sessionErrorBody({ code: 'SESSION_EXHAUSTED', status: 'in_progress', jobId: reworkId });
  assert.match(openBody.message, /Extend/);
  assert.equal(assertExtendOpen({ id: reworkId, status: 'rework' }).code, 'EXTEND_NOT_OPEN');

  const resolvedId = '22222222-2222-4222-8222-222222222222';
  assert.equal(createSessionIfAbsent({ agentId: AGENT, jobId: resolvedId }).ok, true);
  const tomb = reserveForChat({
    agentId: AGENT, jobId: resolvedId, status: 'resolved',
    jobAmountSats: 100000, estimatedCostSats: 1, paymentReady: true,
  });
  assert.equal(tomb.code, 'SESSION_CLOSED');
  assert.equal(readSession(AGENT, resolvedId).closed, true);

  const rejectedId = '33333333-3333-4333-8333-333333333333';
  assert.equal(createSessionIfAbsent({ agentId: AGENT, jobId: rejectedId }).ok, true);
  const rej = reserveForChat({
    agentId: AGENT, jobId: rejectedId, status: 'resolved_rejected',
    jobAmountSats: 100000, estimatedCostSats: 1, paymentReady: true,
  });
  assert.equal(rej.code, 'SESSION_CLOSED');
  assert.equal(readSession(AGENT, rejectedId).closed, true);
});

test('a held sessions.lock refuses the create and does not write', () => {
  const agentId = 'seller-lock';
  const jobId = '44444444-4444-4444-8444-444444444444';
  fs.mkdirSync(path.dirname(sessionLockPath(agentId)), { recursive: true });
  const token = acquireFileLockSync(sessionLockPath(agentId));
  assert.ok(token);
  try {
    const busy = createSessionIfAbsent({ agentId, jobId });
    assert.equal(busy.code, 'SESSION_LOCK_BUSY');
    assert.equal(fs.existsSync(sessionFilePath(agentId, jobId)), false);
  } finally {
    releaseFileLock(sessionLockPath(agentId), token);
  }
});

test('a zero token rate does not reserve and a bad job id does not join a path', () => {
  const zero = estimateCostSats({
    modelPricing: [{ model: 'm', inputTokenRate: 0, outputTokenRate: 0.1 }],
    model: 'm',
    inputTokens: 10,
    outputTokens: 10,
  });
  assert.equal(zero.code, 'SESSION_UNPRICED');
  assert.equal(assertSessionJobId('../etc/passwd').code, 'SESSION_JOB_ID');
  const bad = reserveForChat({
    agentId: AGENT, jobId: '../etc/passwd', status: 'in_progress',
    jobAmountSats: 100000, estimatedCostSats: 1, paymentReady: true,
  });
  assert.equal(bad.code, 'SESSION_JOB_ID');
  assert.equal(assertPaysListing({ serviceType: 'api-endpoint', amount: '0.001', listedPrice: 0 }).code, 'MODEL_PRICE_UNSET');
  assert.equal(assertPaysListing({ serviceType: 'api-endpoint', amount: '0.0005', listedPrice: '0.001' }).code, 'LISTING_PRICE');
  assert.equal(assertPaysListing({ serviceType: 'api-endpoint', listedPrice: '0.001' }).code, 'BAD_AMOUNT');
  assert.equal(serviceAmountCeiling(0.001, 0).ceiling, 0.01);
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /AMOUNT_EXCEEDS_SERVICE_PRICE/);
  assert.match(cli, /closeOwnedModelSession\(state, agentInfo, jobId, \['resolved', 'resolved_rejected'\]\)/);
  assert.match(cli, /job\.status !== 'resolved' && job\.status !== 'resolved_rejected'/);
});
