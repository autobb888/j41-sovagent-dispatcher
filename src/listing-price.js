'use strict';

const { formatVrsc } = require('./wallet');
const { satsOf } = require('./dataset-price');

/**
 * A GPU period is one listed price for the whole window. Paying a different
 * amount would either underpay that window or make every later extension use
 * the wrong rate. A labour listing is a floor: a larger task can pay more.
 * Dataset hires are priced from the question, not from this flat listing.
 */
function assertPaysListing({ serviceType, amount, listedPrice } = {}) {
  const type = serviceType || '';
  if (type === 'dataset' || type === 'data') return { ok: true };
  const listed = satsOf(listedPrice);
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

module.exports = { assertPaysListing };
