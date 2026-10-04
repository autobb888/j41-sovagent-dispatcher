'use strict';

const { parseVrscAmount, formatVrsc } = require('./wallet');

// One row is at least 0.0001, and the hire signature prints four decimal places.
// A unit price on that grid stays exact when the platform formats the amount.
const MIN_UNIT_SATS = 10000;

function satsOf(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return { ok: false, error: 'amount is not a number' };
    if (input === 0) return { ok: true, sats: 0 };
    return satsOf(input.toFixed(8));
  }
  if (typeof input !== 'string') return { ok: false, error: 'amount must be a decimal string or number' };
  const trimmed = input.trim();
  if (trimmed === '0' || /^0\.0+$/.test(trimmed)) return { ok: true, sats: 0 };
  return parseVrscAmount(trimmed);
}

/**
 * Price of one dataset question. units are the rows that question returns.
 * A question with no rows costs nothing and is not a hire.
 */
function quoteDataset({ matchCount, unitPrice } = {}) {
  if (!Number.isInteger(matchCount) || matchCount < 0) {
    return { ok: false, code: 'DATASET_COUNT', message: 'The row count is not a whole number.' };
  }
  const unit = satsOf(unitPrice);
  if (!unit.ok || unit.sats < MIN_UNIT_SATS || unit.sats % MIN_UNIT_SATS !== 0) {
    return {
      ok: false,
      code: 'DATASET_UNIT_PRICE',
      message: 'The dataset price must be at least 0.0001 per row, in steps of 0.0001.',
    };
  }
  if (matchCount > 1000000000) {
    return { ok: false, code: 'DATASET_TOO_MANY', message: 'This question matches more rows than one hire can price.' };
  }
  const amountSats = matchCount * unit.sats;
  if (!Number.isSafeInteger(amountSats)) {
    return { ok: false, code: 'DATASET_TOO_MANY', message: 'This question costs more than one hire can name.' };
  }
  return {
    ok: true,
    unit: 'row',
    unitPrice: formatVrsc(unit.sats),
    unitPriceSats: unit.sats,
    matchCount,
    units: matchCount,
    amountSats,
    amount: matchCount === 0 ? '0.00000000' : formatVrsc(amountSats),
  };
}

function assertDatasetHireAmount({ amount, quote } = {}) {
  if (!quote || quote.ok !== true) {
    return {
      ok: false,
      code: (quote && quote.code) || 'DATASET_QUOTE',
      message: (quote && quote.message) || 'No price for this question.',
    };
  }
  if (quote.units === 0) {
    return {
      ok: false,
      code: 'DATASET_NO_ROWS',
      message: 'This question matches nothing, so there is nothing to charge and no hire is created.',
    };
  }
  const paid = satsOf(amount);
  if (!paid.ok) return { ok: false, code: 'BAD_AMOUNT', message: paid.error || 'amount is not valid' };
  if (paid.sats !== quote.amountSats) {
    return {
      ok: false,
      code: 'DATASET_PRICE',
      message: `This question matches ${quote.units} row${quote.units === 1 ? '' : 's'} at ${quote.unitPrice} each. The price is ${quote.amount}. Pass --amount ${quote.amount}.`,
      quote,
    };
  }
  return { ok: true, quote };
}

function paymentCoversQuote({ paid, quote } = {}) {
  if (!quote || quote.ok !== true) {
    return { ok: false, code: (quote && quote.code) || 'DATASET_QUOTE', quote };
  }
  if (quote.units === 0) {
    return {
      ok: false,
      code: 'DATASET_NO_ROWS',
      quote,
      message: 'This question matches nothing, so there is nothing to deliver.',
    };
  }
  const got = satsOf(paid);
  if (!got.ok || got.sats < quote.amountSats) {
    return {
      ok: false,
      code: 'PAYMENT_SHORT',
      quote,
      message: `This question is ${quote.units} rows at ${quote.unitPrice} each (${quote.amount}). The payment does not cover that price, so no rows are returned.`,
    };
  }
  return { ok: true, quote };
}

module.exports = {
  MIN_UNIT_SATS,
  satsOf,
  quoteDataset,
  assertDatasetHireAmount,
  paymentCoversQuote,
};
