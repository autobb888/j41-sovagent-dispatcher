'use strict';

/**
 * One-note hire spend plan. No wasm, no disk, no network.
 * Change is a shielded output. The tag is only inside the nulldata script.
 */

const MINER_FEE_SATS = 10000;

function isSafeInt(n) {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

function nulldataScript(tagHex) {
  const tag = String(tagHex == null ? '' : tagHex);
  if (!/^[0-9a-fA-F]{32}$/.test(tag)) {
    throw new Error('A nulldata tag must be 16 bytes.');
  }
  return `6a10${tag.toLowerCase()}`;
}

function isScriptHex(script) {
  return typeof script === 'string'
    && script.length > 0
    && script.length % 2 === 0
    && /^[0-9a-fA-F]+$/.test(script);
}

function planHireSpend(input) {
  const src = input && typeof input === 'object' ? input : {};
  if (!isSafeInt(src.noteValueSats) || src.noteValueSats < 0) return { ok: false, code: 'BAD_AMOUNT' };
  if (!isSafeInt(src.labourSats) || src.labourSats <= 0) return { ok: false, code: 'BAD_AMOUNT' };
  if (!isSafeInt(src.platformFeeSats) || src.platformFeeSats <= 0) return { ok: false, code: 'BAD_AMOUNT' };
  if (!isSafeInt(src.minerFeeSats) || src.minerFeeSats <= 0 || src.minerFeeSats > 100000) {
    return { ok: false, code: 'BAD_FEE' };
  }
  if (!isScriptHex(src.sellerScriptHex) || !isScriptHex(src.feeScriptHex)) {
    return { ok: false, code: 'BAD_SCRIPT' };
  }
  if (typeof src.changeAddress !== 'string' || src.changeAddress.length === 0) {
    return { ok: false, code: 'BAD_AMOUNT' };
  }
  let nulldata;
  try {
    nulldata = nulldataScript(src.tagHex);
  } catch {
    return { ok: false, code: 'BAD_TAG' };
  }
  const note = BigInt(src.noteValueSats);
  const labour = BigInt(src.labourSats);
  const platform = BigInt(src.platformFeeSats);
  const miner = BigInt(src.minerFeeSats);
  const outlay = labour + platform + miner;
  if (note < outlay) return { ok: false, code: 'NOTE_TOO_SMALL' };
  const change = note - outlay;
  const transparentOutputs = [
    { scriptHex: src.sellerScriptHex, valueSats: labour },
    { scriptHex: src.feeScriptHex, valueSats: platform },
    { scriptHex: nulldata, valueSats: 0n },
  ];
  const shieldedOutputs = change === 0n ? [] : [{ address: src.changeAddress, valueSats: change }];
  return { ok: true, transparentOutputs, shieldedOutputs, feeSats: miner };
}

function selectCoveringNote(notes, needSats) {
  if (!isSafeInt(needSats) || needSats < 0) return null;
  let best = null;
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || !isSafeInt(note.valueSats) || !isSafeInt(note.height)) continue;
    if (note.valueSats < needSats) continue;
    if (!best
      || note.valueSats < best.valueSats
      || (note.valueSats === best.valueSats && note.height < best.height)) {
      best = note;
    }
  }
  return best;
}

function shieldedPayLine({ jobHash, txid, sellerIAddress, labourSats, feeSats }) {
  return `J41-SHIELDED-PAY|Job:${jobHash}|Tx:${txid}|Seller:${sellerIAddress}|LabourSats:${labourSats}|FeeSats:${feeSats}|I paid this job from a shielded note.`;
}

function payShieldedGate({ features, registeredHex, localHex, status, paymentVerified }) {
  const listed = Array.isArray(features) ? features : [];
  if (!listed.includes('jobs.shielded-hire-v1')) return { ok: false, code: 'SHIELDED_HIRE_OFF' };
  const registered = typeof registeredHex === 'string' ? registeredHex.trim().toLowerCase() : '';
  const local = typeof localHex === 'string' ? localHex.trim().toLowerCase() : '';
  if (!registered) return { ok: false, code: 'Z_ADDRESS_NOT_SET' };
  if (registered !== local) return { ok: false, code: 'Z_ADDRESS_MISMATCH' };
  if (status !== 'accepted') return { ok: false, code: 'JOB_NOT_ACCEPTED' };
  if (paymentVerified === true) return { ok: false, code: 'ALREADY_PAID' };
  return { ok: true };
}

function assertHexOmitsSeed(txHex, seedHex) {
  const hex = String(txHex == null ? '' : txHex).toLowerCase();
  const seed = String(seedHex == null ? '' : seedHex).toLowerCase();
  if (seed.length > 0 && hex.includes(seed)) throw new Error('SEED_IN_TX');
}

module.exports = {
  MINER_FEE_SATS,
  nulldataScript,
  planHireSpend,
  selectCoveringNote,
  shieldedPayLine,
  payShieldedGate,
  assertHexOmitsSeed,
};
