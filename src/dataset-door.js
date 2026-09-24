'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeDatasetTerms, datasetTermsHash } = require('./dataset-terms');
const { mintDatasetToken, readDatasetToken } = require('./dataset-token');

function windowExpiresMs(job) {
  const raw = job && job.reviewWindowExpiresAt;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function termsFromJob(job) {
  const terms = job && job.datasetTerms;
  if (!terms || typeof terms !== 'object') return null;
  const source = { ...terms };
  if (typeof terms.canonical === 'string' && terms.canonical) {
    try {
      const parsed = JSON.parse(terms.canonical);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of ['color', 'kind', 'taste', 'q']) {
          if ((source[key] == null || source[key] === '') && parsed[key]) source[key] = parsed[key];
        }
      }
    } catch { /* the field values on the job still filter the rows */ }
  }
  const normalized = normalizeDatasetTerms(source);
  const hash = terms.hash || datasetTermsHash(normalized);
  return { normalized, hash: String(hash) };
}

function idKey(value) {
  return String(value || '').replace(/@+$/, '').toLowerCase();
}

function buyerMatches(job, ...buyers) {
  const have = idKey(job && job.buyerVerusId);
  if (!have) return false;
  return buyers.some((buyer) => idKey(buyer) && idKey(buyer) === have);
}

function createOrchardDoor({ getJob, secret, verifyMessage, docPath }) {
  const file = docPath || path.join(__dirname, '..', 'templates', 'orchard-apples.json');

  function readDoc() {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function rowsForTerms(terms) {
    const doc = readDoc();
    const items = (Array.isArray(doc.items) ? doc.items : []).filter((row) => {
      if (!row || typeof row !== 'object') return false;
      for (const key of ['color', 'kind', 'taste']) {
        if (terms[key] && String(row[key] || '') !== terms[key]) return false;
      }
      if (terms.q) {
        const hay = [row.kind, row.color, row.taste].join('\n').toLowerCase();
        if (!hay.includes(terms.q.toLowerCase())) return false;
      }
      return true;
    });
    return { count: items.length, items };
  }

  async function paidJob(jobId) {
    const job = await getJob(jobId);
    if (!job || !job.payment || job.payment.verified !== true) return null;
    const exp = windowExpiresMs(job);
    if (exp == null || Date.now() > exp) return null;
    const terms = termsFromJob(job);
    if (!terms) return null;
    return { job, exp, terms };
  }

  return {
    async openGrant({ jobId, timestamp, signature, address, buyer, iAddress } = {}) {
      if (!jobId || !signature || !address || !buyer) return { error: 'DATA_OPEN_FIELDS' };
      const message = `J41-DATA-OPEN|Job:${jobId}|Ts:${timestamp}|Buyer:${buyer}`;
      if (typeof verifyMessage !== 'function' || !verifyMessage(message, address, signature)) {
        return { error: 'DATA_OPEN_SIGNATURE' };
      }
      const paid = await paidJob(jobId);
      if (!paid || !buyerMatches(paid.job, buyer, iAddress)) return { error: 'DATA_NOT_PAID' };
      const token = mintDatasetToken({
        buyer: paid.job.buyerVerusId,
        jobId,
        hash: paid.terms.hash,
        exp: paid.exp,
        secret,
      });
      return { token };
    },
    async rowsForToken(token, query) {
      const body = readDatasetToken(token, secret);
      if (!body || Date.now() > Number(body.exp)) return null;
      const paid = await paidJob(body.jobId);
      if (!paid) return null;
      if (paid.terms.hash !== body.hash) return null;
      if (!buyerMatches(paid.job, body.buyer)) return null;
      if (query && typeof query.get === 'function') {
        const asked = normalizeDatasetTerms({
          color: query.get('color'), kind: query.get('kind'), taste: query.get('taste'), q: query.get('q'),
        });
        const askedSomething = ['color', 'kind', 'taste', 'q'].some((key) => asked[key]);
        if (askedSomething) {
          const same = ['color', 'kind', 'taste', 'q'].every((key) => asked[key] === paid.terms.normalized[key]);
          if (!same) return null;
        }
      }
      const rows = rowsForTerms(paid.terms.normalized);
      return { dataset: 'orchardapples', count: rows.count, items: rows.items };
    },
  };
}

module.exports = { createOrchardDoor, windowExpiresMs };
