'use strict';
// Compute-supply controller (S5). Owns lease lifecycle and publishes upstream changes
// into the SAME agentConfigs Map that handleProxyRequest reads per-request
// (proxy-handler.js:254, cli.js:4058) — so "live upstream mutation" is just updating
// that Map's entries. No money moves; no external API is called (local only).
// Spec: junction41/docs/superpowers/specs/2026-08-18-sovereign-supply-integration-design.md §6.2
const { createProvider } = require('./providers');
const { persistLeases, loadLeases } = require('./config');

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

  async function reconcileTick() {
    for (const [id, lease] of leases) {
      if (lease.state === 'released') continue;
      const b = bound.get(id);
      const provider = b ? b.provider : createProvider(lease.provider, { id, base_url: lease.baseUrl });
      const agentId = b ? b.agentId : null;
      const health = await provider.probe(lease);
      const next = { ...lease, state: health.healthy ? 'ready' : 'degraded' };
      leases.set(id, next);
      if (health.healthy) publishUpstream(agentId, next);
      else unpublishUpstream(agentId);
    }
    persist();
  }

  // Boot crash-recovery: release any persisted, non-terminal lease, then clear the
  // file. release() is idempotent, so a double-release (or a lease already gone) is
  // safe. A leaked lease is capacity/money burning — this is the backstop.
  async function releaseOrphansOnBoot() {
    const persisted = loadLeases();
    for (const [id, lease] of Object.entries(persisted)) {
      if (lease && lease.state && lease.state !== 'released') {
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

  return { attachLocalLeases, reconcileTick, releaseOrphansOnBoot, getLeases, publishUpstream, unpublishUpstream, committedUsdPerHour, acquireUnderCeiling, _injectBoundLease };
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
  const ms = Number(cfg.compute.reconcile_ms) || 60000;
  const timer = setInterval(() => { ctrl.reconcileTick().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  ctrl._timer = timer;
  current = ctrl;
  return ctrl;
}

module.exports = { createSupplyController, maybeStartComputeSupply, getCurrentController };
