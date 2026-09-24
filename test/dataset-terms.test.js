'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  datasetTermsCanonical, datasetTermsHash, jobLineWithDataFilter, descriptionCarriesFilter,
} = require('../src/dataset-terms');
const { mintDatasetToken, readDatasetToken } = require('../src/dataset-token');
const { jobPaymentReady } = require('../src/job-payment');

test('dataset terms hash is stable and the job line gains DataFilter only as an insert', () => {
  const a = datasetTermsHash({ color: 'red', taste: 'sweet' });
  const b = datasetTermsHash({ taste: 'sweet', color: 'red', kind: '', q: '' });
  assert.equal(a, b);
  assert.equal(datasetTermsCanonical({ color: 'red' }).includes('"color":"red"'), true);
  assert.equal(datasetTermsCanonical({ color: 'red', kind: '' }).includes('kind'), false);
  const line = 'J41-JOB|To:seller@|Desc:Dataset hire|Amt:0.0500 VRSCTEST|Ts:1|I request this job and agree to pay upfront before work begins.';
  const next = jobLineWithDataFilter(line, a);
  assert.match(next, new RegExp(`\\|DataFilter:${a}\\|I request this job`));
  assert.equal(descriptionCarriesFilter('color=red'), true);
  assert.equal(descriptionCarriesFilter('Dataset hire'), false);
});

test('a dataset job is paid only when payment.verified is true', () => {
  assert.equal(jobPaymentReady({ datasetTerms: { color: 'red' }, status: 'in_progress' }), false);
  assert.equal(jobPaymentReady({ datasetTerms: { color: 'red' }, payment: { status: 'confirmed' } }), false);
  assert.equal(jobPaymentReady({ datasetTerms: { color: 'red' }, payment: { verified: true } }), true);
  assert.equal(jobPaymentReady({ status: 'in_progress' }), true);
});

test('dataset token round-trips and rejects a tampered hash', () => {
  const secret = 'test-secret';
  const token = mintDatasetToken({
    buyer: 'iBuyer', jobId: 'job-1', hash: 'abc', exp: Date.now() + 1000, secret,
  });
  assert.equal(readDatasetToken(token, secret).jobId, 'job-1');
  assert.equal(readDatasetToken(token.slice(0, -2) + 'aa', secret), null);
});
