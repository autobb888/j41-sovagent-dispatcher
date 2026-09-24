'use strict';

const crypto = require('crypto');
const { canonicalize } = require('json-canonicalize');

const TERM_KEYS = ['color', 'kind', 'taste', 'q'];

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
  return canonicalize(postedDatasetTerms(input));
}

function datasetTermsHash(input) {
  return crypto.createHash('sha256').update(datasetTermsCanonical(input)).digest('hex');
}

function hasDatasetFilter(input) {
  const terms = normalizeDatasetTerms(input);
  return TERM_KEYS.some((key) => terms[key] !== '');
}

function descriptionCarriesFilter(text) {
  return /\b(?:color|kind|taste|q)\s*=/.test(String(text || ''));
}

/** Insert |DataFilter:<hash>| before the human sentence of a J41-JOB line. */
function jobLineWithDataFilter(message, hash) {
  const line = String(message || '');
  const at = line.lastIndexOf('|I request this job');
  if (at < 0) {
    throw new Error('JOB_MESSAGE_SHAPE: dataset hire line has no request sentence');
  }
  return `${line.slice(0, at)}|DataFilter:${hash}${line.slice(at)}`;
}

module.exports = {
  TERM_KEYS,
  normalizeDatasetTerms,
  postedDatasetTerms,
  datasetTermsCanonical,
  datasetTermsHash,
  hasDatasetFilter,
  descriptionCarriesFilter,
  jobLineWithDataFilter,
};
