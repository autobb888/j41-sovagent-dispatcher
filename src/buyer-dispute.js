'use strict';
/**
 * Buyer cancel / dispute / rework-accept. Seller respond-dispute and the
 * refunds queue stay the money path after a refund action.
 *
 * Signing uses SDK buildDisputeMessage (J41-DISPUTE|) + signMessage; unsigned
 * REST is not a skip.
 */
const { buyerOwnsJob } = require('./hire-pay');

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function resolveFn(injected, loader) {
  if (typeof injected === 'function') return injected;
  return loader();
}

function loadBuildDisputeMessage() {
  const { buildDisputeMessage } = require('@junction41/sovagent-sdk/dist/signing/messages.js');
  return buildDisputeMessage;
}

function loadBuildReworkAcceptMessage() {
  const { buildReworkAcceptMessage } = require('@junction41/sovagent-sdk/dist/signing/messages.js');
  return buildReworkAcceptMessage;
}

function loadSignMessage() {
  const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
  return signMessage;
}

async function loadOwnedJob({ client, keys, jobId, missingCode, missingMessage }) {
  if (!client || typeof client.getJob !== 'function') {
    return fail('JOB_CLIENT_MISSING', 'Authenticated client is required.');
  }
  if (!keys || !keys.wif) {
    return fail('BUYER_NOT_REGISTERED', 'Buyer WIF is required.');
  }
  let job;
  try {
    job = await client.getJob(jobId);
  } catch (e) {
    return fail(missingCode, e.message || String(e));
  }
  if (!job || !job.id) {
    return fail(missingCode, missingMessage || `Job ${jobId} not found.`);
  }
  if (!buyerOwnsJob(keys, job)) {
    return fail('PAY_NOT_BUYER', 'This identity is not the buyer on that job.', { jobId: job.id });
  }
  return { ok: true, job };
}

async function cancelBuyerJob({ client, keys, jobId } = {}) {
  const loaded = await loadOwnedJob({
    client,
    keys,
    jobId,
    missingCode: 'CANCEL_NOT_FOUND',
    missingMessage: `Job ${jobId} not found.`,
  });
  if (!loaded.ok) return loaded;
  const { job } = loaded;
  if (String(job.status) !== 'requested') {
    return fail('CANCEL_NOT_REQUESTED', `Job status is ${job.status}, not requested.`, {
      jobId: job.id,
      status: job.status,
    });
  }
  if (typeof client.cancelJob !== 'function') {
    return fail('CANCEL_FAILED', 'Client cannot cancelJob.');
  }
  let cancelled;
  try {
    cancelled = await client.cancelJob(job.id);
  } catch (e) {
    return fail('CANCEL_FAILED', e.message || String(e), { jobId: job.id });
  }
  return {
    ok: true,
    jobId: job.id,
    status: (cancelled && cancelled.status) || 'cancelled',
    job: cancelled,
  };
}

async function disputeBuyerJob({
  client,
  keys,
  jobId,
  reason,
  signMessage: signFn,
  buildDisputeMessage: buildFn,
  network,
  now,
} = {}) {
  const text = reason == null ? '' : String(reason);
  if (!text.trim()) {
    return fail('DISPUTE_NO_REASON', '--reason is required.');
  }
  const loaded = await loadOwnedJob({
    client,
    keys,
    jobId,
    missingCode: 'DISPUTE_NOT_FOUND',
    missingMessage: `Job ${jobId} not found.`,
  });
  if (!loaded.ok) return loaded;
  const { job } = loaded;
  if (!job.jobHash) {
    return fail('DISPUTE_NO_HASH', 'Job is missing jobHash — cannot sign dispute.', { jobId: job.id });
  }
  if (typeof client.disputeJob !== 'function') {
    return fail('DISPUTE_FAILED', 'Client cannot disputeJob.');
  }

  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
  const build = resolveFn(buildFn, loadBuildDisputeMessage);
  const payload = build(job.jobHash, text, timestamp);
  if (typeof payload !== 'string' || !payload.startsWith('J41-DISPUTE|')) {
    return fail('DISPUTE_UNSIGNED', 'Refusing to send a dispute that is not J41-DISPUTE|.');
  }

  let signature;
  try {
    signature = await resolveFn(signFn, loadSignMessage)(keys.wif, payload, network);
  } catch (e) {
    return fail('DISPUTE_FAILED', e.message || String(e), { jobId: job.id });
  }
  if (typeof signature !== 'string' || !signature) {
    return fail('DISPUTE_UNSIGNED', 'Refusing to send an unsigned dispute.', { jobId: job.id });
  }

  let disputed;
  try {
    disputed = await client.disputeJob(job.id, text, signature, timestamp);
  } catch (e) {
    return fail('DISPUTE_FAILED', e.message || String(e), { jobId: job.id });
  }
  return {
    ok: true,
    jobId: job.id,
    status: (disputed && disputed.status) || 'disputed',
    job: disputed,
    timestamp,
  };
}

async function acceptBuyerRework({
  client,
  keys,
  jobId,
  signMessage: signFn,
  buildReworkAcceptMessage: buildFn,
  network,
  now,
} = {}) {
  const loaded = await loadOwnedJob({
    client,
    keys,
    jobId,
    missingCode: 'REWORK_NOT_FOUND',
    missingMessage: `Job ${jobId} not found.`,
  });
  if (!loaded.ok) return loaded;
  const { job } = loaded;
  if (!job.jobHash) {
    return fail('REWORK_NO_HASH', 'Job is missing jobHash — cannot sign rework acceptance.', { jobId: job.id });
  }
  if (typeof client.acceptRework !== 'function') {
    return fail('REWORK_FAILED', 'Client cannot acceptRework.');
  }

  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
  const build = resolveFn(buildFn, loadBuildReworkAcceptMessage);
  const payload = build({ jobHash: job.jobHash, timestamp });
  if (typeof payload !== 'string' || !payload.startsWith('J41-REWORK-ACCEPT|')) {
    return fail('REWORK_UNSIGNED', 'Refusing to send a rework-accept that is not J41-REWORK-ACCEPT|.');
  }

  let signature;
  try {
    signature = await resolveFn(signFn, loadSignMessage)(keys.wif, payload, network);
  } catch (e) {
    return fail('REWORK_FAILED', e.message || String(e), { jobId: job.id });
  }
  if (typeof signature !== 'string' || !signature) {
    return fail('REWORK_UNSIGNED', 'Refusing to send an unsigned rework-accept.', { jobId: job.id });
  }

  let result;
  try {
    result = await client.acceptRework(job.id, { timestamp, signature });
  } catch (e) {
    return fail('REWORK_FAILED', e.message || String(e), { jobId: job.id });
  }
  return {
    ok: true,
    jobId: job.id,
    status: (result && result.status) || 'rework',
    result,
    timestamp,
  };
}

function pickDisputeAction(job, dispute) {
  if (dispute && dispute.response && dispute.response.action) return dispute.response.action;
  if (dispute && dispute.action) return dispute.action;
  if (job && job.dispute && job.dispute.action) return job.dispute.action;
  return null;
}

function pickRefundTxid(job, dispute) {
  const d = dispute || {};
  const j = job || {};
  const nested = d.response || {};
  const jobDisp = j.dispute || {};
  return d.refund_txid || d.refundTxid
    || nested.refund_txid || nested.refundTxid
    || j.refund_txid || j.refundTxid
    || jobDisp.refund_txid || jobDisp.refundTxid
    || null;
}

async function inspectBuyerJob({ client, keys, jobId } = {}) {
  const loaded = await loadOwnedJob({
    client,
    keys,
    jobId,
    missingCode: 'INSPECT_NOT_FOUND',
    missingMessage: `Job ${jobId} not found.`,
  });
  if (!loaded.ok) return loaded;
  const { job } = loaded;
  let dispute = null;
  if (typeof client.getDispute === 'function') {
    try { dispute = await client.getDispute(job.id); } catch { dispute = null; }
  }
  return {
    ok: true,
    jobId: job.id,
    status: job.status,
    disputeAction: pickDisputeAction(job, dispute),
    refundTxid: pickRefundTxid(job, dispute),
    dispute,
  };
}

module.exports = {
  cancelBuyerJob,
  disputeBuyerJob,
  acceptBuyerRework,
  inspectBuyerJob,
};
