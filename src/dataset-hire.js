'use strict';

const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
const {
  postedDatasetTerms,
  datasetTermsHash,
  jobLineWithDataFilter,
} = require('./dataset-terms');

/**
 * Dataset hire. The filter is datasetTerms on POST /v1/jobs, never on
 * GET /v1/jobs/message/request. The signed line is the platform J41-JOB
 * line plus |DataFilter:<hash>| before the request sentence.
 */
async function createDatasetHire({
  agent,
  wif,
  network,
  sellerVerusId,
  description,
  amount,
  currency,
  serviceId,
  terms,
}) {
  const datasetTerms = postedDatasetTerms(terms);
  const hash = datasetTermsHash(datasetTerms);
  const timestamp = Math.floor(Date.now() / 1000);
  const fetched = await agent.client.getJobRequestMessage({
    sellerVerusId,
    description,
    amount,
    currency,
    timestamp,
  });
  const base = fetched && fetched.message;
  if (typeof base !== 'string' || !/^J41-JOB\|/.test(base)) {
    throw new Error('Refusing to sign a dataset hire line that is not J41-JOB');
  }
  if (!base.includes(sellerVerusId) || !base.includes(String(timestamp))) {
    throw new Error('Refusing to sign a dataset hire line that does not bind seller and timestamp');
  }
  const message = jobLineWithDataFilter(base, hash);
  const signature = signMessage(wif, message, network || 'verustest');
  try {
    return await agent.client.createJob({
      sellerVerusId,
      description,
      amount,
      currency: currency || agent.defaultCurrency,
      serviceId,
      timestamp,
      signature,
      datasetTerms,
    });
  } catch (err) {
    if (err && err.code === 'INVALID_SIGNATURE') {
      err.message = `${err.message} (DataFilter ${hash})`;
    }
    throw err;
  }
}

module.exports = { createDatasetHire };
