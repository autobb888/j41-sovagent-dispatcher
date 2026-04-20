/**
 * Deposit Watcher — monitors seller's payaddress for incoming VRSC deposits.
 * Credits the buyer's meter when a deposit is confirmed.
 *
 * Two modes:
 * 1. Report mode: buyer explicitly reports { txid, amount } → dispatcher verifies and credits
 * 2. Poll mode: dispatcher polls UTXOs and detects new ones (background)
 *
 * Confirmation tiers (from spec):
 *   - < 2 VRSC: mempool (0 confirmations)
 *   - 2-10 VRSC: 1 confirmation
 *   - > 10 VRSC: 6 confirmations
 *
 * Processed deposits tracked in ~/.j41/dispatcher/agents/<id>/deposits.json to prevent double-credit.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { creditDeposit } = require('./credit-meter');

const AGENTS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'agents');

// Confirmation tiers
function requiredConfirmations(amount) {
  if (amount < 2) return 0;   // mempool OK for small amounts
  if (amount <= 10) return 1;  // 1 block for medium
  return 6;                    // 6 blocks for large
}

function depositsPath(agentId) {
  return path.join(AGENTS_DIR, agentId, 'deposits.json');
}

function loadDeposits(agentId) {
  const p = depositsPath(agentId);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return { processed: [], pending: [] };
}

function saveDeposits(agentId, data) {
  const p = depositsPath(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  fs.chmodSync(p, 0o600);
}

/**
 * Report a deposit (buyer-initiated). Verifies on-chain and credits meter.
 *
 * @param agentId - Seller agent ID
 * @param client - Authenticated J41Client
 * @param buyerVerusId - Who's claiming the deposit
 * @param txid - Transaction ID
 * @param expectedAmount - Amount buyer claims they sent
 * @param payAddress - Seller's pay address (to verify output)
 * @returns { credited: boolean, message: string, balance?: number }
 */
async function reportDeposit(agentId, client, buyerVerusId, txid, expectedAmount, payAddress) {
  // Check if already processed
  const deposits = loadDeposits(agentId);
  if (deposits.processed.some(d => d.txid === txid)) {
    return { credited: false, message: 'Deposit already processed' };
  }

  // Verify on-chain
  try {
    const verification = await client.verifyPayment({
      txid,
      expectedAddress: payAddress,
      expectedAmount,
      currency: 'VRSCTEST',
    });

    if (!verification.valid) {
      return { credited: false, message: `Payment not found or amount mismatch: ${verification.reason || 'invalid'}` };
    }

    // Check confirmations
    const txStatus = await client.getTxStatus(txid);
    const required = requiredConfirmations(expectedAmount);
    if (txStatus.confirmations < required) {
      // Add to pending — will be credited when confirmed
      if (!deposits.pending.some(d => d.txid === txid)) {
        deposits.pending.push({
          txid,
          buyerVerusId,
          amount: expectedAmount,
          requiredConfirmations: required,
          reportedAt: new Date().toISOString(),
        });
        saveDeposits(agentId, deposits);
      }
      return { credited: false, message: `Waiting for ${required - txStatus.confirmations} more confirmation(s) (${txStatus.confirmations}/${required})` };
    }

    // Confirmed — credit the meter
    const result = creditDeposit(agentId, buyerVerusId, expectedAmount, txid);

    // Mark as processed
    deposits.processed.push({
      txid,
      buyerVerusId,
      amount: expectedAmount,
      confirmations: txStatus.confirmations,
      creditedAt: new Date().toISOString(),
    });
    // Remove from pending if it was there
    deposits.pending = deposits.pending.filter(d => d.txid !== txid);
    // Keep only last 1000 processed (prevent unbounded growth)
    if (deposits.processed.length > 1000) deposits.processed = deposits.processed.slice(-1000);
    saveDeposits(agentId, deposits);

    return { credited: true, message: 'Deposit confirmed and credited', balance: result.newBalance };
  } catch (e) {
    return { credited: false, message: `Verification failed: ${e.message}` };
  }
}

/**
 * Poll pending deposits and credit any that have reached required confirmations.
 * Called periodically by the dispatcher's polling loop.
 *
 * @param agentId - Seller agent ID
 * @param client - Authenticated J41Client
 */
async function pollPendingDeposits(agentId, client) {
  const deposits = loadDeposits(agentId);
  if (deposits.pending.length === 0) return;

  let credited = 0;
  const stillPending = [];

  for (const dep of deposits.pending) {
    try {
      const txStatus = await client.getTxStatus(dep.txid);
      if (txStatus.confirmations >= dep.requiredConfirmations) {
        // Confirmed — credit
        creditDeposit(agentId, dep.buyerVerusId, dep.amount, dep.txid);
        deposits.processed.push({
          ...dep,
          confirmations: txStatus.confirmations,
          creditedAt: new Date().toISOString(),
        });
        credited++;
        console.log(`[Deposits] ${agentId}: credited ${dep.amount} VRSC from ${dep.buyerVerusId} (${dep.txid.substring(0, 12)}...)`);
      } else {
        stillPending.push(dep);
      }
    } catch (e) {
      // Keep in pending on error — retry next poll
      stillPending.push(dep);
      console.warn(`[Deposits] ${agentId}: check failed for ${dep.txid.substring(0, 12)}: ${e.message}`);
    }
  }

  deposits.pending = stillPending;
  if (deposits.processed.length > 1000) deposits.processed = deposits.processed.slice(-1000);
  saveDeposits(agentId, deposits);

  if (credited > 0) {
    console.log(`[Deposits] ${agentId}: ${credited} deposit(s) confirmed, ${stillPending.length} still pending`);
  }
}

/**
 * Start background deposit polling for all api-endpoint agents.
 * Polls every 60 seconds.
 *
 * @param state - Dispatcher state (with agents and agentSessions)
 * @param getAgentSession - Function to get authenticated session
 * @returns Timer ID (for cleanup)
 */
function startDepositPoller(state, getAgentSession) {
  const POLL_INTERVAL = 60000; // 60 seconds

  const timer = setInterval(async () => {
    for (const agentInfo of state.agents) {
      const cap = state.capabilities?.get(agentInfo.id);
      const hasApiEndpoint = cap?.services?.some(s => s.serviceType === 'api-endpoint');
      if (!hasApiEndpoint) continue;

      try {
        const agent = await getAgentSession(state, agentInfo);
        await pollPendingDeposits(agentInfo.id, agent._client || agent.client);
      } catch (e) {
        // Silent — don't spam logs for agents with no pending deposits
      }
    }
  }, POLL_INTERVAL);

  timer.unref(); // Don't keep process alive just for deposit polling
  return timer;
}

module.exports = { reportDeposit, pollPendingDeposits, startDepositPoller, requiredConfirmations };
