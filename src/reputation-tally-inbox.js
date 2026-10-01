'use strict';

const RECORD_ID = 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad';
const TALLY_ID = 'i5rdLDZkDHRax2x1UYavwfViR1cE81fjVw';
const PROSE_ID = 'i6bAtZMcPqgJq7VJQx8ysADCs4CW3LJz76';

const FORBIDDEN_FIELDS = [
  'buyer',
  'buyerVerusId',
  'zaddress',
  'address',
  'jobHash',
  'amount',
  'completedAt',
];

function reputationTallyKeys() {
  if (RECORD_ID !== 'iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad') {
    throw new Error('reputation tally note record id is not iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad');
  }
  return { tally: TALLY_ID, prose: PROSE_ID, recordId: RECORD_ID };
}

function readVdxfMap(item) {
  if (item && item.vdxfData != null && typeof item.vdxfData !== 'string') {
    if (typeof item.vdxfData !== 'object' || Array.isArray(item.vdxfData)) {
      throw new Error('reputation_tally vdxfData is not an object');
    }
    return item.vdxfData;
  }
  const raw = item && (item.vdxf_data != null ? item.vdxf_data : item.vdxfData);
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('reputation_tally vdxf_data is not an object');
    }
    return parsed;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  throw new Error('reputation_tally inbox item has no vdxf data');
}

function assertPublishable(hex, label) {
  const text = Buffer.from(hex, 'hex').toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`reputation_tally ${label} is not JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`reputation_tally ${label} is not an object`);
  }
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) {
      throw new Error(`reputation_tally ${label} carries forbidden field ${field}`);
    }
  }
}

function planReputationTallyAdditions(item, keys) {
  if (!keys || typeof keys.tally !== 'string' || keys.tally.length === 0) {
    throw new Error('reputation_tally keys.tally is required');
  }
  const data = readVdxfMap(item);
  const tallyHex = data[keys.tally];
  if (typeof tallyHex !== 'string' || tallyHex.length === 0) {
    throw new Error('reputation_tally inbox item is missing the tally hex');
  }
  assertPublishable(tallyHex, 'tally');
  const additions = { [keys.tally]: [tallyHex] };
  if (typeof keys.prose === 'string' && keys.prose.length > 0) {
    const proseHex = data[keys.prose];
    if (typeof proseHex === 'string' && proseHex.length > 0) {
      assertPublishable(proseHex, 'prose');
      additions[keys.prose] = [proseHex];
    }
  }
  return additions;
}

async function acceptReputationTallyItem(item, deps) {
  // Legacy dispatchInboxAccept has no writer. Throw before planning so a
  // { id, type } ref, which has no hex, still surfaces this error.
  if (!deps || typeof deps.writeIdentityAdditions !== 'function') {
    throw new Error('reputation_tally write is not wired');
  }
  const additions = planReputationTallyAdditions(item, deps.keys);
  await deps.writeIdentityAdditions(additions);
  return { accepted: true };
}

function splitInboxBatch(items) {
  const chain = [];
  const tally = [];
  for (const it of items || []) {
    if (it && it.type === 'reputation_tally') tally.push(it);
    else chain.push(it);
  }
  return { chain, tally };
}

function tallyWriteShouldCountItem(classification, batchRecord) {
  return classification === 'hard' && !!(batchRecord && batchRecord.escalate);
}

function sameHexOnIdentity(onChain, additions, valueAlreadyOnChain) {
  const keys = Object.keys(additions || {});
  if (keys.length === 0 || typeof valueAlreadyOnChain !== 'function') return false;
  return keys.every((key) => valueAlreadyOnChain(onChain, key, additions[key]));
}

async function ackTallyItem(client, item, txid) {
  if (!item || !item.id || !client || typeof client.acceptInboxItem !== 'function') {
    return { acked: false };
  }
  try {
    await client.acceptInboxItem(item.id, txid == null ? undefined : txid);
    return { acked: true };
  } catch (e) {
    let already = e && e.code === 'ALREADY_PROCESSED';
    if (!already) {
      try {
        const { isAlreadyProcessed } = require('@junction41/sovagent-sdk/dist/index.js');
        already = isAlreadyProcessed(e);
      } catch { /* the code check above is enough when the SDK cannot load */ }
    }
    if (already) return { acked: true, alreadyProcessed: true };
    return { acked: false, ackFailed: true, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Write the two tally keys with buildIdentityUpdateTx. Ack without a second
 * broadcast when that hex is already on the identity. An environmental build
 * or wallet failure is rethrown so the caller can use the batch hard/transient
 * split instead of striking the item on the first failure.
 */
async function writeReputationTallyAdditions(additions, item, opts = {}) {
  const client = opts.client;
  if (!client || typeof client.getIdentityRaw !== 'function'
    || typeof client.getUtxos !== 'function' || typeof client.broadcast !== 'function') {
    throw new Error('reputation_tally write is not wired');
  }
  const sdk = opts.sdk || null;
  const valueAlreadyOnChain = opts.valueAlreadyOnChain
    || (sdk && sdk.valueAlreadyOnChain)
    || require('@junction41/sovagent-sdk/dist/index.js').valueAlreadyOnChain;
  const idRes = await client.getIdentityRaw();
  const identityData = idRes && idRes.data ? idRes.data : idRes;
  const onChain = (identityData && identityData.identity && identityData.identity.contentmultimap) || {};
  if (sameHexOnIdentity(onChain, additions, valueAlreadyOnChain)) {
    const ack = await ackTallyItem(client, item, null);
    return {
      accepted: !!ack.acked,
      broadcast: false,
      alreadyOnChain: true,
      txid: null,
      ackFailed: !!ack.ackFailed,
      error: ack.error,
    };
  }
  if (opts.deferBroadcast) {
    return { deferred: true, reason: 'identity batch this cycle' };
  }
  const utxoData = await client.getUtxos();
  const utxos = (utxoData && utxoData.utxos) || [];
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error('No UTXOs available — wallet is empty or all outputs are unconfirmed');
  }
  const buildIdentityUpdateTx = opts.buildIdentityUpdateTx
    || (sdk && sdk.buildIdentityUpdateTx)
    || require('@junction41/sovagent-sdk/dist/index.js').buildIdentityUpdateTx;
  const computeExpiryHeight = opts.computeExpiryHeight
    || (sdk && sdk.computeExpiryHeight)
    || require('@junction41/sovagent-sdk/dist/index.js').computeExpiryHeight;
  let expiryDelta = opts.expiryDelta;
  if (expiryDelta == null) {
    expiryDelta = require('@junction41/sovagent-sdk/dist/identity/update.js').IDENTITY_EXPIRY_DELTA;
  }
  let expiryHeight;
  if (typeof client.getChainInfo === 'function' && typeof computeExpiryHeight === 'function') {
    const ci = await client.getChainInfo();
    const tip = ci && (ci.blockHeight != null ? ci.blockHeight : (ci.data && ci.data.blockHeight));
    expiryHeight = computeExpiryHeight(tip, expiryDelta);
  }
  const buildArgs = {
    wif: opts.wif,
    identityData,
    utxos,
    network: opts.network,
    expiryHeight,
  };
  let signed;
  try {
    signed = buildIdentityUpdateTx({ ...buildArgs, vdxfAdditions: additions });
  } catch (buildErr) {
    try {
      buildIdentityUpdateTx({ ...buildArgs, vdxfAdditions: Object.create(null) });
    } catch {
      throw buildErr;
    }
    const err = new Error(`tx build failed: ${buildErr && buildErr.message ? buildErr.message : buildErr}`);
    err.code = 'TALLY_TX_BUILD';
    throw err;
  }
  const broadcastResult = await client.broadcast(signed);
  const txid = typeof broadcastResult === 'string'
    ? broadcastResult
    : (broadcastResult && broadcastResult.txid);
  const ack = await ackTallyItem(client, item, txid);
  return {
    accepted: !!ack.acked,
    broadcast: true,
    alreadyOnChain: false,
    txid: txid || null,
    expiryHeight: expiryHeight ?? null,
    ackFailed: !!ack.ackFailed,
    error: ack.error,
  };
}

module.exports = {
  planReputationTallyAdditions,
  acceptReputationTallyItem,
  reputationTallyKeys,
  splitInboxBatch,
  tallyWriteShouldCountItem,
  writeReputationTallyAdditions,
};
