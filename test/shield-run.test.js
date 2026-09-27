'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const utxolib = require('@bitgo/utxo-lib');
const { runOwnNoteProof } = require('../src/shield-run');
const { serializeV4, parseV4, OUTPUT_DESC_LEN } = require('../src/sapling-sign');

const SCRIPT = '76a91400112233445566778899aabbccddeeff0011223388ac';
const R = 'RFnBc4F9Jx6mQqQ2o7m6m1oYk2mQqQ2o7m';
const ZS = 'zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const RECIPIENT = 'cd'.repeat(43);
const SEED = '12'.repeat(64);
const key = utxolib.ECPair.makeRandom({ network: utxolib.networks.verustest });

function harness(overrides) {
  const calls = { shield: 0, spend: [], broadcast: [], wrote: null };
  let account = overrides.account === undefined ? null : overrides.account;
  let shielded = false;
  const deps = {
    readAccount: async () => account,
    writeAccount: async (next) => {
      calls.wrote = next.seedHex;
      account = next;
    },
    randomSeed: () => SEED,
    prepare: async (stored) => {
      assert.equal(Object.prototype.hasOwnProperty.call(stored, 'seedHex'), true);
      return { address: ZS, addressHex: RECIPIENT };
    },
    ready: async () => ({ ok: true }),
    tip: async () => 1_250_000,
    utxos: async () => [{
      txid: 'ab'.repeat(32),
      vout: 0,
      satoshis: 20_000_000,
      address: R,
      script: SCRIPT,
    }],
    scan: async () => (shielded || overrides.note
      ? [{ txid: 'cd'.repeat(32), outputIndex: 0, valueSats: overrides.note || 5_000_000, height: 1_250_001 }]
      : []),
    shield: async (spec) => {
      calls.shield += 1;
      assert.equal(spec.shielded[0].memo, '');
      assert.equal(spec.shielded[0].recipient_hex, RECIPIENT);
      assert.equal(spec.shielded[0].value, 5_000_000);
      return serializeV4({
        header: 0x80000004,
        versionGroupId: 0x892f2085,
        inputs: [{
          txid: Buffer.from(spec.inputs[0].txid_display, 'hex').reverse(),
          vout: spec.inputs[0].vout,
          scriptSig: Buffer.alloc(0),
          sequence: spec.inputs[0].sequence,
        }],
        outputs: spec.outputs.map((output) => ({
          value: BigInt(output.value),
          script: Buffer.from(output.script_hex, 'hex'),
        })),
        lockTime: 0,
        expiryHeight: spec.expiry_height,
        valueBalance: -BigInt(spec.shielded[0].value),
        shieldedSpends: [],
        shieldedOutputs: [Buffer.alloc(OUTPUT_DESC_LEN, 0x44)],
        bindingSig: Buffer.alloc(64, 0x55),
      }).toString('hex');
    },
    spend: async (request) => {
      calls.spend.push(request);
      assert.equal(request.witness, undefined);
      assert.equal(request.extskHex, undefined);
      assert.equal(request.scriptHex, SCRIPT);
      return 'aa'.repeat(32);
    },
    broadcast: async (hex) => {
      calls.broadcast.push(hex);
      if (overrides.reject) {
        const error = new Error('Transaction must spend from your registered address');
        error.code = 'NOT_YOUR_TX';
        throw error;
      }
      shielded = true;
      return { txid: calls.broadcast.length === 1 ? '11'.repeat(32) : '22'.repeat(32) };
    },
    wait: async () => {},
  };
  const req = {
    network: 'verustest',
    amountSats: 5_000_000,
    feeSats: 10_000,
    lightwalletdUrl: 'light.example:9067',
    rAddress: R,
    outputScriptHex: SCRIPT,
    wif: key.toWIF(),
    yes: true,
    ...overrides.req,
  };
  return { calls, deps, req };
}

test('a round trip shields, signs in process, then spends the note back', async () => {
  const { calls, deps, req } = harness({ account: null });
  const result = await runOwnNoteProof(req, deps);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'SHIELD_PROOF_SPENT');
  assert.equal(result.createdNote, true);
  assert.equal(result.broadcast, true);
  assert.equal(calls.shield, 1);
  assert.equal(calls.broadcast.length, 2);
  assert.equal(calls.wrote, SEED);
  const signed = parseV4(calls.broadcast[0]);
  assert.equal(signed.valueBalance, -5_000_000n);
  assert.ok(signed.inputs[0].scriptSig.length > 0);
  const encoded = JSON.stringify({ result, spend: calls.spend, broadcast: calls.broadcast });
  assert.equal(encoded.includes(SEED), false);
  assert.equal(encoded.includes(req.wif), false);
  assert.equal(calls.spend[0].returnedSats, 4_990_000);
});

test('an existing note is spent without shielding again', async () => {
  const { calls, deps, req } = harness({
    account: { seedHex: SEED, birthdayHeight: 10 },
    note: 8_000_000,
  });
  const result = await runOwnNoteProof(req, deps);
  assert.equal(result.ok, true);
  assert.equal(result.createdNote, false);
  assert.equal(calls.shield, 0);
  assert.equal(calls.broadcast.length, 1);
  assert.equal(calls.spend[0].valueSats, 8_000_000);
  assert.equal(result.returnedSats, 7_990_000);
});

test('mainnet and a missing lightwalletd do not create an account', async () => {
  const main = harness({ req: { network: 'verus', yes: true } });
  const refused = await runOwnNoteProof(main.req, main.deps);
  assert.equal(refused.code, 'SHIELD_MAINNET_REFUSED');
  assert.equal(main.calls.wrote, null);

  const offline = harness({ req: { lightwalletdUrl: '', yes: true } });
  const missing = await runOwnNoteProof(offline.req, offline.deps);
  assert.equal(missing.code, 'SHIELD_LIGHTWALLETD');
  assert.equal(offline.calls.wrote, null);
  assert.equal(missing.broadcast, false);
});

test('a refused broadcast names the inputs and does not include the key', async () => {
  const { calls, deps, req } = harness({ account: { seedHex: SEED, birthdayHeight: 10 }, reject: true });
  const result = await runOwnNoteProof(req, deps);
  assert.equal(result.code, 'SHIELD_BROADCAST');
  assert.equal(result.broadcast, false);
  assert.equal(result.inputs[0].txid, 'ab'.repeat(32));
  assert.equal(JSON.stringify(result).includes(req.wif), false);
  assert.equal(calls.broadcast.length, 1);
});

test('without --yes the command does not broadcast', async () => {
  const { calls, deps, req } = harness({
    account: { seedHex: SEED, birthdayHeight: 10 },
    req: { yes: false },
  });
  const result = await runOwnNoteProof(req, deps);
  assert.equal(result.code, 'SHIELD_PROOF_PREVIEW');
  assert.equal(result.broadcast, false);
  assert.equal(result.zsAddress, ZS);
  assert.equal(calls.broadcast.length, 0);
  assert.equal(JSON.stringify(result).includes(SEED), false);
});
