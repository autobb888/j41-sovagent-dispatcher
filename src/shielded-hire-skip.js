'use strict';

/** True only when this hire was paid from a shielded note. */
function isShieldedHire(job) {
  return !!(job && job.payment && job.payment.kind === 'shielded');
}

module.exports = { isShieldedHire };
