'use strict';
// Raw-GPU rental (Cat-1): a job whose deliverable is SSH credentials. No new money
// engine — the existing per-job flow settles it. Release safety lives in
// compute-supply's reconcile/boot loops (S7 T3), not in the job loop, so it survives
// timeout/crash/dispute/SIGKILL. See docs/superpowers/plans/2026-08-18-s7-raw-gpu-rental.md.

function assertRentalEligibleAgent(services = []) {
  if ((services || []).some((s) => s && s.serviceType === 'api-endpoint')) {
    throw new Error('RENTAL_SLOT_CONFLICT: this agent has an api-endpoint service; rentals need a separate agent slot');
  }
}

function assertApiEligibleAgent(services = []) {
  if ((services || []).some((s) => s && s.serviceType === 'gpu-rental')) {
    throw new Error('API_SLOT_CONFLICT: this agent has a gpu-rental service; api endpoints need a separate agent slot');
  }
}

// Hard block: never hand a stranger SSH into a box the dispatcher can't isolate
// (a home/local provider returns canSsh:false).
function assertProviderCanSsh(provider) {
  if (!provider || !provider.capabilities || !provider.capabilities.canSsh) {
    throw new Error('RENTAL_NO_SSH: provider cannot offer SSH access (a home/local box is never rented bare-metal)');
  }
}

// Vast (canProvision && isElastic) starts billing Alice on acquire. Refuse until
// the buyer payment is verified, unless she persisted rentalAckPostpayVastRisk.
// home-gpu is canProvision true, isElastic false → skip (no outbound USD).
function assertPaidBeforePaidProvision({ job, provider, ackPostpayVastRisk, allowUnpriced }) {
  const { jobPaymentReady } = require('./job-payment');
  if (jobPaymentReady(job, { allowUnpriced: !!allowUnpriced })) return;
  if (ackPostpayVastRisk) return;
  const outbound = !!(provider && provider.capabilities && provider.capabilities.canProvision && provider.capabilities.isElastic);
  if (outbound) {
    throw new Error('VAST_PREPAY_REQUIRED: refusing Vast acquire before payment_verified');
  }
  throw new Error('PREPAY_REQUIRED: refusing rental acquire before payment_verified');
}

function hasSshCredential(ssh) {
  if (!ssh || typeof ssh !== 'object') return false;
  const pw = ssh.password != null && String(ssh.password).length > 0;
  const key = ssh.privateKey != null && String(ssh.privateKey).length > 0;
  return pw || key;
}

function assertSshDeliverable(ssh) {
  if (!hasSshCredential(ssh)) {
    throw new Error('RENTAL_SSH_NO_CREDENTIAL: refusing to deliver SSH without password or privateKey');
  }
  return ssh;
}

function formatRentalDeliverable(lease, { jobTimeoutMin } = {}) {
  const ssh = assertSshDeliverable(lease && lease.ssh);
  return {
    ssh,
    expiresAt: lease.expiresAt,
    disclosure: `This rental runs for up to ${jobTimeoutMin || 60} minutes. Billing is all-or-nothing: `
      + 'there is no pro-rata refund for unused time and the box is released at expiry. '
      + `To keep the box past that, request a session extension BEFORE it expires — each extension `
      + `buys another whole ${jobTimeoutMin || 60}-minute period at the same rate, added to the time you already hold.`,
  };
}

// Money -> wall-clock for a Cat-1 extension. Whole periods only: the rental is sold
// all-or-nothing with no pro-rata refund, so selling a fractional period would contradict
// the term the buyer accepted at hire. `amount` under one period buys nothing and MUST be
// refused at approval, before the buyer sends VRSC.
//
// Fails closed on a non-positive/absent period price: without a price there is no honest
// exchange rate, and guessing one sells time we did not price.
function rentalExtensionGrant({ amount, periodAmount, periodMin } = {}) {
  const a = Number(amount);
  const price = Number(periodAmount);
  const min = Number(periodMin);
  if (!Number.isFinite(a) || a <= 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(min) || min <= 0) return null;
  // Tolerate float dust in a decimal price (0.1 + 0.2 problems arrive here as amounts).
  const periods = Math.floor((a + 1e-8) / price);
  if (periods < 1) return null;
  return { periods, minutes: periods * min, ms: periods * min * 60000 };
}

// Acquire a rental lease for a job: canSsh-gated, on-demand pinned (a Cat-1 rental
// must not be reclaimed mid-hour), job-bound with an expiry. Returns the lease plus
// the credentials deliverable the (owner-reviewed) worker hook will hand to the buyer.
async function acquireRentalLease({ controller, provider, spec = {}, jobId, agentId, jobTimeoutMin = 60, periodAmount = null, providerName, now = Date.now(), waitOpts = {} }) {
  assertProviderCanSsh(provider);
  const cands = await provider.discover({ ...spec, interruptible: false });
  if (!cands.length) throw new Error('RENTAL_NO_CAPACITY: no on-demand offer matched the spec');
  const cand = { ...cands[0], meta: { ...(cands[0].meta || {}), interruptible: false } };
  // acquireUnderCeiling records the pending lease (with jobId) BEFORE waitReady (C4), so a
  // crash/timeout can't leak an untracked billing box. interruptible:false is passed through
  // to acquire so Vast omits the bid price (on-demand, not reclaimable).
  const pending = await controller.acquireUnderCeiling(provider, cand, {
    agentId, providerName, jobId, interruptible: false,
  });
  const expiresAt = now + jobTimeoutMin * 60000;
  const ready = await provider.waitReady(pending, { timeoutMs: 300000, readyFor: 'ssh', ...waitOpts });
  // rentalPeriodMin/rentalPeriodAmount travel ON THE LEASE (which is persisted), not in
  // process memory: a mid-session extension arriving after a dispatcher restart still needs
  // the exchange rate that was agreed at hire, and jobs.amount is mutated by every paid
  // extension so it cannot be read back as the original period price.
  const lease = controller.recordLease(
    { ...ready, jobId, expiresAt, rentalPeriodMin: jobTimeoutMin, rentalPeriodAmount: periodAmount ?? null },
    provider, agentId, { providerName },
  );
  // M4 — never hand degraded / ssh:null / credential-less SSH to a paying buyer. Release + fail.
  if (lease.state !== 'ready' || !hasSshCredential(lease.ssh)) {
    await controller.releaseLease(lease);
    throw new Error('RENTAL_NOT_READY: the rental box did not come up in time (released; no charge should stand)');
  }
  try {
    return { lease, deliverable: formatRentalDeliverable(lease, { jobTimeoutMin }) };
  } catch (e) {
    await controller.releaseLease(lease);
    throw e;
  }
}

module.exports = {
  assertRentalEligibleAgent, assertApiEligibleAgent, assertProviderCanSsh, assertPaidBeforePaidProvision,
  hasSshCredential, assertSshDeliverable, formatRentalDeliverable, acquireRentalLease,
  rentalExtensionGrant,
};
