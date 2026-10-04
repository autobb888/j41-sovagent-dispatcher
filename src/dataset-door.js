'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { normalizeDatasetTerms, datasetTermsHash } = require('./dataset-terms');
const { mintDatasetToken, readDatasetToken } = require('./dataset-token');
const { quoteDataset, paymentCoversQuote } = require('./dataset-price');

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

// One paid response returns at most this many rows. Further rows use ?offset=.
const MAX_DATASET_ROWS = 100;

// A JSON document above this is not parsed. A line-oriented file still pages.
const MAX_DATASET_BYTES = 32 * 1024 * 1024;

function pageOffset(query) {
  if (!query || typeof query.get !== 'function') return 0;
  const raw = query.get('offset');
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

function rowMatches(row, terms) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  for (const key of ['color', 'kind', 'taste']) {
    if (terms[key] && String(row[key] || '') !== terms[key]) return false;
  }
  if (terms.q) {
    const hay = [row.kind, row.color, row.taste].join('\n').toLowerCase();
    if (!hay.includes(terms.q.toLowerCase())) return false;
  }
  return true;
}

function pageOf(filtered, offset) {
  const start = offset > filtered.length ? filtered.length : offset;
  const items = filtered.slice(start, start + MAX_DATASET_ROWS);
  const next = start + items.length;
  return {
    count: filtered.length,
    items,
    offset: start,
    nextOffset: next < filtered.length ? next : null,
    truncated: next < filtered.length,
  };
}

function sampleLines(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8', 0, n).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function lineIsObject(line) {
  if (!line.startsWith('{') || !line.endsWith('}')) return false;
  try {
    const parsed = JSON.parse(line);
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function createOrchardDoor({ getJob, secret, verifyMessage, docPath, maxBytes, unitPrice, getUnitPrice } = {}) {
  const file = docPath || path.join(__dirname, '..', 'templates', 'orchard-apples.json');
  const byteCap = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_DATASET_BYTES;
  let cached;
  let mode;

  function classify() {
    if (mode) return mode;
    const size = fs.statSync(file).size;
    const lines = sampleLines(file, size);
    if (lines.length >= 2 && lineIsObject(lines[0]) && lineIsObject(lines[1])) {
      mode = 'jsonl';
      return mode;
    }
    if (size > byteCap) {
      mode = 'too-big';
      cached = {
        error: 'DATASET_TOO_LARGE',
        maxBytes: byteCap,
        bytes: size,
        message: `This dataset file is ${size} bytes. A single JSON document must stay under ${byteCap} bytes. A file of one JSON object per line can be larger, and each open returns ${MAX_DATASET_ROWS} rows.`,
      };
      return mode;
    }
    mode = 'json';
    return mode;
  }

  function readDoc() {
    if (cached !== undefined) return cached;
    classify();
    if (cached !== undefined) return cached;
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cached;
  }

  function rowsForTerms(terms, offset) {
    const doc = readDoc();
    if (doc && doc.error) return doc;
    const filtered = (Array.isArray(doc.items) ? doc.items : []).filter((row) => rowMatches(row, terms));
    return pageOf(filtered, offset);
  }

  async function pageJsonl(terms, offset) {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const items = [];
    let matched = 0;
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try { row = JSON.parse(trimmed); } catch { continue; }
        if (!rowMatches(row, terms)) continue;
        if (matched >= offset && items.length < MAX_DATASET_ROWS) items.push(row);
        matched += 1;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    const next = offset + items.length;
    return {
      count: matched,
      items,
      offset,
      nextOffset: next < matched ? next : null,
      truncated: next < matched,
    };
  }

  async function countJsonl(terms) {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let matched = 0;
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try { row = JSON.parse(trimmed); } catch { continue; }
        if (rowMatches(row, terms)) matched += 1;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return { count: matched };
  }

  async function matchCount(terms) {
    const kind = classify();
    if (kind === 'too-big') return readDoc();
    if (kind === 'jsonl') return countJsonl(terms);
    const doc = readDoc();
    if (doc && doc.error) return doc;
    const filtered = (Array.isArray(doc.items) ? doc.items : []).filter((row) => rowMatches(row, terms));
    return { count: filtered.length };
  }

  async function unitPriceNow() {
    if (unitPrice != null && unitPrice !== '') return unitPrice;
    if (typeof getUnitPrice === 'function') return getUnitPrice();
    return null;
  }

  async function priceFor(terms) {
    const counted = await matchCount(terms);
    if (counted && counted.error) return counted;
    const price = await unitPriceNow();
    const quote = quoteDataset({ matchCount: counted.count, unitPrice: price });
    if (!quote.ok) return { error: quote.code, message: quote.message };
    return quote;
  }

  function pricedPage(page, quote) {
    return {
      ...page,
      unit: quote.unit,
      unitPrice: quote.unitPrice,
      units: quote.units,
      amount: quote.amount,
    };
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
      const priced = await priceFor(paid.terms.normalized);
      if (priced && priced.error) return priced;
      const cover = paymentCoversQuote({ paid: paid.job.amount, quote: priced });
      if (!cover.ok) {
        return {
          error: cover.code,
          message: cover.message,
          unit: priced.unit,
          unitPrice: priced.unitPrice,
          matchCount: priced.matchCount,
          units: priced.units,
          amount: priced.amount,
        };
      }
      const offset = pageOffset(query);
      if (classify() === 'jsonl') {
        const rows = await pageJsonl(paid.terms.normalized, offset);
        return { dataset: 'orchardapples', ...pricedPage(rows, priced) };
      }
      const rows = rowsForTerms(paid.terms.normalized, offset);
      if (rows && rows.error) return rows;
      return {
        dataset: 'orchardapples',
        ...pricedPage({
          count: rows.count,
          items: rows.items,
          offset: rows.offset,
          nextOffset: rows.nextOffset,
          truncated: rows.truncated,
        }, priced),
      };
    },
    async quote(terms) {
      const normalized = normalizeDatasetTerms(terms || {});
      const priced = await priceFor(normalized);
      if (priced && priced.error) return priced;
      return {
        quote: true,
        unit: priced.unit,
        unitPrice: priced.unitPrice,
        matchCount: priced.matchCount,
        units: priced.units,
        amount: priced.amount,
      };
    },
  };
}

module.exports = { createOrchardDoor, windowExpiresMs, MAX_DATASET_ROWS, MAX_DATASET_BYTES };
