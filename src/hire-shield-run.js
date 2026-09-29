'use strict';

/**
 * Prepare, prove, and submit one shielded hire payment.
 * prepareShieldedHire does not prove and does not broadcast.
 * Broadcast goes to lightwalletd, never POST /v1/tx/broadcast.
 */

const crypto = require('crypto');
const {
  MINER_FEE_SATS,
  planHireSpend,
  selectCoveringNote,
  shieldedPayLine,
  payShieldedGate,
  assertHexOmitsSeed,
} = require('./hire-shield');
const { outputScriptFor, loadLibrary, readParams, lightwalletdTarget } = require('./shield-live');
const { COIN_TYPE } = require('./shield-proof');

function transparentPayAddress(qrAddress, resolved) {
  const address = typeof qrAddress === 'string' ? qrAddress : '';
  if (address.startsWith('R')) return address;
  if (address.startsWith('i')) {
    const primary = resolved && typeof resolved.address === 'string' ? resolved.address : '';
    if (primary.startsWith('R')) return primary;
  }
  return address;
}

function satsFromCoins(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  const sats = Math.round(n * 1e8);
  if (!Number.isSafeInteger(sats) || sats < 0) return null;
  return sats;
}

function prepareShieldedHire(input) {
  const src = input && typeof input === 'object' ? input : {};
  const job = src.job && typeof src.job === 'object' ? src.job : {};
  const gate = payShieldedGate({
    features: src.features,
    registeredHex: src.registeredHex,
    localHex: src.localHex,
    status: job.status,
    paymentVerified: !!(job.payment && job.payment.verified === true),
  });
  if (!gate.ok) return gate;

  const tag = src.qr && src.qr.shieldPayTag;
  if (typeof tag !== 'string' || !/^[0-9a-fA-F]{32}$/.test(tag)) {
    return { ok: false, code: 'TAG_NOT_ISSUED' };
  }
  const agentPay = src.qr && src.qr.agentPayment;
  const feePay = src.qr && src.qr.feePayment;
  const labourSats = satsFromCoins(agentPay && agentPay.amount);
  const platformFeeSats = satsFromCoins(feePay && feePay.amount);
  const expectedLabour = satsFromCoins(job.amount);
  const expectedFee = satsFromCoins(Number(job.amount) * 0.05);
  if (labourSats == null || platformFeeSats == null || expectedLabour == null || expectedFee == null
    || labourSats !== expectedLabour || platformFeeSats !== expectedFee) {
    return { ok: false, code: 'AMOUNT_MISMATCH' };
  }
  let sellerScriptHex;
  let feeScriptHex;
  try {
    sellerScriptHex = outputScriptFor(agentPay.address, src.networkName);
    feeScriptHex = outputScriptFor(feePay.address, src.networkName);
  } catch {
    return { ok: false, code: 'BAD_SCRIPT' };
  }
  const need = labourSats + platformFeeSats + MINER_FEE_SATS;
  if (!Number.isSafeInteger(need)) return { ok: false, code: 'BAD_AMOUNT' };
  const note = selectCoveringNote(src.notes, need);
  if (!note) return { ok: false, code: 'NOTE_TOO_SMALL' };
  const plan = planHireSpend({
    noteValueSats: note.valueSats,
    labourSats,
    platformFeeSats,
    minerFeeSats: MINER_FEE_SATS,
    sellerScriptHex,
    feeScriptHex,
    tagHex: tag,
    changeAddress: src.changeAddress,
  });
  if (!plan.ok) return { ok: false, code: plan.code };
  return {
    ok: true,
    linePreview: null,
    note: { txid: note.txid, outputIndex: note.outputIndex, valueSats: note.valueSats },
    plan,
  };
}

function txidOfRawHex(hex) {
  const text = String(hex || '');
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 2 !== 0) {
    const error = new Error('The shielded spend hex is not valid.');
    error.code = 'SHIELD_SPEND';
    throw error;
  }
  const raw = Buffer.from(text, 'hex');
  const hash = crypto.createHash('sha256').update(crypto.createHash('sha256').update(raw).digest()).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

async function spendPreparedHire({ buildSpend, broadcast, sign, post, seedHex, plan, note, line }) {
  const built = await buildSpend({ plan, note });
  const hex = built && typeof built === 'object' ? built.hex : built;
  if (typeof hex !== 'string' || !hex) {
    const error = new Error('The shielded spend did not produce a transaction.');
    error.code = 'SHIELD_SPEND';
    throw error;
  }
  assertHexOmitsSeed(hex, seedHex);
  const sent = await broadcast(hex);
  const txid = sent && typeof sent === 'object' && typeof sent.txid === 'string' && /^[0-9a-fA-F]{64}$/.test(sent.txid)
    ? sent.txid.toLowerCase()
    : txidOfRawHex(hex);
  try {
    const payLine = typeof line === 'function' ? line(txid) : line;
    const signature = await sign(payLine);
    if (typeof signature !== 'string' || !signature) {
      const error = new Error('The payment line was not signed.');
      error.code = 'SHIELD_SIGN';
      throw error;
    }
    await post({ txid, signature });
  } catch {
    return { ok: false, code: 'SHIELDED_HIRE_UNRECORDED', txid };
  }
  return { ok: true, code: 'SHIELDED_HIRE_SUBMITTED', txid };
}

async function proveHireSpend({ seedHex, paramsDir, lightwalletdUrl, plan, note }) {
  const target = lightwalletdTarget(lightwalletdUrl);
  if (!target) {
    const error = new Error('A lightwalletd host:port is required.');
    error.code = 'SHIELD_LIGHTWALLETD';
    throw error;
  }
  const params = readParams(paramsDir);
  if (!params) {
    const error = new Error('The Sapling parameters are not available.');
    error.code = 'SHIELD_PARAMS';
    throw error;
  }
  const lib = await loadLibrary();
  await lib.sapling.verifyCanonicalParams(params);
  const derived = await lib.sapling.deriveSaplingAccount({ seedHex, coinType: COIN_TYPE, account: 0 });
  const lwd = new lib.LightwalletdClient(target.address, { insecure: target.insecure });
  try {
    const spendArg = {
      note: {
        txid: note.txid,
        outputIndex: note.outputIndex,
        valueSats: BigInt(note.valueSats),
        extskHex: derived.extskHex,
      },
      transparentOutputs: plan.transparentOutputs.map((out) => ({
        scriptHex: out.scriptHex,
        valueSats: BigInt(out.valueSats),
      })),
      shieldedOutputs: (plan.shieldedOutputs || []).map((out) => ({
        address: out.address,
        valueSats: BigInt(out.valueSats),
      })),
      feeSats: BigInt(plan.feeSats),
    };
    const built = await lib.sapling.buildShieldedSpend(
      lwd,
      (spec) => lib.sapling.spendShielded(spec, params),
      spendArg,
    );
    return { hex: built.hex };
  } finally {
    try { lwd.close(); } catch { /* the client may already be closed */ }
  }
}

async function broadcastShieldedHex({ lightwalletdUrl, hex }) {
  const target = lightwalletdTarget(lightwalletdUrl);
  if (!target) {
    const error = new Error('A lightwalletd host:port is required.');
    error.code = 'SHIELD_LIGHTWALLETD';
    throw error;
  }
  const lib = await loadLibrary();
  const lwd = new lib.LightwalletdClient(target.address, { insecure: target.insecure });
  try {
    const sent = await lwd.sendTransaction(hex);
    const code = sent && sent.errorCode != null ? Number(sent.errorCode) : 0;
    if (code !== 0) {
      const error = new Error((sent && sent.errorMessage) || 'The spend was rejected.');
      error.code = 'SHIELD_BROADCAST';
      throw error;
    }
  } finally {
    try { lwd.close(); } catch { /* the client may already be closed */ }
  }
  return { txid: txidOfRawHex(hex) };
}

function versionFeatures(version) {
  if (!version) return [];
  if (Array.isArray(version.features)) return version.features.map(String);
  if (version.data && Array.isArray(version.data.features)) return version.data.features.map(String);
  return [];
}

module.exports = {
  transparentPayAddress,
  prepareShieldedHire,
  spendPreparedHire,
  proveHireSpend,
  broadcastShieldedHex,
  versionFeatures,
  shieldedPayLine,
};
