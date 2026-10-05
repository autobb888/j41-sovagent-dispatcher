'use strict';
// A second dataset question is a new hire at that question's price.
// Nothing in the quote accepts a leftover row count.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { quoteDataset, assertDatasetHireAmount } = require('../src/dataset-price');

test('a second question is priced from the second quote only', () => {
  const first = quoteDataset({ matchCount: 2, unitPrice: '0.0001' });
  const second = quoteDataset({ matchCount: 5, unitPrice: '0.0001' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(assertDatasetHireAmount({ amount: second.amount, quote: second }).ok, true);
  assert.equal(assertDatasetHireAmount({ amount: first.amount, quote: second }).code, 'DATASET_PRICE');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dataset-price.js'), 'utf8');
  assert.equal(src.includes('leftover'), false);
  assert.equal(src.includes('remainingRows'), false);
  assert.match(quoteDataset.toString(), /matchCount/);
  assert.equal(/remainder|unused/.test(quoteDataset.toString()), false);
  assert.equal(/remainder|unused/.test(assertDatasetHireAmount.toString()), false);
});
