'use strict';

const { normalizeDatasetTerms } = require('./dataset-terms');
const { quoteDataset, satsOf } = require('./dataset-price');

function datasetDoorOrigin(listing) {
  const endpoint = listing && listing.endpoints && listing.endpoints[0];
  const fromEndpoint = endpoint && (typeof endpoint === 'string' ? endpoint : endpoint.url);
  const base = listing && (listing.website || fromEndpoint);
  if (!base || typeof base !== 'string') return null;
  try { return new URL(base).origin; } catch { return null; }
}

/**
 * Ask the seller what this question costs. The response is a count and a price.
 * A body that already contains rows is refused.
 */
async function fetchDatasetQuote({ origin, terms, fetchImpl } = {}) {
  const base = String(origin || '').replace(/\/+$/, '');
  if (!base) {
    return { ok: false, code: 'DATA_URL_MISSING', message: 'Seller listing has no website to price the question.' };
  }
  const url = new URL('/j41/datasets/orchard-apples.json', `${base}/`);
  url.searchParams.set('quote', '1');
  const normalized = normalizeDatasetTerms(terms || {});
  for (const key of ['color', 'kind', 'taste', 'q']) {
    if (normalized[key]) url.searchParams.set(key, normalized[key]);
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'DATASET_QUOTE_UNAVAILABLE', message: 'fetch is not available.' };
  }
  let res;
  try {
    res = await doFetch(url);
  } catch (e) {
    return {
      ok: false,
      code: 'DATASET_QUOTE_UNAVAILABLE',
      message: `The seller did not price this question (${e.message || e}).`,
    };
  }
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return { ok: false, code: 'DATASET_QUOTE_UNAVAILABLE', message: 'The seller price response was not JSON.' };
  }
  if (!res.ok || body.error) {
    return {
      ok: false,
      code: body.error || 'DATASET_QUOTE_UNAVAILABLE',
      message: body.message || 'The seller did not price this question.',
    };
  }
  if (body.quote !== true || body.items) {
    return { ok: false, code: 'DATASET_QUOTE', message: 'The seller price response included rows. Refusing it.' };
  }
  const quote = quoteDataset({ matchCount: body.matchCount, unitPrice: body.unitPrice });
  if (!quote.ok) return { ok: false, code: quote.code, message: quote.message };
  const stated = satsOf(body.amount);
  if (!stated.ok || stated.sats !== quote.amountSats) {
    return {
      ok: false,
      code: 'DATASET_QUOTE',
      message: 'The seller price does not equal the row count times the per-row price.',
    };
  }
  return { ok: true, quote };
}

module.exports = { datasetDoorOrigin, fetchDatasetQuote };
