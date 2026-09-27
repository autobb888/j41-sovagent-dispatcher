'use strict';

/**
 * Phase B first proof, on the dispatcher only.
 *
 * The proof spends a shielded note this process can already see back to the
 * same identity's transparent R-address. Hire payments stay on the existing
 * transparent path. This module builds the plan and the t→z request. It does
 * not broadcast, does not read a key, and does not keep a note for later.
 *
 * Derivation is ZIP-32 m/32'/133'/0' on VRSCTEST and on mainnet. Coin type 1
 * is the stock Zcash testnet path and is refused. The spending key is a
 * BIP-39 seed, separate from the WIF, and it stays in this process.
 */

const COIN_TYPE = 133;
const STOCK_ZCASH_TESTNET_COIN_TYPE = 1;
const ZIP32_PATH = "m/32'/133'/0'";
const CONSENSUS_BRANCH_ID = 0x76b809bb;
const MEMO_MAX_BYTES = 512;

const PARAM_SHA256 = Object.freeze({
  spend: '8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13',
  output: '2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4',
});

const SECRET_KEYS = new Set([
  'extskhex',
  'extsk_hex',
  'dfvkhex',
  'dfvk_hex',
  'wif',
  'seed',
  'seedhex',
  'mnemonic',
  'ivk',
  'spendingkey',
  'viewingkey',
  'phrase',
]);

function isSats(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Sum satoshi counts without a float crossing. Null when any part is not a
 *  safe non-negative integer or the total no longer fits in one. */
function satsSum(parts) {
  let total = 0n;
  for (const part of parts) {
    if (!isSats(part)) return null;
    total += BigInt(part);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(total);
}

/** Mainnet stays mainnet even when the effective network string was overridden. */
function networkForProof(isMainnet, effectiveNetwork) {
  return isMainnet ? 'verus' : effectiveNetwork;
}

function memoBytes(memo) {
  return Buffer.byteLength(String(memo == null ? '' : memo), 'utf8');
}

function findKeyMaterial(value, path = '$', hits = []) {
  if (!value || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((item, i) => findKeyMaterial(item, `${path}[${i}]`, hits));
    return hits;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(String(key).toLowerCase())) hits.push(`${path}.${key}`);
    else findKeyMaterial(child, `${path}.${key}`, hits);
  }
  return hits;
}

function refuse(code, message, extra) {
  return { ok: false, code, message, broadcast: false, hire: false, fleetSend: false, ...extra };
}

function planOwnNoteProof(input) {
  const src = input || {};
  const leaked = findKeyMaterial(src.outbound);
  if (leaked.length) {
    return refuse('SHIELD_KEY_LEAK', 'A scan or spend key was placed in the outbound payload.', { fields: leaked });
  }
  if (src.network === 'verus') {
    return refuse('SHIELD_MAINNET_REFUSED', 'This proof runs on VRSCTEST.');
  }
  if (src.network !== 'verustest') {
    return refuse('SHIELD_NETWORK', 'The network must be verustest.');
  }
  if (src.coinType !== COIN_TYPE) {
    const stock = src.coinType === STOCK_ZCASH_TESTNET_COIN_TYPE;
    return refuse(
      'SHIELD_COIN_TYPE',
      stock
        ? `Coin type ${STOCK_ZCASH_TESTNET_COIN_TYPE} is the stock Zcash testnet path. This proof uses ${ZIP32_PATH}.`
        : `This proof uses ${ZIP32_PATH}.`,
    );
  }
  if (src.cachedNote === true || src.cachedWitness === true) {
    return refuse('SHIELD_NOTE_CACHE_REFUSED', 'The witness is fetched at spend time.');
  }
  const bytes = memoBytes(src.memo);
  if (bytes > MEMO_MAX_BYTES) {
    return refuse('SHIELD_MEMO_TOO_LONG', `A memo is at most ${MEMO_MAX_BYTES} bytes.`);
  }
  if (bytes !== 0) {
    return refuse('SHIELD_MEMO_REFUSED', 'This proof uses an empty memo.');
  }
  if (!isSats(src.amountSats) || src.amountSats <= 0) {
    return refuse('SHIELD_AMOUNT', 'The shielded amount must be a positive number of satoshis.');
  }
  if (!isSats(src.feeSats) || src.feeSats <= 0 || src.feeSats >= src.amountSats) {
    return refuse('SHIELD_FEE', 'The fee must be a positive satoshi amount smaller than the note.');
  }

  const spending = src.ownRAddress != null || src.toRAddress != null || src.zsAddress != null;
  if (spending) {
    if (src.toRAddress !== src.ownRAddress) {
      return refuse('SHIELD_NOT_OWN_OUTPUT', 'The transparent output is this identity\'s own R-address.');
    }
    if (typeof src.ownRAddress !== 'string' || !/^R[1-9A-HJ-NP-Za-km-z]{20,40}$/.test(src.ownRAddress)) {
      return refuse('SHIELD_ADDRESS', 'The R-address is missing.');
    }
    if (typeof src.zsAddress !== 'string' || !/^zs1[02-9ac-hj-np-z]{20,120}$/.test(src.zsAddress)) {
      return refuse('SHIELD_ADDRESS', 'The shielded address is missing.');
    }
  }

  const missing = [];
  if (!src.hasSeed) missing.push('seed');
  if (!src.hasParams) missing.push('params');
  if (typeof src.lightwalletdUrl !== 'string' || !src.lightwalletdUrl) missing.push('lightwalletd');
  if (!spending) missing.push('account');

  const steps = [
    {
      id: 't2z',
      needsWitness: false,
      memo: '',
      amountSats: src.amountSats,
      feeSats: src.feeSats,
      sign: 'transparent-inputs-in-process',
    },
    { id: 'scan', key: 'dfvk', from: 'birthday', cache: false },
    {
      id: 'z2t',
      needsWitness: true,
      witness: 'fresh',
      memo: '',
      to: 'own-r',
      feeSats: src.feeSats,
    },
  ];

  const netFeeSats = satsSum([src.feeSats, src.feeSats]);
  if (netFeeSats == null) {
    return refuse('SHIELD_FEE', 'The two fees do not fit in a satoshi total.');
  }

  const base = {
    broadcast: false,
    hire: false,
    fleetSend: false,
    path: ZIP32_PATH,
    branchId: CONSENSUS_BRANCH_ID,
    netFeeSats,
    steps,
  };

  if (missing.length) {
    return {
      ...base,
      ok: false,
      code: 'SHIELD_PROOF_NOT_READY',
      message: 'The proof is not ready to broadcast.',
      missing,
    };
  }

  return {
    ...base,
    ok: true,
    code: 'SHIELD_PROOF_READY',
    message: 'The VRSCTEST round trip is allowed. This plan does not broadcast.',
    missing: [],
  };
}

function buildT2zSpec(input) {
  const src = input || {};
  const leaked = findKeyMaterial(src);
  if (leaked.length) {
    return refuse('SHIELD_KEY_LEAK', 'The t→z request contained key material.', { fields: leaked });
  }
  if (!isSats(src.valueSats) || src.valueSats <= 0) {
    return refuse('SHIELD_AMOUNT', 'The shielded output must be a positive number of satoshis.');
  }
  if (!isSats(src.feeSats) || src.feeSats <= 0) {
    return refuse('SHIELD_FEE', 'The t→z fee must be a positive number of satoshis.');
  }
  if (!isSats(src.inputSats) || src.inputSats <= 0) {
    return refuse('SHIELD_AMOUNT', 'The transparent inputs must name a positive satoshi total.');
  }
  const changeSats = src.changeSats == null ? 0 : src.changeSats;
  if (!isSats(changeSats)) {
    return refuse('SHIELD_AMOUNT', 'Change must be a non-negative number of satoshis.');
  }
  const need = satsSum([src.valueSats, changeSats, src.feeSats]);
  if (need == null) {
    return refuse('SHIELD_AMOUNT', 'The shielded output, change, and fee do not fit in a satoshi total.');
  }
  if (src.inputSats !== need) {
    return refuse('SHIELD_UNBALANCED', 'Transparent inputs must equal the shielded output, change, and fee.');
  }
  if (typeof src.recipientHex !== 'string' || !/^[0-9a-f]{86}$/i.test(src.recipientHex)) {
    return refuse('SHIELD_ADDRESS', 'The shielded recipient is 43 bytes, hex.');
  }
  if (!Array.isArray(src.inputs) || src.inputs.length === 0) {
    return refuse('SHIELD_INPUTS', 'The t→z request needs at least one transparent input.');
  }
  const inputs = [];
  for (const inputRow of src.inputs) {
    if (!inputRow || typeof inputRow.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(inputRow.txid)) {
      return refuse('SHIELD_INPUTS', 'Each input txid is 32 bytes, hex.');
    }
    if (!Number.isInteger(inputRow.vout) || inputRow.vout < 0) {
      return refuse('SHIELD_INPUTS', 'Each input vout is a non-negative integer.');
    }
    inputs.push({
      txid_display: inputRow.txid.toLowerCase(),
      vout: inputRow.vout,
      sequence: Number.isInteger(inputRow.sequence) ? inputRow.sequence : 0xffffffff,
    });
  }
  if (!Number.isInteger(src.expiryHeight) || src.expiryHeight <= 0) {
    return refuse('SHIELD_EXPIRY', 'The expiry height must be a block height.');
  }
  if (changeSats > 0 && (typeof src.changeScriptHex !== 'string' || !/^[0-9a-f]+$/i.test(src.changeScriptHex))) {
    return refuse('SHIELD_ADDRESS', 'Change needs the script for this identity\'s own R-address.');
  }

  const spec = {
    inputs,
    outputs: changeSats > 0 ? [{ value: changeSats, script_hex: src.changeScriptHex.toLowerCase() }] : [],
    shielded: [{ recipient_hex: src.recipientHex.toLowerCase(), value: src.valueSats, memo: '' }],
    lock_time: 0,
    expiry_height: src.expiryHeight,
    branch_id: CONSENSUS_BRANCH_ID,
  };
  return { ok: true, code: 'SHIELD_T2Z_SPEC', broadcast: false, spec };
}

function localKeyHandle(hex, bytes, code) {
  if (typeof hex !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(hex)) {
    return { ok: false, code, present: false };
  }
  return { ok: true, code, present: true };
}

module.exports = {
  COIN_TYPE,
  STOCK_ZCASH_TESTNET_COIN_TYPE,
  ZIP32_PATH,
  CONSENSUS_BRANCH_ID,
  MEMO_MAX_BYTES,
  PARAM_SHA256,
  findKeyMaterial,
  networkForProof,
  planOwnNoteProof,
  buildT2zSpec,
  scanHandle: (dfvkHex) => localKeyHandle(dfvkHex, 128, 'SHIELD_VIEW_KEY'),
  spendHandle: (extskHex) => localKeyHandle(extskHex, 169, 'SHIELD_SPEND_KEY'),
};
