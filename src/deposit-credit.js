'use strict';
function clampCredit(expectedAmount, confirmedAmount) {
  if (confirmedAmount == null) return Number(expectedAmount);
  const c = Number(confirmedAmount);
  return Number.isFinite(c) ? Math.min(Number(expectedAmount), c) : Number(expectedAmount);
}
module.exports = { clampCredit };
