'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  decideReviewAsk,
  parseReviewReply,
  askReviewOnClose,
  publishedReview,
  waitForWrittenReview,
  reviewWriteMessage,
} = require('../src/review-close');

test('decideReviewAsk asks on a tty, submits an explicit rating, and leaves --yes/--json alone', () => {
  assert.deepEqual(decideReviewAsk({ tty: true }), { action: 'ask' });
  assert.deepEqual(decideReviewAsk({ tty: true, rating: '4' }), { action: 'submit', rating: 4 });
  assert.deepEqual(decideReviewAsk({ tty: true, yes: true }), { action: 'leave' });
  assert.deepEqual(decideReviewAsk({ tty: true, json: true }), { action: 'leave' });
  assert.deepEqual(decideReviewAsk({ tty: false }), { action: 'leave' });
  assert.deepEqual(decideReviewAsk({ yes: true, rating: '5' }), { action: 'submit', rating: 5 });
  assert.deepEqual(decideReviewAsk({ rating: '9' }), { action: 'bad-rating' });
  assert.deepEqual(decideReviewAsk({ rating: '' }), { action: 'leave' });
});

test('parseReviewReply skips a blank line and keeps an optional sentence', () => {
  assert.deepEqual(parseReviewReply(''), { skipped: true });
  assert.deepEqual(parseReviewReply('skip'), { skipped: true });
  assert.deepEqual(parseReviewReply('5'), { rating: 5, message: '' });
  assert.deepEqual(parseReviewReply('4 rows matched'), { rating: 4, message: 'rows matched' });
  assert.deepEqual(parseReviewReply('great'), { invalid: true });
});

test('askReviewOnClose asks for a sentence only after a bare rating', async () => {
  const prompts = [];
  const answered = await askReviewOnClose({
    ask: async (q) => {
      prompts.push(q);
      return prompts.length === 1 ? '5' : 'Red Delicious and Fuji';
    },
  });
  assert.equal(answered.rating, 5);
  assert.equal(answered.message, 'Red Delicious and Fuji');
  assert.equal(prompts.length, 2);

  const skipped = await askReviewOnClose({ ask: async () => '' });
  assert.equal(skipped.skipped, true);
});

test('publishedReview matches a job review and a wrapped session list', () => {
  const job = publishedReview(
    { id: 'rev-1', verified: true, jobHash: 'abc', rating: 5 },
    { jobHash: 'abc' },
  );
  assert.equal(job.id, 'rev-1');
  assert.equal(publishedReview({ verified: true, jobHash: 'other' }, { jobHash: 'abc' }), null);
  const session = publishedReview(
    { data: [{ verified: true, sessionId: 'sess-1', rating: 4 }], meta: { total: 1 } },
    { sessionId: 'sess-1' },
  );
  assert.equal(session.sessionId, 'sess-1');
  const unverified = publishedReview(
    { id: 'sess-row', verified: false, sessionId: 'sess-2', rating: 5 },
    { sessionId: 'sess-2' },
  );
  assert.equal(unverified.id, 'sess-row');
  assert.equal(publishedReview(
    { verified: false, jobHash: 'abc', rating: 5 },
    { jobHash: 'abc' },
  ), null);
});

test('waitForWrittenReview succeeds when chainReviewCount moves', async () => {
  let t = 0;
  const out = await waitForWrittenReview({
    baselineCount: 0,
    timeoutMs: 100,
    intervalMs: 40,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    readCount: async () => ({ chainReviewCount: t >= 80 ? 2 : 0 }),
    readPublished: async () => (t >= 80 ? { id: 'rev-1', verified: true, jobHash: 'abc' } : null),
    expect: { jobHash: 'abc' },
  });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'REVIEW_WRITTEN');
  assert.equal(out.count, 2);
  assert.equal(out.publicReview.id, 'rev-1');
});

test('waitForWrittenReview reports a public review whose profile count stayed put', async () => {
  const notes = [];
  const out = await waitForWrittenReview({
    baselineCount: 0,
    timeoutMs: 0,
    intervalMs: 0,
    now: () => 0,
    sleep: async () => {},
    readCount: async () => ({ chainReviewCount: 0 }),
    readPublished: async () => ({ id: 'rev-9', verified: true, jobHash: 'abc' }),
    expect: { jobHash: 'abc' },
    onProgress: (row) => notes.push(row.count),
  });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'REVIEW_PUBLIC');
  assert.deepEqual(notes, []);
  assert.match(reviewWriteMessage(out), /rev-9 is public/);
  assert.match(reviewWriteMessage(out), /chainReviewCount is still 0/);
});

test('waitForWrittenReview reports a missing public review', async () => {
  const out = await waitForWrittenReview({
    baselineCount: 1,
    timeoutMs: 0,
    now: () => 5,
    sleep: async () => {},
    readCount: async () => { throw new Error('offline'); },
    readPublished: async () => { throw new Error('missing'); },
    expect: { jobHash: 'abc' },
  });
  assert.equal(out.code, 'REVIEW_NOT_PUBLIC');
  assert.equal(out.count, 1);
});

test('buyer commands ask for the review without requiring complete first', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  assert.match(cli, /function offerBuyerReview/);
  assert.match(cli, /Review while that window is open/);
  for (const name of ['data-open <buyer-agent-id> <job-id>', 'complete <buyer-agent-id> <job-id>', "chat <buyer-agent-id> <seller>", 'job-chat <buyer-agent-id> <job-id>', 'inspect <agent-id> [job-id]']) {
    const start = cli.indexOf(`.command('${name}')`);
    assert.ok(start > -1, name);
    const rind = cli.slice(start, start + 2200);
    assert.match(rind, /--rating/);
  }
  const review = cli.indexOf(".command('review <buyer-agent-id> <job-id>')");
  const reviewRind = cli.slice(review, cli.indexOf('\nprogram\n', review + 10));
  assert.match(reviewRind, /reviewableJobStatus/);
  assert.match(reviewRind, /finishReviewWrite/);
  assert.doesNotMatch(reviewRind, /status !== 'completed'/);
});

test('a shielded review is stored without saying it is public', () => {
  const { shieldedReviewStoredMessage } = require('../src/review-close');
  const line = shieldedReviewStoredMessage();
  assert.match(line, /not move/);
  assert.doesNotMatch(line, /is public/);
  assert.doesNotMatch(line, /seller accept copies the review/);
  assert.doesNotMatch(line, /not in the buyer inbox yet/);
});

test('the review command stores a shielded hire without finishReviewWrite', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const review = cli.slice(cli.indexOf(".command('review "), cli.indexOf(".command('review-session"));
  assert.match(review, /isShieldedHire/);
  assert.match(review, /shieldedReviewStoredMessage/);
  assert.match(review, /finishReviewWrite/);
  assert.doesNotMatch(cli, /command\('z-review/);
  assert.doesNotMatch(cli, /command\('review-shielded/);
  const offer = cli.slice(cli.indexOf('async function offerBuyerReview'), cli.indexOf('function reportReviewWrite'));
  assert.match(offer, /isShieldedHire/);
  assert.match(offer, /shieldedReviewStoredMessage/);
});

test('a shielded hire is not treated as already public', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const fn = cli.slice(cli.indexOf('async function reviewAlreadyPublic'), cli.indexOf('function reviewNextLine'));
  const shieldAt = fn.indexOf('isShieldedHire');
  const lookupAt = fn.indexOf('getJobReview');
  assert.ok(shieldAt > -1 && lookupAt > shieldAt, 'shielded check must run before getJobReview');
});

test('review --json omits the empty-inbox warning for a shielded hire', () => {
  const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'), 'utf8');
  const review = cli.slice(cli.indexOf(".command('review "), cli.indexOf(".command('review-session"));
  assert.match(review, /!shieldedHire && result\.inboxWarning/);
});
