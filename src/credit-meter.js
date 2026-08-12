/**
 * Credit Meter — per-buyer VRSC balance tracking for API endpoint access.
 * Stored in ~/.j41/dispatcher/agents/<id>/credit-meters.json (0o600).
 *
 * Balance is in VRSC. Converted to tokens on-the-fly using modelPricing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const AGENTS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'agents');

function metersPath(agentId) {
  return path.join(AGENTS_DIR, agentId, 'credit-meters.json');
}

function loadMeters(agentId) {
  const p = metersPath(agentId);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return { buyers: {} };
}

function saveMeters(agentId, data) {
  const p = metersPath(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write: this holds buyers' prepaid VRSC balances. A bare writeFileSync
  // torn by a crash mid-write leaves a truncated file that loadMeters absorbs as
  // {buyers:{}} — every balance for this agent silently zeroed. tmp→rename makes
  // the replace atomic (same pattern as config.js persistReactivationQueue).
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function ensureBuyer(data, buyerVerusId) {
  if (!data.buyers[buyerVerusId]) {
    data.buyers[buyerVerusId] = {
      balance: 0,
      totalDeposited: 0,
      totalSpent: 0,
      lastActivity: new Date().toISOString(),
      usage: {},
    };
  }
  return data.buyers[buyerVerusId];
}

/**
 * Calculate cost in VRSC for a given number of tokens.
 * @param modelPricing - Array of { model, inputTokenRate, outputTokenRate }
 * @param model - Model name
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @returns Cost in VRSC
 */
function calculateCost(modelPricing, model, inputTokens, outputTokens) {
  const pricing = (modelPricing || []).find(p => p.model === model);
  if (!pricing) return 0; // unknown model — caller rejects before reaching here
  const ir = Number(pricing.inputTokenRate);
  const or = Number(pricing.outputTokenRate);
  // Fail CLOSED on invalid pricing: a NaN/negative/Infinite rate must never
  // compute to a free (0/NaN) or negative cost — that would be exploitable
  // free usage / credit injection. Infinity makes reserveCredit deny the request.
  if (!Number.isFinite(ir) || !Number.isFinite(or) || ir < 0 || or < 0) return Infinity;
  return (inputTokens * ir) + (outputTokens * or);
}

/**
 * Reserve credit atomically — deducts estimated cost upfront before the request.
 * Prevents TOCTOU race where concurrent requests both pass a balance check.
 * After the request completes, call adjustCredit to correct the estimate.
 */
function reserveCredit(agentId, buyerVerusId, model, estimatedInputTokens, estimatedOutputTokens, modelPricing) {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  const estimatedCost = calculateCost(modelPricing, model, estimatedInputTokens, estimatedOutputTokens);

  if (buyer.balance < estimatedCost) {
    return { allowed: false, balance: buyer.balance, estimatedCost };
  }

  // Deduct NOW — before the async proxy request
  buyer.balance -= estimatedCost;
  buyer.lastActivity = new Date().toISOString();
  saveMeters(agentId, data);

  return { allowed: true, reserved: estimatedCost, balance: buyer.balance };
}

/**
 * Adjust credit after request completes — corrects the upfront reservation.
 * If actual cost < reserved, refunds the difference. If actual > reserved, deducts more.
 * Also records per-model usage stats.
 */
function adjustCredit(agentId, buyerVerusId, model, inputTokens, outputTokens, reservedCost, modelPricing) {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  const actualCost = calculateCost(modelPricing, model, inputTokens, outputTokens);
  const diff = actualCost - reservedCost; // positive = undercharged, negative = overcharged

  // Settle the true cost. Do NOT clamp at zero: if actual usage exceeded the
  // upfront reservation, the balance must be allowed to go negative (debt) so
  // the overage is recovered. Clamping here previously absorbed the overage as
  // free usage, which a buyer could exploit near a zero balance. reserveCredit
  // blocks the next request while the balance is below the next estimate, so a
  // negative balance simply means "blocked until topped up".
  buyer.balance = buyer.balance - diff;
  buyer.totalSpent += actualCost;
  buyer.lastActivity = new Date().toISOString();

  if (!buyer.usage[model]) {
    buyer.usage[model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  buyer.usage[model].requests++;
  buyer.usage[model].inputTokens += inputTokens;
  buyer.usage[model].outputTokens += outputTokens;
  buyer.usage[model].cost += actualCost;

  saveMeters(agentId, data);
  return { remaining: buyer.balance, cost: actualCost };
}

/**
 * Refund a reservation (e.g., upstream failed, request never completed).
 */
function refundReservation(agentId, buyerVerusId, reservedCost) {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  buyer.balance += reservedCost;
  saveMeters(agentId, data);
}

/**
 * Credit a deposit (buyer sends VRSC to seller).
 */
function creditDeposit(agentId, buyerVerusId, amount, txid) {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  buyer.balance += amount;
  buyer.totalDeposited += amount;
  buyer.lastActivity = new Date().toISOString();
  if (txid) buyer.lastDepositTxid = txid;
  // Re-arm the credit-low notify: a deposit means the next downward crossing
  // should fire again. (Edge-triggered debounce, see checkAndFlagLow.)
  delete buyer.lowNotifiedAt;
  saveMeters(agentId, data);
  return { newBalance: buyer.balance };
}

/**
 * Edge-triggered, debounced credit-low detection.
 *
 * Returns true exactly ONCE per downward threshold crossing — when `balance`
 * is strictly below `threshold` AND the buyer is not already flagged. On a true
 * return it stamps `lowNotifiedAt` so subsequent sub-threshold calls return
 * false (no per-request spam). `creditDeposit` clears the flag to re-arm.
 *
 * A non-positive / non-finite threshold disables the feature (returns false).
 *
 * @returns {boolean} true if the caller should fire the credit-low notify now.
 */
function checkAndFlagLow(agentId, buyerVerusId, balance, threshold) {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  if (!(balance < threshold)) return false; // strict less-than; >= threshold is healthy

  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  if (buyer.lowNotifiedAt) return false; // already flagged this crossing — debounce

  buyer.lowNotifiedAt = new Date().toISOString();
  saveMeters(agentId, data);
  return true;
}

/**
 * Get a buyer's raw meter record (or undefined). Used by the proxy settle path
 * for the credit-low flag and by tests.
 */
function getMeter(agentId, buyerVerusId) {
  const data = loadMeters(agentId);
  return data.buyers[buyerVerusId];
}

/**
 * Get a buyer's current balance.
 */
function getBalance(agentId, buyerVerusId) {
  const data = loadMeters(agentId);
  const buyer = data.buyers[buyerVerusId];
  return buyer ? buyer.balance : 0;
}

/**
 * Get all buyer metrics for dashboard display.
 */
function getMetrics(agentId) {
  const data = loadMeters(agentId);
  return data.buyers;
}

module.exports = { reserveCredit, adjustCredit, refundReservation, creditDeposit, getBalance, getMetrics, calculateCost, checkAndFlagLow, getMeter };
