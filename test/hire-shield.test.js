'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MINER_FEE_SATS,
  nulldataScript,
  planHireSpend,
  selectCoveringNote,
  shieldedPayLine,
  payShieldedGate,
  assertHexOmitsSeed,
} = require('../src/hire-shield');

const TAG = '00112233445566778899aabbccddeeff';

test('nulldata is a 16-byte OP_RETURN and the pay line matches the API', () => {
  assert.equal(nulldataScript(TAG.toUpperCase()), '6a10' + TAG);
  assert.throws(() => nulldataScript('abcd'), /16 bytes/);
  assert.equal(
    shieldedPayLine({
      jobHash: 'jobhash',
      txid: 'ab'.repeat(32),
      sellerIAddress: 'iSeller',
      labourSats: 5000000,
      feeSats: 250000,
    }),
    'J41-SHIELDED-PAY|Job:jobhash|Tx:' + 'ab'.repeat(32) + '|Seller:iSeller|LabourSats:5000000|FeeSats:250000|I paid this job from a shielded note.',
  );
});

test('a larger note returns shielded change and conserves value', () => {
  const plan = planHireSpend({
    noteValueSats: 6_000_000,
    labourSats: 5_000_000,
    platformFeeSats: 250_000,
    minerFeeSats: MINER_FEE_SATS,
    sellerScriptHex: '76a91400',
    feeScriptHex: '76a91411',
    tagHex: TAG,
    changeAddress: 'zs1testchange',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.transparentOutputs.length, 3);
  assert.equal(plan.transparentOutputs[2].valueSats, 0n);
  assert.equal(plan.transparentOutputs[2].scriptHex, '6a10' + TAG);
  assert.deepEqual(plan.shieldedOutputs, [{ address: 'zs1testchange', valueSats: 740_000n }]);
  assert.equal(plan.feeSats, 10_000n);
  const spent = plan.transparentOutputs.reduce((sum, out) => sum + out.valueSats, 0n)
    + plan.shieldedOutputs[0].valueSats + plan.feeSats;
  assert.equal(spent, 6_000_000n);
});

test('an exact note has no change output and a short note is refused', () => {
  const exact = planHireSpend({
    noteValueSats: 5_260_000,
    labourSats: 5_000_000,
    platformFeeSats: 250_000,
    minerFeeSats: 10_000,
    sellerScriptHex: 'aa',
    feeScriptHex: 'bb',
    tagHex: TAG,
    changeAddress: 'zs1testchange',
  });
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.shieldedOutputs, []);
  const short = planHireSpend({
    noteValueSats: 5_259_999,
    labourSats: 5_000_000,
    platformFeeSats: 250_000,
    minerFeeSats: 10_000,
    sellerScriptHex: 'aa',
    feeScriptHex: 'bb',
    tagHex: TAG,
    changeAddress: 'zs1testchange',
  });
  assert.deepEqual(short, { ok: false, code: 'NOTE_TOO_SMALL' });
});

test('the smallest covering note is selected', () => {
  const notes = [
    { txid: 'big', valueSats: 9_000_000, height: 1 },
    { txid: 'fit-late', valueSats: 5_260_000, height: 20 },
    { txid: 'fit-early', valueSats: 5_260_000, height: 10 },
    { txid: 'short', valueSats: 1000, height: 1 },
  ];
  assert.equal(selectCoveringNote(notes, 5_260_000).txid, 'fit-early');
  assert.equal(selectCoveringNote(notes, 9_000_001), null);
});

test('the gate refuses a spend while the feature is off or the address is not this identity', () => {
  assert.equal(payShieldedGate({
    features: ['identity.z-address-v1'],
    registeredHex: 'ab'.repeat(43),
    localHex: 'ab'.repeat(43),
    status: 'accepted',
    paymentVerified: false,
  }).code, 'SHIELDED_HIRE_OFF');
  assert.equal(payShieldedGate({
    features: ['jobs.shielded-hire-v1'],
    registeredHex: '',
    localHex: 'ab'.repeat(43),
    status: 'accepted',
    paymentVerified: false,
  }).code, 'Z_ADDRESS_NOT_SET');
  assert.equal(payShieldedGate({
    features: ['jobs.shielded-hire-v1'],
    registeredHex: 'cd'.repeat(43),
    localHex: 'ab'.repeat(43),
    status: 'accepted',
    paymentVerified: false,
  }).code, 'Z_ADDRESS_MISMATCH');
  assert.equal(payShieldedGate({
    features: ['jobs.shielded-hire-v1'],
    registeredHex: 'AB'.repeat(43),
    localHex: 'ab'.repeat(43),
    status: 'requested',
    paymentVerified: false,
  }).code, 'JOB_NOT_ACCEPTED');
  assert.equal(payShieldedGate({
    features: ['jobs.shielded-hire-v1'],
    registeredHex: 'ab'.repeat(43),
    localHex: 'ab'.repeat(43),
    status: 'accepted',
    paymentVerified: true,
  }).code, 'ALREADY_PAID');
  assert.deepEqual(payShieldedGate({
    features: ['jobs.shielded-hire-v1'],
    registeredHex: 'ab'.repeat(43),
    localHex: 'ab'.repeat(43),
    status: 'accepted',
    paymentVerified: false,
  }), { ok: true });
});

test('a transaction hex that contains the seed is refused', () => {
  const seed = 'ab'.repeat(64);
  assert.doesNotThrow(() => assertHexOmitsSeed('010203', seed));
  assert.throws(() => assertHexOmitsSeed('00' + seed + 'ff', seed), /SEED_IN_TX/);
});
