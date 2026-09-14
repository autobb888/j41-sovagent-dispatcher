'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  submitBuyerJobReview,
  parseRating,
  getJobReviewMessage,
} = require('../src/buyer-review');

const BUYER = {
  identity: 'alice.agentplatform@',
  iAddress: 'iAliceBuyer',
  address: 'Ralice',
  wif: 'WIF-MUST-NOT-PRINT',
};
const JOB = {
  id: 'job-labour-1',
  jobHash: 'abc123',
  buyerVerusId: 'alice.agentplatform@',
  sellerVerusId: 'bob.agentplatform@',
  status: 'completed',
};
const SELLER = JOB.sellerVerusId;

function jobCanonical({
  rating = 5,
  text = '',
  ts = 1700000000,
  hash = JOB.jobHash,
  agent = SELLER,
} = {}) {
  return `J41-REVIEW|Agent:${agent}|Job:${hash}|Rating:${rating}|Msg:${text}|Ts:${ts}|I submit this review for a completed job.`;
}

function stringifyNoWif(value) {
  return JSON.stringify(value);
}

function baseClient(overrides = {}) {
  return {
    getJob: async () => ({ ...JOB }),
    submitReview: async () => ({ id: 'review-1' }),
    getInbox: async () => ({ data: [{ type: 'review' }] }),
    ...overrides,
  };
}

test('buyer-review source GETs J41-REVIEW| and never homemade template / getAttestations', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/buyer-review.js'), 'utf8');
  assert.match(src, /submitReview/);
  assert.match(src, /J41-REVIEW\|/);
  assert.match(src, /REVIEW_NOT_CANONICAL/);
  assert.match(src, /\/v1\/reviews\/message\?/);
  assert.match(src, /getInbox\(/);
  assert.doesNotMatch(src, /getAttestations/);
  assert.doesNotMatch(src, /toSign = `J41-REVIEW\|/);
  assert.doesNotMatch(src, /J41-REVIEW\|Agent:\$\{/);
  assert.doesNotMatch(src, /agent\.submitReview/);
});

test('parseRating accepts 1-5 and rejects 1.5, 01, 1.0, empty, 9', () => {
  assert.equal(parseRating('1'), 1);
  assert.equal(parseRating(5), 5);
  assert.equal(parseRating(' 3 '), 3);
  assert.equal(parseRating('1.5'), null);
  assert.equal(parseRating(1.5), null);
  assert.equal(parseRating('01'), null);
  assert.equal(parseRating('1.0'), null);
  assert.equal(parseRating(''), null);
  assert.equal(parseRating(9), null);
  assert.equal(parseRating('9'), null);
});

test('Junction41 Review is REVIEW_NOT_CANONICAL, never signs or POSTs', async () => {
  let signed = 0;
  let posted = 0;
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async () => { posted += 1; return { id: 'nope' }; },
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 5,
    getReviewMessage: async () => ({
      message: 'Junction41 Review\nPlease sign this human block',
      timestamp: 1700000000,
    }),
    signMessage: () => { signed += 1; return 'sig'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_NOT_CANONICAL');
  assert.equal(signed, 0);
  assert.equal(posted, 0);
});

test('canonical lock line with hash+5 signs those exact bytes; POST timestamp = GET timestamp', async () => {
  const signed = [];
  const sent = [];
  const got = [];
  const inboxArgs = [];
  const canonical = jobCanonical({ rating: 5, text: 'great work', ts: 1_700_000_222 });
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async (payload) => {
        sent.push(payload);
        return { id: 'review-1' };
      },
      getInbox: async (status, limit, types) => {
        inboxArgs.push({ status, limit, types });
        return { data: [{ type: 'review' }, { type: 'attestation' }] };
      },
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 5,
    message: 'great work',
    network: 'verustest',
    now: 1_700_000_222,
    getReviewMessage: async (params) => {
      got.push(params);
      return { message: canonical, timestamp: 1_700_000_222 };
    },
    signMessage: (wif, message, network) => {
      signed.push({ message, network, wifLen: String(wif || '').length });
      return 'sig-from-buyer-wif';
    },
  });
  assert.equal(r.ok, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].jobHash, JOB.jobHash);
  assert.equal(got[0].rating, 5);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].message, canonical);
  assert.ok(signed[0].message.startsWith('J41-REVIEW|'));
  assert.match(signed[0].message, /Job:abc123/);
  assert.match(signed[0].message, /Rating:5/);
  assert.equal(signed[0].network, 'verustest');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jobHash, JOB.jobHash);
  assert.equal(sent[0].rating, 5);
  assert.equal(sent[0].timestamp, 1_700_000_222);
  assert.equal(sent[0].signature, 'sig-from-buyer-wif');
  assert.equal(sent[0].agentVerusId, SELLER);
  assert.equal(sent[0].buyerVerusId, BUYER.identity);
  assert.equal(r.jobId, JOB.id);
  assert.equal(r.rating, 5);
  assert.equal(r.inboxCount, 2);
  assert.equal(r.inboxWarning, undefined);
  assert.equal(inboxArgs[0].status, 'pending');
  assert.deepEqual(inboxArgs[0].types, ['review', 'attestation']);
  assert.equal(stringifyNoWif(r).includes(BUYER.wif), false);
  assert.equal(stringifyNoWif(sent).includes(BUYER.wif), false);
});

test('J41-COMPLETE|Job:<hash>| containing rating is REVIEW_NOT_CANONICAL', async () => {
  let signed = 0;
  let posted = 0;
  const complete = `J41-COMPLETE|Job:${JOB.jobHash}|Rating:5|Ts:1700000000|I complete this job.`;
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async () => { posted += 1; return { id: 'nope' }; },
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 5,
    getReviewMessage: async () => ({ message: complete, timestamp: 1700000000 }),
    signMessage: () => { signed += 1; return 'sig'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_NOT_CANONICAL');
  assert.equal(signed, 0);
  assert.equal(posted, 0);
});

test('Rating:5 does not bind rating 1 via timestamp substring', async () => {
  let signed = 0;
  let posted = 0;
  const message = jobCanonical({ rating: 5, ts: 1700000001 });
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async () => { posted += 1; return { id: 'nope' }; },
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 1,
    getReviewMessage: async () => ({ message, timestamp: 1700000001 }),
    signMessage: () => { signed += 1; return 'sig'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_NOT_CANONICAL');
  assert.equal(signed, 0);
  assert.equal(posted, 0);
});

test('canonical J41-REVIEW| with Junction41 Review in Msg: is still signed', async () => {
  const canonical = jobCanonical({ rating: 5, text: 'mentions Junction41 Review', ts: 1700000888 });
  const signed = [];
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async () => ({ id: 'review-msg' }),
      getInbox: async () => ({ data: [{ type: 'review' }] }),
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 5,
    message: 'mentions Junction41 Review',
    getReviewMessage: async () => ({ message: canonical, timestamp: 1700000888 }),
    signMessage: (_wif, message) => { signed.push(message); return 'sig'; },
  });
  assert.equal(r.ok, true);
  assert.equal(signed[0], canonical);
});

test('unbound hash/rating/missing Agent:/wrong seller is REVIEW_NOT_CANONICAL', async () => {
  const cases = [
    jobCanonical({ hash: 'zzz-not-our-hash', rating: 5 }),
    jobCanonical({ rating: 4 }),
    `J41-REVIEW|Job:${JOB.jobHash}|Rating:5|Msg:|Ts:1700000000|I submit this review for a completed job.`,
    jobCanonical({ agent: 'eve.agentplatform@', rating: 5 }),
  ];
  for (const message of cases) {
    let signed = 0;
    let posted = 0;
    const r = await submitBuyerJobReview({
      client: baseClient({
        submitReview: async () => { posted += 1; return { id: 'nope' }; },
      }),
      keys: BUYER,
      jobId: JOB.id,
      rating: 5,
      getReviewMessage: async () => ({ message, timestamp: 1700000000 }),
      signMessage: () => { signed += 1; return 'sig'; },
    });
    assert.equal(r.ok, false, message);
    assert.equal(r.code, 'REVIEW_NOT_CANONICAL', message);
    assert.equal(signed, 0, message);
    assert.equal(posted, 0, message);
  }
});

test('parseRating 1.5 / 9 is REVIEW_BAD_RATING', async () => {
  for (const rating of [1.5, 9, '1.5', '9']) {
    let called = 0;
    const r = await submitBuyerJobReview({
      client: baseClient({
        getJob: async () => { called += 1; return { ...JOB }; },
        submitReview: async () => { called += 1; },
      }),
      keys: BUYER,
      jobId: JOB.id,
      rating,
      signMessage: () => { called += 1; return 'sig'; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REVIEW_BAD_RATING');
    assert.equal(called, 0);
  }
});

test('2xx POST + throwing getInbox still { ok: true, inboxWarning }', async () => {
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async () => ({ id: 'review-ok' }),
      getInbox: async () => { throw new Error('inbox down'); },
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 5,
    getReviewMessage: async () => ({
      message: jobCanonical({ rating: 5, ts: 1700000666 }),
      timestamp: 1700000666,
    }),
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, true);
  assert.equal(r.inboxWarning, 'BUYER_INBOX_READ_FAILED');
  assert.equal(r.result.id, 'review-ok');
});

test('2xx POST + empty getInbox is ok with BUYER_INBOX_EMPTY', async () => {
  const r = await submitBuyerJobReview({
    client: baseClient({
      submitReview: async () => ({ id: 'review-ok' }),
      getInbox: async () => ({ data: [] }),
    }),
    keys: BUYER,
    jobId: JOB.id,
    rating: 5,
    getReviewMessage: async () => ({
      message: jobCanonical({ rating: 5, ts: 1700000777 }),
      timestamp: 1700000777,
    }),
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, true);
  assert.equal(r.inboxWarning, 'BUYER_INBOX_EMPTY');
  assert.equal(r.inboxCount, 0);
});

test('getJobReviewMessage omits empty message query', async () => {
  const paths = [];
  await getJobReviewMessage({
    request: async (method, path) => {
      paths.push({ method, path });
      return { data: { message: 'J41-REVIEW|x', timestamp: 1 } };
    },
  }, {
    agentVerusId: SELLER,
    jobHash: JOB.jobHash,
    rating: 5,
    message: '',
    timestamp: 1,
  });
  assert.equal(paths[0].method, 'GET');
  assert.match(paths[0].path, /\/v1\/reviews\/message\?/);
  assert.match(paths[0].path, /jobHash=/);
  assert.match(paths[0].path, /rating=5/);
  assert.doesNotMatch(paths[0].path, /(?:^|[?&])message=/);
});

test('CLI review is a thin rind over buyer-review', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const start = cli.indexOf(".command('review <buyer-agent-id> <job-id>')");
  assert.ok(start > -1);
  const next = cli.indexOf('\nprogram\n', start + 10);
  const rind = cli.slice(start, next > start ? next : start + 2500);
  assert.match(rind, /require\('\.\/buyer-review'\)/);
  assert.match(rind, /submitBuyerJobReview/);
  assert.match(rind, /REVIEW_NOT_CANONICAL/);
  assert.match(rind, /\.requiredOption\('--rating/);
  const parseAt = rind.indexOf('parseRating(');
  const confirmAt = rind.indexOf('confirmHire(');
  const getJobAt = rind.indexOf('getJob(');
  assert.ok(parseAt > -1 && parseAt < confirmAt, 'parseRating must run before confirmHire');
  assert.ok(getJobAt > -1 && getJobAt < confirmAt, 'job gates must run before confirmHire');
  assert.doesNotMatch(rind, /agent\.submitReview\(/);
  assert.doesNotMatch(rind, /`J41-REVIEW\|/);
  assert.doesNotMatch(rind, /toSign = `J41-REVIEW\|/);
  assert.doesNotMatch(rind, /console\.(log|error|info).*wif/i);
  assert.doesNotMatch(cli, /agent\.submitReview\(/);
});
