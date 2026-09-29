'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outputScriptFor } = require('../src/shield-live');
const { shieldedPayLine, MINER_FEE_SATS } = require('../src/hire-shield');
const { prepareShieldedHire, spendPreparedHire } = require('../src/hire-shield-run');

const TAG = '00112233445566778899aabbccddeeff';
const SELLER = 'RFzAZGqmJRwYQz3Y7FwYJVD5mnNGZXRDY6';
const FEE = 'RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2';
const HEX = 'ab'.repeat(43);

function input(overrides = {}) {
  return {
    features: ['jobs.shielded-hire-v1'],
    registeredHex: HEX,
    localHex: HEX,
    job: {
      status: 'accepted',
      jobHash: 'jobhash',
      sellerVerusId: 'iSeller',
      amount: '0.05',
      payment: { verified: false },
    },
    qr: {
      shieldPayTag: TAG,
      agentPayment: { address: SELLER, amount: '0.05' },
      feePayment: { address: FEE, amount: '0.0025' },
    },
    notes: [{ txid: '11'.repeat(32), outputIndex: 1, valueSats: 6_000_000, height: 4 }],
    changeAddress: 'zs1testchange',
    networkName: 'verustest',
    ...overrides,
  };
}

test('a missing feature refuses before any script is built', () => {
  const result = prepareShieldedHire(input({
    features: ['identity.z-address-v1'],
    qr: {
      shieldPayTag: TAG,
      agentPayment: { address: 'zs1nottransparent', amount: '0.05' },
      feePayment: { address: FEE, amount: '0.0025' },
    },
  }));
  assert.deepEqual(result, { ok: false, code: 'SHIELDED_HIRE_OFF' });
});

test('one covering note plans the seller, the fee, the tag, and shielded change', () => {
  const result = prepareShieldedHire(input());
  assert.equal(result.ok, true);
  assert.equal(result.plan.transparentOutputs.length, 3);
  assert.equal(result.plan.transparentOutputs[0].scriptHex, outputScriptFor(SELLER, 'verustest'));
  assert.equal(result.plan.transparentOutputs[0].valueSats, 5_000_000n);
  assert.equal(result.plan.transparentOutputs[1].scriptHex, outputScriptFor(FEE, 'verustest'));
  assert.equal(result.plan.transparentOutputs[1].valueSats, 250_000n);
  assert.equal(result.plan.transparentOutputs[2].valueSats, 0n);
  assert.equal(result.plan.transparentOutputs[2].scriptHex, '6a10' + TAG);
  assert.deepEqual(result.plan.shieldedOutputs, [{ address: 'zs1testchange', valueSats: 740_000n }]);
  assert.equal(result.plan.feeSats, BigInt(MINER_FEE_SATS));
  assert.deepEqual(result.note, { txid: '11'.repeat(32), outputIndex: 1, valueSats: 6_000_000 });
  assert.equal('seedHex' in result, false);
  assert.equal('extskHex' in result, false);
  assert.equal(result.tag, undefined);
  assert.equal(result.shieldPayTag, undefined);
});

test('a QR labour amount that is not the job amount is refused', () => {
  const result = prepareShieldedHire(input({
    qr: {
      shieldPayTag: TAG,
      agentPayment: { address: SELLER, amount: '0.06' },
      feePayment: { address: FEE, amount: '0.0025' },
    },
  }));
  assert.deepEqual(result, { ok: false, code: 'AMOUNT_MISMATCH' });
});

test('no covering note is refused', () => {
  const result = prepareShieldedHire(input({
    notes: [{ txid: '22'.repeat(32), outputIndex: 0, valueSats: 1_000, height: 1 }],
  }));
  assert.deepEqual(result, { ok: false, code: 'NOTE_TOO_SMALL' });
});

test('a hex that contains the seed is not broadcast or posted', async () => {
  const seed = 'ab'.repeat(64);
  let broadcasted = 0;
  let signed = 0;
  let posted = 0;
  await assert.rejects(
    () => spendPreparedHire({
      seedHex: seed,
      plan: {},
      note: { txid: '11'.repeat(32), outputIndex: 0, valueSats: 6_000_000 },
      line: 'unused',
      buildSpend: async () => ({ hex: `00${seed}ff` }),
      broadcast: async () => { broadcasted += 1; return { txid: 'cd'.repeat(32) }; },
      sign: async () => { signed += 1; return 'sig'; },
      post: async () => { posted += 1; },
    }),
    /SEED_IN_TX/,
  );
  assert.equal(broadcasted, 0);
  assert.equal(signed, 0);
  assert.equal(posted, 0);
});

test('a clean hex is signed on the pay line and posted as txid plus signature', async () => {
  const txid = 'cd'.repeat(32);
  const line = shieldedPayLine({
    jobHash: 'jobhash',
    txid,
    sellerIAddress: 'iSeller',
    labourSats: 5000000,
    feeSats: 250000,
  });
  let signed = null;
  let body = null;
  const result = await spendPreparedHire({
    seedHex: 'ab'.repeat(64),
    plan: { feeSats: 10_000n, transparentOutputs: [], shieldedOutputs: [] },
    note: { txid: '11'.repeat(32), outputIndex: 0, valueSats: 6_000_000 },
    line,
    buildSpend: async () => ({ hex: '010203' }),
    broadcast: async (hex) => {
      assert.equal(hex, '010203');
      return { txid };
    },
    sign: async (got) => { signed = got; return 'sig'; },
    post: async (got) => { body = got; return { data: { stored: true } }; },
  });
  assert.equal(signed, line);
  assert.deepEqual(body, { txid, signature: 'sig' });
  assert.deepEqual(Object.keys(body).sort(), ['signature', 'txid']);
  assert.equal(result.ok, true);
  assert.equal(result.txid, txid);
  assert.equal('seedHex' in result, false);
  assert.equal('extskHex' in result, false);
});
