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
const crypto = require('crypto');
const { creditDeposit } = require('./credit-meter');
const { loadDispatcherConfig } = require('./config-loader.js');
const { checkAndRecordNonce } = require('./nonce-cache');

const AGENTS_DIR = path.join(os.homedir(), '.j41', 'dispatcher', 'agents');

// Deposit reports must be signed within this window (replay/freshness bound).
const DEPOSIT_REPORT_MAX_AGE_MS = 5 * 60 * 1000;

/** Currency symbol for a network (deposits are in the chain's native coin). */
function networkCurrency(network) {
  return network === 'verus' ? 'VRSC' : 'VRSCTEST';
}

/**
 * Authenticate a buyer-submitted deposit report.
 *
 * Verifies the report is signed by the claimed `buyerVerusId` (against its
 * on-chain primary address), is fresh, and has an unused nonce. This stops an
 * attacker from anonymously claiming someone else's payment, and stops replay
 * of a captured report.
 *
 * NOTE: proving control of buyerVerusId is necessary but not sufficient to
 * prove buyerVerusId *funded* the tx — that requires platform sender
 * verification (see reportDeposit's expectedSender handling and
 * docs/backend-requests/deposit-sender-verification.md).
 *
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
async function verifyDepositReport(client, report, network) {
  const { buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp, signature } = report || {};
  if (!buyerVerusId || !sellerVerusId || !txid || amount == null || !nonce || !timestamp || !signature) {
    return { ok: false, code: 'MISSING_FIELDS', message: 'Missing required signed-report fields (buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp, signature)' };
  }

  // 1. Freshness — reject stale or future-dated reports.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > DEPOSIT_REPORT_MAX_AGE_MS) {
    return { ok: false, code: 'STALE', message: 'Report timestamp is outside the allowed freshness window' };
  }

  // 2. Replay — single-use nonce, remembered past the freshness window.
  const replay = checkAndRecordNonce(String(nonce), ts * 1000 + DEPOSIT_REPORT_MAX_AGE_MS * 2);
  if (!replay.ok) {
    return { ok: false, code: 'REPLAY', message: 'Deposit report nonce has already been used' };
  }

  // 3. Signature — must match the buyer's on-chain identity.
  const { buildDepositReportMessage, verifyMessage } = require('@junction41/sovagent-sdk/dist/index.js');
  const message = buildDepositReportMessage({ buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp: ts });

  let keys;
  try {
    keys = await client.getIdentityKeys(buyerVerusId);
  } catch (e) {
    return { ok: false, code: 'IDENTITY_LOOKUP_FAILED', message: `Could not resolve buyer identity: ${e.message}` };
  }
  const primaryAddresses = (keys && keys.primaryAddresses) || [];
  const minSigs = (keys && keys.minimumSignatures) || 1;
  if (minSigs > 1) {
    return { ok: false, code: 'MULTISIG_UNSUPPORTED', message: 'Multisig buyer identities cannot self-report deposits (single signature provided)' };
  }
  const signed = primaryAddresses.some((addr) => verifyMessage(message, addr, signature, network));
  if (!signed) {
    return { ok: false, code: 'BAD_SIGNATURE', message: 'Deposit report signature does not match the buyer identity' };
  }

  return { ok: true };
}

// Per-agent notify context for J41 webhook after confirmed deposit.
// Keyed by agentId. Each context has { sellerWif, sellerVerusId, network }.
const _notifyContexts = new Map();

function setNotifyContext(agentId, ctx) {
  _notifyContexts.set(agentId, ctx);
}

function getNotifyContext(agentId) {
  return _notifyContexts.get(agentId);
}

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
 * Report a deposit (buyer-initiated). Authenticates the signed report, verifies
 * on-chain, and credits the meter.
 *
 * @param agentId - Seller agent ID
 * @param client - Authenticated J41Client
 * @param report - Signed report { buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp, signature }
 * @param payAddress - Seller's pay address (to verify output)
 * @param network - 'verus' | 'verustest' (for signature verification + currency)
 * @returns { credited: boolean, message: string, balance?: number, code?: string }
 */
async function reportDeposit(agentId, client, report, payAddress, network = 'verustest') {
  // ── Authenticate the report before doing anything else ──
  const auth = await verifyDepositReport(client, report, network);
  if (!auth.ok) {
    console.warn(`[Deposit] Rejected report for ${agentId}: ${auth.code} — ${auth.message}`);
    return { credited: false, message: auth.message, code: auth.code };
  }

  const { buyerVerusId, txid } = report;
  const expectedAmount = Number(report.amount);

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
      currency: networkCurrency(network),
      // Ask the platform to confirm the funding tx came from the buyer. On
      // platforms that support it this is the authoritative anti-misattribution
      // check; older platforms omit the sender fields (handled below).
      expectedSender: buyerVerusId,
    });

    // Canonical field is `verified` (the platform has no `valid`). On a provable
    // sender mismatch the platform forces verified=false with reason
    // "sender_mismatch", so this single check also blocks misattribution.
    if (!verification.verified) {
      const reason = verification.reason || 'invalid';
      const code = reason === 'sender_mismatch' ? 'SENDER_MISMATCH' : undefined;
      return { credited: false, code, message: `Payment verification failed: ${reason}` };
    }

    // Sender binding: if the platform verified the sender, enforce it matches
    // the claiming buyer. If it could not be verified (false), refuse. If the
    // field is absent, the platform doesn't verify sender yet — fall back to
    // the signature-based authentication above (auth-only) and warn.
    if (verification.senderVerified === false) {
      return { credited: false, code: 'SENDER_MISMATCH', message: 'Funding transaction sender could not be confirmed to belong to the claiming buyer' };
    }
    if (verification.senderVerified === true && verification.senderVerusId && verification.senderVerusId !== buyerVerusId) {
      return { credited: false, code: 'SENDER_MISMATCH', message: 'Funding transaction sender does not match the claiming buyer' };
    }
    if (verification.senderVerified === undefined) {
      console.warn(`[Deposit] Platform did not return sender verification for ${txid.substring(0, 12)}… — crediting on signature auth only (see backend-requests/deposit-sender-verification.md)`);
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

    // Notify J41 platform (non-blocking, non-fatal) — uses per-agent context
    const ctx = _notifyContexts.get(agentId);
    if (ctx) {
      notifyJ41DepositConfirmed(ctx.sellerWif, ctx.sellerVerusId, buyerVerusId, expectedAmount, txid, ctx.network).catch(() => {});
    }

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
        // Notify J41 — uses per-agent context
        const pollCtx = _notifyContexts.get(agentId);
        if (pollCtx) {
          notifyJ41DepositConfirmed(pollCtx.sellerWif, pollCtx.sellerVerusId, dep.buyerVerusId, dep.amount, dep.txid, pollCtx.network).catch(() => {});
        }
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
  const POLL_INTERVAL = loadDispatcherConfig().deposit.poll_interval_ms;

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

/**
 * Notify J41 platform about a confirmed deposit.
 * POST /v1/webhooks/dispatcher/deposit-confirmed with signed canonical body.
 *
 * @param sellerWif - Seller's WIF for signing the notification
 * @param sellerVerusId - Seller's VerusID
 * @param buyerVerusId - Buyer who deposited
 * @param amount - Amount in VRSC
 * @param txid - Transaction ID
 * @param network - 'verus' or 'verustest'
 */
async function notifyJ41DepositConfirmed(sellerWif, sellerVerusId, buyerVerusId, amount, txid, network) {
  const J41_API_URL = loadDispatcherConfig().platform.api_url;
  try {
    const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
    const canonicalize = require('json-canonicalize');

    const nonce = crypto.randomBytes(16).toString('hex');
    const confirmedAt = new Date().toISOString();

    // Canonical message — json-canonicalize (RFC 8785), matching J41's signed-inbound pattern
    const payload = {
      action: 'dispatcher.deposit-confirmed',
      sellerVerusId,
      buyerVerusId,
      amountVrsc: String(amount),
      txid,
      confirmedAt,
      nonce,
    };
    const canonical = canonicalize(payload);
    const signature = signMessage(sellerWif, canonical, network);

    const body = JSON.stringify({ ...payload, signature });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${J41_API_URL}/v1/webhooks/dispatcher/deposit-confirmed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'j41-dispatcher/2.0' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      console.log(`[Deposits] J41 notified: deposit ${txid.substring(0, 12)}... confirmed for ${buyerVerusId}`);
    } else {
      console.warn(`[Deposits] J41 notification failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (e) {
    console.warn(`[Deposits] J41 notification failed (non-fatal): ${e.message}`);
  }
}

module.exports = { reportDeposit, verifyDepositReport, pollPendingDeposits, startDepositPoller, requiredConfirmations, notifyJ41DepositConfirmed, setNotifyContext, getNotifyContext, DEPOSIT_REPORT_MAX_AGE_MS };
