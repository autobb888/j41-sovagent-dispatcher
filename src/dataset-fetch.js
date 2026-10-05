'use strict';

const { datasetDoorOrigin } = require('./dataset-quote');

/**
 * Open a paid dataset page. The bearer stays on this object for data-open.
 * artifacts writes the rows and does not copy the token.
 */
async function fetchDatasetPage({
  origin,
  jobId,
  keys,
  network,
  offset,
  fetchImpl,
  signMessage,
} = {}) {
  if (!origin) {
    return { ok: false, code: 'DATA_URL_MISSING', message: 'Seller listing has no website to open the dataset.', jobId };
  }
  if (!keys || !keys.wif || !keys.identity || typeof signMessage !== 'function') {
    return { ok: false, code: 'DATA_OPEN_DENIED', message: 'Dataset open needs the buyer key.', jobId };
  }
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, code: 'DATA_OPEN_DENIED', message: 'fetch is not available.', jobId };
  }
  const buyer = String(keys.identity).endsWith('@') ? keys.identity : `${keys.identity}@`;
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `J41-DATA-OPEN|Job:${jobId}|Ts:${timestamp}|Buyer:${buyer}`;
  const signature = signMessage(keys.wif, message, network);
  let res;
  try {
    res = await doFetch(`${origin}/j41/datasets/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        timestamp,
        signature,
        address: keys.address,
        buyer,
        iAddress: keys.iAddress,
      }),
    });
  } catch (e) {
    return { ok: false, code: 'DATA_OPEN_DENIED', message: e.message || String(e), jobId };
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || !payload.token) {
    return {
      ok: false,
      code: payload.error || 'DATA_OPEN_DENIED',
      message: payload.message || payload.error || `data-open failed (${res.status})`,
      jobId,
    };
  }
  const page = new URLSearchParams();
  if (offset != null && offset !== '') page.set('offset', String(offset));
  const rowUrl = `${origin}/j41/datasets/orchard-apples.json${page.toString() ? `?${page}` : ''}`;
  let rowRes;
  try {
    rowRes = await doFetch(rowUrl, { headers: { Authorization: `Bearer ${payload.token}` } });
  } catch (e) {
    return { ok: false, code: 'DATA_ROWS_DENIED', message: e.message || String(e), jobId };
  }
  const rows = await rowRes.json().catch(() => ({}));
  if (!rowRes.ok || rows.error || !Array.isArray(rows.items)) {
    return {
      ok: false,
      code: rows.error || 'DATA_ROWS_DENIED',
      message: rows.message || rows.error || `rows failed (${rowRes.status})`,
      jobId,
      amount: rows.amount,
      units: rows.units,
      unitPrice: rows.unitPrice,
    };
  }
  return {
    ok: true,
    jobId,
    token: payload.token,
    count: rows.count,
    units: rows.units,
    unitPrice: rows.unitPrice,
    amount: rows.amount,
    offset: rows.offset,
    nextOffset: rows.nextOffset,
    items: rows.items,
  };
}

module.exports = { datasetDoorOrigin, fetchDatasetPage };
