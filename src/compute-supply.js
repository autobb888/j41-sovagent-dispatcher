'use strict';
// Compute-supply controller (S5). Owns lease lifecycle and publishes upstream changes
// into the SAME agentConfigs Map that handleProxyRequest reads per-request
// (proxy-handler.js:254, cli.js:4058) — so "live upstream mutation" is just updating
// that Map's entries. No money moves; no external API is called (local only).
// Spec: junction41/docs/superpowers/specs/2026-08-18-sovereign-supply-integration-design.md §6.2
const { createProvider } = require('./providers');
const { persistLeases, loadLeases, loadActiveJobs } = require('./config');

function createSupplyController({ cfg, agentConfigs, now = Date.now }) {
  const leases = new Map(); // leaseId -> lease
  const bound = new Map();  // leaseId -> { provider, agentId }
  const compute = (cfg && cfg.compute) || {};
  const provCfgs = compute.providers || {};

  function persist() { persistLeases(leases); }

  // Point an agent's proxy upstream at a ready lease. Carries the per-lease private
  // allowance onto the agentConfigs entry so a home GPU is reachable WITHOUT the
  // global runtime.allow_local_upstream (proxy-handler checkUpstreamHostSafe, T8).
  function publishUpstream(agentId, lease) {
    if (!agentId) return;
    const cur = agentConfigs.get(agentId) || {};
    agentConfigs.set(agentId, { ...cur, endpointUrl: lease.baseUrl, allowPrivate: !!lease.private });
  }

  // A degraded lease clears the upstream so the proxy returns its clean
  // "Seller endpoint not configured" 502 instead of a raw ECONNREFUSED.
  function unpublishUpstream(agentId) {
    if (!agentId) return;
    const cur = agentConfigs.get(agentId);
    if (cur) agentConfigs.set(agentId, { ...cur, endpointUrl: null });
  }

  async function attachLocalLeases() {
    for (const [name, pcfg] of Object.entries(provCfgs)) {
      if (pcfg.type !== 'local') continue; // S6 handles vast
      const provider = createProvider('local', { id: `local:${name}`, ...pcfg });
      const cands = await provider.discover({});
      let lease = await provider.acquire(cands[0], {});
      lease = await provider.waitReady(lease, { timeoutMs: 60000 });
      leases.set(lease.id, lease);
      bound.set(lease.id, { provider, agentId: pcfg.agent_id });
      if (lease.state === 'ready') publishUpstream(pcfg.agent_id, lease);
      else unpublishUpstream(pcfg.agent_id);
    }
    persist();
  }

  // Provision rented (vast) leases. OFF unless compute.max_usd_per_hour > 0 — paid
  // provisioning is opt-in. Every acquire passes the ceiling gate. Never auto-spends
  // when disabled.
  async function attachVastLeases() {
    const max = Number(compute.max_usd_per_hour) || 0;
    for (const [name, pcfg] of Object.entries(provCfgs)) {
      if (pcfg.type !== 'vast') continue;
      if (max <= 0) { console.log(`  Compute: vast "${name}" provisioning off (set compute.max_usd_per_hour > 0)`); continue; }
      const provider = createProvider('vast', { id: `vast:${name}`, ...pcfg });
      try {
        const cands = await provider.discover({});
        if (!cands.length) { console.log(`  Compute: vast "${name}" — no offers matched the spec`); continue; }
        let lease = await acquireUnderCeiling(provider, cands[0]);
        lease = await provider.waitReady(lease, { timeoutMs: 300000 });
        leases.set(lease.id, lease);
        bound.set(lease.id, { provider, agentId: pcfg.agent_id });
        if (lease.state === 'ready') publishUpstream(pcfg.agent_id, lease);
        else unpublishUpstream(pcfg.agent_id);
      } catch (e) {
        console.error(`  Compute: vast "${name}" attach failed: ${e.message}`);
      }
    }
    persist();
  }

  async function reconcileTick() {
    // Snapshot: a replacement adds a fresh lease mid-loop, and iterating the live Map
    // would re-probe it in the same tick (an unhealthy-probe provider would loop forever).
    for (const [id, lease] of [...leases.entries()]) {
      if (lease.state === 'released') continue;
      // Rental expiry (S7): a job-bound lease past its window is released here, so the
      // box is freed by the reconcile loop even if the job loop never got to it.
      if (lease.expiresAt && now() > lease.expiresAt) {
        const bx = bound.get(id);
        const prov = bx ? bx.provider : createProvider(lease.provider, { id, base_url: lease.baseUrl });
        try { await prov.release(lease); } catch { /* idempotent */ }
        leases.set(id, { ...lease, state: 'released' });
        unpublishUpstream(bx ? bx.agentId : null);
        continue;
      }
      const b = bound.get(id);
      const provider = b ? b.provider : createProvider(lease.provider, { id, base_url: lease.baseUrl });
      const agentId = b ? b.agentId : null;
      const health = await provider.probe(lease);
      if (health.healthy) {
        const next = { ...lease, state: 'ready' };
        leases.set(id, next);
        publishUpstream(agentId, next);
        continue;
      }
      // Unhealthy. For an elastic, provisionable provider (vast), replace-on-death.
      const caps = (provider && provider.capabilities) || {};
      if (caps.isElastic && caps.canProvision) {
        try {
          const cands = await provider.discover({});
          if (cands.length) {
            let fresh = await acquireUnderCeiling(provider, cands[0]);
            fresh = await provider.waitReady(fresh, { timeoutMs: 300000 });
            try { await provider.release(lease); } catch { /* best effort */ }
            leases.delete(id);
            bound.delete(id);
            leases.set(fresh.id, fresh);
            if (b) bound.set(fresh.id, b);
            if (fresh.state === 'ready') publishUpstream(agentId, fresh);
            else unpublishUpstream(agentId);
            continue;
          }
        } catch { /* fall through to degrade-in-place */ }
      }
      // Non-elastic (local) or replacement failed: degrade in place, clear upstream.
      leases.set(id, { ...lease, state: 'degraded' });
      unpublishUpstream(agentId);
    }
    persist();
  }

  // Boot crash-recovery: release any persisted, non-terminal lease, then clear the
  // file. release() is idempotent, so a double-release (or a lease already gone) is
  // safe. A leaked lease is capacity/money burning — this is the backstop.
  async function releaseOrphansOnBoot(isJobActive) {
    const activeSet = typeof isJobActive === 'function' ? null : new Set(Object.keys(loadActiveJobs()));
    const active = isJobActive || ((jobId) => activeSet.has(jobId));
    const persisted = loadLeases();
    for (const [id, lease] of Object.entries(persisted)) {
      if (!lease || !lease.state || lease.state === 'released') continue;
      // Release a non-job lease (S5: local re-attaches fresh) OR a job-bound lease
      // whose job is terminal (S7: a leaked rental is money burning). Keep a
      // job-bound lease whose job is still active.
      const terminalJob = lease.jobId && !active(lease.jobId);
      if (terminalJob || !lease.jobId) {
        try { await createProvider(lease.provider, { id, base_url: lease.baseUrl }).release(lease); }
        catch { /* idempotent; ignore */ }
      }
    }
    persistLeases(new Map());
  }

  function getLeases() { return [...leases.values()]; }

  // Sum USD/hour committed across held (non-released) leases.
  function committedUsdPerHour() {
    let sum = 0;
    for (const l of leases.values()) if (l.state !== 'released') sum += Number(l.usdPerHour) || 0;
    return sum;
  }

  // The hard spend ceiling (spec §7 / GPU doc §7): a paid acquire is refused unless
  // committed + this candidate stays within compute.max_usd_per_hour. max<=0 blocks
  // ALL paid provisioning — provisioning is off until the operator opts in with a number.
  async function acquireUnderCeiling(provider, candidate, opts = {}) {
    const max = opts.maxUsdPerHour != null ? Number(opts.maxUsdPerHour) : Number(compute.max_usd_per_hour) || 0;
    const committed = opts.committedUsdPerHour != null ? Number(opts.committedUsdPerHour) : committedUsdPerHour();
    const add = Number(candidate.usdPerHour) || 0;
    if (committed + add > max) throw new Error(`CEILING_EXCEEDED committed=${committed} add=${add} max=${max}`);
    return provider.acquire(candidate);
  }

  // Test seam: register a pre-built lease + its provider binding (used by replace-on-death tests).
  function _injectBoundLease(lease, provider, agentId) {
    leases.set(lease.id, lease);
    bound.set(lease.id, { provider, agentId });
  }

  // Bind a lease to a rental job (S7). The jobId + expiresAt on the lease drive
  // release from reconcile/boot, so the box is freed even if the job loop never gets to.
  function bindJobLease(lease, provider, agentId, jobId) {
    const l = { ...lease, jobId };
    leases.set(l.id, l);
    bound.set(l.id, { provider, agentId, jobId });
    return l;
  }

  return { attachLocalLeases, attachVastLeases, reconcileTick, releaseOrphansOnBoot, getLeases, publishUpstream, unpublishUpstream, committedUsdPerHour, acquireUnderCeiling, bindJobLease, _injectBoundLease };
}

// Singleton handle for the control API (T10). Set by maybeStartComputeSupply.
let current = null;
function getCurrentController() { return current; }

// Boot entry point wired from cli.js. No-op unless [compute] enabled=true (the
// rollback switch): returns null and leaves agentConfigs untouched.
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
