'use strict';

const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { ensureSeed, storeJobKey } = require('./seal-address-store');

const LIB_URL = pathToFileURL(path.join(__dirname, 'vendor', 'veruszsupportlib', 'index.mjs')).href;

// zip32 rejects an index >= 2^31 ("unreachable"). Clearing the high bit keeps
// an already-posted index below 2^31 unchanged.
const ZIP32_INDEX_MASK = 0x7fffffff;

function maskEncryptionIndex(index) {
  return (Number(index) >>> 0) & ZIP32_INDEX_MASK;
}

function sealIndexError() {
  const err = new Error('Seal address derivation was rejected by the zip32 library');
  err.code = 'SEAL_INDEX';
  return err;
}

async function deriveJobAddress(seed, partyId, jobId, role = 'buyer') {
  if (role !== 'buyer' && role !== 'seller') {
    const err = new Error('Seal role is not buyer or seller');
    err.code = 'SEAL_ROLE';
    throw err;
  }
  const { webcrypto } = require('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;
  const lib = await import(LIB_URL);
  const fromId = crypto.createHash('sha256').update(String(partyId)).digest().subarray(0, 20);
  const toId = crypto.createHash('sha256').update(String(jobId)).digest().subarray(0, 20);
  const encryptionIndex = maskEncryptionIndex(
    crypto.createHash('sha256').update(`${jobId}:${role}`).digest().readUInt32BE(0),
  );
  let keys;
  try {
    keys = lib.z_getEncryptionAddress({
      seed,
      fromId,
      toId,
      encryptionIndex,
      returnSecret: false,
    });
  } catch {
    throw sealIndexError();
  }
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
 * Derive the job address for this role, keep the viewing key in agentDir, and
 * post { addressHex } only. The returned object never includes the viewing key.
 */
async function publishRoleSealAddress({ agentDir, partyId, jobId, post, yes, role }) {
  if (!yes) {
    return { ok: true, code: 'SEAL_ADDRESS_PREVIEW', jobId, role, posted: false };
  }
  const seed = ensureSeed(agentDir);
  const derived = await deriveJobAddress(seed, partyId, jobId, role);
  const stored = storeJobKey(agentDir, jobId, derived.addressHex, derived.ivk);
  derived.ivk.fill(0);
  const body = await post(stored.addressHex);
  return {
    ok: true,
    code: 'SEAL_ADDRESS_STORED',
    jobId,
    role,
    addressHex: stored.addressHex,
    keyFile: stored.path,
    created: stored.created,
    posted: true,
    stored: !!(body && (body.data ? body.data.stored : body.stored)),
  };
}

function publishBuyerSealAddress({ agentDir, buyerId, jobId, post, yes }) {
  return publishRoleSealAddress({ agentDir, partyId: buyerId, jobId, post, yes, role: 'buyer' });
}

function publishSellerSealAddress({ agentDir, sellerId, jobId, post, yes }) {
  return publishRoleSealAddress({ agentDir, partyId: sellerId, jobId, post, yes, role: 'seller' });
}

module.exports = {
  deriveJobAddress,
  maskEncryptionIndex,
  sealIndexError,
  publishBuyerSealAddress,
  publishSellerSealAddress,
};
