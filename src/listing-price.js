'use strict';

const { formatVrsc } = require('./wallet');
const { satsOf } = require('./dataset-price');

/**
 * Same cap the API uses on hire and on each extension.
 * ceiling = +(adjustedPrice * 10).toFixed(4), adjustedPrice = price * (1 + markup/100).
 * A missing markup is null so the caller still posts and the API 400 is the authority.
 */
function serviceAmountCeiling(servicePrice, markupPct) {
  const price = Number(servicePrice);
  if (!(price > 0) || !Number.isFinite(price)) return null;
  if (markupPct == null || markupPct === '') return null;
  const markup = Number(markupPct);
  if (!Number.isFinite(markup)) return null;
  const adjustedPrice = price * (1 + markup / 100);
  const ceiling = +(adjustedPrice * 10).toFixed(4);
  return { ceiling, adjustedPrice };
}

function listingMarkup(service) {
  if (!service || typeof service !== 'object') return null;
  for (const key of ['markupPct', 'markup_pct', 'sellerMarkupPct', 'markup']) {
    if (service[key] != null && service[key] !== '') return service[key];
  }
  return null;
}

/**
 * A GPU period is one listed price for the whole window. Paying a different
 * amount would either underpay that window or make every later extension use
 * the wrong rate. A labour listing is a floor: a larger task can pay more.
 * Dataset hires are priced from the question, not from this flat listing.
 * A model session is a floor at the listed price. Price 0 is not a session.
 */
function assertPaysListing({ serviceType, amount, listedPrice } = {}) {
  const type = serviceType || '';
  if (type === 'dataset' || type === 'data') return { ok: true };
  const listed = satsOf(listedPrice);
  if (type === 'api-endpoint' || type === 'model') {
    if (!listed.ok || listed.sats <= 0) {
      return { ok: false, code: 'MODEL_PRICE_UNSET', message: 'The seller has not set a session price.' };
    }
    const paidModel = satsOf(amount);
    if (!paidModel.ok || paidModel.sats <= 0) {
      return { ok: false, code: 'BAD_AMOUNT', message: (paidModel && paidModel.error) || '--amount must be a positive number' };
    }
    const shownModel = formatVrsc(listed.sats);
    if (paidModel.sats < listed.sats) {
      return {
        ok: false,
        code: 'LISTING_PRICE',
        message: `This session is ${shownModel}. Pass --amount of at least that. A larger window can pay more, up to the 10x ceiling.`,
      };
    }
    return { ok: true };
  }
  if (!listed.ok || listed.sats <= 0) return { ok: true };
  const paid = satsOf(amount);
  if (!paid.ok || paid.sats <= 0) {
    return { ok: false, code: 'BAD_AMOUNT', message: (paid && paid.error) || '--amount must be a positive number' };
  }
  const shown = formatVrsc(listed.sats);
  if (type === 'gpu-rental' || type === 'compute') {
    if (paid.sats !== listed.sats) {
      return {
        ok: false,
        code: 'COMPUTE_PRICE',
        message: `This GPU period is listed at ${shown}. Pass --amount ${shown}. One payment holds the machine for that period; unused minutes are not refunded. Another period is an extension at the same price.`,
      };
    }
    return { ok: true };
  }
  if (paid.sats < listed.sats) {
    return {
      ok: false,
      code: 'LISTING_PRICE',
      message: `This listing is ${shown}. Pass --amount of at least that. A larger task can pay more; the seller accepts or refuses.`,
    };
  }
  return { ok: true };
}

module.exports = { assertPaysListing, serviceAmountCeiling, listingMarkup };
