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

module.exports = { computeMaxAgents, capacityLine, DEFAULTS };
