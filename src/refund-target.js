'use strict';
const { isIAddress } = require('@junction41/sovagent-sdk/dist/index.js');

/**
 * Establish and verify the destination for a refund. The ONLY place a refund
 * address is decided. Send target is the buyer's i-address (job.buyerVerusId);
 * a friendly name is displayed for human confirmation but never used as the
 * send destination. Returns confident:false (with the failing check) rather
 * than throwing, so callers hold the refund as needs_review.
 */
function resolveRefundTarget(job, dispute, ctx = {}) {
  const address = job && job.buyerVerusId;
  const selfAddresses = ctx.selfAddresses || new Set();
  const checks = {};
  checks.isIAddress = !!address && isIAddress(address);
  checks.notSelf = !!address && !selfAddresses.has(address);
  checks.notPlatformFee = !ctx.platformFeeAddress || address !== ctx.platformFeeAddress;
  if (dispute) checks.disputeSigner = !!address && dispute.raised_by === address;

  let displayName = null;
  if (typeof ctx.resolveName === 'function' && address) {
    try {
      const r = ctx.resolveName(address);
      if (r && r.name) {
        displayName = r.name;
        checks.nameRoundTrip = r.iaddress === address;
      }
    } catch { checks.nameRoundTrip = false; }
  }

  const confident =
    checks.isIAddress === true &&
    checks.notSelf === true &&
    checks.notPlatformFee === true &&
    (dispute ? checks.disputeSigner === true : true) &&
    (checks.nameRoundTrip !== false);

  return { address: address || null, displayName, checks, confident };
}
module.exports = { resolveRefundTarget };
