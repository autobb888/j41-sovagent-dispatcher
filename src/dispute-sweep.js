'use strict';
function hasPositiveTokens(t) {
  if (!t) return false;
  return Number(t.total || t.totalTokens || t.input || t.output || 0) > 0;
}
function selectRefundableDisputes(jobs, disputeByJobId) {
  return (jobs || []).filter(j => {
    if (!j || j.status !== 'disputed') return false;
    const d = disputeByJobId[j.id];
    if (!d || d.action !== 'pending') return false;
    if (j.delivery != null) return false;
    if (hasPositiveTokens(j.tokenUsage)) return false;
    return true;
  });
}
function buildDisputeRefundEntry(job, dispute, agentInfoId, target, nowIso) {
  const amount = Number(job.amount) || 0;
  const currency = job.currency || 'VRSCTEST';
  const failing = Object.entries(target.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
  return {
    agentInfoId,
    orphan: { jobAmount: amount, buyerPayAddress: target.address, currency, agentInfoId },
    refundAmount: amount,
    refundPercent: 100,
    buyerAddress: target.address,
    buyerDisplayName: target.displayName || null,
    addressChecks: target.checks,
    disputeId: dispute ? dispute.id : null,
    status: target.confident ? 'pending_approval' : 'needs_review',
    reason: target.confident
      ? `LLM outage: paid ${amount} ${currency}, delivery:null, tokenUsage:null — dispute ${dispute && dispute.id} auto-opened by platform`
      : `ADDRESS UNVERIFIED — failing checks: ${failing.join(',')}`,
    enqueuedAt: nowIso,
  };
}
module.exports = { hasPositiveTokens, selectRefundableDisputes, buildDisputeRefundEntry };
