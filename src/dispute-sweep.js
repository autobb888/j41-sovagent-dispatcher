'use strict';
/**
 * Which disputed jobs owe the buyer money, and what the ledger entry looks like.
 *
 * Two distinct obligations reach the operator's approval queue, and conflating
 * them would be a money bug in either direction:
 *
 *  1. UNANSWERED — the platform auto-opened a dispute, the seller has not
 *     responded, and the buyer demonstrably got nothing (no delivery, no
 *     tokens). This is the "paid and received nothing" safety net. It is
 *     deliberately narrow: a job with a real delivery or real token usage is
 *     NOT swept, because whether it is owed is a judgement call.
 *
 *  2. SELLER-AGREED — the seller answered `refund` and no txid exists yet.
 *     Here the judgement has already been made, explicitly and on the record,
 *     so delivery and token usage are irrelevant: the seller said they owe it.
 *
 * (2) was missing until 2.12.2, and its absence was a silent hole: responding
 * `refund` to a dispute set `action: 'refund'` on the platform, which is
 * precisely what disqualified the job from (1)'s `action === 'pending'` filter.
 * Agreeing to pay was the thing that guaranteed nobody was ever asked to pay.
 * The buyer saw `refund_percent: 100` while no queue entry, no prompt and no
 * automated path existed anywhere — found live on job b09440f5.
 */

function hasPositiveTokens(t) {
  if (!t) return false;
  return Number(t.total || t.totalTokens || t.input || t.output || 0) > 0;
}

/** Has the seller already paid this one? A txid is the proof. */
function alreadyPaid(d) {
  const tx = d && (d.refund_txid || d.refundTxid);
  return typeof tx === 'string' && tx.length > 0;
}

/**
 * GET /v1/jobs/:id/dispute is `{ dispute, deadline_at, ... }`. The SDK usually
 * returns the inner row. A body with no action and a `.dispute` object is that
 * wrapper — use the inner row.
 */
function unwrapDispute(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw || null;
  if (raw.action == null && raw.dispute && typeof raw.dispute === 'object' && !Array.isArray(raw.dispute)) {
    return raw.dispute;
  }
  return raw;
}

/**
 * The percentage the seller actually agreed to.
 *
 * Load-bearing: the entry builder used to hardcode 100. A seller who agreed to
 * 50% would have had the full amount queued, i.e. paid double what they owed.
 * Falls back to 100 only for the unanswered case, where the whole payment is
 * being returned by definition.
 */
function agreedRefundPercent(d) {
  const raw = d && (d.refund_percent ?? d.refundPercent);
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}

function selectRefundableDisputes(jobs, disputeByJobId) {
  return (jobs || []).filter(j => {
    if (!j || j.status !== 'disputed') return false;
    const d = unwrapDispute(disputeByJobId[j.id]);
    if (!d) return false;
    if (alreadyPaid(d)) return false; // never re-queue something already sent

    // (2) Seller agreed to refund. Explicit consent outranks the heuristics —
    // a delivered job can still be refunded if the seller said so.
    // M5 — a seller-agreed refund whose percentage is absent or outside (0,100] used
    // to be dropped here with NO ledger entry, NO event and NO log line: the same
    // silent-loss class this file documents as fixed in 2.12.2, reached through a
    // different door. `respond-dispute` does not range-check the flag, so an operator
    // typo (`--refund-percent 150`, or `1o0`) is a live trigger and the buyer is
    // simply never paid. Keep it OUT of the auto-queue — we must not invent an amount
    // the seller did not agree to — but make it impossible to miss.
    if (d.action === 'refund') {
      if (agreedRefundPercent(d) !== null) return true;
      const raw = d.refund_percent ?? d.refundPercent;
      console.error(`[DisputeSweep] ⚠️  ${String(j.id).substring(0, 8)}: seller agreed to a refund but the ` +
        `percentage is unusable (${JSON.stringify(raw)}). NOT queueing — the amount owed is ambiguous. ` +
        `Fix it with: j41-dispatcher respond-dispute ${j.id} --agent <id> --action refund --refund-percent <1-100> --message "..."`);
      return false;
    }

    // (1) Unanswered + buyer got nothing.
    if (d.action !== 'pending') return false;
    if (j.delivery != null) return false;
    if (hasPositiveTokens(j.tokenUsage)) return false;
    return true;
  });
}

function buildDisputeRefundEntry(job, dispute, agentInfoId, target, nowIso) {
  dispute = unwrapDispute(dispute);
  const amount = Number(job.amount) || 0;
  const currency = job.currency || 'VRSCTEST';
  const failing = Object.entries(target.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
  const sellerAgreed = dispute && dispute.action === 'refund';
  // Honour the agreed percentage. Only the unanswered path implies 100%.
  const pct = sellerAgreed ? (agreedRefundPercent(dispute) ?? 100) : 100;
  const refundAmount = Math.round(amount * (pct / 100) * 1e8) / 1e8;

  return {
    agentInfoId,
    orphan: { jobAmount: amount, buyerPayAddress: target.address, currency, agentInfoId },
    refundAmount,
    refundPercent: pct,
    buyerAddress: target.address,
    buyerDisplayName: target.displayName || null,
    addressChecks: target.checks,
    disputeId: dispute ? dispute.id : null,
    status: target.confident ? 'pending_approval' : 'needs_review',
    reason: !target.confident
      ? `ADDRESS UNVERIFIED — failing checks: ${failing.join(',')}`
      : sellerAgreed
        ? `SELLER AGREED to refund ${pct}% of ${amount} ${currency} — dispute ${dispute && dispute.id}, no txid yet`
        : `Paid ${amount} ${currency}, delivery:null, tokenUsage:null — dispute ${dispute && dispute.id} auto-opened by platform, seller has not responded`,
    enqueuedAt: nowIso,
  };
}

function logUnselectedDisputes(jobs, disputeByJobId, selectedJobs, log = console.log) {
  const selected = new Set((selectedJobs || []).map((j) => j && j.id).filter(Boolean));
  for (const job of jobs || []) {
    if (!job || !job.id || selected.has(job.id)) continue;
    const d = unwrapDispute(disputeByJobId && disputeByJobId[job.id]);
    if (!d) continue;
    const action = d.action == null ? 'none' : d.action;
    log(`[DisputeSweep] ${String(job.id).substring(0, 8)} not selected (action=${action})`);
  }
}

/**
 * Page GET /v1/me/jobs until a short page. `fetchPage` returns one page of rows.
 * Stops after `maxPages` and logs when a full last page means later jobs were skipped.
 */
async function listSellerDisputedJobs(fetchPage, opts = {}) {
  const pageSize = opts.pageSize || 20;
  const maxPages = opts.maxPages || 10;
  const log = opts.log || console.error;
  const jobs = [];
  const seen = new Set();
  let truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const list = await fetchPage({ limit: pageSize, offset });
    const rows = Array.isArray(list) ? list : [];
    let added = 0;
    for (const row of rows) {
      if (!row || !row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      jobs.push(row);
      added += 1;
    }
    if (rows.length < pageSize || added === 0) return { jobs, truncated: false };
    if (page === maxPages - 1) {
      truncated = true;
      log(`stopped after ${maxPages} pages of disputed seller jobs — later pages were not scanned`);
    }
  }
  return { jobs, truncated };
}

async function fetchSellerDisputedJobs(client, opts = {}) {
  if (!client || typeof client.request !== 'function') {
    if (!client || typeof client.getMyJobs !== 'function') return { jobs: [], truncated: false };
    const res = await client.getMyJobs({ role: 'seller', status: 'disputed' });
    const rows = res && res.data ? res.data : (Array.isArray(res) ? res : []);
    return { jobs: rows, truncated: false };
  }
  return listSellerDisputedJobs(async ({ limit, offset }) => {
    const query = new URLSearchParams({
      role: 'seller',
      status: 'disputed',
      limit: String(limit),
      offset: String(offset),
    });
    const res = await client.request('GET', `/v1/me/jobs?${query}`);
    if (res && Array.isArray(res.data)) return res.data;
    if (Array.isArray(res)) return res;
    return [];
  }, opts);
}

module.exports = {
  hasPositiveTokens, alreadyPaid, agreedRefundPercent, unwrapDispute,
  selectRefundableDisputes, buildDisputeRefundEntry, logUnselectedDisputes,
  listSellerDisputedJobs, fetchSellerDisputedJobs,
};
