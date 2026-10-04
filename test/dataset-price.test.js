'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quoteDataset, assertDatasetHireAmount, paymentCoversQuote } = require('../src/dataset-price');
const { assertPaysListing } = require('../src/listing-price');
const { fetchDatasetQuote } = require('../src/dataset-quote');

test('two rows cost twice one row, and an empty question is not a hire', () => {
  const one = quoteDataset({ matchCount: 1, unitPrice: '0.0001' });
  const two = quoteDataset({ matchCount: 2, unitPrice: 0.0001 });
  const none = quoteDataset({ matchCount: 0, unitPrice: '0.00010000' });
  assert.equal(one.amountSats, 10000);
  assert.equal(two.amountSats, 20000);
  assert.equal(two.amount, '0.00020000');
  assert.equal(none.units, 0);
  assert.equal(assertDatasetHireAmount({ amount: '0.0002', quote: two }).ok, true);
  assert.equal(assertDatasetHireAmount({ amount: '0.00020000', quote: two }).ok, true);
  assert.equal(assertDatasetHireAmount({ amount: '0.0001', quote: two }).code, 'DATASET_PRICE');
  assert.equal(assertDatasetHireAmount({ amount: '0.001', quote: two }).code, 'DATASET_PRICE');
  assert.equal(assertDatasetHireAmount({ amount: '0.0001', quote: none }).code, 'DATASET_NO_ROWS');
  assert.equal(paymentCoversQuote({ paid: '0.0001', quote: two }).code, 'PAYMENT_SHORT');
  assert.equal(paymentCoversQuote({ paid: 0.0002, quote: two }).ok, true);
  assert.equal(paymentCoversQuote({ paid: '0.001', quote: two }).ok, true);
});

test('a unit price off the 0.0001 grid is refused', () => {
  assert.equal(quoteDataset({ matchCount: 1, unitPrice: '0.00015' }).code, 'DATASET_UNIT_PRICE');
  assert.equal(quoteDataset({ matchCount: 1, unitPrice: '0' }).code, 'DATASET_UNIT_PRICE');
});

test('a GPU hire must be the listed period, and labour can pay more but not less', () => {
  assert.equal(assertPaysListing({ serviceType: 'gpu-rental', amount: '0.001', listedPrice: 0.001 }).ok, true);
  assert.equal(assertPaysListing({ serviceType: 'gpu-rental', amount: '0.0001', listedPrice: '0.001' }).code, 'COMPUTE_PRICE');
  assert.equal(assertPaysListing({ serviceType: 'gpu-rental', amount: '0.002', listedPrice: '0.001' }).code, 'COMPUTE_PRICE');
  assert.equal(assertPaysListing({ serviceType: 'agent', amount: '0.05', listedPrice: '0.05' }).ok, true);
  assert.equal(assertPaysListing({ serviceType: 'agent', amount: '0.20', listedPrice: '0.05' }).ok, true);
  assert.equal(assertPaysListing({ serviceType: 'agent', amount: '0.01', listedPrice: '0.05' }).code, 'LISTING_PRICE');
  assert.equal(assertPaysListing({ serviceType: 'dataset', amount: '0.0002', listedPrice: '0.0001' }).ok, true);
});

test('a quote that hides rows or breaks the multiplication is refused', async () => {
  const ok = await fetchDatasetQuote({
    origin: 'https://seller.example',
    terms: { color: 'red' },
    fetchImpl: async (url) => {
      assert.match(String(url), /quote=1/);
      assert.match(String(url), /color=red/);
      return {
        ok: true,
        json: async () => ({ quote: true, matchCount: 2, unitPrice: '0.00010000', amount: '0.00020000' }),
      };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.quote.amountSats, 20000);
  const lied = await fetchDatasetQuote({
    origin: 'https://seller.example',
    terms: {},
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ quote: true, matchCount: 2, unitPrice: '0.00010000', amount: '0.00010000', items: [{ kind: 'Fuji' }] }),
    }),
  });
  assert.equal(lied.code, 'DATASET_QUOTE');
});
