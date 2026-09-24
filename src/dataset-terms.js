'use strict';

const crypto = require('crypto');
const { canonicalize } = require('json-canonicalize');

const TERM_KEYS = ['color', 'kind', 'taste', 'q'];
// The platform sets this on every datasetTerms object before hashing.
const DATASET_TERMS_VERSION = 1;

function normalizeDatasetTerms(input = {}) {
  const out = {};
  for (const key of TERM_KEYS) {
    const raw = input[key];
    out[key] = raw == null ? '' : String(raw).trim();
  }
  return out;
}

function postedDatasetTerms(input) {
  const terms = normalizeDatasetTerms(input);
  const out = {};
  for (const key of TERM_KEYS) {
    if (terms[key] !== '') out[key] = terms[key];
  }
  return out;
}

function datasetTermsCanonical(input) {
  // v is not sent on POST. The server adds it, and the signed hash includes it.
  return canonicalize({ ...postedDatasetTerms(input), v: DATASET_TERMS_VERSION });
}

function datasetTermsHash(input) {
  return crypto.createHash('sha256').update(datasetTermsCanonical(input)).digest('hex');
}

function datasetDeliveryHash(job) {
  const terms = job && job.datasetTerms;
  if (terms && terms.hash) return String(terms.hash);
  return datasetTermsHash(terms || {});
}

function hasDatasetFilter(input) {
  const terms = normalizeDatasetTerms(input);
  return TERM_KEYS.some((key) => terms[key] !== '');
}

function descriptionCarriesFilter(text) {
  return /\b(?:color|kind|taste|q)\s*=/.test(String(text || ''));
}

/** Insert |DataFilter:<hash>| after DelAttest and before Deadline. */
function jobLineWithDataFilter(message, hash) {
  const line = String(message || '');
  const needle = '|DelAttest:yes|';
  const at = line.indexOf(needle);
  if (at < 0) {
    throw new Error('JOB_MESSAGE_SHAPE: dataset hire line has no DelAttest field');
  }
  const insertAt = at + needle.length;
  return `${line.slice(0, insertAt)}DataFilter:${hash}|${line.slice(insertAt)}`;
}

module.exports = {
  TERM_KEYS,
  DATASET_TERMS_VERSION,
  normalizeDatasetTerms,
  postedDatasetTerms,
  datasetTermsCanonical,
  datasetTermsHash,
  datasetDeliveryHash,
  hasDatasetFilter,
  descriptionCarriesFilter,
  jobLineWithDataFilter,
};
