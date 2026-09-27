'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { ensureSeed, storeJobKey } = require('./seal-address-store');

const LIB_URL = pathToFileURL(path.join(__dirname, 'vendor', 'veruszsupportlib', 'index.mjs')).href;

async function deriveJobAddress(seed, buyerId, jobId) {
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const lib = await import(LIB_URL);
  const fromId = crypto.createHash('sha256').update(String(buyerId)).digest().subarray(0, 20);
  const toId = crypto.createHash('sha256').update(String(jobId)).digest().subarray(0, 20);
  const encryptionIndex = crypto.createHash('sha256').update(`${jobId}:buyer`).digest().readUInt32BE(0);
  const keys = lib.z_getEncryptionAddress({
    seed,
    fromId,
    toId,
    encryptionIndex,
    returnSecret: false,
  });
  if (keys.spendingKey) {
    const err = new Error('Derivation returned a spend key');
    err.code = 'SEAL_SPEND';
    throw err;
  }
  const addressHex = Buffer.from(keys.address).toString('hex');
  if (addressHex.length !== 86) {
    const err = new Error('Derived address was not 43 bytes');
    err.code = 'SEAL_ADDRESS';
    throw err;
  }
  return { addressHex, ivk: Buffer.from(keys.ivk) };
}

/**
 * Derive the buyer's job address, keep the viewing key in agentDir, and post
 * { addressHex } only. The returned object never includes the viewing key.
 */
async function publishBuyerSealAddress({ agentDir, buyerId, jobId, post, yes }) {
  if (!yes) {
    return { ok: true, code: 'SEAL_ADDRESS_PREVIEW', jobId, posted: false };
  }
  const seed = ensureSeed(agentDir);
  const derived = await deriveJobAddress(seed, buyerId, jobId);
  const stored = storeJobKey(agentDir, jobId, derived.addressHex, derived.ivk);
  derived.ivk.fill(0);
  const body = await post(stored.addressHex);
  return {
    ok: true,
    code: 'SEAL_ADDRESS_STORED',
    jobId,
    addressHex: stored.addressHex,
    keyFile: stored.path,
    created: stored.created,
    posted: true,
    stored: !!(body && (body.data ? body.data.stored : body.stored)),
  };
}

module.exports = {
  deriveJobAddress,
  publishBuyerSealAddress,
};
