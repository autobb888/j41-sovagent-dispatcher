'use strict';

/**
 * Broadcast a VRSCTEST round trip of one agent's own coins.
 *
 * When a shielded note is already visible it is spent back to that agent's
 * R-address. Otherwise the R-address shields the requested amount, the note
 * is read from lightwalletd, and that note is spent back. Notes are not
 * written down. The spending key stays inside the caller-supplied deps.
 */

const { planOwnNoteProof, buildT2zSpec, COIN_TYPE } = require('./shield-proof');
const { parseV4, signTransparentInputs } = require('./sapling-sign');

const DUST_SATS = 1000;
const POLL_ATTEMPTS = 30;
const POLL_MS = 20_000;

function fail(code, message, extra) {
  return { ok: false, code, message, broadcast: false, hire: false, ...extra };
}

function selectOwnInputs(utxos, rAddress, outputScriptHex, needSats) {
  const own = (Array.isArray(utxos) ? utxos : []).filter((utxo) => {
    return utxo && utxo.address === rAddress && Number.isSafeInteger(utxo.satoshis) && utxo.satoshis > 0;
  });
  const wanted = String(outputScriptHex || '').toLowerCase();
  const matching = own.filter((utxo) => String(utxo.script || '').toLowerCase() === wanted && wanted);
  if (own.length > 0 && matching.length === 0) {
    return fail('SHIELD_SCRIPT', 'The R-address coins are not the script derived from this key.');
  }
  const ordered = matching.slice().sort((a, b) => b.satoshis - a.satoshis);
  const picked = [];
  let total = 0;
  for (const utxo of ordered) {
    if (total > Number.MAX_SAFE_INTEGER - utxo.satoshis) break;
    picked.push(utxo);
    total += utxo.satoshis;
    if (total >= needSats) break;
  }
  if (total < needSats) {
    return fail('SHIELD_FUNDS', 'The R-address does not have enough confirmed coins for this amount and fee.', {
      haveSats: total,
      needSats,
    });
  }
  return { ok: true, inputs: picked, inputSats: total };
}

function fundShield({ inputs, inputSats, amountSats, feeSats, changeScriptHex, recipientHex, expiryHeight }) {
  let changeSats = inputSats - amountSats - feeSats;
  let actualFee = feeSats;
  if (changeSats < 0) {
    return fail('SHIELD_FUNDS', 'The selected coins do not cover the shielded amount and fee.');
  }
  if (changeSats <= DUST_SATS) {
    actualFee += changeSats;
    changeSats = 0;
  }
  return buildT2zSpec({
    inputs: inputs.map((utxo) => ({ txid: utxo.txid, vout: utxo.vout })),
    inputSats,
    valueSats: amountSats,
    changeSats,
    changeScriptHex: changeSats > 0 ? changeScriptHex : undefined,
    feeSats: actualFee,
    recipientHex,
    expiryHeight,
  });
}

async function spendNote(req, deps, pub, note, createdNote, shieldTxid) {
  const returnedSats = note.valueSats - req.feeSats;
  if (!Number.isSafeInteger(returnedSats) || returnedSats <= 0) {
    return fail('SHIELD_FEE', 'The note is not larger than the fee.');
  }
  const hex = await deps.spend({
    txid: note.txid,
    outputIndex: note.outputIndex,
    valueSats: note.valueSats,
    returnedSats,
    scriptHex: req.outputScriptHex,
    feeSats: req.feeSats,
  });
  if (!hex || typeof hex !== 'string') return fail('SHIELD_SPEND', 'The shielded spend did not produce a transaction.');
  const sent = await deps.broadcast(hex);
  if (!sent || !sent.txid) return fail('SHIELD_BROADCAST', 'The spend was rejected.', { createdNote, shieldTxid });
  return {
    ok: true,
    code: 'SHIELD_PROOF_SPENT',
    broadcast: true,
    hire: false,
    createdNote,
    zsAddress: pub.address,
    rAddress: req.rAddress,
    shieldTxid: shieldTxid || null,
    spendTxid: sent.txid,
    noteValueSats: note.valueSats,
    returnedSats,
    feeSats: req.feeSats,
    message: 'The note was spent back to the same R-address.',
  };
}

async function runOwnNoteProof(req, deps) {
  const src = req || {};
  const early = planOwnNoteProof({
    network: src.network,
    coinType: src.coinType == null ? COIN_TYPE : src.coinType,
    amountSats: src.amountSats,
    feeSats: src.feeSats,
    memo: src.memo || '',
    cachedNote: src.cachedNote === true,
  });
  if (early.code !== 'SHIELD_PROOF_NOT_READY') return early;
  if (!Number.isSafeInteger(src.amountSats + src.feeSats)) {
    return fail('SHIELD_AMOUNT', 'The shielded amount and fee do not fit in a satoshi total.');
  }
  if (typeof src.lightwalletdUrl !== 'string' || !src.lightwalletdUrl) {
    return fail('SHIELD_LIGHTWALLETD', 'Set a Verus lightwalletd host:port. This program does not run one.');
  }
  if (typeof src.rAddress !== 'string' || typeof src.outputScriptHex !== 'string') {
    return fail('SHIELD_ADDRESS', 'The R-address derived from the key is missing.');
  }

  const existing = await deps.readAccount();
  if (!src.yes) {
    const pub = existing ? await deps.prepare(existing) : null;
    return {
      ok: true,
      code: 'SHIELD_PROOF_PREVIEW',
      broadcast: false,
      hire: false,
      zsAddress: pub ? pub.address : null,
      rAddress: src.rAddress,
      amountSats: src.amountSats,
      feeSats: src.feeSats,
      account: existing ? 'present' : 'absent',
      message: existing
        ? 'Pass --yes to broadcast this round trip.'
        : 'Pass --yes to create the shielded account and broadcast this round trip.',
    };
  }

  const ready = await deps.ready();
  if (!ready || ready.ok === false) {
    return fail(ready && ready.code ? ready.code : 'SHIELD_PARAMS', ready && ready.message ? ready.message : 'The Sapling parameters are not available.');
  }

  let account = existing;
  if (!account) {
    const tip = await deps.tip();
    if (!Number.isInteger(tip) || tip < 1) return fail('SHIELD_TIP', 'The chain tip is not available.');
    account = { seedHex: deps.randomSeed(), birthdayHeight: tip };
    await deps.writeAccount(account);
  }
  const pub = await deps.prepare(account);
  if (!pub || typeof pub.address !== 'string' || typeof pub.addressHex !== 'string') {
    return fail('SHIELD_ACCOUNT', 'The shielded account did not produce an address.');
  }
  const birthday = Number.isInteger(account.birthdayHeight) && account.birthdayHeight > 0
    ? account.birthdayHeight
    : await deps.tip();

  const visible = await deps.scan(birthday);
  const spendable = (Array.isArray(visible) ? visible : [])
    .filter((note) => note && Number.isSafeInteger(note.valueSats) && note.valueSats > src.feeSats)
    .sort((a, b) => a.height - b.height);
  if (spendable.length) return spendNote(src, deps, pub, spendable[0], false, null);

  const tip = await deps.tip();
  if (!Number.isInteger(tip) || tip < 1) return fail('SHIELD_TIP', 'The chain tip is not available.');
  const coins = await deps.utxos();
  const need = src.amountSats + src.feeSats;
  const picked = selectOwnInputs(coins, src.rAddress, src.outputScriptHex, need);
  if (!picked.ok) return picked;
  const funded = fundShield({
    inputs: picked.inputs,
    inputSats: picked.inputSats,
    amountSats: src.amountSats,
    feeSats: src.feeSats,
    changeScriptHex: src.outputScriptHex,
    recipientHex: pub.addressHex,
    expiryHeight: tip + 60,
  });
  if (!funded.ok) return funded;

  const unsigned = await deps.shield(funded.spec);
  let parsed;
  try {
    parsed = parseV4(unsigned);
  } catch (error) {
    return fail('SHIELD_TX_SHAPE', error.message);
  }
  if (parsed.valueBalance !== -BigInt(src.amountSats)) {
    return fail('SHIELD_TX_SHAPE', 'The shielded transaction does not move the requested amount.');
  }
  const signed = signTransparentInputs({
    hex: unsigned,
    wif: src.wif,
    networkName: 'verustest',
    prevouts: picked.inputs.map((utxo) => ({
      script: Buffer.from(utxo.script, 'hex'),
      satoshis: utxo.satoshis,
    })),
  });
  if (!signed.ok) return signed;
  const spentInputs = picked.inputs.map((utxo) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    address: utxo.address,
  }));
  let shielded;
  try {
    shielded = await deps.broadcast(signed.hex);
  } catch (error) {
    return fail('SHIELD_BROADCAST', error && error.message ? error.message : 'The shield was rejected.', {
      inputs: spentInputs,
    });
  }
  if (!shielded || !shielded.txid) {
    return fail('SHIELD_BROADCAST', 'The shield was rejected.', { inputs: spentInputs });
  }

  let found = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const seen = await deps.scan(birthday);
    const notes = Array.isArray(seen) ? seen : [];
    found = notes.find((note) => note && note.txid === shielded.txid && note.valueSats === src.amountSats)
      || notes.find((note) => note && note.valueSats === src.amountSats);
    if (found) break;
    if (attempt + 1 < POLL_ATTEMPTS) await deps.wait(POLL_MS);
  }
  if (!found) {
    return {
      ok: false,
      code: 'SHIELD_NOTE_UNSEEN',
      broadcast: true,
      hire: false,
      shieldTxid: shielded.txid,
      zsAddress: pub.address,
      rAddress: src.rAddress,
      message: 'The shield was broadcast. The note is not visible yet. Run the same command again once it is.',
    };
  }
  return spendNote(src, deps, pub, found, true, shielded.txid);
}

module.exports = {
  selectOwnInputs,
  fundShield,
  runOwnNoteProof,
  POLL_ATTEMPTS,
  POLL_MS,
};
