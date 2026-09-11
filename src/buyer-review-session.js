'use strict';
/**
 * Buyer API-session review (model grants). Job `review` stays on submitReview.
 * Always signs J41-REVIEW|…; never rewrites platform `Junction41 Review`.
 * POST /v1/reviews/api-session 404 → REVIEW_SESSION_UNSUPPORTED (backend).
 */
const { loadAccessGrant, persistGrantSession } = require('./buyer-access');

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

function parseRating(raw) {
  const rating = parseInt(String(raw), 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
  return rating;
}

function isHttp404(err) {
  if (!err) return false;
  const status = err.statusCode || err.status;
  if (Number(status) === 404) return true;
  if (err.error && Number(err.error.statusCode) === 404) return true;
  return false;
}

function isNonCanonicalReview(message) {
  return typeof message !== 'string' || !/^J41-/.test(message);
}

function resolveSessionId({ sessionId, grant, agentsDir, buyerId, seller }) {
  if (sessionId) return String(sessionId);
  if (grant && grant.sessionId) return String(grant.sessionId);
  if (agentsDir && buyerId && seller) {
    const rec = loadAccessGrant(agentsDir, buyerId, seller);
    if (rec && rec.sessionId) return String(rec.sessionId);
  }
  return '';
}

function canonicalNotBound(message, sessionId, rating) {
  return !message.includes(String(sessionId)) || !message.includes(String(rating));
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
  let toSign = `J41-REVIEW|Session:${sid}|Rating:${rating}|Ts:${timestamp}|${text}`;
  let signedTimestamp = timestamp;

  if (typeof getReviewMessage === 'function') {
    let msgResult;
    try {
      msgResult = await getReviewMessage({
        agentVerusId: seller,
        sessionId: sid,
        rating,
        message: text,
        timestamp,
      });
    } catch (e) {
      if (isHttp404(e)) {
        return fail(
          'REVIEW_SESSION_UNSUPPORTED',
          'Platform has no API-session review message endpoint (HTTP 404). Backend.',
          { seller, sessionId: sid },
        );
      }
      return fail('REVIEW_FAILED', e.message || String(e), { seller, sessionId: sid });
    }
    const platformBytes = msgResult && msgResult.message;
    if (isNonCanonicalReview(platformBytes) || /Junction41 Review/i.test(String(platformBytes || ''))) {
      return fail(
        'REVIEW_NOT_CANONICAL',
        'Platform review bytes are not J41-…; backend must emit J41-REVIEW|. Review on the website or retry after that fix. Dispatcher will not sign Junction41 Review.',
        { seller, sessionId: sid },
      );
    }
    if (canonicalNotBound(platformBytes, sid, rating)) {
      return fail(
        'REVIEW_NOT_CANONICAL',
        'Refusing to sign review bytes that do not bind our sessionId + rating.',
        { seller, sessionId: sid },
      );
    }
    toSign = platformBytes;
    if (Number.isFinite(Number(msgResult.timestamp))) signedTimestamp = Number(msgResult.timestamp);
  }

  if (isNonCanonicalReview(toSign)) {
    return fail(
      'REVIEW_NOT_CANONICAL',
      'Refusing to sign platform-supplied bytes that do not start with J41-.',
      { seller, sessionId: sid },
    );
  }

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

  return {
    ok: true,
    seller,
    sessionId: sid,
    rating,
    result,
    timestamp: signedTimestamp,
  };
}

module.exports = {
  submitBuyerApiSessionReview,
  persistGrantSession,
  parseRating,
};
