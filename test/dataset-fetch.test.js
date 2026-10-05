'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchDatasetPage } = require('../src/dataset-fetch');

function scripted(routes) {
  return async (url, opts = {}) => {
    const hit = routes.find((route) => String(url).includes(route.match));
    if (!hit) throw new Error(`unexpected ${url}`);
    hit.seen = { url: String(url), opts };
    return {
      ok: hit.ok !== false,
      status: hit.status || (hit.ok === false ? 400 : 200),
      async json() { return hit.body; },
    };
  };
}

const keys = { wif: 'wif', identity: 'buyer@', address: 'R1', iAddress: 'i1' };

test('a missing seller website is DATA_URL_MISSING', async () => {
  const page = await fetchDatasetPage({ origin: '', jobId: 'job', keys, signMessage: () => 'sig' });
  assert.equal(page.ok, false);
  assert.equal(page.code, 'DATA_URL_MISSING');
});

test('a refused open is DATA_OPEN_DENIED and does not fetch rows', async () => {
  const fetchImpl = scripted([
    { match: '/j41/datasets/open', ok: false, status: 403, body: { error: 'DATA_OPEN_DENIED', message: 'no' } },
  ]);
  const page = await fetchDatasetPage({
    origin: 'https://seller.example',
    jobId: 'job-1',
    keys,
    network: 'verustest',
    fetchImpl,
    signMessage: () => 'sig',
  });
  assert.equal(page.code, 'DATA_OPEN_DENIED');
});

test('a paid page returns rows and keeps the bearer off the row list', async () => {
  const fetchImpl = scripted([
    { match: '/j41/datasets/open', body: { token: 'bearer-secret' } },
    { match: 'orchard-apples.json', body: { items: [{ color: 'red' }], count: 1, units: 1, unitPrice: 0.0001, amount: 0.0001, offset: 0, nextOffset: null } },
  ]);
  const page = await fetchDatasetPage({
    origin: 'https://seller.example',
    jobId: 'job-1',
    keys,
    network: 'verustest',
    offset: 0,
    fetchImpl,
    signMessage: (wif, message) => {
      assert.equal(wif, 'wif');
      assert.match(message, /J41-DATA-OPEN\|Job:job-1/);
      return 'sig';
    },
  });
  assert.equal(page.ok, true);
  assert.equal(page.items[0].color, 'red');
  assert.equal(page.token, 'bearer-secret');
  assert.equal(Object.prototype.hasOwnProperty.call(page.items[0], 'token'), false);
});
