'use strict';
// Cat-1 gpu-rental worker. Accepted rental jobs acquire a lease, seal SSH via
// POST /v1/jobs/:id/rental-secret, and deliverJob a notice with NO host/password.
// Never calls startJob / startJobContainer / startJobLocal / JOB_IMAGE.
const { acquireRentalLease, assertPaidBeforePaidProvision, rentalExtensionGrant } = require('./rental-job');
const { deliverSealed } = require('./rental-delivery');

function isGpuRentalJob(job, services = []) {
  if (job && job.serviceType === 'gpu-rental') return true;
  if (!job || !job.serviceId) return false;
  const svc = (services || []).find((s) => s && (s.id === job.serviceId || s.serviceId === job.serviceId));
  return !!(svc && svc.serviceType === 'gpu-rental');
}

function servicesForAgent(state, agentInfo, loadAgentConfigFn) {
  const id = agentInfo && agentInfo.id;
  const cap = state && state.capabilities && typeof state.capabilities.get === 'function' && id
    ? state.capabilities.get(id)
    : null;
  if (cap && Array.isArray(cap.services) && cap.services.length) return cap.services;
  if (typeof loadAgentConfigFn === 'function' && id) {
    try {
      const { slotServicesFromAgentConfig } = require('./rental-setup');
      return slotServicesFromAgentConfig(loadAgentConfigFn(id)) || [];
    } catch {
      return [];
    }
  }
  return [];
}

function agentIsRentalSlot(services = []) {
  const list = services || [];
  return list.some((s) => s && s.serviceType === 'gpu-rental')
    && !list.some((s) => s && s.serviceType && s.serviceType !== 'gpu-rental');
}

function resolveRentalProvider(cfg, agentId) {
  const { providerCfgForAgent } = require('./rental-setup');
  const { createProvider } = require('./providers');
  const found = providerCfgForAgent(cfg, agentId);
  if (!found) throw new Error('RENTAL_NO_PROVIDER: declare [compute.providers.*] with agent_id=' + agentId);
  const [name, pcfg] = found;
  const provider = createProvider(pcfg.type, { id: name, ...pcfg });
  return { providerName: name, pcfg, provider };
}

async function ensureComputeController(state, cfg) {
  if (state && state.computeSupply) return state.computeSupply;
  if (state && state.proxyContext && state.proxyContext.computeSupply) {
    state.computeSupply = state.proxyContext.computeSupply;
    return state.computeSupply;
  }
  const { getCurrentController, maybeStartComputeSupply } = require('./compute-supply');
  const cur = getCurrentController();
  if (cur) {
    if (state) state.computeSupply = cur;
    return cur;
  }
  const agentConfigs = (state && state.proxyContext && state.proxyContext.agentConfigs) || new Map();
  const ctrl = await maybeStartComputeSupply({ cfg, agentConfigs });
  if (!ctrl) throw new Error('RENTAL_NO_CONTROLLER: [compute] enabled=true is required for gpu-rental');
  if (state) {
    state.computeSupply = ctrl;
    if (state.proxyContext) state.proxyContext.computeSupply = ctrl;
  }
  return ctrl;
}

async function startRentalJob(opts) {
  const {
    state, job, agentInfo, controller, provider, spec = {}, now = Date.now(),
    client, signDeliver, signer, providerName, ackPostpayVastRisk, jobTimeoutMin,
    startJobContainer: _startJobContainer,
  } = opts || {};
  // Injected in tests only to prove it is not called. Never invoke.
  void _startJobContainer;

  if (!controller) throw new Error('RENTAL_NO_CONTROLLER');
  if (!provider) throw new Error('RENTAL_NO_PROVIDER');
  if (!client) throw new Error('RENTAL_NO_CLIENT');
  if (!job || !job.id) throw new Error('RENTAL_NO_JOB');
  if (!agentInfo || !agentInfo.id) throw new Error('RENTAL_NO_AGENT');

  assertPaidBeforePaidProvision({ job, provider, ackPostpayVastRisk });

  // The rental period comes from the SELLER'S CONFIG, passed in explicitly by the caller.
  //
  // This used to read `job.timeoutMin ?? job.jobTimeoutMin ?? spec.jobTimeoutMin` and fall back
  // to 60. None of those three fields exists: the backend has no timeoutMin column or field, the
  // SDK never sends one, and the live caller passed no `spec` — so every rental was leased for 60
  // minutes while `rental-setup` advertised the seller's configured `job_timeout_min` in the
  // service description. A seller running 180 sold three hours, took the money under an
  // all-or-nothing no-refund term, and the reconcile loop killed the box at one.
  //
  // The tests could not catch it because all four of them passed `job.timeoutMin: 60` — a field
  // they invented. The phantom fallbacks are deliberately GONE so that can never recur.
  const periodMin = Number(jobTimeoutMin) > 0 ? Number(jobTimeoutMin) : 60;
  // The period price for mid-session extensions: the job amount at hire, BEFORE any paid
  // extension increments it on the platform side.
  const periodAmount = Number(job.amount) > 0 ? Number(job.amount) : null;
  const { lease, deliverable } = await acquireRentalLease({
    controller,
    provider,
    spec,
    jobId: job.id,
    agentId: agentInfo.id,
    jobTimeoutMin: periodMin,
    periodAmount,
    providerName,
    now,
  });

  try {
    if (typeof client.confirmWorkerAttached === 'function') {
      await client.confirmWorkerAttached(job.id);
    }
  } catch (e) {
    console.warn(`[Rental] confirmWorkerAttached failed for ${job.id}: ${e && e.message}`);
  }

  try {
    await deliverSealed({ client, signDeliver, signer, job, deliverable });
  } catch (e) {
    try { await controller.releaseLease(lease); } catch (relErr) {
      console.error(`[Rental] release after deliver failure: ${relErr && relErr.message}`);
    }
    throw e;
  }

  const rec = {
    kind: 'gpu-rental',
    leaseId: lease.id,
    agentId: agentInfo.id,
    agentInfo,
    agentInfoId: agentInfo.id,
    startedAt: now,
    rentalPeriodMin: periodMin,
    rentalPeriodAmount: periodAmount,
    jobAmount: job.amount || null,
    buyerPayAddress: job.buyerPayAddress || (job.buyer && job.buyer.payAddress) || null,
    currency: job.currency || null,
  };
  state.active.set(job.id, rec);
  if (Array.isArray(state.available)) {
    state.available = state.available.filter((a) => a.id !== agentInfo.id);
  }
  if (state.seen && typeof state.seen.set === 'function') {
    state.seen.set(job.id, now);
  }
  try { require('./config').persistActiveJobs(state.active); } catch { /* crash-recovery best-effort */ }
  state.emitEvent?.('job.started', { jobId: job.id, agentId: agentInfo.id, kind: 'gpu-rental', leaseId: lease.id });
  return { lease, deliverable };
}

/**
 * Should this rental extension be approved? Pure — no I/O.
 *
 * A rental extension is NOT a labour extension: CPU load and free RAM say nothing about
 * whether a leased box can be held for another hour, so the capacity gate that guards
 * labour jobs is meaningless here and would reject a perfectly extendable rental on a
 * busy host. What matters is (a) the box is still live and (b) the money buys at least
 * one whole period at the rate agreed at hire.
 *
 * Refusing BEFORE payment is the point: approval is what generates the buyer's invoice, so
 * an amount that buys nothing must be rejected here rather than discovered after the VRSC
 * has moved.
 */
function decideRentalExtension({ lease, amount, now = Date.now() } = {}) {
  if (!lease) return { approve: false, reason: 'no rental lease for this job' };
  if (lease.state === 'released' || lease.state === 'release-pending') {
    return { approve: false, reason: 'the rental box has been released' };
  }
  const expiresAt = Number(lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return { approve: false, reason: 'the rental has already expired' };
  }
  const grant = rentalExtensionGrant({
    amount,
    periodAmount: lease.rentalPeriodAmount,
    periodMin: lease.rentalPeriodMin,
  });
  if (!grant) {
    const price = Number(lease.rentalPeriodAmount);
    return {
      approve: false,
      reason: Number.isFinite(price) && price > 0
        ? `an extension must buy at least one whole period (${price} minimum)`
        : 'this rental has no period price recorded, so extra time cannot be priced',
    };
  }
  return { approve: true, grant };
}

/**
 * Apply a PAID rental extension: push the lease expiry out by the time bought.
 *
 * Idempotent by extensionId (see compute-supply.extendLease) — the webhook and the poll
 * fallback both deliver the same paid extension, deliberately, so that a missed webhook
 * cannot cost the buyer a box they paid to keep.
 */
function applyRentalExtension({ state, jobId, extensionId, amount, now = Date.now() } = {}) {
  const ctrl = resolveComputeController(state);
  if (!ctrl || typeof ctrl.extendLease !== 'function') {
    return { extended: false, reason: 'no compute controller' };
  }
  const active = state && state.active && state.active.get(jobId);
  const lease = findRentalLease(ctrl, active, jobId);
  const decision = decideRentalExtension({ lease, amount, now });
  if (!decision.approve) return { extended: false, reason: decision.reason };
  const before = Number(lease.expiresAt);
  const next = ctrl.extendLease(lease.id, decision.grant.ms, extensionId, now);
  if (!next) return { extended: false, reason: 'the lease could not be extended (gone or expired)' };
  // `changed` separates a real grant from the idempotent re-delivery of one already applied,
  // so the poll fallback can re-check every sweep without re-announcing the same hour.
  return {
    extended: true,
    changed: Number(next.expiresAt) !== before,
    leaseId: lease.id,
    minutes: decision.grant.minutes,
    periods: decision.grant.periods,
    expiresAt: next.expiresAt,
  };
}

// Delivered/completed is NOT a yank — Cat-1 credentials delivered means the buyer
// still owns the box until expiresAt. Compute-supply reconcile releases on expiry.
const YANK_RENTAL_STATUSES = Object.freeze([
  'cancelled', 'resolved', 'resolved_rejected',
]);

/**
 * Re-adopt rentals that outlived a dispatcher restart.
 *
 * A Cat-1 rental is `delivered` from the moment credentials go out, and nothing puts a
 * delivered job back into `state.active` on boot: crash recovery deliberately SKIPS it
 * (delivered means earned — auto-refunding it would make the operator eat the compute and
 * the payout) and then clears active-jobs.json, while the job poll only fetches
 * requested/accepted/in_progress. So a restart left a live, paid box running with the
 * dispatcher no longer tracking it, and two things broke:
 *
 *  1. Mid-session extension went dead. Both delivery paths — the `job.extension_paid`
 *     webhook and the poll sweep — key off `state.active`, so a renter could pay for more
 *     time and nothing would move the lease.
 *  2. The NEXT boot released the box early. `releaseOrphansOnBoot` keeps only leases whose
 *     jobId is in active-jobs.json; once that file has been cleared and never rewritten
 *     with the rental, the lease reads as an orphan and is released — while the renter is
 *     on it, inside time they paid for.
 *
 * The lease itself survives a restart intact (it is persisted whole, including the period
 * and the applied-extension ids), so re-adoption needs no platform state to reconstruct.
 */
async function adoptLiveRentals({ state, getSession, now = Date.now(), persist } = {}) {
  const ctrl = resolveComputeController(state);
  if (!ctrl || typeof ctrl.getLeases !== 'function' || !state || !state.active) return 0;
  let adopted = 0;
  for (const lease of ctrl.getLeases() || []) {
    if (!lease || !lease.jobId) continue;
    if (lease.state === 'released' || lease.state === 'release-pending') continue;
    if (!(Number(lease.expiresAt) > now)) continue;      // expiry is the reconcile loop's job
    if (state.active.has(lease.jobId)) continue;
    const agentInfo = (state.agents || []).find((a) => a && a.id === lease.boundAgentId);
    if (!agentInfo) continue;                            // cannot act for an agent we do not hold

    // Confirm the job is not one of the statuses that yank a rental. A fetch failure is NOT
    // a reason to skip: leaving it unadopted is what strands the box. Adopt, and let the
    // teardown sweep — which re-checks the status every pass — correct it.
    let status = null;
    if (typeof getSession === 'function') {
      try {
        const session = await getSession(agentInfo);
        const job = await session.client.getJob(lease.jobId);
        status = job && job.status;
      } catch { /* adopt anyway; the sweep re-checks */ }
    }
    if (status && YANK_RENTAL_STATUSES.includes(status)) continue;

    state.active.set(lease.jobId, {
      kind: 'gpu-rental',
      leaseId: lease.id,
      agentId: agentInfo.id,
      agentInfo,
      agentInfoId: agentInfo.id,
      startedAt: now,
      rentalPeriodMin: lease.rentalPeriodMin ?? null,
      rentalPeriodAmount: lease.rentalPeriodAmount ?? null,
      readopted: true,
    });
    if (Array.isArray(state.available)) {
      state.available = state.available.filter((a) => a.id !== agentInfo.id);
    }
    adopted++;
  }
  if (adopted) {
    // Rewrite active-jobs.json so the NEXT boot's orphan sweep still sees these as live.
    try { (persist || require('./config').persistActiveJobs)(state.active); } catch { /* best-effort */ }
  }
  return adopted;
}

function resolveComputeController(state) {
  if (!state) return null;
  return state.computeSupply || (state.proxyContext && state.proxyContext.computeSupply) || null;
}

function findRentalLease(controller, active, jobId) {
  if (!controller || typeof controller.getLeases !== 'function') return null;
  const leases = controller.getLeases() || [];
  if (active && active.leaseId) {
    const byId = leases.find((l) => l && l.id === active.leaseId);
    if (byId) return byId;
  }
  return leases.find((l) => l && l.jobId === jobId) || null;
}

function rentalLeaseGoneOrExpired(lease, now = Date.now()) {
  if (!lease) return true;
  if (lease.state === 'released') return true;
  if (lease.expiresAt != null && Number(lease.expiresAt) <= now) return true;
  return false;
}

function shouldTeardownRental({ state, jobId, active, job, now = Date.now() }) {
  if (job && YANK_RENTAL_STATUSES.includes(job.status)) return true;
  const ctrl = resolveComputeController(state);
  const lease = findRentalLease(ctrl, active, jobId);
  return rentalLeaseGoneOrExpired(lease, now);
}

async function stopRentalJob(state, jobId, { skipReturnAgent = false } = {}) {
  const active = state && state.active && state.active.get(jobId);
  if (!active || active.kind !== 'gpu-rental') return false;
  if (active._stopping) return false;
  active._stopping = true;

  const ctrl = resolveComputeController(state);
  const lease = findRentalLease(ctrl, active, jobId);
  if (ctrl && typeof ctrl.releaseLease === 'function' && lease && lease.state !== 'released') {
    try {
      await ctrl.releaseLease(lease);
    } catch (e) {
      console.error(`[Rental] releaseLease failed for ${jobId}: ${e && e.message}`);
    }
  }

  if (!skipReturnAgent && !active.paused) {
    const agentInfo = active.agentInfo;
    if (Array.isArray(state.available) && agentInfo && agentInfo.id) {
      if (!state.available.some((a) => a && a.id === agentInfo.id)) state.available.push(agentInfo);
    }
  }
  if (state.retries && typeof state.retries.delete === 'function') state.retries.delete(jobId);
  if (active._timeoutTimer) clearTimeout(active._timeoutTimer);

  state.active.delete(jobId);
  try { require('./config').persistActiveJobs(state.active); } catch { /* best-effort */ }
  if (state._lastSentStatus && typeof state._lastSentStatus.delete === 'function') state._lastSentStatus.delete(jobId);
  if (state._pendingWorkspace && typeof state._pendingWorkspace.delete === 'function') state._pendingWorkspace.delete(jobId);
  if (state.pendingPayment && typeof state.pendingPayment.delete === 'function') state.pendingPayment.delete(jobId);
  state.emitEvent?.('job.stopped', { jobId, agentId: active.agentId, kind: 'gpu-rental' });
  return true;
}

module.exports = {
  isGpuRentalJob,
  startRentalJob,
  stopRentalJob,
  shouldTeardownRental,
  servicesForAgent,
  agentIsRentalSlot,
  resolveRentalProvider,
  ensureComputeController,
  YANK_RENTAL_STATUSES,
  decideRentalExtension,
  applyRentalExtension,
  adoptLiveRentals,
};
