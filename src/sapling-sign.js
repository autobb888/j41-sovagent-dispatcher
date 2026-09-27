'use strict';

/**
 * Sign the transparent inputs of a Sapling v4 transaction in this process.
 *
 * @chainvue/verus-sapling builds a t→z with empty scriptSigs and expects a
 * daemon `signrawtransaction`. That would put the WIF in verusd. ZIP-243 is
 * computed here instead, and only the finished hex is broadcast.
 *
 * The zero-valueBalance form of this hash matches @bitgo/utxo-lib. A t→z is
 * the same preimage with the prover's valueBalance and shielded outputs.
 */

const blake2b = require('@bitgo/blake2b');

const V4_HEADER = 0x80000004;
const SAPLING_VERSION_GROUP_ID = 0x892f2085;
const SIGHASH_ALL = 1;
const OUTPUT_DESC_LEN = 948;
const SPEND_DESC_LEN = 384;
const BINDING_SIG_LEN = 64;
const BRANCH_ID = 0x76b809bb;

function blakePersonal(personal, data) {
  const out = Buffer.alloc(32);
  const label = Buffer.isBuffer(personal) ? personal : Buffer.from(personal);
  if (label.length !== 16) throw new Error('blake2b personalization must be 16 bytes');
  blake2b(32, null, null, label).update(data).digest(out);
  return out;
}

function readCompact(buf, offset) {
  if (offset >= buf.length) throw new Error('truncated compact size');
  const tag = buf[offset];
  if (tag < 0xfd) return { value: tag, offset: offset + 1 };
  if (tag === 0xfd) {
    if (offset + 3 > buf.length) throw new Error('truncated compact size');
    return { value: buf.readUInt16LE(offset + 1), offset: offset + 3 };
  }
  if (tag === 0xfe) {
    if (offset + 5 > buf.length) throw new Error('truncated compact size');
    return { value: buf.readUInt32LE(offset + 1), offset: offset + 5 };
  }
  throw new Error('compact size does not fit a transaction count');
}

function writeCompact(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('compact size is not a count');
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  }
  const buf = Buffer.alloc(5);
  buf[0] = 0xfe;
  buf.writeUInt32LE(n, 1);
  return buf;
}

function readInt64(buf, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value |= BigInt(buf[offset + i]) << (8n * BigInt(i));
  if (value >= 0x8000000000000000n) value -= 0x10000000000000000n;
  return value;
}

function writeInt64(value) {
  let v = BigInt(value);
  if (v < 0n) v += 0x10000000000000000n;
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) buf[i] = Number((v >> (8n * BigInt(i))) & 0xffn);
  return buf;
}

function take(buf, offset, len) {
  if (offset + len > buf.length) throw new Error('truncated sapling transaction');
  return { bytes: buf.subarray(offset, offset + len), offset: offset + len };
}

function parseV4(hex) {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length < 16 || buf.toString('hex') !== String(hex).toLowerCase().replace(/^0x/, '')) {
    throw new Error('transaction hex is not hexadecimal');
  }
  let offset = 0;
  const header = buf.readUInt32LE(offset);
  offset += 4;
  const versionGroupId = buf.readUInt32LE(offset);
  offset += 4;
  if (header !== V4_HEADER || versionGroupId !== SAPLING_VERSION_GROUP_ID) {
    throw new Error('not a Sapling v4 transaction');
  }

  let count = readCompact(buf, offset);
  offset = count.offset;
  const inputs = [];
  for (let i = 0; i < count.value; i += 1) {
    let part = take(buf, offset, 32);
    const txid = Buffer.from(part.bytes);
    offset = part.offset;
    part = take(buf, offset, 4);
    const vout = part.bytes.readUInt32LE(0);
    offset = part.offset;
    const scriptLen = readCompact(buf, offset);
    offset = scriptLen.offset;
    part = take(buf, offset, scriptLen.value);
    const scriptSig = Buffer.from(part.bytes);
    offset = part.offset;
    part = take(buf, offset, 4);
    const sequence = part.bytes.readUInt32LE(0);
    offset = part.offset;
    inputs.push({ txid, vout, scriptSig, sequence });
  }

  count = readCompact(buf, offset);
  offset = count.offset;
  const outputs = [];
  for (let i = 0; i < count.value; i += 1) {
    let part = take(buf, offset, 8);
    const value = part.bytes.readBigUInt64LE(0);
    offset = part.offset;
    const scriptLen = readCompact(buf, offset);
    offset = scriptLen.offset;
    part = take(buf, offset, scriptLen.value);
    outputs.push({ value, script: Buffer.from(part.bytes) });
    offset = part.offset;
  }

  let part = take(buf, offset, 4);
  const lockTime = part.bytes.readUInt32LE(0);
  offset = part.offset;
  part = take(buf, offset, 4);
  const expiryHeight = part.bytes.readUInt32LE(0);
  offset = part.offset;
  part = take(buf, offset, 8);
  const valueBalance = readInt64(part.bytes, 0);
  offset = part.offset;

  count = readCompact(buf, offset);
  offset = count.offset;
  const shieldedSpends = [];
  for (let i = 0; i < count.value; i += 1) {
    part = take(buf, offset, SPEND_DESC_LEN);
    shieldedSpends.push(Buffer.from(part.bytes));
    offset = part.offset;
  }
  count = readCompact(buf, offset);
  offset = count.offset;
  const shieldedOutputs = [];
  for (let i = 0; i < count.value; i += 1) {
    part = take(buf, offset, OUTPUT_DESC_LEN);
    shieldedOutputs.push(Buffer.from(part.bytes));
    offset = part.offset;
  }
  count = readCompact(buf, offset);
  offset = count.offset;
  if (count.value !== 0) throw new Error('JoinSplits are not part of this proof');

  let bindingSig = Buffer.alloc(0);
  if (shieldedSpends.length || shieldedOutputs.length) {
    part = take(buf, offset, BINDING_SIG_LEN);
    bindingSig = Buffer.from(part.bytes);
    offset = part.offset;
  }
  if (offset !== buf.length) throw new Error('transaction has trailing bytes');

  return {
    header,
    versionGroupId,
    inputs,
    outputs,
    lockTime,
    expiryHeight,
    valueBalance,
    shieldedSpends,
    shieldedOutputs,
    bindingSig,
  };
}

function serializeV4(tx) {
  const parts = [
    Buffer.alloc(4),
    Buffer.alloc(4),
  ];
  parts[0].writeUInt32LE(tx.header);
  parts[1].writeUInt32LE(tx.versionGroupId);
  parts.push(writeCompact(tx.inputs.length));
  for (const input of tx.inputs) {
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(input.vout);
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(input.sequence);
    parts.push(input.txid, vout, writeCompact(input.scriptSig.length), input.scriptSig, sequence);
  }
  parts.push(writeCompact(tx.outputs.length));
  for (const output of tx.outputs) {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(output.value);
    parts.push(value, writeCompact(output.script.length), output.script);
  }
  const lockTime = Buffer.alloc(4);
  lockTime.writeUInt32LE(tx.lockTime);
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32LE(tx.expiryHeight);
  parts.push(lockTime, expiry, writeInt64(tx.valueBalance));
  parts.push(writeCompact(tx.shieldedSpends.length), ...tx.shieldedSpends);
  parts.push(writeCompact(tx.shieldedOutputs.length), ...tx.shieldedOutputs);
  parts.push(writeCompact(0));
  if (tx.shieldedSpends.length || tx.shieldedOutputs.length) parts.push(tx.bindingSig);
  return Buffer.concat(parts);
}

function transparentSighash({
  branchId = BRANCH_ID,
  inputs,
  outputs,
  lockTime,
  expiryHeight,
  valueBalance,
  shieldedSpends,
  shieldedOutputs,
  inputIndex,
  scriptCode,
  amount,
}) {
  const prevouts = Buffer.concat(inputs.map((input) => {
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(input.vout);
    return Buffer.concat([input.txid, vout]);
  }));
  const sequences = Buffer.concat(inputs.map((input) => {
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32LE(input.sequence);
    return sequence;
  }));
  const outs = Buffer.concat(outputs.map((output) => {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(output.value);
    return Buffer.concat([value, writeCompact(output.script.length), output.script]);
  }));
  const hashPrevouts = blakePersonal('ZcashPrevoutHash', prevouts);
  const hashSequence = blakePersonal('ZcashSequencHash', sequences);
  const hashOutputs = blakePersonal('ZcashOutputsHash', outs);
  const hashJoinSplits = Buffer.alloc(32);
  const hashShieldedSpends = shieldedSpends.length
    ? blakePersonal('ZcashSSpendsHash', Buffer.concat(shieldedSpends))
    : Buffer.alloc(32);
  const hashShieldedOutputs = shieldedOutputs.length
    ? blakePersonal('ZcashSOutputHash', Buffer.concat(shieldedOutputs))
    : Buffer.alloc(32);

  const header = Buffer.alloc(4);
  header.writeUInt32LE(V4_HEADER);
  const group = Buffer.alloc(4);
  group.writeUInt32LE(SAPLING_VERSION_GROUP_ID);
  const lock = Buffer.alloc(4);
  lock.writeUInt32LE(lockTime);
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32LE(expiryHeight);
  const hashType = Buffer.alloc(4);
  hashType.writeUInt32LE(SIGHASH_ALL);
  const input = inputs[inputIndex];
  const vout = Buffer.alloc(4);
  vout.writeUInt32LE(input.vout);
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32LE(input.sequence);
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(BigInt(amount));

  const preimage = Buffer.concat([
    header,
    group,
    hashPrevouts,
    hashSequence,
    hashOutputs,
    hashJoinSplits,
    hashShieldedSpends,
    hashShieldedOutputs,
    lock,
    expiry,
    writeInt64(valueBalance),
    hashType,
    input.txid,
    vout,
    writeCompact(scriptCode.length),
    scriptCode,
    value,
    sequence,
  ]);
  const personal = Buffer.alloc(16);
  personal.write('ZcashSigHash');
  personal.writeUInt32LE(branchId >>> 0, 12);
  return blakePersonal(personal, preimage);
}

function signTransparentInputs({ hex, wif, networkName, prevouts }) {
  const utxolib = require('@bitgo/utxo-lib');
  const network = networkName === 'verus' ? utxolib.networks.verus : utxolib.networks.verustest;
  let parsed;
  try {
    parsed = parseV4(hex);
  } catch (error) {
    return { ok: false, code: 'SHIELD_TX_SHAPE', message: error.message };
  }
  if (!Array.isArray(prevouts) || prevouts.length !== parsed.inputs.length) {
    return { ok: false, code: 'SHIELD_INPUTS', message: 'Each transparent input needs its own script and amount.' };
  }
  let keyPair;
  try {
    keyPair = utxolib.ECPair.fromWIF(wif, network);
  } catch (error) {
    return { ok: false, code: 'SHIELD_WIF', message: 'The WIF does not match this network.' };
  }
  const scriptSigs = [];
  for (let i = 0; i < parsed.inputs.length; i += 1) {
    const prev = prevouts[i];
    if (!prev || !Buffer.isBuffer(prev.script) || !Number.isSafeInteger(prev.satoshis) || prev.satoshis <= 0) {
      return { ok: false, code: 'SHIELD_INPUTS', message: 'A transparent input is missing its script or amount.' };
    }
    const hash = transparentSighash({
      inputs: parsed.inputs,
      outputs: parsed.outputs,
      lockTime: parsed.lockTime,
      expiryHeight: parsed.expiryHeight,
      valueBalance: parsed.valueBalance,
      shieldedSpends: parsed.shieldedSpends,
      shieldedOutputs: parsed.shieldedOutputs,
      inputIndex: i,
      scriptCode: prev.script,
      amount: prev.satoshis,
    });
    const signature = keyPair.sign(hash).toScriptSignature(utxolib.Transaction.SIGHASH_ALL);
    scriptSigs.push(utxolib.script.compile([signature, keyPair.getPublicKeyBuffer()]));
  }
  const signed = serializeV4({
    ...parsed,
    inputs: parsed.inputs.map((input, i) => ({ ...input, scriptSig: scriptSigs[i] })),
  });
  return { ok: true, hex: signed.toString('hex') };
}

module.exports = {
  V4_HEADER,
  SAPLING_VERSION_GROUP_ID,
  BRANCH_ID,
  OUTPUT_DESC_LEN,
  parseV4,
  serializeV4,
  transparentSighash,
  signTransparentInputs,
  writeInt64,
};
