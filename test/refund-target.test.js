'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRefundTarget } = require('../src/refund-target.js');

const BUYER = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';           // valid i-address form
const SELF = 'iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D';
const FEE  = 'RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2';
const baseCtx = { selfAddresses: new Set([SELF]), platformFeeAddress: FEE };
const job = { buyerVerusId: BUYER, amount: 0.5, currency: 'VRSCTEST' };
const dispute = { id: 'd1', raised_by: BUYER };

test('confident when i-address, not self, not fee, dispute signer matches', () => {
  const r = resolveRefundTarget(job, dispute, baseCtx);
  assert.equal(r.address, BUYER);
  assert.equal(r.confident, true);
  assert.equal(r.checks.disputeSigner, true);
});

test('NOT confident when dispute.raised_by mismatches buyer', () => {
  const r = resolveRefundTarget(job, { id: 'd', raised_by: 'iSomeoneElseXXXXXXXXXXXXXXXXXXXXXXX' }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.disputeSigner, false);
});

test('NOT confident when target is one of our own addresses', () => {
  const r = resolveRefundTarget({ ...job, buyerVerusId: SELF }, { id: 'd', raised_by: SELF }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.notSelf, false);
});

test('NOT confident when target is the platform fee address', () => {
  const r = resolveRefundTarget({ ...job, buyerVerusId: FEE }, { id: 'd', raised_by: FEE }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.notPlatformFee, false);
});

test('NOT confident when address is not a valid i-address', () => {
  const r = resolveRefundTarget({ ...job, buyerVerusId: 'not-an-iaddr' }, { id: 'd', raised_by: 'not-an-iaddr' }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.isIAddress, false);
});

test('crash-recovery (dispute null) confident without signer check', () => {
  const r = resolveRefundTarget(job, null, baseCtx);
  assert.equal(r.confident, true);
  assert.equal(r.checks.disputeSigner, undefined);
});

test('name round-trip populates displayName; bad round-trip fails confident', () => {
  const good = resolveRefundTarget(job, dispute, { ...baseCtx, resolveName: () => ({ name: 'subid.agentplatform@', iaddress: BUYER }) });
  assert.equal(good.displayName, 'subid.agentplatform@');
  assert.equal(good.confident, true);
  const bad = resolveRefundTarget(job, dispute, { ...baseCtx, resolveName: () => ({ name: 'x@', iaddress: 'iDIFFERENTxxxxxxxxxxxxxxxxxxxxxxxxx' }) });
  assert.equal(bad.checks.nameRoundTrip, false);
  assert.equal(bad.confident, false);
});
