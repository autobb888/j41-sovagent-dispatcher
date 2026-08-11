/**
 * T2 — the `review.received` webhook must not write identity transactions itself.
 *
 * It used to loop `acceptReview` over up to 10 pending inbox items, each of which
 * writes an identity transaction, back to back — outside the batch and outside the
 * pending-write gate. That is exactly the double-spend CLAUDE.md says never to do: the
 * platform serves the last CONFIRMED prevOutput, so writes 2..N of the burst spend an
 * output the chain has already seen consumed.
 *
 * It also failed silently: `TX_REJECTED` classifies as `contention` in
 * inbox-deadletter.js, which never escalates, so the rejected writes retried forever
 * and invisibly.
 *
 * Source-level assertions, because the handler is a switch arm inside a long function
 * that cannot be invoked in isolation. They pin the property that matters: the webhook
 * delegates rather than writes.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const CLI = fs.readFileSync(require.resolve('../src/cli.js'), 'utf8');

function reviewCase() {
  const start = CLI.indexOf("case 'review.received'");
  assert.ok(start > -1, "the review.received case must exist");
  const end = CLI.indexOf("case '", start + 30);
  return CLI.slice(start, end);
}

test('the review webhook never calls acceptReview directly', () => {
  assert.ok(!/acceptReview\s*\(/.test(reviewCase()),
    'a direct acceptReview here bypasses the batch and the pending-write gate');
});

test('it delegates to the batched inbox sweep instead', () => {
  assert.match(reviewCase(), /checkPendingInbox\s*\(\s*state\s*\)/,
    'the batched processor is the only path that honours _inboxLastWrite');
});

test('it does not start a second sweep while one is running', () => {
  // Two concurrent sweeps race _inboxLastWrite and re-create the contention the
  // batching exists to prevent — checkPendingInbox guards this, but the webhook
  // should not rely on that alone, and should say why it skipped.
  assert.match(reviewCase(), /_inboxSweepRunning/,
    'the handler must check for an in-flight sweep');
});

test('L7: the shutdown on-chain deactivate consults the pending-write gate', () => {
  const i = CLI.indexOf("setOnChainStatus('inactive')");
  assert.ok(i > -1, 'the shutdown on-chain deactivate must exist');
  const before = CLI.slice(Math.max(0, i - 1200), i);
  assert.match(before, /_inboxLastWrite/,
    'an identity write at shutdown must not race an unconfirmed inbox write');
});
