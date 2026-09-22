'use strict';
/**
 * Buyer API-session review (model grants). Job `review` is src/buyer-review.js.
 * Sign GET /v1/reviews/message?sessionId=…  J41-REVIEW-SESSION|… only.
 * Homemade J41-REVIEW|Session: is a 401 — never send it.
 * Until reviews.j41-review-v2, GET cannot return that line → REVIEW_SESSION_UNSUPPORTED.
 */
const { loadAccessGrant, persistGrantSession } = require('./buyer-access');
const { parseRating, readBuyerReviewInbox } = require('./buyer-review');

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

function httpStatus(err) {
  if (!err) return 0;
  const n = Number(err.statusCode || err.status || (err.error && err.error.statusCode));
  return Number.isFinite(n) ? n : 0;
}

function isHttp404(err) {
  return httpStatus(err) === 404;
}

function isSessionMessageUnsupported(err) {
  if (!err) return false;
  const status = httpStatus(err);
  if (status === 404 || status === 400) return true;
  const msg = String(err.message || err.code || '');
  return /MISSING_PARAMS/i.test(msg) || /jobHash/i.test(msg);
}

function isSessionCanonical(message) {
  return typeof message === 'string' && message.startsWith('J41-REVIEW-SESSION|');
}

async function getSessionReviewMessage(client, params) {
  if (!client || typeof client.request !== 'function') {
    const err = new Error('Client cannot GET /v1/reviews/message?sessionId= (SDK getReviewMessage requires jobHash).');
    err.statusCode = 400;
    err.code = 'MISSING_PARAMS';
    throw err;
  }
  const query = new URLSearchParams();
  query.set('agentVerusId', params.agentVerusId);
  query.set('sessionId', params.sessionId);
  query.set('rating', String(params.rating));
  if (params.message) query.set('message', params.message);
  if (params.timestamp != null) query.set('timestamp', String(params.timestamp));
  const res = await client.request('GET', `/v1/reviews/message?${query}`);
  return (res && res.data !== undefined) ? res.data : res;
}

function resolveSessionId({ sessionId, grant, agentsDir, buyerId, seller }) {
  const { sessionTokenFromHeader } = require('./session-token');
  let raw = sessionId || (grant && grant.sessionId) || '';
  if (!raw && agentsDir && buyerId && seller) {
    const rec = loadAccessGrant(agentsDir, buyerId, seller);
    if (rec && rec.sessionId) raw = rec.sessionId;
  }
  return raw ? sessionTokenFromHeader(String(raw)) : '';
}

function canonicalNotBound(message, sessionId, rating, seller) {
  return !message.includes(`Session:${sessionId}`)
    || !message.includes(`Rating:${rating}`)
    || !message.includes(`Agent:${seller}`);
}

async function submitBuyerApiSessionReview({
  client,
  keys,
  seller,
  rating: ratingRaw,
  message,
  sessionId,
  grant,
  agentsDir,
  buyerId,
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
    return fail('BUYER_NOT_REGISTERED', 'Buyer WIF is required to sign a session review.');
  }
  if (!client || typeof client.submitApiSessionReview !== 'function') {
    return fail('REVIEW_SESSION_UNSUPPORTED', 'Client cannot submitApiSessionReview.');
  }

  const rec = grant || ((agentsDir && buyerId && seller) ? loadAccessGrant(agentsDir, buyerId, seller) : null);
  const sid = resolveSessionId({ sessionId, grant: rec, agentsDir, buyerId, seller });
  if (!sid) {
    return fail(
      'REVIEW_SESSION_NO_SESSION',
      'No sessionId on the grant. Chat the seller first so the grant stores sessionId.',
      { seller },
    );
  }

  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Math.floor(Date.now() / 1000);
  const text = message == null ? '' : String(message);
  const fetchMessage = typeof getReviewMessage === 'function'
    ? getReviewMessage
    : (params) => getSessionReviewMessage(client, params);

  let msgResult;
  try {
    msgResult = await fetchMessage({
      agentVerusId: seller,
      sessionId: sid,
      rating,
      message: text,
      timestamp,
    });
  } catch (e) {
    if (isSessionMessageUnsupported(e)) {
      return fail(
        'REVIEW_SESSION_UNSUPPORTED',
        'GET /v1/reviews/message cannot return J41-REVIEW-SESSION| yet (gate on reviews.j41-review-v2).',
        { seller, sessionId: sid },
      );
    }
    return fail('REVIEW_FAILED', e.message || String(e), { seller, sessionId: sid });
  }
  const platformBytes = msgResult && msgResult.message;
  if (!isSessionCanonical(platformBytes)) {
    return fail(
      'REVIEW_SESSION_UNSUPPORTED',
      'Platform session-review bytes are not J41-REVIEW-SESSION|. Homemade J41-REVIEW|Session: will 401. Gate on reviews.j41-review-v2.',
      { seller, sessionId: sid },
    );
  }
  if (canonicalNotBound(platformBytes, sid, rating, seller)) {
    return fail(
      'REVIEW_NOT_CANONICAL',
      'Refusing to sign review bytes that do not bind our sessionId + rating.',
      { seller, sessionId: sid },
    );
  }
  const toSign = platformBytes;
  let signedTimestamp = timestamp;
  if (Number.isFinite(Number(msgResult.timestamp))) signedTimestamp = Number(msgResult.timestamp);

  let signature;
  try {
    signature = await resolveFn(signFn, loadSignMessage)(keys.wif, toSign, network);
  } catch (e) {
    return fail('REVIEW_FAILED', e.message || String(e), { seller, sessionId: sid });
  }
  if (typeof signature !== 'string' || !signature) {
    return fail('REVIEW_FAILED', 'Refusing to send an unsigned session review.', { seller, sessionId: sid });
  }

  const payload = {
    agentVerusId: seller,
    buyerVerusId: buyerVerusId(keys),
    sessionId: sid,
    rating,
    message: text,
    timestamp: signedTimestamp,
    signature,
  };
  const model = rec && rec.models && rec.models[0];
  if (model) payload.model = model;

  let result;
  try {
    result = await client.submitApiSessionReview(payload);
  } catch (e) {
    const msg = String(e.message || e);
    if (isHttp404(e)) {
      return fail(
        'REVIEW_SESSION_UNSUPPORTED',
        'POST /v1/reviews/api-session returned 404. Backend has not shipped API-session reviews.',
        { seller, sessionId: sid },
      );
    }
    if (/do not start with J41-/i.test(msg) || /Junction41 Review/i.test(msg)) {
      return fail(
        'REVIEW_NOT_CANONICAL',
        'Platform review bytes are not J41-…; backend must emit J41-REVIEW|. Review on the website or retry after that fix. Dispatcher will not sign Junction41 Review.',
        { seller, sessionId: sid },
      );
    }
    return fail('REVIEW_FAILED', msg, { seller, sessionId: sid });
  }

  const inbox = await readBuyerReviewInbox(client);

  return {
    ok: true,
    seller,
    sessionId: sid,
    rating,
    result,
    timestamp: signedTimestamp,
    ...inbox,
  };
}

module.exports = {
  submitBuyerApiSessionReview,
  persistGrantSession,
  parseRating,
  getSessionReviewMessage,
};
