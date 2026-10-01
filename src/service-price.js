'use strict';

const MIN_SERVICE_PRICE = 0.0001;

function assertServicePrice(raw) {
  const n = typeof raw === 'number' ? raw : Number(String(raw == null ? '' : raw).trim());
  if (!Number.isFinite(n) || n < MIN_SERVICE_PRICE) {
    const err = new Error(`SERVICE_PRICE_TOO_LOW: price must be at least ${MIN_SERVICE_PRICE}`);
    err.code = 'SERVICE_PRICE_TOO_LOW';
    throw err;
  }
  return n;
}

module.exports = { assertServicePrice, MIN_SERVICE_PRICE };
