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
const { creditDeposit, reverseDeposit } = require('./credit-meter');
const { clampCredit } = require('./deposit-credit.js');
const { loadDispatcherConfig } = require('./config-loader.js');
const { checkNonceAfterVerify } = require('./nonce-cache');

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

  // S3 — the nonce is recorded AFTER the signature verifies, not before.
  //
  // This route used to record the nonce and fire the outbound getIdentityKeys before
  // any signature check, unauthenticated and unrated. nonce-cache.js:78-88 documents
  // exactly this attack and ships `checkNonceAfterVerify` for it — the v2 access path
  // uses it; this one did not. The cache is bounded at 100k and SHARED with that path,
  // so junk nonces here evict legitimate entries and reopen the replay window on the
  // paid proxy. (The outbound lookup cannot move after verification — it supplies the
  // key we verify against — so amplification is handled by the rate limit added to the
  // route in webhook-server.js, mirroring /j41/discovery/request-access.)
  //
  // Replay protection is unchanged: a genuine replay still finds the nonce recorded
  // from the first time it verified.

  // 2. Signature — must match the buyer's on-chain identity.
  const { buildDepositReportMessage, verifyMessage } = require('@junction41/sovagent-sdk/dist/index.js');
  const message = buildDepositReportMessage({ buyerVerusId, sellerVerusId, txid, amount, nonce, timestamp: ts });

  let keys;
  try {
    keys = await client.getIdentityKeys(buyerVerusId);
  } catch (e) {
    // Preserve KEYS_UNSIGNED / KEYS_BAD_SIGNATURE from the SDK's pinned
    // platform-signature check (server-side trust-anchor failure → 502) so the
    // HTTP layer doesn't mislabel them as a 400/client error. Any other lookup
    // failure (identity doesn't exist, network blip) stays IDENTITY_LOOKUP_FAILED.
    const code = (e && (e.code === 'KEYS_UNSIGNED' || e.code === 'KEYS_BAD_SIGNATURE')) ? e.code : 'IDENTITY_LOOKUP_FAILED';
    return { ok: false, code, message: `Could not resolve buyer identity: ${e.message}` };
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

  // 3. Replay — single-use nonce, recorded only now that the caller is proven.
  const replay = checkNonceAfterVerify(true, String(nonce), ts * 1000 + DEPOSIT_REPORT_MAX_AGE_MS * 2);
  if (!replay.ok) {
    return { ok: false, code: 'REPLAY', message: 'Deposit report nonce has already been used' };
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

// ── Audit M4: per-(agent,txid) atomic credit claim ──────────────────────────
// The per-report nonce only dedups IDENTICAL reports. Two differently-nonced
// reports for the SAME txid — or a report racing the poller — both load
// deposits, both pass the `processed.some(d=>d.txid===txid)` check, both await
// verifyPayment/getTxStatus, and both creditDeposit → double-credit.
//
// txid is the real idempotency key. We claim it SYNCHRONOUSLY (before any await)
// against both the in-memory in-progress set AND the persisted `processed` list.
// Node is single-threaded, so a synchronous check-and-set is atomic: no two
// concurrent code paths can both win the claim. The claim is held across the
// awaits and released only after `processed` is durably written (so a retry
// sees it via the persisted check) or on a failure path (so it can be retried).
const _claimsInProgress = new Set(); // key: `${agentId}\0${txid}`

function _claimKey(agentId, txid) { return `${String(agentId).length}:${agentId}\0${txid}`; }

/**
 * Atomically claim (agentId, txid) for crediting. Returns false if it's already
 * claimed in-process OR already in the persisted `processed` list. MUST be
 * called synchronously (no await) between loadDeposits and the first await.
 * @param {object} deposits - the freshly-loaded deposits.json contents
 */
function claimTxid(agentId, txid, deposits) {
  const k = _claimKey(agentId, txid);
  if (_claimsInProgress.has(k)) return false;
  if (deposits && deposits.processed && deposits.processed.some((d) => d.txid === txid)) return false;
  _claimsInProgress.add(k);
  return true;
}

function releaseTxid(agentId, txid) {
  _claimsInProgress.delete(_claimKey(agentId, txid));
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
  // Atomic write: `processed` is the txid dedup ledger that stops a deposit from
  // being credited twice. A torn bare write → loadDeposits absorbs it as
  // {processed:[],pending:[]} → the dedup guard is gone → any re-reported/pending
  // deposit re-verifies on-chain and CREDITS AGAIN. tmp→rename makes it atomic.
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
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

  // ── Audit M4: claim the txid ATOMICALLY (synchronously) before any await ──
  // claimTxid checks both the in-process set and the persisted `processed` list.
  // If it fails, this txid is already being (or has been) credited — refuse.
  const deposits = loadDeposits(agentId);
  if (!claimTxid(agentId, txid, deposits)) {
    return { credited: false, message: 'Deposit already processed' };
  }

  // `committed` flips true only once `processed` is durably written; the finally
  // releases the in-process claim unless committed (then the persisted check in
  // claimTxid covers future attempts).
  let committed = false;
  try {
    // Verify on-chain
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
    // Audit 2026-06-02 M-DISPATCHER-auth-2 (Family 3): literal-string compare
    // of two VerusID forms ('seller.agentplatform@' vs 'seller.agentplatform')
    // misses common cosmetic variations and lets a legitimate sender mismatch
    // appear identical, OR a non-match slip through. Normalize both: strip
    // trailing '@', lowercase, trim. The proper fix is iAddress normalization
    // via rpc.getIdentity() — deferred until the SDK exposes a helper
    // (`client.normalizeIdentity(form) → iAddress`). The simple normalizer
    // catches every Family-3 case seen in the 2026-05 backend audit.
    const normId = (s) => (typeof s === 'string' ? s.trim().toLowerCase().replace(/@+$/, '') : s);
    if (verification.senderVerified === true && verification.senderVerusId &&
        normId(verification.senderVerusId) !== normId(buyerVerusId)) {
      return { credited: false, code: 'SENDER_MISMATCH', message: 'Funding transaction sender does not match the claiming buyer' };
    }
    if (verification.senderVerified === undefined) {
      // Audit M-DISPATCHER-funds-1: hard-fail unless operator opts in to the
      // legacy signature-only credit path (it's the H-equivalent of the
      // "trust the platform" findings — without sender verification, anyone
      // who observes a public funding tx can claim its credit). Default
      // refuses; J41_DEPOSIT_ALLOW_AUTH_ONLY=1 restores the old behavior.
      const allowAuthOnly = process.env.J41_DEPOSIT_ALLOW_AUTH_ONLY === '1';
      if (!allowAuthOnly) {
        return {
          credited: false,
          code: 'SENDER_VERIFICATION_REQUIRED',
          message: 'Platform did not return sender verification for this deposit; refusing to credit on signature-only auth. Set J41_DEPOSIT_ALLOW_AUTH_ONLY=1 to opt in to the legacy behavior.',
        };
      }
      console.warn(`[Deposit] Platform did not return sender verification for ${txid.substring(0, 12)}… — crediting on signature auth only via J41_DEPOSIT_ALLOW_AUTH_ONLY opt-in (audit M-DISPATCHER-funds-1)`);
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

    // Confirmed — credit the meter. RE-LOAD deposits fresh here (audit M4): the
    // `deposits` snapshot above predates the awaits, so the poller or another
    // path may have written `processed` for OTHER txids in the meantime; persist
    // against the latest state to avoid clobbering it. Our in-process claim
    // guarantees no concurrent path is crediting THIS txid, and we re-check the
    // persisted `processed` one last time as belt-and-suspenders.
    const fresh = loadDeposits(agentId);
    if (fresh.processed.some(d => d.txid === txid)) {
      // Persisted by someone else after we claimed (e.g. a crash-recovery edge).
      return { credited: false, message: 'Deposit already processed' };
    }
    const credited = clampCredit(expectedAmount, verification.confirmedAmount);
    if (credited < expectedAmount) {
      console.warn(`[deposit] credited ${credited} < reported ${expectedAmount} (confirmedAmount=${verification.confirmedAmount}) for tx ${txid}`);
    }
    const result = creditDeposit(agentId, buyerVerusId, credited, txid);
    // M4: `required === 0` means we just credited straight out of the mempool.
    // A mempool transaction is not money — flag it so pollPendingDeposits comes
    // back and either confirms it or takes the credit away. See reconcile below.
    const _unconfirmed = required === 0 && (txStatus.confirmations || 0) < 1;

    // Notify J41 platform (non-blocking, non-fatal) — uses per-agent context
    const ctx = _notifyContexts.get(agentId);
    if (ctx) {
      notifyJ41DepositConfirmed(ctx.sellerWif, ctx.sellerVerusId, buyerVerusId, credited, txid, ctx.network).catch(() => {});
    }

    // Mark as processed (on the fresh snapshot)
    fresh.processed.push({
      txid,
      buyerVerusId,
      amount: credited,
      confirmations: txStatus.confirmations,
      creditedAt: new Date().toISOString(),
      ...(_unconfirmed ? { unconfirmed: true, creditedAtMs: Date.now(), misses: 0 } : {}),
    });
    // Remove from pending if it was there
    fresh.pending = fresh.pending.filter(d => d.txid !== txid);
    // Keep only last 1000 processed (prevent unbounded growth)
    if (fresh.processed.length > 1000) fresh.processed = fresh.processed.slice(-1000);
    saveDeposits(agentId, fresh);
    committed = true; // durably persisted — the persisted check now covers this txid

    return { credited: true, message: 'Deposit confirmed and credited', balance: result.newBalance };
  } catch (e) {
    return { credited: false, message: `Verification failed: ${e.message}` };
  } finally {
    // Release the in-process claim unless we durably committed `processed`
    // (in which case the persisted check in claimTxid covers future attempts).
    if (!committed) releaseTxid(agentId, txid);
  }
}

/**
 * Poll pending deposits and credit any that have reached required confirmations.
 * Called periodically by the dispatcher's polling loop.
 *
 * @param agentId - Seller agent ID
 * @param client - Authenticated J41Client
 */
// ── M4: reconcile 0-conf credits ────────────────────────────────────────────
//
// `requiredConfirmations` returns 0 below 2 VRSC, so a small deposit is credited
// out of the mempool for instant proxy access. That is a deliberate UX call and
// it matches the platform's own tiering — but it was one-way. The credit was
// written to `processed` and nothing ever went back to ask whether the funding
// transaction actually got mined. A mempool tx can be evicted, replaced, or never
// mined at all, and the buyer keeps the credit either way. Repeatable with a
// fresh txid each time, for free.
//
// The reconciler is deliberately biased toward KEEPING the credit. Reversing a
// legitimate buyer's balance is worse than a delayed clawback, so a reversal
// requires all three of:
//   1. past the grace deadline (the tx has had time to be mined),
//   2. RECONCILE_MIN_MISSES consecutive lookups that positively say "unknown",
//      not merely a failed API call, and
//   3. still no confirmation.
// Any sighting — confirmed OR still visibly in the mempool — resets the miss
// counter, because presence is positive evidence the tx exists.
const RECONCILE_GRACE_MS = 30 * 60 * 1000; // ~30 blocks at Verus' ~60s target
const RECONCILE_MIN_MISSES = 3;
// Misses must also SPAN this long. Three polls is three minutes, which a routine
// backend deploy window can supply on its own — and a deploy is precisely when the
// tx-status route is most likely to answer wrongly. Requiring the run to persist
// makes a transient platform-side fault insufficient on its own.
const RECONCILE_MISS_SPAN_MS = 10 * 60 * 1000;
// A 'weak' signal (a bare 404) needs far more before it may move money: a generic
// 404 is what a renamed route or a proxy answers with, identically for every txid.
const RECONCILE_WEAK_MIN_MISSES = 6;
const RECONCILE_WEAK_SPAN_MS = 2 * 60 * 60 * 1000;

/**
 * Does this error mean "the chain has never heard of this txid", as opposed to
 * "we could not reach the API" or "that route is not there right now"?
 *
 * Only a transaction-specific signal counts. A bare 404 does NOT: the SDK
 * surfaces route-level failures as `HTTP 404` and
 * `Non-JSON response from GET /v1/tx/status/… (HTTP 404)`, which a renamed
 * endpoint or a reverse proxy mid-deploy produces for every txid at once. Three
 * of those in a row would otherwise reverse every open credit on the fleet
 * simultaneously — the loudest possible way to get this wrong.
 *
 * Erring here costs us nothing: an unrecognised error just means we keep waiting,
 * and the credit stays. Erring the other way takes money from a buyer who paid.
 */
function _isTxUnknown(err) {
  return _classifyLookupFailure(err) === 'strong';
}

/**
 * How much does this error tell us? Three answers, because two are not enough.
 *
 *   'strong' — a transaction-specific signal. The chain was asked about THIS txid
 *              and said no.
 *   'weak'   — a bare 404 / generic NOT_FOUND. Consistent with a dropped tx, and
 *              equally consistent with the route being renamed or a proxy answering
 *              during a deploy, which would look identical for every txid at once.
 *   null     — tells us nothing (connection refused, 5xx, a timeout).
 *
 * Why 'weak' exists at all: review round 3 found that the platform's OWN published
 * error shape for a 404 is `{"error":{"code":"NOT_FOUND","message":"The requested
 * resource does not exist"}}` (j41-docs api/overview.md), and `/v1/tx/status/:txid`
 * documents no tx-specific code. The SDK surfaces `error.message` as the Error's
 * message and `error.code` as `err.code` — which the first version never inspected.
 * So on the documented evidence the strong patterns match NOTHING the real backend
 * produces, the reconciler would wait forever, and the whole feature would be inert
 * against the leak it exists to close. Treating a generic 404 as weak evidence —
 * requiring a much longer run, and only when the failure is not fleet-wide — keeps
 * the deploy-window protection while making the feature actually able to fire.
 *
 * The question is out to the backend team; if they add a stable `TX_NOT_FOUND`,
 * that path is already 'strong' here and the weak tier stops mattering.
 */
function _classifyLookupFailure(err) {
  const m = String((err && err.message) || err || '');
  const code = String((err && err.code) || '');

  if (code === 'TX_NOT_FOUND' || /\bTX_NOT_FOUND\b/.test(m)) return 'strong';
  if (/(transaction|tx|txid)[^.]{0,40}(not\s*found|unknown|does\s*not\s*exist)/i.test(m)) return 'strong';
  if (/no\s*such\s*(transaction|tx)\b/i.test(m)) return 'strong';
  if (/invalid\s*or\s*non-?wallet\s*transaction/i.test(m)) return 'strong';
  // verusd's own phrasing for a txid it cannot index.
  if (/no\s*information\s*available\s*about\s*transaction/i.test(m)) return 'strong';

  const status = err && (err.statusCode || err.status);
  if (status === 404 || code === 'NOT_FOUND' || /\b404\b/.test(m)) return 'weak';
  return null;
}

async function reconcileUnconfirmedDeposits(agentId, client, now = Date.now()) {
  const deposits = loadDeposits(agentId);
  const open = (deposits.processed || []).filter(d => d && d.unconfirmed);
  if (open.length === 0) return { confirmed: 0, reversed: 0, waiting: 0 };

  let confirmed = 0, reversed = 0, waiting = 0;

  // A route-level failure answers identically for EVERY txid, so "all of them are
  // unknown at once" is evidence about the route, not about any transaction. A
  // genuinely dropped tx is isolated among its peers. Only usable when there is
  // more than one open record, so it supplements the weak/strong tiering rather
  // than replacing it.
  let weakCount = 0;
  const openCount = open.length;

  for (const rec of open) {
    let seen = null;
    let unknown = false;
    let strength = null;
    try {
      const st = await client.getTxStatus(rec.txid);
      // A response we cannot interpret is NOT evidence of absence.
      seen = st && Number.isFinite(st.confirmations) ? st.confirmations : null;
    } catch (e) {
      strength = _classifyLookupFailure(e);
      if (strength) { unknown = true; if (strength === 'weak') weakCount++; }
      else {
        // Transient — an unreachable platform must never cost a buyer their balance.
        waiting++;
        continue;
      }
    }

    // The call RESOLVED but we could not read a confirmation count out of it —
    // an empty body, `{}`, a stringified count, a re-wrapped `{data:{…}}` shape.
    // That is not evidence of absence either, and the original code fell straight
    // through this gap into the reversal path: a backend response-shape change
    // would have clawed back every open 0-conf credit on the fleet within three
    // polls. The comment above claimed this was handled; only this line makes it so.
    if (!unknown && seen === null) {
      waiting++;
      continue;
    }

    // Re-load per record: crediting/reversing is a write, and other paths write
    // `processed` too (audit M4's clobber lesson).
    const fresh = loadDeposits(agentId);
    const live = (fresh.processed || []).find(d => d && d.txid === rec.txid && d.unconfirmed);
    if (!live) continue; // someone else resolved it while we were awaiting

    if (seen !== null && seen >= 1) {
      // If we already debited this one on a previous pass (crash between the meter
      // write and the record removal) and the transaction has now CONFIRMED, the
      // debit was wrong — the buyer funded it after all. Put the credit back before
      // clearing the flag, or they are charged for a genuinely funded deposit.
      if (live.reversal === 'debited') {
        // We know the meter was debited, so putting it back is safe and correct.
        // Clear the flag and persist FIRST: if we crash between the two writes,
        // a lost re-credit leaves the buyer short by a recorded amount an operator
        // can see and fix, whereas a repeated re-credit silently mints money on
        // every subsequent pass. Neither window can be closed without a
        // transactional store; this picks the one that fails visibly.
        live.reversal = 'recredited';
        saveDeposits(agentId, fresh);
        creditDeposit(agentId, live.buyerVerusId, live.amount, live.txid);
        console.warn(`[Deposits] ${agentId}: ${rec.txid.substring(0, 12)}… confirmed AFTER a completed reversal — ` +
          `re-credited ${live.amount} VRSC to ${live.buyerVerusId}.`);
        delete live.reversal;
      } else if (live.reversal) {
        // 'debiting' (crashed between the intent stamp and the debit) or
        // 'recredited' (crashed between the flag write and the credit). We cannot
        // tell whether the money moved, and this is a confirmed, genuinely funded
        // deposit — so DO NOT guess. Every other ambiguous-money path in this
        // codebase stops and asks a human (see the refund in-flight marker); a
        // silent guess here is either a buyer charged for a deposit they funded or
        // a seller paying twice.
        live.needsOperator = `reversal state '${live.reversal}' when the tx confirmed — balance may be off by ${live.amount}`;
        delete live.reversal;
        console.error(`[Deposits] ${agentId}: ⚠️  ${rec.txid.substring(0, 12)}… confirmed while a reversal was ` +
          `mid-flight. We CANNOT tell whether ${live.amount} VRSC was debited from ${live.buyerVerusId}. ` +
          'No money moved. Check the meter against the chain and correct it by hand.');
      }
      delete live.unconfirmed;
      delete live.misses;
      delete live.firstMissAtMs;
      live.confirmations = seen;
      saveDeposits(agentId, fresh);
      confirmed++;
      console.log(`[Deposits] ${agentId}: 0-conf credit ${rec.txid.substring(0, 12)}… confirmed at ${seen} block(s)`);
      continue;
    }

    if (seen === 0) {
      // Still in the mempool. It exists; keep waiting and reset the miss run.
      if (live.misses || live.firstMissAtMs || live.weak) {
        live.misses = 0;
        delete live.firstMissAtMs;
        delete live.weak;
        saveDeposits(agentId, fresh);
      }
      waiting++;
      const ageMin = Math.round((now - (live.creditedAtMs || now)) / 60000);
      if (ageMin >= 60 && ageMin % 60 < 2) {
        console.warn(`[Deposits] ${agentId}: ${rec.txid.substring(0, 12)}… has sat unconfirmed in the mempool for ${ageMin} min ` +
          `(${rec.amount} VRSC credited to ${rec.buyerVerusId}). It has not been reversed — it is still visible on the network.`);
      }
      continue;
    }

    // unknown === true: the chain does not know this txid.
    //
    // A `reversing` stamp from a previous pass means we may already have debited
    // the meter and died before clearing the record — reverseDeposit writes
    // credit-meters.json and the record removal writes deposits.json, two separate
    // atomic writes with a crash window between them. Finish the bookkeeping
    // WITHOUT debiting again. The residual is that a crash between the stamp and
    // the debit forgives ≤2 VRSC; debiting twice would take 2 VRSC from a buyer,
    // and only one of those two is reversible by the person it happens to.
    // 'debited' is proof. 'debiting' only proves we INTENDED to — the stamp is
    // written before the debit precisely so a crash is recoverable, which means it
    // cannot also stand as evidence that the debit ran. Treat the ambiguous case as
    // already-debited: forgiving ≤2 VRSC beats debiting a buyer twice.
    const _alreadyDebited = live.reversal === 'debited' || live.reversal === 'debiting';
    live.misses = (live.misses || 0) + 1;
    if (!live.firstMissAtMs) live.firstMissAtMs = now;
    // A weak signal anywhere in the run holds the whole run to the weak thresholds.
    if (strength === 'weak') live.weak = true;
    const _weak = live.weak === true;
    const _minMisses = _weak ? RECONCILE_WEAK_MIN_MISSES : RECONCILE_MIN_MISSES;
    const _minSpan = _weak ? RECONCILE_WEAK_SPAN_MS : RECONCILE_MISS_SPAN_MS;
    const pastGrace = now - (live.creditedAtMs || 0) >= RECONCILE_GRACE_MS;
    const missRunLongEnough = live.misses >= _minMisses
      && now - live.firstMissAtMs >= _minSpan;
    // Every open record failing in the same pass is a statement about the route.
    const systemic = openCount > 1 && weakCount === openCount;
    if (systemic) {
      saveDeposits(agentId, fresh);
      waiting++;
      continue;
    }
    if (!_alreadyDebited && (!pastGrace || !missRunLongEnough)) {
      saveDeposits(agentId, fresh);
      waiting++;
      continue;
    }

    if (!_alreadyDebited) {
      // Persist the intent BEFORE the irreversible debit, so a crash in between is
      // recoverable rather than a guess. Same shape as markRefundInflight.
      live.reversal = 'debiting';
      saveDeposits(agentId, fresh);
      reverseDeposit(agentId, live.buyerVerusId, live.amount, live.txid);
      live.reversal = 'debited';
      saveDeposits(agentId, fresh);
    } else {
      console.warn(`[Deposits] ${agentId}: ${live.txid.substring(0, 12)}… was mid-reversal at the last crash — ` +
        'completing the bookkeeping without debiting again.');
    }
    fresh.processed = fresh.processed.filter(d => d.txid !== live.txid);
    fresh.reversed = fresh.reversed || [];
    fresh.reversed.push({
      txid: live.txid,
      buyerVerusId: live.buyerVerusId,
      amount: live.amount,
      creditedAt: live.creditedAt,
      reversedAt: new Date().toISOString(),
      reason: 'funding transaction never confirmed and is unknown to the chain',
    });
    if (fresh.reversed.length > 1000) fresh.reversed = fresh.reversed.slice(-1000);
    saveDeposits(agentId, fresh);
    reversed++;
    console.error(`[Deposits] ${agentId}: ⛔ REVERSED ${live.amount} VRSC of credit for ${live.buyerVerusId} — ` +
      `funding tx ${live.txid.substring(0, 12)}… never confirmed and the chain does not know it. ` +
      'If the buyer disputes this, check the txid on-chain before re-crediting.');
  }

  if (confirmed || reversed) {
    console.log(`[Deposits] ${agentId}: reconciled 0-conf credits — ${confirmed} confirmed, ${reversed} reversed, ${waiting} still open`);
  }
  return { confirmed, reversed, waiting };
}

async function pollPendingDeposits(agentId, client) {
  // Reconcile first: a 0-conf credit already spendable is a live exposure, and it
  // is cheap to check. Failures here must not stop the pending sweep below.
  try {
    await reconcileUnconfirmedDeposits(agentId, client);
  } catch (e) {
    console.warn(`[Deposits] ${agentId}: 0-conf reconcile failed (${e.message})`);
  }

  const deposits = loadDeposits(agentId);
  if (deposits.pending.length === 0) return;

  let credited = 0;
  let stillPendingCount = 0;

  for (const dep of deposits.pending) {
    // ── Audit M4: claim the txid atomically (synchronously) before the await ──
    // Skips it if another path (a concurrent report, or already-processed) holds
    // it. A skipped claim means someone else is crediting it — don't touch it.
    const fresh0 = loadDeposits(agentId);
    if (!claimTxid(agentId, dep.txid, fresh0)) {
      // Already claimed/processed elsewhere — drop from our pending view.
      continue;
    }
    let committed = false;
    try {
      const txStatus = await client.getTxStatus(dep.txid);
      if (txStatus.confirmations >= dep.requiredConfirmations) {
        // Confirmed — credit. RE-LOAD fresh and re-check persisted `processed`
        // before crediting/persisting so we never double-credit or clobber a
        // concurrent writer's state (audit M4).
        const fresh = loadDeposits(agentId);
        if (fresh.processed.some(d => d.txid === dep.txid)) {
          continue; // already credited by another path
        }
        creditDeposit(agentId, dep.buyerVerusId, dep.amount, dep.txid);
        fresh.processed.push({
          ...dep,
          confirmations: txStatus.confirmations,
          creditedAt: new Date().toISOString(),
        });
        fresh.pending = fresh.pending.filter(d => d.txid !== dep.txid);
        if (fresh.processed.length > 1000) fresh.processed = fresh.processed.slice(-1000);
        saveDeposits(agentId, fresh);
        committed = true;
        credited++;
        console.log(`[Deposits] ${agentId}: credited ${dep.amount} VRSC from ${dep.buyerVerusId} (${dep.txid.substring(0, 12)}...)`);
        // Notify J41 — uses per-agent context
        const pollCtx = _notifyContexts.get(agentId);
        if (pollCtx) {
          notifyJ41DepositConfirmed(pollCtx.sellerWif, pollCtx.sellerVerusId, dep.buyerVerusId, dep.amount, dep.txid, pollCtx.network).catch(() => {});
        }
      } else {
        stillPendingCount++;
      }
    } catch (e) {
      // Keep in pending on error — retry next poll
      stillPendingCount++;
      console.warn(`[Deposits] ${agentId}: check failed for ${dep.txid.substring(0, 12)}: ${e.message}`);
    } finally {
      if (!committed) releaseTxid(agentId, dep.txid);
    }
  }

  if (credited > 0) {
    console.log(`[Deposits] ${agentId}: ${credited} deposit(s) confirmed, ${stillPendingCount} still pending`);
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
    // json-canonicalize exports { canonicalize }, not a callable default.
    // The previous `const canonicalize = require(...)` made canonicalize(payload)
    // throw "canonicalize is not a function", which the try/catch silently
    // swallowed — deposit-confirmed notifies never actually reached J41.
    const { canonicalize } = require('json-canonicalize');

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

/**
 * Notify J41 that a buyer's prepaid balance crossed BELOW the credit-low
 * threshold. POST /v1/webhooks/dispatcher/credit-low with a seller-signed
 * canonical body (mirrors notifyJ41DepositConfirmed). Best-effort / non-fatal:
 * the caller (proxy settle path) must never break a proxy response on failure.
 *
 * Canonical signed bytes (spec §2a, must match J41 verbatim):
 *   canonicalize({ action: 'dispatcher.credit-low', sellerVerusId, buyerVerusId,
 *                  balance, threshold, suggestedTopup, payAddress, observedAt, nonce })
 * with balance/threshold/suggestedTopup as strings and observedAt unix seconds.
 *
 * @param sellerWif - Seller's WIF for signing
 * @param sellerVerusId - Seller's VerusID
 * @param buyerVerusId - Buyer whose balance crossed low
 * @param balance - VRSC remaining (number)
 * @param threshold - The crossing threshold in VRSC (number)
 * @param suggestedTopup - Suggested top-up in VRSC (number)
 * @param payAddress - Seller's deposit address (R-address)
 * @param network - 'verus' or 'verustest'
 */
async function notifyJ41CreditLow(sellerWif, sellerVerusId, buyerVerusId, balance, threshold, suggestedTopup, payAddress, network) {
  const J41_API_URL = loadDispatcherConfig().platform.api_url;
  try {
    const { signMessage } = require('@junction41/sovagent-sdk/dist/identity/signer.js');
    const { canonicalize } = require('json-canonicalize');

    const nonce = crypto.randomBytes(16).toString('hex');
    const observedAt = Math.floor(Date.now() / 1000);

    // Field ORDER here is irrelevant (json-canonicalize sorts keys), but the
    // field NAMES, value types (balance/threshold/suggestedTopup as strings,
    // observedAt as a unix-seconds integer) and the action string must match
    // the J41 handler's canonical exactly or the signature won't verify.
    const payload = {
      action: 'dispatcher.credit-low',
      sellerVerusId,
      buyerVerusId,
      balance: String(balance),
      threshold: String(threshold),
      suggestedTopup: String(suggestedTopup),
      payAddress: payAddress || '',
      observedAt,
      nonce,
    };
    const canonical = canonicalize(payload);
    const dispatcherSig = signMessage(sellerWif, canonical, network);

    const body = JSON.stringify({ ...payload, dispatcherSig });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${J41_API_URL}/v1/webhooks/dispatcher/credit-low`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'j41-dispatcher/2.0' },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      console.log(`[Proxy] J41 notified: credit-low for ${buyerVerusId} (balance ${String(balance)} < ${String(threshold)} VRSC)`);
    } else {
      console.warn(`[Proxy] J41 credit-low notification failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (e) {
    console.warn(`[Proxy] J41 credit-low notification failed (non-fatal): ${e.message}`);
  }
}

module.exports = { reportDeposit, verifyDepositReport, pollPendingDeposits, reconcileUnconfirmedDeposits, RECONCILE_GRACE_MS, RECONCILE_MIN_MISSES, RECONCILE_MISS_SPAN_MS, RECONCILE_WEAK_MIN_MISSES, RECONCILE_WEAK_SPAN_MS, _isTxUnknown, _classifyLookupFailure, startDepositPoller, requiredConfirmations, notifyJ41DepositConfirmed, notifyJ41CreditLow, setNotifyContext, getNotifyContext, DEPOSIT_REPORT_MAX_AGE_MS };
