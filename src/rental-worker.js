'use strict';
// Cat-1 gpu-rental worker. Accepted rental jobs acquire a lease, seal SSH via
// POST /v1/jobs/:id/rental-secret, and deliverJob a notice with NO host/password.
// Never calls startJob / startJobContainer / startJobLocal / JOB_IMAGE.
const { acquireRentalLease } = require('./rental-job');
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
    client, signDeliver, signer, providerName,
    startJobContainer: _startJobContainer,
  } = opts || {};
  // Injected in tests only to prove it is not called. Never invoke.
  void _startJobContainer;

  if (!controller) throw new Error('RENTAL_NO_CONTROLLER');
  if (!provider) throw new Error('RENTAL_NO_PROVIDER');
  if (!client) throw new Error('RENTAL_NO_CLIENT');
  if (!job || !job.id) throw new Error('RENTAL_NO_JOB');
  if (!agentInfo || !agentInfo.id) throw new Error('RENTAL_NO_AGENT');

  const jobTimeoutMin = Number(job.timeoutMin || job.jobTimeoutMin || spec.jobTimeoutMin) || 60;
  const { lease, deliverable } = await acquireRentalLease({
    controller,
    provider,
    spec,
    jobId: job.id,
    agentId: agentInfo.id,
    jobTimeoutMin,
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

module.exports = {
  isGpuRentalJob,
  startRentalJob,
  servicesForAgent,
  agentIsRentalSlot,
  resolveRentalProvider,
  ensureComputeController,
};
