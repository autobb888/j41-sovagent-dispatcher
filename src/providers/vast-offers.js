'use strict';
// Pure offer scoring/filtering for the Vast provider — no network, so it's
// unit-testable in isolation (the hardware-sizing.js precedent). Given raw Vast
// /bundles/ offers + a spec, return Candidate[] cheapest-first.
function scoreOffers(offers, spec = {}) {
  const minVramGb = Number(spec.minVramGb) || 0;
  const maxUsd = spec.maxUsdPerHour == null ? Infinity : Number(spec.maxUsdPerHour);
  const minGpu = Number(spec.minGpuCount) || 1;
  return (offers || [])
    .filter((o) => o && o.rentable && !o.rented)
    .filter((o) => (Number(o.gpu_ram) || 0) / 1024 >= minVramGb)
    .filter((o) => (Number(o.num_gpus) || 0) >= minGpu)
    .filter((o) => (Number(o.dph_total) || Infinity) <= maxUsd)
    .map((o) => ({
      provider: 'vast',
      usdPerHour: Number(o.dph_total),
      gpu: { name: o.gpu_name || null, vramGb: Math.round((Number(o.gpu_ram) || 0) / 1024), count: Number(o.num_gpus) || 1 },
      meta: {
        askId: o.id,
        geolocation: o.geolocation || null,
        ...(spec.interruptible !== undefined ? { interruptible: !!spec.interruptible } : {}),
      },
    }))
    .sort((a, b) => a.usdPerHour - b.usdPerHour);
}
module.exports = { scoreOffers };
