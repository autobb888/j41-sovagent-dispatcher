'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  submitBuyerApiSessionReview,
  persistGrantSession,
} = require('../src/buyer-review-session');
const { saveAccessGrant, loadAccessGrant } = require('../src/buyer-access');

const BUYER = {
  identity: 'alice.agentplatform@',
  iAddress: 'iAliceBuyer',
  address: 'Ralice',
  wif: 'WIF-MUST-NOT-PRINT',
};
const SELLER = 'duskseek.agentplatform@';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';

function sessionCanonical({ rating = 5, text = '', ts = 1700000000 } = {}) {
  return `J41-REVIEW-SESSION|Agent:${SELLER}|Session:${SESSION_ID}|Rating:${rating}|Msg:${text}|Ts:${ts}|I submit this review for an API session.`;
}

function stringifyNoWif(value) {
  return JSON.stringify(value);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'j41-review-session-'));
}

function http404(message) {
  const err = new Error(message || 'HTTP 404');
  err.statusCode = 404;
  err.code = 'HTTP_ERROR';
  return err;
}

test('review-session source GETs J41-REVIEW-SESSION| and never homemade J41-REVIEW|Session:', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/buyer-review-session.js'), 'utf8');
  assert.match(src, /submitApiSessionReview/);
  assert.match(src, /J41-REVIEW-SESSION\|/);
  assert.match(src, /REVIEW_SESSION_UNSUPPORTED/);
  assert.match(src, /\/v1\/reviews\/message\?/);
  assert.doesNotMatch(src, /toSign = `J41-REVIEW\|Session:/);
  assert.doesNotMatch(src, /J41-REVIEW\|Session:\$\{/);
  assert.doesNotMatch(src, /reviews shipped/i);
});

test('submitBuyerApiSessionReview signs GET J41-REVIEW-SESSION| and POSTs sessionId', async () => {
  const signed = [];
  const sent = [];
  const got = [];
  const canonical = sessionCanonical({ rating: 5, text: 'good model', ts: 1_700_000_222 });
  const r = await submitBuyerApiSessionReview({
    client: {
      submitApiSessionReview: async (payload) => {
        sent.push(payload);
        return { id: 'review-1' };
      },
    },
    keys: BUYER,
    seller: SELLER,
    sessionId: SESSION_ID,
    rating: 5,
    message: 'good model',
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
  assert.equal(got[0].sessionId, SESSION_ID);
  assert.equal(signed.length, 1);
  assert.equal(signed[0].message, canonical);
  assert.ok(signed[0].message.startsWith('J41-REVIEW-SESSION|'));
  assert.match(signed[0].message, /Msg:good model/);
  assert.equal(signed[0].network, 'verustest');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, SESSION_ID);
  assert.equal(sent[0].rating, 5);
  assert.equal(sent[0].signature, 'sig-from-buyer-wif');
  assert.equal(sent[0].agentVerusId, SELLER);
  assert.equal(sent[0].buyerVerusId, BUYER.identity);
  assert.equal(stringifyNoWif(r).includes(BUYER.wif), false);
  assert.equal(stringifyNoWif(sent).includes(BUYER.wif), false);
});

test('grant sessionId after chat is enough — no extra --session-id required', async () => {
  const sent = [];
  const canonical = sessionCanonical({ rating: 4, ts: 1_700_000_333 });
  const r = await submitBuyerApiSessionReview({
    client: {
      submitApiSessionReview: async (payload) => {
        sent.push(payload);
        return { id: 'review-grant' };
      },
    },
    keys: BUYER,
    seller: SELLER,
    grant: { sessionId: SESSION_ID, models: ['duskseek'] },
    rating: 4,
    network: 'verustest',
    now: 1_700_000_333,
    getReviewMessage: async () => ({ message: canonical, timestamp: 1_700_000_333 }),
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, true);
  assert.equal(sent[0].sessionId, SESSION_ID);
  assert.equal(sent[0].rating, 4);
  assert.equal(sent[0].model, 'duskseek');
});

test('missing sessionId is REVIEW_SESSION_NO_SESSION and never submits', async () => {
  let called = 0;
  const r = await submitBuyerApiSessionReview({
    client: {
      submitApiSessionReview: async () => { called += 1; return { id: 'nope' }; },
    },
    keys: BUYER,
    seller: SELLER,
    rating: 5,
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_SESSION_NO_SESSION');
  assert.equal(called, 0);
});

test('no GET / missing reviews.j41-review-v2 is REVIEW_SESSION_UNSUPPORTED and never homemade', async () => {
  let submitted = 0;
  let signed = 0;
  const r = await submitBuyerApiSessionReview({
    client: {
      submitApiSessionReview: async () => { submitted += 1; return { id: 'nope' }; },
    },
    keys: BUYER,
    seller: SELLER,
    sessionId: SESSION_ID,
    rating: 5,
    network: 'verustest',
    now: 1_700_000_444,
    signMessage: () => { signed += 1; return 'sig'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_SESSION_UNSUPPORTED');
  assert.equal(submitted, 0);
  assert.equal(signed, 0);
});

test('404 on /v1/reviews/api-session is REVIEW_SESSION_UNSUPPORTED', async () => {
  let signed = 0;
  const canonical = sessionCanonical({ ts: 1_700_000_444 });
  const r = await submitBuyerApiSessionReview({
    client: {
      submitApiSessionReview: async () => { throw http404('Not Found'); },
    },
    keys: BUYER,
    seller: SELLER,
    sessionId: SESSION_ID,
    rating: 5,
    network: 'verustest',
    now: 1_700_000_444,
    getReviewMessage: async () => ({ message: canonical, timestamp: 1_700_000_444 }),
    signMessage: () => { signed += 1; return 'sig'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_SESSION_UNSUPPORTED');
  assert.equal(signed, 1);
});

test('live Junction41 API Session Review / homemade J41-REVIEW|Session: never submitted', async () => {
  let submitted = 0;
  let signed = 0;
  for (const message of [
    'Junction41 API Session Review\nPlease sign this human block',
    `J41-REVIEW|Session:${SESSION_ID}|Rating:5|Ts:1700000555|nope`,
  ]) {
    const r = await submitBuyerApiSessionReview({
      client: {
        submitApiSessionReview: async () => { submitted += 1; return { id: 'nope' }; },
      },
      keys: BUYER,
      seller: SELLER,
      sessionId: SESSION_ID,
      rating: 5,
      getReviewMessage: async () => ({ message, timestamp: 1700000555 }),
      signMessage: () => { signed += 1; return 'sig'; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REVIEW_SESSION_UNSUPPORTED');
  }
  assert.equal(submitted, 0);
  assert.equal(signed, 0);
});

test('platform J41-REVIEW-SESSION| bytes that bind sessionId+rating are signed as-is', async () => {
  const signed = [];
  const sent = [];
  const canonical = sessionCanonical({ rating: 3, text: 'ok', ts: 1700000666 });
  const r = await submitBuyerApiSessionReview({
    client: {
      submitApiSessionReview: async (payload) => {
        sent.push(payload);
        return { id: 'review-canonical' };
      },
    },
    keys: BUYER,
    seller: SELLER,
    sessionId: SESSION_ID,
    rating: 3,
    getReviewMessage: async () => ({ message: canonical, timestamp: 1700000666 }),
    signMessage: (wif, message) => {
      signed.push(message);
      return 'sig-canonical';
    },
  });
  assert.equal(r.ok, true);
  assert.equal(signed[0], canonical);
  assert.equal(sent[0].signature, 'sig-canonical');
  assert.equal(sent[0].timestamp, 1700000666);
});

test('--rating must be an integer 1-5', async () => {
  let called = 0;
  const r = await submitBuyerApiSessionReview({
    client: { submitApiSessionReview: async () => { called += 1; } },
    keys: BUYER,
    seller: SELLER,
    sessionId: SESSION_ID,
    rating: 9,
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_BAD_RATING');
  assert.equal(called, 0);
});

test('--rating 1.5 is REVIEW_BAD_RATING', async () => {
  let called = 0;
  const r = await submitBuyerApiSessionReview({
    client: { submitApiSessionReview: async () => { called += 1; } },
    keys: BUYER,
    seller: SELLER,
    sessionId: SESSION_ID,
    rating: 1.5,
    signMessage: () => 'sig',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REVIEW_BAD_RATING');
  assert.equal(called, 0);
});

test('persistGrantSession writes sessionId onto the access grant (0600)', () => {
  const dir = tmpDir();
  try {
    saveAccessGrant(dir, 'agent-1', SELLER, {
      apiKey: 'sk-test-secret',
      endpointUrl: 'https://proxy.example/j41/proxy/v1',
      expiresAt: '2099-01-01T00:00:00Z',
      models: ['duskseek'],
    });
    persistGrantSession(dir, 'agent-1', SELLER, SESSION_ID);
    const rec = loadAccessGrant(dir, 'agent-1', SELLER);
    assert.equal(rec.sessionId, SESSION_ID);
    const p = path.join(dir, 'agent-1', 'access', SELLER.replace(/[^A-Za-z0-9._-]+/g, '_') + '.json');
    assert.equal(fs.statSync(p).mode & 0o077, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI review-session is a thin rind over buyer-review-session', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /\.command\('review-session <buyer-agent-id> <seller>'\)/);
  const start = cli.indexOf(".command('review-session <buyer-agent-id> <seller>')");
  assert.ok(start > -1);
  const next = cli.indexOf('\nprogram\n', start + 10);
  const rind = cli.slice(start, next > start ? next : start + 2500);
  assert.match(rind, /require\('\.\/buyer-review-session'\)/);
  assert.match(rind, /submitBuyerApiSessionReview/);
  assert.match(rind, /REVIEW_SESSION_UNSUPPORTED/);
  assert.match(rind, /\.requiredOption\('--rating/);
  assert.doesNotMatch(rind, /client\.submitApiSessionReview\(/);
  assert.doesNotMatch(rind, /console\.(log|error|info).*wif/i);
  assert.doesNotMatch(rind, /reviews shipped/i);
  assert.doesNotMatch(cli, /2\.37\.4.*reviews shipped/i);
  const chatStart = cli.indexOf(".command('chat <buyer-agent-id> <seller>')");
  const chatNext = cli.indexOf('\nprogram\n', chatStart + 10);
  const chatRind = cli.slice(chatStart, chatNext > chatStart ? chatNext : chatStart + 2500);
  assert.match(chatRind, /persistGrantSession/);
});

test('CHANGELOG and help do not claim reviews shipped', () => {
  const changelog = fs.readFileSync(path.join(__dirname, '../CHANGELOG.md'), 'utf8');
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.doesNotMatch(changelog, /reviews shipped/i);
  assert.doesNotMatch(changelog, /live reviews/i);
  const start = cli.indexOf(".command('review-session <buyer-agent-id> <seller>')");
  const rind = cli.slice(start, start + 800);
  assert.doesNotMatch(rind, /\.description\([^)]*reviews now/i);
  assert.match(rind, /J41-/);
});
