'use strict';
// A second GPU hire is a new listing period. Unused minutes of the first
// rental are not added, and a completed rental cannot be extended.
const test = require('node:test');
const assert = require('node:assert/strict');

const { acquireRentalLease, formatRentalDeliverable, rentalExtensionGrant } = require('../src/rental-job');
const { YANK_RENTAL_STATUSES } = require('../src/rental-worker');
const { assertExtendOpen, LABOUR_OPEN, GPU_OPEN } = require('../src/buyer-extend');

const PERIOD_MIN = 240;
const PERIOD_PRICE = 0.001;

function provider() {
  return {
    get capabilities() { return { canSsh: true, canProvision: true, canScaleToZero: true, isElastic: false }; },
    async discover() { return [{ provider: 'home-gpu', usdPerHour: 0, meta: {} }]; },
    async waitReady(lease) {
      return { ...lease, state: 'ready', ssh: { host: 'gpu.example.com', port: 2222, user: 'renter', password: 'secretpw' } };
    },
  };
}

function controller() {
  return {
    async acquireUnderCeiling() { return { id: 'box-1', state: 'pending' }; },
    recordLease(lease) { return lease; },
    async releaseLease() {},
  };
}

test('a second rental starts a full period from its own payment', async () => {
  const firstNow = 1_000_000;
  const first = await acquireRentalLease({
    controller: controller(),
    provider: provider(),
    jobId: '11111111-1111-1111-1111-111111111111',
    agentId: 'gpu-1',
    jobTimeoutMin: PERIOD_MIN,
    periodAmount: PERIOD_PRICE,
    now: firstNow,
  });
  const secondNow = firstNow + 60 * 60000;
  const second = await acquireRentalLease({
    controller: controller(),
    provider: provider(),
    jobId: '22222222-2222-2222-2222-222222222222',
    agentId: 'gpu-1',
    jobTimeoutMin: PERIOD_MIN,
    periodAmount: PERIOD_PRICE,
    now: secondNow,
  });
  assert.equal(first.lease.expiresAt, firstNow + PERIOD_MIN * 60000);
  assert.equal(second.lease.expiresAt, secondNow + PERIOD_MIN * 60000);
  assert.notEqual(second.lease.expiresAt, first.lease.expiresAt - (secondNow - firstNow));
  const fresh = rentalExtensionGrant({ amount: PERIOD_PRICE, periodAmount: PERIOD_PRICE, periodMin: PERIOD_MIN });
  const again = rentalExtensionGrant({ amount: PERIOD_PRICE, periodAmount: PERIOD_PRICE, periodMin: PERIOD_MIN });
  assert.equal(fresh.minutes, PERIOD_MIN);
  assert.equal(again.minutes, fresh.minutes);
  assert.equal(again.minutes, PERIOD_MIN);
  assert.match(first.deliverable.disclosure, /there is no pro-rata refund for unused time/);
  assert.match(formatRentalDeliverable(second.lease, { jobTimeoutMin: PERIOD_MIN }).disclosure, /there is no pro-rata refund for unused time/);
  assert.ok(YANK_RENTAL_STATUSES.includes('completed'));
});

test('extend stays inside the open window', () => {
  assert.deepEqual([...LABOUR_OPEN].sort(), ['in_progress', 'paused']);
  assert.equal(assertExtendOpen({ id: 'a', status: 'in_progress' }).ok, true);
  assert.equal(assertExtendOpen({ id: 'a', status: 'paused' }).ok, true);
  assert.equal(assertExtendOpen({ id: 'a', status: 'completed' }).code, 'EXTEND_NOT_OPEN');
  assert.equal(assertExtendOpen({ id: 'a', status: 'rework' }).code, 'EXTEND_NOT_OPEN');
  assert.equal(assertExtendOpen({ id: 'g', status: 'delivered', serviceType: 'gpu-rental' }).ok, true);
  assert.equal(assertExtendOpen({ id: 'g', status: 'completed', serviceType: 'gpu-rental' }).code, 'EXTEND_NOT_OPEN');
  assert.equal(assertExtendOpen({ id: 'g', status: 'rework', serviceType: 'gpu-rental' }).code, 'EXTEND_NOT_OPEN');
  assert.ok(GPU_OPEN.has('delivered'));
  assert.equal(GPU_OPEN.has('completed'), false);
  assert.equal(GPU_OPEN.has('rework'), false);
});
