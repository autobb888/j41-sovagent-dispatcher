'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COIN_TYPE,
  STOCK_ZCASH_TESTNET_COIN_TYPE,
  ZIP32_PATH,
  CONSENSUS_BRANCH_ID,
  networkForProof,
  planOwnNoteProof,
  buildT2zSpec,
  findKeyMaterial,
  scanHandle,
  spendHandle,
} = require('../src/shield-proof');

const READY = {
  network: 'verustest',
  coinType: COIN_TYPE,
  amountSats: 1_000_000,
  feeSats: 10_000,
  memo: '',
  cachedNote: false,
  ownRAddress: 'RFnBc4F9Jx6mQqQ2o7m6m1oYk2mQqQ2o7m',
  toRAddress: 'RFnBc4F9Jx6mQqQ2o7m6m1oYk2mQqQ2o7m',
  zsAddress: 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  hasSeed: true,
  hasParams: true,
  lightwalletdUrl: 'lightwalletd.example:9067',
  outbound: { agentId: 'pippinwork' },
};

test('the account path is m/32\'/133\'/0\'', () => {
  assert.equal(COIN_TYPE, 133);
  assert.equal(STOCK_ZCASH_TESTNET_COIN_TYPE, 1);
  assert.equal(ZIP32_PATH, "m/32'/133'/0'");
  assert.equal(CONSENSUS_BRANCH_ID, 0x76b809bb);
});

test('a complete VRSCTEST plan is allowed and does not broadcast', () => {
  const plan = planOwnNoteProof(READY);
  assert.equal(plan.ok, true);
  assert.equal(plan.code, 'SHIELD_PROOF_READY');
  assert.equal(plan.broadcast, false);
  assert.equal(plan.hire, false);
  assert.equal(plan.fleetSend, false);
  assert.equal(plan.netFeeSats, 20_000);
  assert.deepEqual(plan.steps.map((step) => step.id), ['t2z', 'scan', 'z2t']);
  assert.equal(plan.steps[0].needsWitness, false);
  assert.equal(plan.steps[1].cache, false);
  assert.equal(plan.steps[2].witness, 'fresh');
  assert.equal(plan.steps[0].memo, '');
  assert.equal(plan.steps[2].memo, '');
});

test('a mainnet config stays mainnet when the effective network says testnet', () => {
  assert.equal(networkForProof(true, 'verustest'), 'verus');
  assert.equal(networkForProof(false, 'verustest'), 'verustest');
  assert.equal(planOwnNoteProof({ ...READY, network: networkForProof(true, 'verustest') }).code, 'SHIELD_MAINNET_REFUSED');
});

test('mainnet and coin type 1 are refused before readiness', () => {
  assert.equal(planOwnNoteProof({ ...READY, network: 'verus', lightwalletdUrl: '' }).code, 'SHIELD_MAINNET_REFUSED');
  assert.equal(planOwnNoteProof({ ...READY, coinType: 1, hasSeed: false }).code, 'SHIELD_COIN_TYPE');
  assert.equal(planOwnNoteProof({ ...READY, network: 'vrsc' }).code, 'SHIELD_NETWORK');
});

test('a memo, a cached note, or another recipient is refused', () => {
  assert.equal(planOwnNoteProof({ ...READY, memo: 'delivery.zip' }).code, 'SHIELD_MEMO_REFUSED');
  assert.equal(planOwnNoteProof({ ...READY, memo: 'x'.repeat(513) }).code, 'SHIELD_MEMO_TOO_LONG');
  assert.equal(planOwnNoteProof({ ...READY, cachedNote: true }).code, 'SHIELD_NOTE_CACHE_REFUSED');
  assert.equal(planOwnNoteProof({ ...READY, cachedWitness: true }).code, 'SHIELD_NOTE_CACHE_REFUSED');
  assert.equal(
    planOwnNoteProof({ ...READY, toRAddress: 'RAnotherAddress111111111111111' }).code,
    'SHIELD_NOT_OWN_OUTPUT',
  );
});

test('the fee has to be smaller than the note', () => {
  assert.equal(planOwnNoteProof({ ...READY, amountSats: 0 }).code, 'SHIELD_AMOUNT');
  assert.equal(planOwnNoteProof({ ...READY, feeSats: 1_000_000 }).code, 'SHIELD_FEE');
  assert.equal(planOwnNoteProof({ ...READY, feeSats: 0 }).code, 'SHIELD_FEE');
});

test('a key in the outbound payload is refused and is not copied onto the result', () => {
  const secret = 'ab'.repeat(169);
  const plan = planOwnNoteProof({ ...READY, outbound: { nested: { extsk_hex: secret } } });
  assert.equal(plan.code, 'SHIELD_KEY_LEAK');
  assert.equal(JSON.stringify(plan).includes(secret), false);
  assert.deepEqual(findKeyMaterial({ job: { ivk: 'nope' } }), ['$.job.ivk']);
});

test('missing seed, params, or lightwalletd leaves the steps and does not broadcast', () => {
  const plan = planOwnNoteProof({
    network: 'verustest',
    coinType: 133,
    amountSats: 50_000,
    feeSats: 10_000,
    memo: '',
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'SHIELD_PROOF_NOT_READY');
  assert.deepEqual(plan.missing.sort(), ['account', 'lightwalletd', 'params', 'seed']);
  assert.equal(plan.broadcast, false);
  assert.equal(plan.steps.length, 3);
});

test('the t→z request balances, carries an empty memo, and has no key', () => {
  const spec = buildT2zSpec({
    inputs: [{ txid: 'ab'.repeat(32), vout: 0 }],
    inputSats: 1_020_000,
    valueSats: 1_000_000,
    changeSats: 10_000,
    changeScriptHex: '76a91400112233445566778899aabbccddeeff0011223388ac',
    feeSats: 10_000,
    recipientHex: 'cd'.repeat(43),
    expiryHeight: 1_250_000,
  });
  assert.equal(spec.ok, true);
  assert.equal(spec.broadcast, false);
  assert.equal(spec.spec.shielded[0].memo, '');
  assert.equal(spec.spec.shielded[0].value, 1_000_000);
  assert.equal(spec.spec.outputs[0].value, 10_000);
  assert.equal(spec.spec.branch_id, CONSENSUS_BRANCH_ID);
  assert.equal(spec.spec.inputs[0].sequence, 0xffffffff);
  assert.equal(JSON.stringify(spec).includes('wif'), false);
});

test('a satoshi total that leaves the safe range is refused', () => {
  const huge = Number.MAX_SAFE_INTEGER;
  assert.equal(planOwnNoteProof({ ...READY, amountSats: huge, feeSats: huge - 1 }).code, 'SHIELD_FEE');
  assert.equal(buildT2zSpec({
    inputs: [{ txid: '11'.repeat(32), vout: 0 }],
    inputSats: huge,
    valueSats: huge,
    changeSats: 1,
    feeSats: 1,
    recipientHex: 'aa'.repeat(43),
    expiryHeight: 10,
  }).code, 'SHIELD_AMOUNT');
});

test('an unbalanced t→z or a short recipient is refused', () => {
  const base = {
    inputs: [{ txid: '11'.repeat(32), vout: 1 }],
    inputSats: 100,
    valueSats: 50,
    feeSats: 10,
    recipientHex: 'aa'.repeat(43),
    expiryHeight: 10,
  };
  assert.equal(buildT2zSpec(base).code, 'SHIELD_UNBALANCED');
  assert.equal(buildT2zSpec({ ...base, inputSats: 60, recipientHex: 'abcd' }).code, 'SHIELD_ADDRESS');
  assert.equal(buildT2zSpec({ ...base, inputSats: 60, wif: 'secret' }).code, 'SHIELD_KEY_LEAK');
});

test('scan and spend handles confirm the key and do not return it', () => {
  const view = 'aa'.repeat(128);
  const spend = 'bb'.repeat(169);
  const scanned = scanHandle(view);
  const spending = spendHandle(spend);
  assert.equal(scanned.ok, true);
  assert.equal(spending.ok, true);
  const encoded = JSON.stringify({ scanned, spending });
  assert.equal(encoded.includes(view), false);
  assert.equal(encoded.includes(spend), false);
  assert.equal(scanHandle('aa').ok, false);
  assert.equal(spendHandle(view).ok, false);
});
