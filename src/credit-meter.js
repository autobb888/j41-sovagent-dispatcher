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
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  fs.chmodSync(p, 0o600);
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
  if (!pricing) return 0; // unknown model — free (or reject in caller)
  return (inputTokens * pricing.inputTokenRate) + (outputTokens * pricing.outputTokenRate);
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

  buyer.balance = Math.max(0, buyer.balance - diff);
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
  saveMeters(agentId, data);
  return { newBalance: buyer.balance };
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

module.exports = { reserveCredit, adjustCredit, refundReservation, creditDeposit, getBalance, getMetrics, calculateCost };
