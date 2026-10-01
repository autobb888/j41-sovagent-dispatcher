'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  selectRefundableDisputes, buildDisputeRefundEntry, hasPositiveTokens,
  unwrapDispute, agreedRefundPercent, alreadyPaid, logUnselectedDisputes,
  listSellerDisputedJobs, fetchSellerDisputedJobs,
} = require('../src/dispute-sweep.js');

const disp = { id: 'd1', action: 'pending', raised_by: 'iBUY' };
const undelivered = { id: 'j1', status: 'disputed', delivery: null, tokenUsage: null, amount: 0.5, currency: 'VRSCTEST', buyerVerusId: 'iBUY' };

test('selects undelivered + pending + no-tokens', () => {
  const out = selectRefundableDisputes([undelivered], { j1: disp });
  assert.equal(out.length, 1);
});
test('excludes delivered jobs', () => {
  const out = selectRefundableDisputes([{ ...undelivered, delivery: { hash: 'abc' } }], { j1: disp });
  assert.equal(out.length, 0);
});
test('excludes jobs with token usage', () => {
  const out = selectRefundableDisputes([{ ...undelivered, tokenUsage: { total: 42 } }], { j1: disp });
  assert.equal(out.length, 0);
});
test('excludes non-pending disputes', () => {
  const out = selectRefundableDisputes([undelivered], { j1: { ...disp, action: 'refund' } });
  assert.equal(out.length, 0);
});
test('excludes jobs with no dispute record', () => {
  assert.equal(selectRefundableDisputes([undelivered], {}).length, 0);
});
test('buildDisputeRefundEntry: confident target => pending_approval, verified address', () => {
  const target = { address: 'iBUY', displayName: 'buyer@', checks: { isIAddress: true }, confident: true };
  const e = buildDisputeRefundEntry(undelivered, disp, 'agent-5', target, '2026-07-16T00:00:00Z');
  assert.equal(e.status, 'pending_approval');
  assert.equal(e.buyerAddress, 'iBUY');
  assert.equal(e.refundAmount, 0.5);
  assert.equal(e.refundPercent, 100);
  assert.equal(e.disputeId, 'd1');
  assert.equal(e.orphan.buyerPayAddress, 'iBUY');
});
test('buildDisputeRefundEntry: unconfident target => needs_review with failing checks in reason', () => {
  const target = { address: 'iBUY', displayName: null, checks: { disputeSigner: false, isIAddress: true }, confident: false };
  const e = buildDisputeRefundEntry(undelivered, disp, 'agent-5', target, '2026-07-16T00:00:00Z');
  assert.equal(e.status, 'needs_review');
  assert.match(e.reason, /disputeSigner/);
});

// Exclusion-logic locks (Task 3 review, Minor): guard against a refactor that
// silently auto-refunds delivered/token-bearing work.
test('hasPositiveTokens: {total:0} and null are no-tokens; {input:5} is positive', () => {
  assert.equal(hasPositiveTokens({ total: 0 }), false);
  assert.equal(hasPositiveTokens(null), false);
  assert.equal(hasPositiveTokens(undefined), false);
  assert.equal(hasPositiveTokens({ input: 5 }), true);
  assert.equal(hasPositiveTokens({ total: 42 }), true);
});

test('excludes a job with a non-null empty delivery object', () => {
  const out = selectRefundableDisputes([{ ...undelivered, delivery: {} }], { j1: disp });
  assert.equal(out.length, 0);
});

test('excludes a job whose only token field is a positive input count', () => {
  const out = selectRefundableDisputes([{ ...undelivered, tokenUsage: { input: 5 } }], { j1: disp });
  assert.equal(out.length, 0);
});

// ---------------------------------------------------------------------------
// Seller-agreed refunds must reach the operator's approval queue.
//
// Found live on job b09440f5 (2026-08-06): responding `refund` to a dispute
// sets action:'refund' on the platform — which is exactly what disqualified the
// job from the `action === 'pending'` filter. Agreeing to pay was the thing
// that guaranteed nobody was ever asked to pay. The buyer saw refund_percent:100
// while no queue entry, no prompt and no automated path existed anywhere.
// ---------------------------------------------------------------------------

const job = (over = {}) => ({
  id: 'j1', status: 'disputed', delivery: null, tokenUsage: null,
  amount: 0.5, currency: 'VRSCTEST', ...over,
});
const target = { address: 'iBuyer', confident: true, checks: {} };

test('a seller-agreed refund IS queued for approval', () => {
  const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action: 'refund', refund_percent: 100 } });
  assert.equal(sel.length, 1, 'the seller said they owe it — it must reach the queue');
});

test('a seller-agreed refund is queued even when the job WAS delivered', () => {
  // Explicit consent outranks the heuristics: the unanswered path skips
  // delivered jobs because it is guessing, but here the seller has decided.
  const sel = selectRefundableDisputes(
    [job({ delivery: { hash: 'abc' }, tokenUsage: { totalTokens: 900 } })],
    { j1: { id: 'd', action: 'refund', refund_percent: 100 } });
  assert.equal(sel.length, 1);
});

test('a refund that was already PAID is never re-queued', () => {
  // The txid is the proof of payment. Re-queueing would pay twice.
  for (const tx of ['abc123', 'deadbeef']) {
    const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action: 'refund', refund_percent: 100, refund_txid: tx } });
    assert.equal(sel.length, 0, `already paid (${tx}) must not re-queue`);
  }
});

test('rework and rejected responses do NOT queue money', () => {
  for (const action of ['rework', 'rejected']) {
    const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action } });
    assert.equal(sel.length, 0, `${action} owes nothing`);
  }
});

test('a malformed refund_percent does not queue a guess', () => {
  for (const p of [null, undefined, 0, -5, 101, NaN, 'half', {}]) {
    const sel = selectRefundableDisputes([job()], { j1: { id: 'd', action: 'refund', refund_percent: p } });
    assert.equal(sel.length, 0, `refund_percent=${JSON.stringify(p)} must not queue`);
  }
});

test('a PARTIAL refund queues the agreed amount, not the whole job', () => {
  // The builder used to hardcode 100. A seller agreeing to 50% would have had
  // the full amount queued — paying double what they owed.
  const e = buildDisputeRefundEntry(job(), { id: 'd', action: 'refund', refund_percent: 50 }, 'agent-7', target, 'now');
  assert.equal(e.refundPercent, 50);
  assert.equal(e.refundAmount, 0.25, 'half of 0.5, not 0.5');
  assert.match(e.reason, /SELLER AGREED/);
});

test('the unanswered path still implies 100% and still requires "got nothing"', () => {
  const e = buildDisputeRefundEntry(job(), { id: 'd', action: 'pending' }, 'agent-7', target, 'now');
  assert.equal(e.refundPercent, 100);
  assert.equal(e.refundAmount, 0.5);
  // and it must still refuse a delivered job
  assert.equal(selectRefundableDisputes([job({ delivery: { hash: 'x' } })], { j1: { id: 'd', action: 'pending' } }).length, 0);
  assert.equal(selectRefundableDisputes([job({ tokenUsage: { totalTokens: 5 } })], { j1: { id: 'd', action: 'pending' } }).length, 0);
});

test('an unverified buyer address still routes to needs_review, not auto-approval', () => {
  const e = buildDisputeRefundEntry(job(), { id: 'd', action: 'refund', refund_percent: 100 }, 'agent-7',
    { address: 'iBuyer', confident: false, checks: { isIAddress: false } }, 'now');
  assert.equal(e.status, 'needs_review');
  assert.match(e.reason, /ADDRESS UNVERIFIED/);
});

// ── M5: an unusable agreed percentage must be loud, not silent ──────────────
//
// A seller-agreed refund whose percent is absent or outside (0,100] was dropped with
// no ledger entry, no event and no log line — the same silent-loss class this module
// documents as fixed in 2.12.2, reached through a different door. respond-dispute does
// not range-check the flag, so an operator typo is a live trigger and the buyer is
// simply never paid.

test('M5: an out-of-range agreed percentage is not queued, and says so', () => {
  const logged = [];
  const origErr = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    for (const bad of [150, 0, -10, 'abc', null, undefined]) {
      const jobs = [{ id: 'job-m5-bad', status: 'disputed', amount: 1 }];
      const disputes = { 'job-m5-bad': { action: 'refund', refund_percent: bad } };
      const picked = selectRefundableDisputes(jobs, disputes);
      assert.equal(picked.length, 0, `percent ${JSON.stringify(bad)} must not be auto-queued`);
    }
  } finally { console.error = origErr; }
  assert.ok(logged.length >= 6, 'every dropped refund must produce an operator-visible line');
  assert.ok(logged.some(l => /respond-dispute/.test(l)),
    'the message must name the command that fixes it');
});

test('flat and wrapped refund rows are both selected', () => {
  const flat = { action: 'refund', refund_percent: 100 };
  const wrapped = { dispute: { action: 'refund', refund_percent: 100 }, deadline_passed: false };
  assert.equal(selectRefundableDisputes([job()], { j1: flat }).length, 1);
  assert.equal(selectRefundableDisputes([job({ id: 'j-wrap' })], { 'j-wrap': wrapped }).length, 1);
  assert.equal(unwrapDispute(wrapped).action, 'refund');
  assert.equal(unwrapDispute(wrapped).refund_percent, 100);
  assert.equal(unwrapDispute(flat), flat);
  const entry = buildDisputeRefundEntry(job(), wrapped, 'agent-7', target, 'now');
  assert.equal(entry.refundPercent, 100);
  assert.match(entry.reason, /SELLER AGREED/);
});

test('camelCase refund percent and txid are read', () => {
  assert.equal(agreedRefundPercent({ refundPercent: 40 }), 40);
  assert.equal(alreadyPaid({ refundTxid: 'abc' }), true);
  const sel = selectRefundableDisputes([job()], {
    j1: { action: 'refund', refundPercent: 100, refundTxid: 'paid' },
  });
  assert.equal(sel.length, 0);
  const queued = selectRefundableDisputes([job()], {
    j1: { action: 'refund', refundPercent: 25 },
  });
  assert.equal(queued.length, 1);
});

test('a fetched dispute that is not selected logs the job prefix and action', () => {
  const lines = [];
  logUnselectedDisputes(
    [{ id: 'abcdef012345', status: 'disputed' }],
    { abcdef012345: { dispute: { action: 'rework' } } },
    [],
    (msg) => lines.push(msg),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /abcdef01/);
  assert.match(lines[0], /action=rework/);
});

test('seller disputed pages stop on a short page and cap a full scan', async () => {
  const calls = [];
  const short = await listSellerDisputedJobs(async ({ limit, offset }) => {
    calls.push({ limit, offset });
    if (offset === 0) return Array.from({ length: 20 }, (_, i) => ({ id: `p0-${i}` }));
    return [{ id: 'p1-0' }];
  }, { pageSize: 20, maxPages: 10, log: () => { throw new Error('short page must not hit the cap'); } });
  assert.equal(short.truncated, false);
  assert.equal(short.jobs.length, 21);
  assert.deepEqual(calls, [{ limit: 20, offset: 0 }, { limit: 20, offset: 20 }]);

  const logs = [];
  let n = 0;
  const capped = await listSellerDisputedJobs(async () => {
    const page = [];
    for (let i = 0; i < 20; i++) page.push({ id: `c-${n++}` });
    return page;
  }, { pageSize: 20, maxPages: 10, log: (msg) => logs.push(msg) });
  assert.equal(capped.truncated, true);
  assert.equal(capped.jobs.length, 200);
  assert.match(logs[0], /stopped after 10 pages/);
});

test('fetch paginates with request and falls back to getMyJobs', async () => {
  const seen = [];
  const viaRequest = await fetchSellerDisputedJobs({
    request: async (_method, url) => {
      seen.push(url);
      return { data: url.includes('offset=0') ? [{ id: 'only' }] : [] };
    },
  }, { pageSize: 20, maxPages: 3 });
  assert.equal(viaRequest.jobs.length, 1);
  assert.equal(viaRequest.jobs[0].id, 'only');
  assert.match(seen[0], /\/v1\/me\/jobs\?/);
  assert.match(seen[0], /role=seller/);
  assert.match(seen[0], /status=disputed/);
  assert.match(seen[0], /limit=20/);
  assert.match(seen[0], /offset=0/);

  const viaJobs = await fetchSellerDisputedJobs({
    getMyJobs: async (q) => {
      assert.equal(q.role, 'seller');
      assert.equal(q.status, 'disputed');
      return { data: [{ id: 'legacy' }] };
    },
  });
  assert.equal(viaJobs.jobs[0].id, 'legacy');
  assert.equal(viaJobs.truncated, false);
});

test('M5: a valid agreed percentage is still queued silently', () => {
  const logged = [];
  const origErr = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const jobs = [{ id: 'job-m5-ok', status: 'disputed', amount: 1 }];
    const disputes = { 'job-m5-ok': { action: 'refund', refund_percent: 50 } };
    assert.equal(selectRefundableDisputes(jobs, disputes).length, 1);
  } finally { console.error = origErr; }
  assert.equal(logged.length, 0, 'the happy path must not warn');
});
