'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const utxolib = require('@bitgo/utxo-lib');
const {
  parseV4,
  serializeV4,
  transparentSighash,
  signTransparentInputs,
  writeInt64,
  OUTPUT_DESC_LEN,
} = require('../src/sapling-sign');

function sampleTx() {
  const tx = new utxolib.Transaction(utxolib.networks.verustest);
  tx.version = 4;
  tx.overwintered = 1;
  tx.versionGroupId = 0x892f2085;
  tx.consensusBranchId = utxolib.networks.verustest.consensusBranchId[4];
  tx.expiryHeight = 1_250_000;
  tx.locktime = 0;
  tx.ins.push({
    hash: Buffer.from('ab'.repeat(32), 'hex'),
    index: 1,
    script: Buffer.alloc(0),
    sequence: 0xffffffff,
    witness: [],
  });
  tx.outs.push({
    value: 900_000,
    script: Buffer.from('76a91400112233445566778899aabbccddeeff0011223388ac', 'hex'),
  });
  return tx;
}

const PREV = Buffer.from(`76a914${'ff'.repeat(20)}88ac`, 'hex');

test('the transparent sighash matches utxo-lib when valueBalance is zero', () => {
  const tx = sampleTx();
  const expected = tx.hashForZcashSignature(0, PREV, 1_000_000, utxolib.Transaction.SIGHASH_ALL);
  const actual = transparentSighash({
    branchId: tx.consensusBranchId,
    inputs: [{ txid: tx.ins[0].hash, vout: tx.ins[0].index, sequence: tx.ins[0].sequence }],
    outputs: [{ value: BigInt(tx.outs[0].value), script: tx.outs[0].script }],
    lockTime: tx.locktime,
    expiryHeight: tx.expiryHeight,
    valueBalance: 0n,
    shieldedSpends: [],
    shieldedOutputs: [],
    inputIndex: 0,
    scriptCode: PREV,
    amount: 1_000_000,
  });
  assert.deepEqual(actual, expected);
});

test('a shielded output and a negative valueBalance change the hash the library hardcodes as zero', () => {
  const tx = sampleTx();
  const zero = tx.hashForZcashSignature(0, PREV, 1_000_000, utxolib.Transaction.SIGHASH_ALL);
  const shielded = Buffer.alloc(OUTPUT_DESC_LEN, 0x11);
  const base = {
    branchId: tx.consensusBranchId,
    inputs: [{ txid: tx.ins[0].hash, vout: tx.ins[0].index, sequence: tx.ins[0].sequence }],
    outputs: [{ value: BigInt(tx.outs[0].value), script: tx.outs[0].script }],
    lockTime: tx.locktime,
    expiryHeight: tx.expiryHeight,
    shieldedSpends: [],
    inputIndex: 0,
    scriptCode: PREV,
    amount: 1_000_000,
  };
  const withBalance = transparentSighash({ ...base, valueBalance: -1_000_000n, shieldedOutputs: [] });
  const withOutput = transparentSighash({ ...base, valueBalance: -1_000_000n, shieldedOutputs: [shielded] });
  assert.notDeepEqual(withBalance, zero);
  assert.notDeepEqual(withOutput, withBalance);

  const hashPrevouts = tx.getPrevoutHash(utxolib.Transaction.SIGHASH_ALL);
  const hashSequence = tx.getSequenceHash(utxolib.Transaction.SIGHASH_ALL);
  const hashOutputs = tx.getOutputsHash(utxolib.Transaction.SIGHASH_ALL, 0);
  const personal = Buffer.alloc(16);
  personal.write('ZcashSigHash');
  personal.writeUInt32LE(tx.consensusBranchId, 12);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(tx.getHeader() >>> 0);
  const group = Buffer.alloc(4);
  group.writeUInt32LE(tx.versionGroupId);
  const lock = Buffer.alloc(4);
  lock.writeUInt32LE(tx.locktime);
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32LE(tx.expiryHeight);
  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(1);
  const vout = Buffer.alloc(4);
  vout.writeUInt32LE(tx.ins[0].index);
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32LE(tx.ins[0].sequence);
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(1_000_000n);
  const preimage = Buffer.concat([
    header,
    group,
    hashPrevouts,
    hashSequence,
    hashOutputs,
    Buffer.alloc(32),
    Buffer.alloc(32),
    tx.getBlake2bHash(shielded, 'ZcashSOutputHash'),
    lock,
    expiry,
    writeInt64(-1_000_000n),
    hashType,
    tx.ins[0].hash,
    vout,
    Buffer.from([PREV.length]),
    PREV,
    amount,
    sequence,
  ]);
  assert.deepEqual(withOutput, tx.getBlake2bHash(preimage, personal));
});

test('signing fills the scriptSig and leaves the shielded bytes in place', () => {
  const key = utxolib.ECPair.makeRandom({ network: utxolib.networks.verustest });
  const shielded = Buffer.alloc(OUTPUT_DESC_LEN, 0x22);
  const binding = Buffer.alloc(64, 0x33);
  const unsigned = serializeV4({
    header: 0x80000004,
    versionGroupId: 0x892f2085,
    inputs: [{
      txid: Buffer.from('ab'.repeat(32), 'hex'),
      vout: 0,
      scriptSig: Buffer.alloc(0),
      sequence: 0xffffffff,
    }],
    outputs: [{
      value: 4_990_000n,
      script: Buffer.from('76a91400112233445566778899aabbccddeeff0011223388ac', 'hex'),
    }],
    lockTime: 0,
    expiryHeight: 1_250_060,
    valueBalance: -5_000_000n,
    shieldedSpends: [],
    shieldedOutputs: [shielded],
    bindingSig: binding,
  });
  const signed = signTransparentInputs({
    hex: unsigned.toString('hex'),
    wif: key.toWIF(),
    networkName: 'verustest',
    prevouts: [{ script: PREV, satoshis: 10_000_000 }],
  });
  assert.equal(signed.ok, true);
  assert.equal(signed.hex.includes(key.toWIF()), false);
  const parsed = parseV4(signed.hex);
  assert.ok(parsed.inputs[0].scriptSig.length > 0);
  assert.equal(parsed.valueBalance, -5_000_000n);
  assert.deepEqual(parsed.shieldedOutputs[0], shielded);
  assert.deepEqual(parsed.bindingSig, binding);
  assert.equal(serializeV4(parsed).toString('hex'), signed.hex);
});
