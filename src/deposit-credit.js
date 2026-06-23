'use strict';
function clampCredit(expectedAmount, confirmedAmount) {
  if (confirmedAmount == null) return Number(expectedAmount);
  const c = Number(confirmedAmount);
  // Clamp to non-negative: a (compromised/buggy) backend returning a negative
  // confirmedAmount must never debit the buyer's balance via creditDeposit.
  return Number.isFinite(c) ? Math.max(0, Math.min(Number(expectedAmount), c)) : Number(expectedAmount);
}
module.exports = { clampCredit };
