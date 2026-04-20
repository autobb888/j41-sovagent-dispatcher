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
 * Check if buyer has enough credit for a request.
 */
function checkCredit(agentId, buyerVerusId, model, estimatedInputTokens, estimatedOutputTokens, modelPricing) {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  const estimatedCost = calculateCost(modelPricing, model, estimatedInputTokens, estimatedOutputTokens);
  return {
    allowed: buyer.balance >= estimatedCost,
    balance: buyer.balance,
    estimatedCost,
  };
}

/**
 * Deduct credit after a request completes.
 */
function deductCredit(agentId, buyerVerusId, model, inputTokens, outputTokens, modelPricing) {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  const cost = calculateCost(modelPricing, model, inputTokens, outputTokens);

  buyer.balance = Math.max(0, buyer.balance - cost);
  buyer.totalSpent += cost;
  buyer.lastActivity = new Date().toISOString();

  // Per-model usage tracking
  if (!buyer.usage[model]) {
    buyer.usage[model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  }
  buyer.usage[model].requests++;
  buyer.usage[model].inputTokens += inputTokens;
  buyer.usage[model].outputTokens += outputTokens;
  buyer.usage[model].cost += cost;

  saveMeters(agentId, data);
  return { remaining: buyer.balance, cost };
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

module.exports = { checkCredit, deductCredit, creditDeposit, getBalance, getMetrics, calculateCost };
