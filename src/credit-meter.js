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

// ── Cross-process serialisation of the balance file ─────────────────────────
//
// Every mutation here is a synchronous load → mutate → save, which Node's single
// thread already serialises WITHIN a process. That was sufficient while the
// daemon was the only writer. It stopped being sufficient when `deposits credit`
// shipped: an operator resolving an anomaly out-of-band is a second process
// writing this file, and the proxy path writes it two or three times per served
// request. Atomic tmp→rename makes each write whole; it does nothing about a
// lost update, and the loser here is either a buyer's balance or a settled
// charge.
//
// SYNCHRONOUS on purpose. The critical section contains no awaits, so the lock
// is held for microseconds, and making it async would turn every call site —
// including the proxy hot path — into an async signature for no benefit.
//
// Fails OPEN after a short deadline, and this is the one place in the deposit
// work where that is the right call: refusing to settle a completed LLM request
// would either drop the charge (free compute) or fail a request the buyer has
// already been served. A lost update is a rare bounded error; a broken settle
// path is a continuous one. It says so loudly when it happens.
const METER_LOCK_SPIN_MS = 250;
const METER_LOCK_STALE_MS = 100;

function meterLockPath(agentId) {
  return path.join(AGENTS_DIR, agentId, 'credit-meters.lock');
}

/**
 * Run a synchronous meter mutation with the file lock held.
 *
 * Delegates to file-lock.js rather than re-implementing the discipline. The
 * first version of this function stole a dead holder's lock by unlinking it and
 * retrying, which is exactly the pattern acquireSendLock's comment condemns —
 * two contenders judge the same dead lock, the second's unlink deletes the
 * first's freshly published live one, and both end up inside the section. It
 * was written three commits after file-lock.js wrote that invariant down.
 *
 * @param {string} agentId
 * @param {Function} fn
 * @param {{failClosed?: boolean}} [opts]
 */
function withMeterLock(agentId, fn, opts = {}) {
  const { acquireFileLockSync, releaseFileLock } = require('./file-lock.js');
  const lockPath = meterLockPath(agentId);

  let token = null;
  try {
    token = acquireFileLockSync(lockPath, { timeoutMs: METER_LOCK_SPIN_MS, staleMs: METER_LOCK_STALE_MS });
  } catch (e) {
    // A filesystem that refuses us entirely must not take the request path down.
    console.error(`[Meter] ${agentId}: lock unavailable (${e.message})`);
  }

  if (!token) {
    // Fail-open is right for the PROXY settle path — refusing to settle a
    // request the buyer has already been served would either drop the charge or
    // break a response. It is wrong for a deposit adjudication, which can
    // simply be retried, so those callers pass failClosed and get an error
    // instead of a silent lost update.
    if (opts.failClosed) {
      const e = new Error(`could not acquire the credit-meter lock for ${agentId}`);
      e.code = 'METER_LOCK_BUSY';
      throw e;
    }
    console.error(`[Meter] ${agentId}: balance lock not acquired in ${METER_LOCK_SPIN_MS}ms — ` +
      'applying the change UNSERIALIZED. A concurrent writer could drop it; ' +
      'compare totalDeposited against the deposit ledger if a balance looks wrong.');
  }
  try {
    return fn();
  } finally {
    if (token) releaseFileLock(lockPath, token);
  }
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
  return withMeterLock(agentId, () => {
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
  });
}

/**
 * Adjust credit after request completes — corrects the upfront reservation.
 * If actual cost < reserved, refunds the difference. If actual > reserved, deducts more.
 * Also records per-model usage stats.
 */
function adjustCredit(agentId, buyerVerusId, model, inputTokens, outputTokens, reservedCost, modelPricing) {
  return withMeterLock(agentId, () => {
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
  });
}

/**
 * Refund a reservation (e.g., upstream failed, request never completed).
 */
function refundReservation(agentId, buyerVerusId, reservedCost) {
  return withMeterLock(agentId, () => {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  buyer.balance += reservedCost;
  saveMeters(agentId, data);
  });
}

/**
 * Credit a deposit (buyer sends VRSC to seller).
 */
function creditDeposit(agentId, buyerVerusId, amount, txid) {
  // failClosed: a deposit adjudication can simply be retried, unlike a proxy
  // settle for a request the buyer has already been served. Without this the
  // most carefully-guarded paths in the system inherit the hot path's
  // fail-open policy purely because they share a lock wrapper.
  return withMeterLock(agentId, () => {
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
  }, { failClosed: true });
}

/**
 * Reverse a deposit that was credited but whose funding transaction never landed.
 *
 * M4: deposits under 2 VRSC are credited at 0 confirmations — straight from the
 * mempool — so the buyer gets instant proxy access. A mempool transaction is not
 * money: it can be evicted, replaced, or simply never mined. Nothing ever went
 * back to check, so a dropped sub-2-VRSC tx left the credit standing forever, and
 * the trick is repeatable with a fresh txid each time.
 *
 * Deliberately NOT clamped at zero. If the buyer already spent the credit the
 * balance goes negative, which is the honest state — they consumed compute they
 * did not pay for. `reserveCredit` refuses while balance < cost, so a negative
 * balance blocks further spending until it is topped up past the debt. Clamping
 * to zero would forgive the debt and make the exploit free.
 *
 * @returns {{newBalance: number}}
 */
function reverseDeposit(agentId, buyerVerusId, amount, txid) {
  // failClosed: a deposit adjudication can simply be retried, unlike a proxy
  // settle for a request the buyer has already been served. Without this the
  // most carefully-guarded paths in the system inherit the hot path's
  // fail-open policy purely because they share a lock wrapper.
  return withMeterLock(agentId, () => {
  const data = loadMeters(agentId);
  const buyer = ensureBuyer(data, buyerVerusId);
  buyer.balance -= amount;
  buyer.totalDeposited -= amount;
  buyer.lastActivity = new Date().toISOString();
  if (txid) buyer.lastReversedTxid = txid;
  saveMeters(agentId, data);
  return { newBalance: buyer.balance };
  }, { failClosed: true });
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

module.exports = { reserveCredit, adjustCredit, refundReservation, creditDeposit, reverseDeposit, getBalance, getMetrics, calculateCost, checkAndFlagLow, getMeter };
