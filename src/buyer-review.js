'use strict';
/**
 * Buyer job review. Sign GET /v1/reviews/message?jobHash=…  J41-REVIEW|… only.
 * Homemade J41-REVIEW| or Junction41 Review is REVIEW_NOT_CANONICAL — never send it.
 * POST via client.submitReview (HTTP). Do not wrap the SDK agent helper
 * (it GETs again with its own timestamp). After 2xx, read buyer inbox only;
 * never write buyer VDXF.
 */
const { buyerOwnsJob } = require('./hire-pay');

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function resolveFn(injected, loader) {
  if (typeof injected === 'function') return injected;
  return loader();
}

function loadSignMessage() {
  const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
  return signMessage;
}

function buyerVerusId(keys) {
  if (keys && keys.identity) {
    return keys.identity.endsWith('@') ? keys.identity : `${keys.identity}@`;
  }
  return (keys && keys.iAddress) || '';
}

/** Integer 1-5 only. Reject 1.5, 01, 1.0, empty — Number.isInteger after /^[1-5]$/. */
function parseRating(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^[1-5]$/.test(s)) return null;
  const rating = Number(s);
  if (!Number.isInteger(rating)) return null;
  return rating;
}

function isJobCanonical(message) {
  return typeof message === 'string' && message.startsWith('J41-REVIEW|');
}

function canonicalNotBound(message, jobHash, rating, seller) {
  return !message.includes(String(jobHash))
    || !message.includes(String(rating))
    || !message.includes('Agent:')
    || !message.includes(String(seller));
}

function inboxItems(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

async function getJobReviewMessage(client, params) {
  if (!client || typeof client.request !== 'function') {
    const err = new Error('Client cannot GET /v1/reviews/message?jobHash=.');
    err.statusCode = 400;
    err.code = 'MISSING_PARAMS';
    throw err;
  }
  const query = new URLSearchParams();
  query.set('agentVerusId', params.agentVerusId);
  query.set('jobHash', params.jobHash);
  query.set('rating', String(params.rating));
  if (params.message) query.set('message', params.message);
  if (params.timestamp != null) query.set('timestamp', String(params.timestamp));
  const res = await client.request('GET', `/v1/reviews/message?${query}`);
  return (res && res.data !== undefined) ? res.data : res;
}

async function submitBuyerJobReview({
  client,
  keys,
  jobId,
  rating: ratingRaw,
  message,
  signMessage: signFn,
  getReviewMessage,
  network,
  now,
} = {}) {
  const rating = parseRating(ratingRaw);
  if (rating == null) {
    return fail('REVIEW_BAD_RATING', '--rating must be an integer 1-5.');
  }
  if (!keys || !keys.wif) {
    return fail('BUYER_NOT_REGISTERED', 'Buyer WIF is required to sign a job review.');
  }
  if (!client || typeof client.submitReview !== 'function') {
    return fail('REVIEW_FAILED', 'Client cannot submitReview.');
  }
  if (typeof client.getJob !== 'function') {
    return fail('REVIEW_FAILED', 'Client cannot getJob.');
  }

  let job;
  try {
    job = await client.getJob(jobId);
  } catch (e) {
    return fail('REVIEW_NOT_COMPLETED', e.message || String(e));
  }
  if (!job || !job.id) {
    return fail('REVIEW_NOT_COMPLETED', `Job ${jobId} not found.`);
  }
  if (!buyerOwnsJob(keys, job)) {
    return fail('PAY_NOT_BUYER', 'This identity is not the buyer on that job.', { jobId: job.id });
  }
  if (job.status !== 'completed') {
    return fail('REVIEW_NOT_COMPLETED', `Job status is ${job.status}, not completed.`, {
      jobId: job.id,
      status: job.status,
    });
  }
  const jobHash = job.jobHash;
  if (!jobHash) {
    return fail('REVIEW_FAILED', 'Job is missing jobHash — cannot sign review.', { jobId: job.id });
  }
  const seller = job.sellerVerusId || job.seller;
  if (!seller) {
    return fail('REVIEW_FAILED', 'Job is missing seller VerusID.', { jobId: job.id });
  }

  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
  const text = message == null ? '' : String(message);
  const fetchMessage = typeof getReviewMessage === 'function'
    ? getReviewMessage
    : (params) => getJobReviewMessage(client, params);

  let msgResult;
  try {
    msgResult = await fetchMessage({
      agentVerusId: seller,
      jobHash,
      rating,
      message: text,
      timestamp,
    });
  } catch (e) {
    return fail('REVIEW_FAILED', e.message || String(e), { jobId: job.id });
  }
  const platformBytes = msgResult && msgResult.message;
  if (!isJobCanonical(platformBytes) || /Junction41 Review/i.test(String(platformBytes || ''))) {
    return fail(
      'REVIEW_NOT_CANONICAL',
      'Platform review bytes are not J41-…; backend must emit J41-REVIEW|. Review on the website or retry after that fix. Dispatcher will not sign Junction41 Review.',
      { jobId: job.id },
    );
  }
  if (canonicalNotBound(platformBytes, jobHash, rating, seller)) {
    return fail(
      'REVIEW_NOT_CANONICAL',
      'Refusing to sign review bytes that do not bind our jobHash + rating.',
      { jobId: job.id },
    );
  }
  const toSign = platformBytes;
  let signedTimestamp = timestamp;
  if (msgResult && Number.isFinite(Number(msgResult.timestamp))) {
    signedTimestamp = Number(msgResult.timestamp);
  }

  let signature;
  try {
    signature = await resolveFn(signFn, loadSignMessage)(keys.wif, toSign, network);
  } catch (e) {
    return fail('REVIEW_FAILED', e.message || String(e), { jobId: job.id });
  }
  if (typeof signature !== 'string' || !signature) {
    return fail('REVIEW_FAILED', 'Refusing to send an unsigned job review.', { jobId: job.id });
  }

  const payload = {
    agentVerusId: seller,
    buyerVerusId: buyerVerusId(keys),
    jobHash,
    rating,
    message: text,
    timestamp: signedTimestamp,
    signature,
  };

  let result;
  try {
    result = await client.submitReview(payload);
  } catch (e) {
    const msg = String(e.message || e);
    if (/do not start with J41-/i.test(msg) || /Junction41 Review/i.test(msg)) {
      return fail(
        'REVIEW_NOT_CANONICAL',
        'Platform review bytes are not J41-…; backend must emit J41-REVIEW|. Review on the website or retry after that fix. Dispatcher will not sign Junction41 Review.',
        { jobId: job.id },
      );
    }
    return fail('REVIEW_FAILED', msg, { jobId: job.id });
  }

  let inboxCount = 0;
  let inboxWarning;
  try {
    const inbox = await client.getInbox('pending', 20, ['review', 'attestation']);
    inboxCount = inboxItems(inbox).length;
    if (inboxCount === 0) inboxWarning = 'BUYER_INBOX_EMPTY';
  } catch {
    inboxWarning = 'BUYER_INBOX_READ_FAILED';
  }

  return {
    ok: true,
    jobId: job.id,
    rating,
    result,
    inboxCount,
    timestamp: signedTimestamp,
    ...(inboxWarning ? { inboxWarning } : {}),
  };
}

module.exports = {
  submitBuyerJobReview,
  parseRating,
  getJobReviewMessage,
};
