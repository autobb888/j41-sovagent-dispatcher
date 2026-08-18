'use strict';
// Compute-supply controller (S5-S7, hardened after adversarial money-path review).
// Owns lease lifecycle and publishes lease upstreams into the SAME agentConfigs Map the
// proxy reads per-request (proxy-handler.js, cli.js). No money moves for `local`; `vast`
// spends under a hard ceiling.
//
// Money-safety invariants:
//   - A lease is recorded + persisted the instant acquire() returns, BEFORE waitReady,
//     so a crash or a waitReady failure can never leak an untracked (billing) instance.
//   - Providers are always reconstructed WITH their real config (api_key) from
//     cfg.compute.providers, so a release DELETE is authenticated.
//   - release() failures keep the lease as 'release-pending'; the reconcile loop retries.
//   - Boot recovery rehydrates still-active rentals instead of wiping the ledger.
//   - reconcileTick is non-reentrant; the spend ceiling reserves headroom synchronously.
const { createProvider } = require('./providers');
const { persistLeases, loadLeases, loadActiveJobs } = require('./config');

function createSupplyController({ cfg, agentConfigs, now = Date.now }) {
  const leases = new Map();        // leaseId -> lease
  const bound = new Map();         // leaseId -> { provider, agentId, jobId }
  const savedUpstream = new Map();  // agentId -> { endpointUrl, allowPrivate } captured before a lease published
  let reserved = 0;                // in-flight USD/hour reserved by acquires not yet in `leases`
  let reconcileInFlight = false;
  const compute = (cfg && cfg.compute) || {};
  const provCfgs = compute.providers || {};

  function persist() { try { persistLeases(leases); } catch { /* logged by writer */ } }

  // Point an agent's proxy upstream at a ready lease. A job-bound (rental) lease is NEVER
  // published — a rented bare-metal box is not an inference upstream (H6b). The agent's
  // pre-lease upstream is saved once so unpublish can RESTORE it (H6), not null it.
  function publishUpstream(agentId, lease) {
    if (!agentId || (lease && lease.jobId)) return;
    const cur = agentConfigs.get(agentId) || {};
    if (!savedUpstream.has(agentId)) savedUpstream.set(agentId, { endpointUrl: cur.endpointUrl ?? null, allowPrivate: cur.allowPrivate });
    agentConfigs.set(agentId, { ...cur, endpointUrl: lease.baseUrl, allowPrivate: !!lease.private });
  }

  function unpublishUpstream(agentId) {
    if (!agentId) return;
    const cur = agentConfigs.get(agentId);
    if (!cur) return;
    const saved = savedUpstream.get(agentId);
    agentConfigs.set(agentId, { ...cur, endpointUrl: saved ? saved.endpointUrl : null, allowPrivate: saved ? saved.allowPrivate : cur.allowPrivate });
  }

  function committedUsdPerHour() {
    let sum = 0;
    for (const l of leases.values()) if (l.state !== 'released') sum += Number(l.usdPerHour) || 0;
    return sum;
  }

  // Reconstruct a provider for a lease WITH its real config (api_key), so a DELETE is
  // authenticated. Prefer the live bound provider; else the config table by providerName.
  function reconstructProvider(lease) {
    const b = bound.get(lease.id);
    if (b && b.provider) return b.provider;
    const pcfg = lease.providerName && provCfgs[lease.providerName];
    if (pcfg) return createProvider(lease.provider, { id: lease.id, ...pcfg });
    return createProvider(lease.provider, { id: lease.id, base_url: lease.baseUrl }); // best-effort fallback
  }

  // Record (or update) a lease + its binding and persist immediately (C4).
  function recordLease(lease, provider, agentId, extra = {}) {
    const l = { ...lease, boundAgentId: agentId ?? lease.boundAgentId ?? null, ...extra };
    leases.set(l.id, l);
    bound.set(l.id, { provider, agentId: l.boundAgentId, jobId: l.jobId });
    persist();
    return l;
  }

  // Try to release; on success mark 'released', on failure keep 'release-pending' (C2).
  async function tryRelease(lease, provider) {
    try {
      await provider.release(lease);
      const cur = leases.get(lease.id) || lease;
      leases.set(lease.id, { ...cur, state: 'released' });
      persist();
      return true;
    } catch (e) {
      const cur = leases.get(lease.id) || lease;
      leases.set(lease.id, { ...cur, state: 'release-pending', lastReleaseError: e.message });
      persist();
      return false;
    }
  }

  // Public: release a specific lease now (used by rental M4 cleanup).
  async function releaseLease(lease) {
    const provider = reconstructProvider(lease);
    const ok = await tryRelease(lease, provider);
    unpublishUpstream((bound.get(lease.id) || {}).agentId || lease.boundAgentId || null);
    return ok;
  }

  // Gate a PAID acquire against the ceiling, reserving headroom synchronously so
  // concurrent acquires can't jointly exceed it (H3). Records the pending lease the
  // instant acquire returns (C4). max<=0 blocks all paid provisioning.
  async function acquireUnderCeiling(provider, candidate, opts = {}) {
    const max = opts.maxUsdPerHour != null ? Number(opts.maxUsdPerHour) : Number(compute.max_usd_per_hour) || 0;
    const add = Number(candidate.usdPerHour) || 0;
    if (committedUsdPerHour() + reserved + add > max) {
      throw new Error(`CEILING_EXCEEDED committed=${committedUsdPerHour()} reserved=${reserved} add=${add} max=${max}`);
    }
    reserved += add;
    try {
      const lease = await provider.acquire(candidate);
      return recordLease(lease, provider, opts.agentId || null, { providerName: opts.providerName, jobId: opts.jobId });
    } finally {
      reserved -= add;
    }
  }

  async function attachLocalLeases() {
    for (const [name, pcfg] of Object.entries(provCfgs)) {
      if (pcfg.type !== 'local') continue;
      const provider = createProvider('local', { id: `local:${name}`, ...pcfg });
      const cands = await provider.discover({});
      // local is owned hardware (no ceiling); record before waitReady (C4).
      let lease = recordLease(await provider.acquire(cands[0], {}), provider, pcfg.agent_id, { providerName: name });
      lease = recordLease(await provider.waitReady(lease, { timeoutMs: 60000 }), provider, pcfg.agent_id, { providerName: name });
      if (lease.state === 'ready') publishUpstream(pcfg.agent_id, lease); else unpublishUpstream(pcfg.agent_id);
    }
    persist();
  }

  async function attachVastLeases() {
    const max = Number(compute.max_usd_per_hour) || 0;
    for (const [name, pcfg] of Object.entries(provCfgs)) {
      if (pcfg.type !== 'vast') continue;
      if (max <= 0) { console.log(`  Compute: vast "${name}" provisioning off (set compute.max_usd_per_hour > 0)`); continue; }
      const provider = createProvider('vast', { id: `vast:${name}`, ...pcfg });
      try {
        const cands = await provider.discover({});
        if (!cands.length) { console.log(`  Compute: vast "${name}" — no offers matched the spec`); continue; }
        // acquireUnderCeiling records the pending lease before waitReady (C4).
        const pending = await acquireUnderCeiling(provider, cands[0], { agentId: pcfg.agent_id, providerName: name });
        const lease = recordLease(await provider.waitReady(pending, { timeoutMs: 300000 }), provider, pcfg.agent_id, { providerName: name });
        if (lease.state === 'ready') publishUpstream(pcfg.agent_id, lease); else unpublishUpstream(pcfg.agent_id);
      } catch (e) {
        console.error(`  Compute: vast "${name}" attach failed: ${e.message}`);
      }
    }
    persist();
  }

  async function reconcileTick() {
    if (reconcileInFlight) return; // H4 — never let two ticks race
    reconcileInFlight = true;
    try {
      for (const [id, lease] of [...leases.entries()]) {
        if (lease.state === 'released') continue;
        const provider = reconstructProvider(lease);
        const agentId = (bound.get(id) || {}).agentId ?? lease.boundAgentId ?? null;

        // Expiry OR a prior failed release → (re)try release now.
        if (lease.state === 'release-pending' || (lease.expiresAt && now() > lease.expiresAt)) {
          await tryRelease(lease, provider);
          unpublishUpstream(agentId);
          continue;
        }

        const health = await provider.probe(lease);
        if (health.healthy) {
          const next = { ...lease, state: 'ready' };
          leases.set(id, next);
          publishUpstream(agentId, next);
          continue;
        }

        // Unhealthy. A job-bound rental is NEVER replaced — the buyer holds credentials
        // for THIS box; release it and let the job path handle the refund (H2).
        if (lease.jobId) { await tryRelease(lease, provider); unpublishUpstream(agentId); continue; }

        // Elastic non-job lease: replace-on-death. Release the dead box FIRST so its cost
        // frees ceiling headroom before the replacement acquire (H3).
        const caps = (provider && provider.capabilities) || {};
        if (caps.isElastic && caps.canProvision) {
          const released = await tryRelease(lease, provider);
          if (released) { leases.delete(id); bound.delete(id); }
          try {
            const cands = await provider.discover({});
            if (cands.length) {
              const pending = await acquireUnderCeiling(provider, cands[0], { agentId, providerName: lease.providerName });
              const fresh = recordLease(await provider.waitReady(pending, { timeoutMs: 300000 }), provider, agentId, { providerName: lease.providerName });
              if (fresh.state === 'ready') publishUpstream(agentId, fresh); else unpublishUpstream(agentId);
              continue;
            }
          } catch { /* fall through to degrade */ }
        }
        leases.set(id, { ...lease, state: 'degraded' });
        unpublishUpstream(agentId);
      }
      persist();
    } finally {
      reconcileInFlight = false;
    }
  }

  // Boot crash-recovery. Reconstruct providers WITH config so DELETEs are authenticated
  // (C1). Release terminal-job + non-job leases; a release failure keeps the lease as
  // release-pending. A still-active rental is REHYDRATED (kept in the map + file), not
  // wiped, so reconcile can expire/release it later (C3).
  async function releaseOrphansOnBoot(isJobActive) {
    const activeSet = typeof isJobActive === 'function' ? null : new Set(Object.keys(loadActiveJobs()));
    const active = isJobActive || ((jobId) => activeSet.has(jobId));
    const persisted = loadLeases();
    const keep = new Map();
    for (const [id, lease] of Object.entries(persisted)) {
      if (!lease || !lease.state || lease.state === 'released') continue;
      if (lease.jobId && active(lease.jobId)) {
        // Still-serving rental: rehydrate.
        leases.set(id, lease);
        bound.set(id, { provider: reconstructProvider(lease), agentId: lease.boundAgentId || null, jobId: lease.jobId });
        keep.set(id, lease);
        continue;
      }
      const provider = reconstructProvider(lease);
      try {
        await provider.release(lease);
      } catch {
        const pend = { ...lease, state: 'release-pending' };
        leases.set(id, pend);
        bound.set(id, { provider, agentId: lease.boundAgentId || null, jobId: lease.jobId });
        keep.set(id, pend);
      }
    }
    persistLeases(keep);
  }

  function getLeases() { return [...leases.values()]; }

  // Test/compat seams.
  function _injectBoundLease(lease, provider, agentId) {
    const l = { ...lease, boundAgentId: agentId };
    leases.set(l.id, l);
    bound.set(l.id, { provider, agentId, jobId: l.jobId });
  }
  function bindJobLease(lease, provider, agentId, jobId) {
    return recordLease({ ...lease, jobId }, provider, agentId, {});
  }

  return {
    attachLocalLeases, attachVastLeases, reconcileTick, releaseOrphansOnBoot, getLeases,
    publishUpstream, unpublishUpstream, committedUsdPerHour, acquireUnderCeiling, recordLease,
    releaseLease, bindJobLease, _injectBoundLease,
  };
}

// Singleton handle for the control API. Set by maybeStartComputeSupply.
let current = null;
function getCurrentController() { return current; }

async function maybeStartComputeSupply({ cfg, agentConfigs }) {
  if (!cfg || !cfg.compute || cfg.compute.enabled !== true) { current = null; return null; }
  const ctrl = createSupplyController({ cfg, agentConfigs });
  try { await ctrl.releaseOrphansOnBoot(); } catch { /* boot best-effort */ }
  await ctrl.attachLocalLeases();
  await ctrl.attachVastLeases();
  const ms = Number(cfg.compute.reconcile_ms) || 60000;
  const timer = setInterval(() => { ctrl.reconcileTick().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  ctrl._timer = timer;
  current = ctrl;
  return ctrl;
}

module.exports = { createSupplyController, maybeStartComputeSupply, getCurrentController };
