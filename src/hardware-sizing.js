'use strict';
// Conservative capacity math for a download-and-run product: never OOM a
// stranger's machine. Pure functions (no os.* calls here) so they're testable;
// cli.js passes in os.totalmem()/os.cpus().length.

const GB = 1024 * 1024 * 1024;
const DEFAULTS = {
  perContainerMemBytes: 2 * GB, // matches cli.js container Memory (5959)
  coreReserve: 1,               // leave a core for host + dispatcher + egress/signer hosts
  minHostReserveBytes: 2 * GB,  // absolute floor for host headroom
  hostReserveFraction: 0.15,    // …or 15% of total, whichever is larger (conservative)
};

function computeMaxAgents({
  totalMemBytes,
  cpuCount,
  perContainerMemBytes = DEFAULTS.perContainerMemBytes,
  hostReserveBytes,
  coreReserve = DEFAULTS.coreReserve,
} = {}) {
  const reserve = hostReserveBytes != null
    ? hostReserveBytes
    : Math.max(DEFAULTS.minHostReserveBytes, Math.floor(totalMemBytes * DEFAULTS.hostReserveFraction));
  const memBound = Math.floor((totalMemBytes - reserve) / perContainerMemBytes);
  const cpuBound = cpuCount - coreReserve;
  return Math.max(1, Math.min(memBound, cpuBound));
}

function capacityLine({ totalMemBytes, cpuCount, maxAgents, perContainerMemBytes, hostReserveBytes }) {
  const gb = (b) => `${Math.round(b / GB)} GB`;
  return `Detected ${gb(totalMemBytes)} / ${cpuCount} cores → capacity ${maxAgents} agents `
    + `(${gb(perContainerMemBytes)} each, ${gb(hostReserveBytes)} host reserve). `
    + `Override with max_concurrent in config.`;
}

// Resolve the effective agent cap. The owner overrides ONLY by setting an
// explicit positive max_concurrent in the source-of-truth config (config.toml)
// or the J41_MAX_CONCURRENT env var. Anything else (unset, 0, negative, garbage)
// auto-follows the conservative hardware `estimate` — the system self-sizes and
// never runs above what the box safely supports unless the owner deliberately
// says so. `overridden` drives the startup notification.
function resolveCapacity({ configMax, estimate }) {
  const overridden = Number.isFinite(configMax) && configMax > 0;
  return {
    maxAgents: overridden ? configMax : estimate,
    auto: !overridden,
    overridden,
    estimate,
  };
}

module.exports = { computeMaxAgents, capacityLine, resolveCapacity, DEFAULTS };
