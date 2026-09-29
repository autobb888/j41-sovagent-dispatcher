'use strict';

/**
 * Register one Sapling address for the signed-in identity.
 * The seed stays in sapling-account.json. The POST body is { addressHex } only.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { COIN_TYPE } = require('./shield-proof');
const { accountFile, readStoredAccount, writeStoredAccount } = require('./shield-live');

const SCRUB = new Set(['seed', 'seedhex', 'extskhex', 'dfvkhex', 'ivk', 'wif', 'spendingkey']);
const DERIVE_FORBIDDEN = new Set(['seed', 'seedhex', 'extskhex', 'dfvkhex']);

function scrub(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    if (SCRUB.has(String(key).toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function safePostMessage(error, seedHex) {
  let message = String((error && error.message) || 'The z-address post failed.');
  const seed = String(seedHex || '').toLowerCase();
  if (seed && message.toLowerCase().includes(seed)) message = 'The z-address post failed.';
  return message;
}

function assertDerive(derived) {
  if (!derived || typeof derived !== 'object') {
    const error = new Error('Derivation did not return an address.');
    error.code = 'Z_ADDRESS_DERIVE';
    throw error;
  }
  for (const key of Object.keys(derived)) {
    if (DERIVE_FORBIDDEN.has(String(key).toLowerCase())) {
      const error = new Error('Derivation returned a key.');
      error.code = 'Z_ADDRESS_DERIVE';
      throw error;
    }
  }
  const addressHex = String(derived.addressHex || '').toLowerCase();
  if (!/^[0-9a-f]{86}$/.test(addressHex)) {
    const error = new Error('Derived address was not 86 hex characters.');
    error.code = 'Z_ADDRESS_DERIVE';
    throw error;
  }
  return addressHex;
}

let saplingPromise = null;
function loadSapling() {
  if (!saplingPromise) {
    saplingPromise = (async () => {
      const sapling = await import('@chainvue/verus-sapling');
      const entry = path.dirname(require.resolve('@chainvue/verus-sapling'));
      const root = [entry, path.resolve(entry, '..'), path.resolve(entry, '../..')]
        .find((candidate) => fs.existsSync(path.join(candidate, 'crate/pkg/verus_sapling_prover_bg.wasm')));
      const wasm = root && path.join(root, 'crate/pkg/verus_sapling_prover_bg.wasm');
      if (!wasm) throw new Error('The Sapling prover wasm is not in the installed package.');
      await sapling.initSapling(fs.readFileSync(wasm));
      return sapling;
    })().catch((error) => {
      saplingPromise = null;
      throw error;
    });
  }
  return saplingPromise;
}

/** Production derive. Returns the payment address and its 86-hex form, never a key. */
async function deriveIdentityAddress(seedHex) {
  const sapling = await loadSapling();
  const derived = await sapling.deriveSaplingAccount({ seedHex, coinType: COIN_TYPE, account: 0 });
  return { addressHex: derived.addressHex, changeAddress: derived.address };
}

async function publishIdentityZAddress({ agentsDir, agentId, yes, derive, post, birthdayHeight }) {
  const file = accountFile(agentsDir, agentId);
  const stored = readStoredAccount(file);
  if (stored && stored.invalid) return scrub({ ok: false, code: 'SHIELD_ACCOUNT' });
  if (yes !== true) {
    if (!stored) return scrub({ ok: true, code: 'Z_ADDRESS_PREVIEW', posted: false, addressHex: null });
    const addressHex = assertDerive(await derive(stored.seedHex));
    return scrub({ ok: true, code: 'Z_ADDRESS_PREVIEW', posted: false, addressHex });
  }
  let seedHex;
  if (!stored) {
    seedHex = crypto.randomBytes(64).toString('hex');
    const height = Number.isInteger(birthdayHeight) ? birthdayHeight : null;
    writeStoredAccount(file, { seedHex, birthdayHeight: height });
  } else {
    seedHex = stored.seedHex;
  }
  const addressHex = assertDerive(await derive(seedHex));
  try {
    await post({ addressHex });
  } catch (error) {
    return scrub({ ok: false, code: 'Z_ADDRESS_POST', message: safePostMessage(error, seedHex) });
  }
  return scrub({ ok: true, code: 'Z_ADDRESS_REGISTERED', posted: true, addressHex });
}

async function readLocalZAddress({ agentsDir, agentId, derive }) {
  const stored = readStoredAccount(accountFile(agentsDir, agentId));
  if (stored && stored.invalid) return scrub({ ok: false, code: 'SHIELD_ACCOUNT' });
  if (!stored) return scrub({ ok: false, code: 'Z_ADDRESS_NOT_SET' });
  const derived = await derive(stored.seedHex);
  const addressHex = assertDerive(derived);
  const changeAddress = derived.changeAddress;
  if (typeof changeAddress !== 'string' || changeAddress.length === 0 || /^[0-9a-fA-F]{86}$/.test(changeAddress)) {
    const error = new Error('Derivation did not return a payment address.');
    error.code = 'Z_ADDRESS_DERIVE';
    throw error;
  }
  return scrub({
    ok: true,
    addressHex,
    changeAddress,
    birthdayHeight: stored.birthdayHeight,
  });
}

module.exports = {
  publishIdentityZAddress,
  deriveIdentityAddress,
  readLocalZAddress,
};
