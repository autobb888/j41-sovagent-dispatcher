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

function formatRentalDeliverable(lease, { jobTimeoutMin } = {}) {
  return {
    ssh: lease.ssh,
    expiresAt: lease.expiresAt,
    disclosure: `This rental runs for up to ${jobTimeoutMin || 60} minutes. Billing is all-or-nothing: `
      + 'there is no pro-rata refund for unused time and the box is released at expiry.',
  };
}

// Acquire a rental lease for a job: canSsh-gated, on-demand pinned (a Cat-1 rental
// must not be reclaimed mid-hour), job-bound with an expiry. Returns the lease plus
// the credentials deliverable the (owner-reviewed) worker hook will hand to the buyer.
async function acquireRentalLease({ controller, provider, spec = {}, jobId, agentId, jobTimeoutMin = 60, now = Date.now() }) {
  assertProviderCanSsh(provider);
  const cands = await provider.discover({ ...spec, interruptible: false });
  if (!cands.length) throw new Error('RENTAL_NO_CAPACITY: no on-demand offer matched the spec');
  let lease = await controller.acquireUnderCeiling(provider, cands[0]);
  lease = await provider.waitReady(lease, { timeoutMs: 300000 });
  lease = { ...lease, jobId, expiresAt: now + jobTimeoutMin * 60000 };
  controller.bindJobLease(lease, provider, agentId, jobId);
  return { lease, deliverable: formatRentalDeliverable(lease, { jobTimeoutMin }) };
}

module.exports = { assertRentalEligibleAgent, assertApiEligibleAgent, assertProviderCanSsh, formatRentalDeliverable, acquireRentalLease };
