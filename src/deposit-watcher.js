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

// ── The dedup ledger is not the audit log ───────────────────────────────────
// `processed` serves two masters: it is the human-readable record of what was
// credited, and it is the ONLY thing stopping a txid being credited twice.
// Trimming it for size silently trimmed the dedup, so a deposit older than
// PROCESSED_AUDIT_CAP could be re-reported and credited again.
//
// `creditedTxids` is the dedup ledger proper: txid strings only, so it holds an
// order of magnitude more history for a fraction of the bytes, and it is what
// claimTxid consults. Records may age out of the audit log; the txid does not
// age out of the dedup ledger with it.
const PROCESSED_AUDIT_CAP = 1000;
const CREDITED_TXID_CAP = 10000;

/**
 * Fill in structure a caller can rely on, and migrate older files in place.
 *
 * A deposits.json written before `creditedTxids` existed has its ledger seeded
 * from whatever `processed` still holds — the best reconstruction available.
 * Anything the old trim already discarded is unrecoverable and stays that way;
 * this stops the bleeding rather than pretending to undo it.
 */
function _normalizeDeposits(d) {
  const out = d && typeof d === 'object' ? d : {};
  if (!Array.isArray(out.processed)) out.processed = [];
  if (!Array.isArray(out.pending)) out.pending = [];
  if (!Array.isArray(out.reversed)) out.reversed = [];
  if (!Array.isArray(out.creditedTxids)) {
    out.creditedTxids = out.processed.map((r) => r && r.txid).filter(Boolean);
  }
  return out;
}

/** True if this txid has ever been credited (or is mid-credit) on this agent. */
function _hasCreditedTxid(deposits, txid) {
  if (!deposits) return false;
  if (Array.isArray(deposits.creditedTxids) && deposits.creditedTxids.includes(txid)) return true;
  return Array.isArray(deposits.processed) && deposits.processed.some((d) => d && d.txid === txid);
}

function _rememberCreditedTxid(deposits, txid) {
  if (!deposits.creditedTxids.includes(txid)) deposits.creditedTxids.push(txid);
  if (deposits.creditedTxids.length > CREDITED_TXID_CAP) {
    const dropped = deposits.creditedTxids.splice(0, deposits.creditedTxids.length - CREDITED_TXID_CAP);
    // Loud on purpose. Past this horizon a re-reported deposit CAN be credited
    // twice, and a silent cap would make that look like it never happened.
    console.warn(`[Deposits] dedup ledger full — ${dropped.length} oldest txid(s) evicted; ` +
      'a deposit older than that horizon could be re-reported and credited again');
  }
}

/** An open money question: the record is not finished being decided. */
function _isOpenRecord(r) {
  return !!(r && (r.crediting || r.unconfirmed || r.needsOperator));
}

/**
 * Trim the audit log, never the unresolved.
 *
 * A record still marked `crediting`, `unconfirmed` or `needsOperator` is an open
 * money question — the meter may or may not have moved, or the reconciler has
 * not finished deciding — so it is exempt from the cap. Dropping one would erase
 * the only evidence that a human needs to look, and in the `unconfirmed` case
 * would silently retire a credit the reconciler was still tracking.
 */
function _trimProcessed(deposits) {
  if (deposits.processed.length <= PROCESSED_AUDIT_CAP) return;
  const open = deposits.processed.filter(_isOpenRecord);
  const settled = deposits.processed.filter((r) => !_isOpenRecord(r));
  const keep = Math.max(0, PROCESSED_AUDIT_CAP - open.length);
  deposits.processed = [...open, ...settled.slice(-keep)];
}

/**
 * Phase 1 of a credit: durably claim the txid before any money moves.
 *
 * Throws if the write fails, and that is the point — no record, no credit.
 *
 * @param deposits - a FRESHLY loaded snapshot (never one that predates an await)
 */
function _recordCreditIntent(agentId, deposits, { txid, buyerVerusId, amount, confirmations, unconfirmed }) {
  deposits.processed.push({
    txid,
    buyerVerusId,
    amount,
    confirmations,
    crediting: true,
    intentAt: new Date().toISOString(),
    // M4: credited straight out of the mempool. A mempool transaction is not
    // money — flag it so the reconciler comes back and either confirms it or
    // takes the credit away. `creditedAtMs` anchors the block-denominated grace.
    ...(unconfirmed ? { unconfirmed: true, creditedAtMs: Date.now(), misses: 0 } : {}),
  });
  deposits.pending = deposits.pending.filter((d) => d.txid !== txid);
  // This txid may have been reversed earlier and is now being credited afresh.
  // Settle that ledger entry or _recheckReversals will credit it AGAIN.
  _settleReversedForTxid(deposits, txid, 'credited afresh');
  _rememberCreditedTxid(deposits, txid);
  _trimProcessed(deposits);
  saveDeposits(agentId, deposits);
}

/**
 * Phase 3: the money moved, so settle the record.
 *
 * Best-effort by design. If this save fails the record stays `crediting`, which
 * reads as "a human must check" — wrong in the harmless direction, since the
 * txid is already in the dedup ledger and cannot be credited again.
 */
function _finalizeCredit(agentId, txid) {
  try {
    const d = loadDeposits(agentId);
    const rec = d.processed.find((r) => r && r.txid === txid && r.crediting);
    if (!rec) return;
    delete rec.crediting;
    delete rec.intentAt;
    rec.creditedAt = new Date().toISOString();
    saveDeposits(agentId, d);
  } catch (e) {
    console.error(`[Deposits] ${agentId}: credited tx ${String(txid).substring(0, 12)}… but could not ` +
      `finalize its record (${e.message}). It stays flagged mid-credit; the credit itself did land.`);
  }
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
  if (_hasCreditedTxid(deposits, txid)) {
    // A record left in `crediting` is a crash between the intent and its
    // finalization: the meter may or may not have moved. Refusing is the safe
    // half (never credit twice); saying so is the other half, because the only
    // way to settle it is for a human to compare the meter against the chain.
    const open = deposits.processed.find((d) => d && d.txid === txid && d.crediting);
    if (open) {
      console.error(`[Deposits] ${agentId}: tx ${String(txid).substring(0, 12)}… is stuck mid-credit ` +
        `(intent recorded ${open.intentAt}, never finalized). Refusing to credit again. ` +
        'Check the buyer\'s meter against the chain — the credit may or may not have landed.');
    }
    return false;
  }
  _claimsInProgress.add(k);
  return true;
}

function releaseTxid(agentId, txid) {
  _claimsInProgress.delete(_claimKey(agentId, txid));
}

function loadDeposits(agentId) {
  const p = depositsPath(agentId);
  try {
    if (fs.existsSync(p)) return _normalizeDeposits(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {}
  return { processed: [], pending: [], creditedTxids: [] };
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
  //
  // Deliberately OUTSIDE the deposit lock. This call is reachable by anyone who
  // can POST to the webhook, and holding a per-agent lock across an
  // unauthenticated network round-trip would let junk reports stall the poller.
  const auth = await verifyDepositReport(client, report, network);
  if (!auth.ok) {
    console.warn(`[Deposit] Rejected report for ${agentId}: ${auth.code} — ${auth.message}`);
    return { credited: false, message: auth.message, code: auth.code };
  }

  try {
    return await withDepositLock(agentId,
      () => _reportVerifiedDeposit(agentId, client, report, payAddress, network));
  } catch (e) {
    if (e && e.code === 'DEPOSIT_LOCK_BUSY') {
      return { credited: false, code: 'BUSY', message: 'Deposit ledger is busy; please retry in a moment' };
    }
    throw e;
  }
}

/** The serialised half of reportDeposit. Runs under the per-agent deposit lock. */
async function _reportVerifiedDeposit(agentId, client, report, payAddress, network) {
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
      // Add to pending — will be credited when confirmed.
      //
      // RE-LOAD fresh, for the same reason the credit path below does: the
      // `deposits` snapshot predates verifyPayment/getTxStatus, and a commit
      // that landed during those awaits would be erased by saving the stale
      // copy — taking that txid's dedup entry with it, and, if the clobbered
      // write was a reversal, resurrecting a record the reconciler would then
      // reverse a second time.
      const freshPending = loadDeposits(agentId);
      if (!freshPending.pending.some(d => d.txid === txid)) {
        freshPending.pending.push({
          txid,
          buyerVerusId,
          amount: expectedAmount,
          requiredConfirmations: required,
          reportedAt: new Date().toISOString(),
        });
        saveDeposits(agentId, freshPending);
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
    if (_hasCreditedTxid(fresh, txid)) {
      // Persisted by someone else after we claimed (e.g. a crash-recovery edge).
      return { credited: false, message: 'Deposit already processed' };
    }
    const credited = clampCredit(expectedAmount, verification.confirmedAmount);
    if (credited < expectedAmount) {
      console.warn(`[deposit] credited ${credited} < reported ${expectedAmount} (confirmedAmount=${verification.confirmedAmount}) for tx ${txid}`);
    }

    // ── Record the intent BEFORE the money moves ──────────────────────────
    // Crediting first and persisting second means a crash in between leaves a
    // credited meter with no record of it, and the next attempt credits again
    // — unbounded by the confirmation tier, so this is the >10 VRSC path too.
    // Writing the intent first inverts the failure: the worst case becomes a
    // deposit that is recorded but possibly not credited, which a human can
    // settle, instead of one that is silently credited twice, which nobody
    // sees. Same two-phase shape the reversal path uses (`debiting`/`debited`).
    _recordCreditIntent(agentId, fresh, {
      txid, buyerVerusId, amount: credited, confirmations: txStatus.confirmations,
      unconfirmed: required === 0 && (txStatus.confirmations || 0) < 1,
    });
    committed = true; // the txid is durably claimed from here on

    let result;
    try {
      result = creditDeposit(agentId, buyerVerusId, credited, txid);
    } catch (e) {
      // The intent is durable but the money did not move. Say exactly that:
      // the generic "Verification failed" this used to fall through to would
      // send the operator hunting a verification problem that does not exist,
      // while a buyer sits under-credited behind a dedup entry that stops any
      // automatic retry. Deliberate — an under-credit a human can fix beats a
      // double-credit nobody sees — but only if the message is honest.
      console.error(`[Deposits] ${agentId}: intent recorded for tx ${String(txid).substring(0, 12)}… ` +
        `but the meter write FAILED (${e.message}). Flagged mid-credit; it will NOT be retried ` +
        'automatically. Credit the buyer by hand or clear the flag.');
      return {
        credited: false,
        code: 'CREDIT_WRITE_FAILED',
        message: 'Deposit recorded but the credit could not be applied; flagged for operator review',
      };
    }
    _finalizeCredit(agentId, txid);

    // Notify J41 platform (non-blocking, non-fatal) — uses per-agent context.
    // After the credit, not before: notifying about money that did not move
    // leaves our ledger and the platform's disagreeing.
    const ctx = _notifyContexts.get(agentId);
    if (ctx) {
      notifyJ41DepositConfirmed(ctx.sellerWif, ctx.sellerVerusId, buyerVerusId, credited, txid, ctx.network).catch(() => {});
    }

    return { credited: true, message: 'Deposit confirmed and credited', balance: result.newBalance };
  } catch (e) {
    return { credited: false, message: `Verification failed: ${e.message}` };
  } finally {
    // Release the in-process claim unless we durably committed `processed`
    // (in which case the persisted check in claimTxid covers future attempts).
    if (!committed) releaseTxid(agentId, txid);
  }
}

// ── M4: reconcile 0-conf credits ────────────────────────────────────────────
//
// `requiredConfirmations` returns 0 below 2 VRSC, so a small deposit is credited
// out of the mempool for instant proxy access. That is a deliberate UX call and
// it matches the platform's own tiering — but it was one-way. The credit was
// written and nothing ever went back to ask whether the funding transaction
// actually got mined. A mempool tx can be evicted, replaced, or never mined at
// all, and the buyer keeps the credit either way. Repeatable with a fresh txid
// each time, for free.
//
// The reconciler is deliberately biased toward KEEPING the credit. Reversing a
// legitimate buyer's balance is worse than a delayed clawback, so every
// ambiguous input — an unreachable platform, an unreadable response, an
// unrecognised error, a lagging node — leaves the credit standing.
const RECONCILE_MIN_MISSES = 3;
// Misses must also SPAN this long. Three polls is three minutes, which a routine
// backend deploy window can supply on its own — and a deploy is precisely when
// the tx-status route is most likely to answer wrongly.
const RECONCILE_MISS_SPAN_MS = 10 * 60 * 1000;
// The grace is denominated in BLOCKS, not wall time. "30 minutes elapsed" is
// satisfied by a frozen node that ingested nothing; "this node ingested 30
// blocks while staying at its peers' tip and still says the txid does not
// exist" is actual evidence. Same reasoning as shouldDeferForPendingWrite in
// inbox-deadletter.js, whose comment says outright that wall-clock windows lie
// about chain progress. ~30 blocks is ~30 min at Verus' ~60s target.
const RECONCILE_MIN_ADVANCE_BLOCKS = 30;
// How long a REVERSED credit stays eligible for automatic restoration if its
// transaction turns up on-chain after all. A reversal is our judgement call on
// incomplete evidence, so it has to be revisitable.
const REVERSAL_RECHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
// Pre-port 0-conf credits carry no `unconfirmed` flag, so the reconciler cannot
// see them. Adopt the recent ones; anything older than this is past any
// plausible mempool lifetime, and re-litigating it on a node whose txindex may
// have been pruned risks reversing a credit that was genuinely funded.
const RECONCILE_BACKFILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Blast-radius cap. A backend fault that answers TX_NOT_FOUND for every txid
// while the node reports itself synced would otherwise reverse every open
// credit on the fleet at once. The systemic guard catches that within a single
// agent's pass; this catches it across agents and across passes.
const REVERSAL_BUDGET_WINDOW_MS = 60 * 60 * 1000;
const REVERSAL_BUDGET_MAX_DEFAULT = 10;

/** Operator-settable; see the doctrine comment in config-loader.js. */
function _reversalBudgetMax() {
  try {
    const n = loadDispatcherConfig().deposit.reversal_budget_max;
    return Number.isFinite(n) && n >= 0 ? n : REVERSAL_BUDGET_MAX_DEFAULT;
  } catch { return REVERSAL_BUDGET_MAX_DEFAULT; }
}

const _recentReversals = []; // epoch ms, module-wide (i.e. fleet-wide)
const _lastReconcileState = new Map(); // agentId -> last logged reconciler state

/**
 * Is the fleet-wide financial kill switch set?
 *
 * Read from disk rather than importing cli.js, which would be circular. Same
 * path cli.js writes (FINANCIAL_SUSPENDED_PATH); an operator with a dead daemon
 * clears it with rm, and that must work for this subsystem too.
 */
function _financiallySuspended() {
  try {
    return fs.existsSync(path.join(os.homedir(), ".j41", "dispatcher", "financial-suspended"));
  } catch { return false; }
}

function _reversalBudgetAvailable(now) {
  while (_recentReversals.length && now - _recentReversals[0] > REVERSAL_BUDGET_WINDOW_MS) {
    _recentReversals.shift();
  }
  return _recentReversals.length < _reversalBudgetMax();
}

/**
 * Does the backend advertise a transaction-specific not-found code?
 *
 * Fails CLOSED: no flag, no reachable /v1/version, no answer at all → we
 * classify nothing as strong evidence and never reverse. That is the correct
 * money direction, but it is also SILENT — an inert reconciler looks exactly
 * like a working one, and reproduces the very leak this exists to close. The
 * caller is responsible for surfacing it — see the `state` field on the
 * reconcile result, which pollPendingDeposits logs when it is not `armed`.
 *
 * Uses the SDK's cached helper (5-minute TTL) rather than a bare fetch: this
 * runs per-agent per-poll, and an uncached /v1/version GET on each pass would
 * hammer the platform for an answer that changes on deploys.
 */
async function _strongCodeSupported() {
  try {
    const { hasFeature } = require('@junction41/sovagent-sdk/dist/backend-features.js');
    return (await hasFeature(loadDispatcherConfig().platform.api_url, 'tx.status-notfound-code')) === true;
  } catch {
    return false;
  }
}

/**
 * How much does this lookup failure tell us?
 *
 *   'strong' — the platform was asked about THIS txid and said it does not exist.
 *   null     — tells us nothing (connection refused, 5xx, a timeout, a bare 404).
 *
 * Match the CODE, not the message text. The earlier version also matched a set
 * of message regexes and treated a bare 404 as a weaker tier of evidence; both
 * are gone. A bare 404 is what a renamed route or a proxy mid-deploy answers
 * with, identically for every txid, and a tier that lets it move money is a
 * tier that empties every open credit during a deploy. `TX_NOT_FOUND` is a
 * published contract now, gated on the feature flag, so the guesswork is
 * unnecessary.
 */
function _classifyLookupFailure(err, strongCodeSupported) {
  if (!strongCodeSupported) return null;
  return String((err && err.code) || '') === 'TX_NOT_FOUND' ? 'strong' : null;
}

/**
 * Is this node's view of the chain trustworthy enough to take money on?
 *
 * A node behind the tip returns "transaction not found" for a transaction that
 * really landed. Node-down is a safe 5xx; node-lag is a 404 that debits a buyer
 * who genuinely paid — so the verdict is only admissible from a node that says
 * it is caught up.
 *
 * Every clause earns its place:
 *   - `longestChain > 0` — Komodo-lineage daemons report 0 before peer heights
 *     are polled, and `anyHeight >= 0` is trivially true. The backend restarts
 *     daily, so this state is reached routinely, and without this clause an
 *     arbitrarily-behind node reads as perfectly synced.
 *   - `connections > 0` — an isolated node's `longestChain` is just its own
 *     stale tip agreeing with itself.
 *   - `testnet` match — a node pointed at the wrong chain, or with a corrupt
 *     txindex, is "synced" by every height test and still answers TX_NOT_FOUND
 *     for every genuinely-landed txid.
 *
 * What it does NOT catch: an eclipsed node whose peers are all stale. There is
 * no tip timestamp in the response, so tip age cannot be computed client-side;
 * backend-attested sync would close it and is the right long-term answer.
 */
function _syncedView(ci, network) {
  if (!ci) return false;
  const h = Number(ci.blockHeight);
  const lc = Number(ci.longestChain);
  if (!Number.isFinite(h) || !Number.isFinite(lc) || h <= 0 || lc <= 0) return false;
  if (!(Number(ci.connections) > 0)) return false;
  if (h < lc) return false;
  if (typeof ci.testnet === 'boolean' && ci.testnet !== (network !== 'verus')) return false;
  return true;
}

async function _chainInfo(client) {
  try {
    const ci = await client.getChainInfo();
    return ci && ci.data ? ci.data : ci;
  } catch {
    return null;
  }
}

/**
 * Mark any open `reversed` ledger entry for this txid as settled, because some
 * OTHER path just credited it.
 *
 * A reversed txid is deliberately removed from the dedup ledger so a buyer whose
 * payment did confirm can re-report it. The orphaned ledger entry would then
 * still look restorable, and _recheckReversals would credit it a second time.
 */
function _settleReversedForTxid(deposits, txid, reason) {
  let touched = false;
  for (const r of deposits.reversed || []) {
    if (r && r.txid === txid && !r.restoredAt) {
      r.restoredAt = new Date().toISOString();
      r.resolvedBy = reason;
      // Clear the flag too. Left standing, a settled entry keeps showing up as
      // actionable, `deposits list` prints the resolution command next to it,
      // and an operator following the tool's own instruction credits a buyer
      // who has already been made whole.
      if (r.needsOperator && !r.resolvedAt) {
        r.resolvedAt = r.restoredAt;
        r.resolution = 'settled automatically — another path credited this txid';
        delete r.needsOperator;
      }
      touched = true;
    }
  }
  return touched;
}

/**
 * Find the one unresolved anomaly for a txid, wherever it lives.
 *
 * @returns {{entry: object, where: 'processed'|'reversed'}|null}
 */
function _findAnomaly(deposits, txid) {
  const p = deposits.processed.find((r) => r && r.txid === txid && _isUnresolvedAnomaly(r));
  if (p) return { entry: p, where: 'processed' };
  const r = deposits.reversed.find((x) => x && x.txid === txid && _isUnresolvedAnomaly(x));
  if (r) return { entry: r, where: 'reversed' };
  return null;
}

/**
 * Operator decision: the buyer IS owed this amount. Apply it and close the entry.
 *
 * Fails closed on any doubt about the transaction. The anomalies this resolves
 * all have the same shape — "the tx confirmed but we cannot prove which way the
 * meter moved" — so a correction in the buyer's favour is only defensible if the
 * transaction really is on-chain.
 */
async function creditDepositAnomaly(agentId, txid, { client, resolvedBy = 'operator' } = {}) {
  // Verify BEFORE taking the lock (it is a network call), then re-check the
  // ledger inside the lock — the entry may have been settled while we waited.
  let confs = null;
  try {
    const st = await client.getTxStatus(txid);
    confs = st && Number.isFinite(st.confirmations) ? st.confirmations : null;
  } catch (e) {
    return { ok: false, code: 'VERIFY_FAILED', message: `Could not check ${txid} on-chain: ${e.message}` };
  }
  if (confs === null || confs < 1) {
    return {
      ok: false,
      code: 'NOT_CONFIRMED',
      message: `Refusing: ${txid} has ${confs === null ? 'an unreadable confirmation count' : `${confs} confirmation(s)`}. ` +
        'Only a transaction that is genuinely on-chain justifies crediting the buyer.',
    };
  }

  return withDepositLock(agentId, () => {
    const d = loadDeposits(agentId);
    const found = _findAnomaly(d, txid);
    if (!found) {
      return { ok: false, code: 'NOT_FOUND', message: `No unresolved anomaly for ${txid} on ${agentId} (already settled?)` };
    }
    const { entry, where } = found;
    const amount = entry.amount;
    const buyerVerusId = entry.buyerVerusId;

    if (entry.resolving) {
      // A previous run of this verb died between the meter write and the record
      // write. Retrying blind is how a human turns one credit into two — and a
      // human who just watched the command die is exactly who retries.
      return {
        ok: false,
        code: 'RESOLVE_INTERRUPTED',
        message: `A previous credit of ${amount} VRSC to ${buyerVerusId} was interrupted ` +
          `(started ${entry.resolvingAt}). The meter may already hold it. Compare ` +
          'totalDeposited against the ledger before retrying, then dismiss it if it landed.',
      };
    }

    // Intent first, money second — the protocol every other credit path in this
    // file follows. A crash between them leaves `resolving`, which refuses
    // above instead of paying twice.
    entry.resolving = true;
    entry.resolvingAt = new Date().toISOString();
    saveDeposits(agentId, d);

    creditDeposit(agentId, buyerVerusId, amount, txid);

    delete entry.resolving;
    delete entry.resolvingAt;
    entry.resolvedAt = new Date().toISOString();
    entry.resolvedBy = resolvedBy;
    entry.resolution = `credited ${amount} VRSC by operator (tx confirmed at ${confs} block(s))`;
    delete entry.needsOperator;
    if (where === 'reversed') entry.restoredAt = entry.restoredAt || entry.resolvedAt;

    // Back into the dedup ledger. A reversal takes the txid OUT so the buyer can
    // re-report; now that we have credited it by hand, a re-report must not
    // credit it a second time — the same coupling _recheckReversals maintains.
    if (!d.processed.some((r) => r && r.txid === txid)) {
      d.processed.push({
        txid, buyerVerusId, amount, confirmations: confs,
        creditedAt: entry.resolvedAt,
        resolvedByOperator: true,
      });
    }
    _rememberCreditedTxid(d, txid);
    _trimProcessed(d);
    saveDeposits(agentId, d);

    return { ok: true, credited: amount, buyerVerusId, confirmations: confs };
  });
}

/**
 * Operator decision: nothing is owed. Close the entry, move no money.
 */
async function dismissDepositAnomaly(agentId, txid, { reason, resolvedBy = 'operator' } = {}) {
  if (!reason) return { ok: false, code: 'REASON_REQUIRED', message: 'A dismissal must record why' };
  return withDepositLock(agentId, () => {
    const d = loadDeposits(agentId);
    const found = _findAnomaly(d, txid);
    if (!found) {
      return { ok: false, code: 'NOT_FOUND', message: `No unresolved anomaly for ${txid} on ${agentId} (already settled?)` };
    }
    const { entry } = found;
    entry.resolvedAt = new Date().toISOString();
    entry.resolvedBy = resolvedBy;
    entry.resolution = `dismissed by operator: ${reason}`;
    delete entry.needsOperator;
    saveDeposits(agentId, d);
    return { ok: true, dismissed: true, buyerVerusId: entry.buyerVerusId, amount: entry.amount };
  });
}

/**
 * What an operator needs to answer "did the debit actually run?".
 *
 * The flags say "check the meter against the chain", and the chain half is easy.
 * The meter half is not: credit-meters.json keeps no journal, and `balance`
 * moves with every proxied request, so no arithmetic on the balance alone can
 * isolate one historical adjustment. What CAN be reconstructed is
 * `totalDeposited`, which only deposits and reversals touch — comparing it to
 * the sum of this buyer's settled ledger records turns the decision from a
 * judgement call into arithmetic.
 */
function reconcileMeterAgainstLedger(agentId, buyerVerusId) {
  const { getMeter } = require('./credit-meter.js');
  const d = loadDeposits(agentId);
  const meter = getMeter(agentId, buyerVerusId) || null;

  const credited = d.processed
    .filter((r) => r && r.buyerVerusId === buyerVerusId && !r.crediting)
    .reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const debited = d.reversed
    .filter((r) => r && r.buyerVerusId === buyerVerusId && r.debited === true && !r.restoredAt)
    .reduce((n, r) => n + (Number(r.amount) || 0), 0);

  const expected = credited - debited;
  const actual = meter && Number.isFinite(meter.totalDeposited) ? meter.totalDeposited : null;
  return {
    buyerVerusId,
    expectedTotalDeposited: Number(expected.toFixed(8)),
    actualTotalDeposited: actual,
    delta: actual === null ? null : Number((actual - expected).toFixed(8)),
    balance: meter && Number.isFinite(meter.balance) ? meter.balance : null,
  };
}

/** Clear a miss run's stamps. Every one of them, every time — see below. */
function _clearMissRun(rec) {
  // `firstMissHeight` MUST be cleared everywhere `firstMissAtMs` is. The stamp
  // idiom is `if (!rec.firstMissHeight)`, so a stale value left behind by a
  // flapping index makes the next run's "30 blocks have passed" test true
  // immediately, and the block grace silently degrades to nothing.
  delete rec.misses;
  delete rec.firstMissAtMs;
  delete rec.firstMissHeight;
}

/**
 * Adopt 0-conf credits minted before this code existed.
 *
 * They carry `confirmations: 0` but no `unconfirmed` flag, so the reconciler's
 * filter cannot see them and they would never be reconciled at all. Bounded to
 * recent ones on purpose; the older tail is reported rather than silently
 * written off, because "we decided not to" and "we never noticed" prescribe
 * different actions.
 */
function _backfillPrePortZeroConf(agentId, deposits, now) {
  let opened = 0;
  let tooOld = 0;
  for (const rec of deposits.processed) {
    if (!rec || rec.unconfirmed || rec.crediting || rec.confirmations !== 0) continue;
    if (rec.reconcileBackfillSkipped) continue;
    const at = Date.parse(rec.creditedAt || '');
    if (!Number.isFinite(at)) { rec.reconcileBackfillSkipped = true; tooOld++; continue; }
    if (now - at > RECONCILE_BACKFILL_MAX_AGE_MS) { rec.reconcileBackfillSkipped = true; tooOld++; continue; }
    rec.unconfirmed = true;
    rec.creditedAtMs = at;
    rec.misses = 0;
    opened++;
  }
  if (opened || tooOld) {
    saveDeposits(agentId, deposits);
    if (tooOld) {
      console.warn(`[Deposits] ${agentId}: ${tooOld} pre-existing 0-conf credit(s) are older than the ` +
        'backfill window and will NOT be reconciled — they predate the reconciler and are past any ' +
        'plausible mempool lifetime. Audit them by hand if the balances look wrong.');
    }
    if (opened) {
      console.log(`[Deposits] ${agentId}: adopted ${opened} pre-existing 0-conf credit(s) for reconciliation`);
    }
  }
  return { opened, tooOld };
}

/**
 * Reconcile every open 0-conf credit for one agent.
 *
 * @returns {{confirmed:number, reversed:number, waiting:number, restored:number, state:string}}
 */
async function reconcileUnconfirmedDeposits(agentId, client, now = Date.now(), emit) {
  return withDepositLock(agentId, () => _reconcileLocked(agentId, client, now, emit));
}

async function _reconcileLocked(agentId, client, now, emit) {
  let reconcileEnabled = true;
  try { reconcileEnabled = loadDispatcherConfig().deposit.reconcile_enabled !== false; } catch {}
  if (!reconcileEnabled) {
    // Deliberately off. Credits stand; nothing is clawed back. Reported rather
    // than silent, because an operator who forgot they disabled it would
    // otherwise see open credits climb with no explanation.
    return { confirmed: 0, reversed: 0, waiting: 0, restored: 0, state: 'disabled' };
  }
  const network = loadDispatcherConfig().platform.network;

  const seed = loadDeposits(agentId);
  _backfillPrePortZeroConf(agentId, seed, now);
  const deposits = loadDeposits(agentId);
  const open = deposits.processed.filter((d) => d && d.unconfirmed);
  if (open.length === 0) {
    // No OPEN credits, but a reversal may still be waiting to be undone — and a
    // reversal is precisely the state in which nothing is open any more.
    const restoredOnly = await _recheckReversals(agentId, client, now, emit);
    return { confirmed: 0, reversed: 0, waiting: 0, restored: restoredOnly, state: 'idle' };
  }

  const strongCodeSupported = await _strongCodeSupported();

  // ── Gate: is this node's word worth acting on? ───────────────────────────
  // Taken after the early-return so idle agents cost nothing.
  const ciBefore = await _chainInfo(client);
  if (!_syncedView(ciBefore, network)) {
    // A lagging, unreachable, isolated or wrong-chain node produces ZERO
    // evidence. No miss increments, no persistence — an outage cannot
    // accumulate its way to a reversal one pass at a time.
    const restoredOnly = await _recheckReversals(agentId, client, now, emit);
    return { confirmed: 0, reversed: 0, waiting: open.length, restored: restoredOnly, state: 'inert-unsynced' };
  }

  let confirmed = 0, reversed = 0, waiting = 0;

  // ── Phase 1: LOOK UP EVERYTHING, decide nothing ──────────────────────────
  // The systemic check compares each record against the whole pass, so the whole
  // pass must exist before any record is judged. Doing both in one loop makes
  // the guard true only for the LAST record of each pass, which is not a guard.
  const lookups = [];
  for (const rec of open) {
    let seen = null;
    let strength = null;
    let transient = false;
    try {
      const st = await client.getTxStatus(rec.txid);
      seen = st && Number.isFinite(st.confirmations) ? st.confirmations : null;
      // The call RESOLVED but we could not read a confirmation count out of it —
      // an empty body, `{}`, a stringified count, a re-wrapped `{data:{…}}`.
      // A backend response-shape change must not claw back every open credit.
      if (seen === null) transient = true;
    } catch (e) {
      strength = _classifyLookupFailure(e, strongCodeSupported);
      if (!strength) transient = true;
    }
    lookups.push({ rec, seen, strength, transient });
  }

  // ── Phase 2: is this about the transactions, or about the backend? ───────
  // A backend fault answers identically for EVERY txid; a genuinely dropped
  // transaction is isolated among its peers. A txindex wipe or rebuild returns
  // a tx-specific TX_NOT_FOUND for everything while the node sits happily at
  // its peers' tip, so this is judged over the STRONG class — the class that
  // can actually move money.
  const strongMisses = lookups.filter((l) => l.strength === 'strong').length;
  if (lookups.length > 1 && strongMisses === lookups.length) {
    console.error(`[Deposits] ${agentId}: all ${lookups.length} open 0-conf lookups returned TX_NOT_FOUND ` +
      'identically — treating as a backend-side fault, not as evidence about any transaction. Nothing counted.');
    const restoredOnly = await _recheckReversals(agentId, client, now, emit);
    return { confirmed: 0, reversed: 0, waiting: lookups.length, restored: restoredOnly, state: 'systemic' };
  }

  // Second half of the bracket. The gate is a self-report sampled at one instant;
  // the lookups happened after it. Re-sampling detects a node that restarted,
  // fell behind, or was swapped mid-pass, for the price of one public GET.
  const ciAfter = await _chainInfo(client);
  const stillSynced = _syncedView(ciAfter, network)
    && Number(ciAfter.blockHeight) >= Number(ciBefore.blockHeight);
  // The most conservative height available across the whole pass.
  const passHeight = stillSynced
    ? Math.min(Number(ciBefore.blockHeight), Number(ciAfter.blockHeight))
    : null;

  // ── Phase 3: act, one record at a time ───────────────────────────────────
  for (const { rec, seen, strength, transient } of lookups) {
    if (transient) {
      waiting++;
      continue;
    }

    // Re-load per record: crediting/reversing is a write, and other paths write
    // `processed` too.
    const fresh = loadDeposits(agentId);
    const live = fresh.processed.find((d) => d && d.txid === rec.txid && d.unconfirmed);
    if (!live) continue; // someone else resolved it while we were awaiting

    if (seen !== null && seen >= 1) {
      if (live.reversal === 'debited') {
        // We know the meter was debited and the tx has now confirmed, so the
        // debit was wrong — the buyer funded it after all. Clear the flag and
        // persist FIRST: a lost re-credit leaves the buyer short by a recorded
        // amount an operator can see, whereas a repeated re-credit silently
        // mints money on every subsequent pass.
        live.reversal = 'recredited';
        saveDeposits(agentId, fresh);
        creditDeposit(agentId, live.buyerVerusId, live.amount, live.txid);
        console.warn(`[Deposits] ${agentId}: ${rec.txid.substring(0, 12)}… confirmed AFTER a completed reversal — ` +
          `re-credited ${live.amount} VRSC to ${live.buyerVerusId}.`);
        delete live.reversal;
      } else if (live.reversal) {
        // 'debiting' (crashed between the intent stamp and the debit) or
        // 'recredited' (crashed between the flag write and the credit). We
        // cannot tell whether the money moved, and this is a confirmed,
        // genuinely funded deposit — so do NOT guess. Stop and ask a human.
        live.needsOperator = `reversal state '${live.reversal}' when the tx confirmed — balance may be off by ${live.amount}`;
        delete live.reversal;
        console.error(`[Deposits] ${agentId}: ⚠️  ${rec.txid.substring(0, 12)}… confirmed while a reversal was ` +
          `mid-flight. We CANNOT tell whether ${live.amount} VRSC was debited from ${live.buyerVerusId}. ` +
          'No money moved. Check the meter against the chain and correct it by hand.');
        _emit(emit, 'deposit.needs_operator', { agentId, txid: live.txid, buyerVerusId: live.buyerVerusId, amount: live.amount, where: 'processed', reason: live.needsOperator });
      }
      if (live.withheldReversal) {
        // The reversal we declined to make turned out to be the right call: the
        // transaction confirmed, so the credit standing on the meter is correct
        // and nothing is owed. Retire the flag, or it pins /health to degraded
        // forever and walks an operator into crediting an unreversed deposit.
        delete live.withheldReversal;
        delete live.needsOperator;
        live.resolvedAt = new Date().toISOString();
        live.resolution = 'tx confirmed — the withheld reversal was correctly withheld';
      }
      delete live.unconfirmed;
      _clearMissRun(live);
      live.confirmations = seen;
      saveDeposits(agentId, fresh);
      confirmed++;
      console.log(`[Deposits] ${agentId}: 0-conf credit ${rec.txid.substring(0, 12)}… confirmed at ${seen} block(s)`);
      continue;
    }

    if (seen === 0) {
      // Still in the mempool. It exists; keep waiting and reset the miss run.
      if (live.misses || live.firstMissAtMs || live.firstMissHeight) {
        _clearMissRun(live);
        live.misses = 0;
        saveDeposits(agentId, fresh);
      }
      waiting++;
      continue;
    }

    // strength === 'strong': the platform says the chain does not know this txid.
    //
    // A `reversing` stamp from a previous pass means we may already have debited
    // the meter and died before clearing the record. 'debited' is proof;
    // 'debiting' only proves we INTENDED to — the stamp is written before the
    // debit precisely so a crash is recoverable, which means it cannot also
    // stand as evidence that the debit ran. Treat the ambiguous case as already
    // debited: forgiving ≤2 VRSC beats debiting a buyer twice.
    if (live.crediting) {
      // We cannot prove the credit ever reached the meter, so we cannot know
      // whether there is anything to take back. claimTxid already treats this
      // record as "the meter may or may not have moved" — the reversal path must
      // agree with it rather than guessing in the direction that charges a buyer.
      if (!live.needsOperator) {
        live.needsOperator = 'credit intent never finalized and the funding tx is unknown to the chain — ' +
          `cannot tell whether ${live.amount} VRSC ever reached ${live.buyerVerusId}`;
        saveDeposits(agentId, fresh);
        console.error(`[Deposits] ${agentId}: ⚠️  ${rec.txid.substring(0, 12)}… is both stuck mid-credit ` +
          'and unknown to the chain. Refusing to debit a buyer whose credit we cannot prove landed. ' +
          'Check the meter against the ledger.');
        _emit(emit, 'deposit.needs_operator', {
          agentId, txid: live.txid, buyerVerusId: live.buyerVerusId,
          amount: live.amount, where: 'processed', reason: live.needsOperator,
        });
      }
      waiting++;
      continue;
    }

    const alreadyDebited = live.reversal === 'debited' || live.reversal === 'debiting';
    live.misses = (live.misses || 0) + 1;
    if (!live.firstMissAtMs) live.firstMissAtMs = now;
    if (!live.firstMissHeight) live.firstMissHeight = passHeight || Number(ciBefore.blockHeight);

    const missRunLongEnough = live.misses >= RECONCILE_MIN_MISSES
      && now - live.firstMissAtMs >= RECONCILE_MISS_SPAN_MS;
    // The substance of the gate: this node ingested ≥30 blocks, stayed at its
    // peers' tip at BOTH ends of the pass, and still says the txid does not
    // exist. A frozen node satisfies the wall clock and never satisfies this.
    const blocksAdvanced = passHeight !== null && Number.isFinite(live.firstMissHeight)
      ? passHeight - live.firstMissHeight
      : -1;
    const pastBlockGrace = blocksAdvanced >= RECONCILE_MIN_ADVANCE_BLOCKS;

    if (!alreadyDebited && !(stillSynced && missRunLongEnough && pastBlockGrace)) {
      saveDeposits(agentId, fresh);
      waiting++;
      continue;
    }

    if (!alreadyDebited && _financiallySuspended()) {
      // The operator (or the outage sweep) has declared the platform untrusted
      // for money decisions. Refunds already freeze on this flag; a reversal
      // debits a buyer on the SAME platform answers, with no approval queue in
      // front of it, so it has to honour the flag too — otherwise the operator
      // mental model ("that file means no money moves") is false for the one
      // subsystem that moves money unattended. Restores and confirms keep
      // running: they only ever move money toward the buyer, on positive evidence.
      waiting++;
      continue;
    }

    if (!alreadyDebited && !_reversalBudgetAvailable(now)) {
      // More reversals in the last hour than any plausible organic rate. Stop
      // and say so rather than working through the fleet one buyer at a time.
      live.needsOperator = 'reversal withheld: fleet reversal budget exhausted — ' +
        'suspected backend-side fault, check before clearing';
      // Tagged so the confirmed branch can retire it. Without the tag the flag
      // outlives the question it asked: the tx confirms, the credit was never
      // reversed, nothing is owed — and the operator surface still lists the
      // entry with a credit command beside it.
      live.withheldReversal = true;
      saveDeposits(agentId, fresh);
      waiting++;
      console.error(`[Deposits] ${agentId}: ⛔ reversal budget exhausted (${_reversalBudgetMax()} in the last hour). ` +
        `Withholding the reversal of ${live.amount} VRSC for ${live.buyerVerusId} and flagging for review. ` +
        'This usually means the backend is wrong, not that every buyer stopped paying at once.');
      _emit(emit, 'deposit.needs_operator', { agentId, txid: live.txid, buyerVerusId: live.buyerVerusId, amount: live.amount, where: 'processed', reason: live.needsOperator });
      continue;
    }

    let debitCertain = false;
    if (!alreadyDebited) {
      // Persist the intent BEFORE the irreversible debit, so a crash in between
      // is recoverable rather than a guess.
      live.reversal = 'debiting';
      saveDeposits(agentId, fresh);
      reverseDeposit(agentId, live.buyerVerusId, live.amount, live.txid);
      live.reversal = 'debited';
      saveDeposits(agentId, fresh);
      debitCertain = true;
      _recentReversals.push(now);
    } else {
      console.warn(`[Deposits] ${agentId}: ${live.txid.substring(0, 12)}… was mid-reversal at the last crash — ` +
        'completing the bookkeeping without debiting again.');
    }

    fresh.processed = fresh.processed.filter((d) => d.txid !== live.txid);
    // Out of the dedup ledger too, and release the in-process claim: the credit
    // is gone, so a buyer whose payment DID confirm must be able to re-report
    // it. _recordCreditIntent settles the ledger entry when they do, and
    // _recheckReversals re-adds the txid if it restores automatically — so
    // exactly one of the two paths can ever credit it.
    if (debitCertain) {
      // The credit is genuinely gone, so the buyer must be able to re-report the
      // txid if it turns out to have confirmed after all.
      fresh.creditedTxids = fresh.creditedTxids.filter((t) => t !== live.txid);
      releaseTxid(agentId, live.txid);
    }
    // When the debit was NOT certain we deliberately did not charge the buyer —
    // so their original credit may still be standing. Releasing the txid then
    // lets them re-report the same deposit and be credited a SECOND time on top
    // of a credit that was never reversed. Keep the dedup entry; the reversed
    // ledger row still records what happened, and _recheckReversals already
    // refuses to auto-restore a `debited !== true` entry for the same reason.
    fresh.reversed = fresh.reversed || [];
    fresh.reversed.push({
      txid: live.txid,
      buyerVerusId: live.buyerVerusId,
      amount: live.amount,
      creditedAt: live.creditedAt,
      reversedAt: new Date().toISOString(),
      reason: 'funding transaction never confirmed and is unknown to the chain',
      // Did the meter ACTUALLY move? Only `true` licenses an automatic restore.
      // The forgiveness branch above reaches here having deliberately NOT
      // debited, so a ledger entry exists for a buyer who was never charged;
      // restoring that on a later confirmation credits them a second time.
      debited: debitCertain,
    });
    if (fresh.reversed.length > 1000) {
      const open2 = fresh.reversed.filter((r) => r && (!r.restoredAt || r.needsOperator));
      const settled = fresh.reversed.filter((r) => !(r && (!r.restoredAt || r.needsOperator)));
      fresh.reversed = [...open2, ...settled.slice(-Math.max(0, 1000 - open2.length))];
    }
    saveDeposits(agentId, fresh);
    reversed++;
    console.error(`[Deposits] ${agentId}: ⛔ REVERSED ${live.amount} VRSC of credit for ${live.buyerVerusId} — ` +
      `funding tx ${live.txid.substring(0, 12)}… never confirmed and the chain does not know it. ` +
      'If the buyer disputes this, check the txid on-chain before re-crediting.');
    _emit(emit, 'deposit.reversed', { agentId, txid: live.txid, buyerVerusId: live.buyerVerusId, amount: live.amount, debited: debitCertain });
  }

  // ── Phase 4: was a reversal wrong? ───────────────────────────────────────
  const restored = await _recheckReversals(agentId, client, now, emit);

  if (confirmed || reversed || restored) {
    console.log(`[Deposits] ${agentId}: reconciled 0-conf credits — ${confirmed} confirmed, ${reversed} reversed, ` +
      `${restored} restored, ${waiting} still open`);
  }
  return {
    confirmed, reversed, waiting, restored,
    state: strongCodeSupported ? (stillSynced ? 'armed' : 'inert-unsynced') : 'inert-no-flag',
  };
}

/**
 * Restore a reversed credit whose transaction later confirmed.
 *
 * Bounded by REVERSAL_RECHECK_WINDOW_MS and idempotent via `restoredAt`. Only
 * ever acts on a POSITIVE confirmation, which is trustworthy from any node — so
 * unlike the reversal path this needs no sync gate. An unknown or unreachable
 * lookup leaves the reversal standing.
 */
async function _recheckReversals(agentId, client, now = Date.now(), emit) {
  const d = loadDeposits(agentId);

  // A `restoring` stamp that survived a restart means we crashed between the
  // intent and the credit. Whether the buyer got their money back is unknowable
  // from here, and the entry is excluded from the candidate filter below — so
  // without this it would be terminal and invisible, which is the exact failure
  // the intent stamp was introduced to prevent.
  let flagged = false;
  for (const r of d.reversed) {
    if (r && r.restoring && !r.needsOperator) {
      r.needsOperator = `restore was interrupted (stamped ${r.restoringAt}) — ` +
        `check whether ${r.buyerVerusId} received ${r.amount} back`;
      flagged = true;
      console.error(`[Deposits] ${agentId}: ⚠️  restore of ${String(r.txid).substring(0, 12)}… was interrupted. ` +
        `Cannot tell whether ${r.amount} VRSC went back to ${r.buyerVerusId}. Check the meter by hand.`);
      _emit(emit, 'deposit.needs_operator', { agentId, txid: r.txid, buyerVerusId: r.buyerVerusId, amount: r.amount, where: 'reversed', reason: r.needsOperator });
    }
  }
  if (flagged) saveDeposits(agentId, d);

  const candidates = (d.reversed || []).filter((r) => {
    if (!r || r.restoredAt || r.restoring || !r.txid) return false;
    const at = Date.parse(r.reversedAt || '');
    return Number.isFinite(at) && now - at <= REVERSAL_RECHECK_WINDOW_MS;
  });
  if (candidates.length === 0) return 0;

  let restored = 0;
  for (const cand of candidates) {
    // Only an entry we KNOW debited may be restored automatically. `debited:
    // false` means the reversal forgave an ambiguous crash and never charged
    // the buyer; crediting it back would hand them the deposit twice.
    // `undefined` is an entry written before this field existed — same
    // treatment, because we cannot tell.
    if (cand.debited !== true) {
      const fresh0 = loadDeposits(agentId);
      const e0 = (fresh0.reversed || []).find((r) => r && r.txid === cand.txid && !r.restoredAt);
      if (e0 && !e0.needsOperator) {
        e0.needsOperator = 'reversed without a certain debit, and the tx later confirmed — ' +
          `check whether ${e0.buyerVerusId} is owed ${e0.amount}`;
        saveDeposits(agentId, fresh0);
        console.error(`[Deposits] ${agentId}: ⚠️  reversed tx ${String(cand.txid).substring(0, 12)}… has confirmed, ` +
          'but we cannot prove the reversal ever debited. No money moved. Check the meter by hand.');
        _emit(emit, 'deposit.needs_operator', { agentId, txid: e0.txid, buyerVerusId: e0.buyerVerusId, amount: e0.amount, where: 'reversed', reason: e0.needsOperator });
      }
      continue;
    }
    let confs = null;
    try {
      const st = await client.getTxStatus(cand.txid);
      confs = st && Number.isFinite(st.confirmations) ? st.confirmations : null;
    } catch {
      continue; // no news is not good news, and not bad news either
    }
    if (confs === null || confs < 1) continue;

    const fresh = loadDeposits(agentId);
    const live = (fresh.reversed || []).find((r) => r && r.txid === cand.txid && !r.restoredAt && !r.restoring);
    if (!live) continue;

    // Intent, money, settle — the same three-step the credit path uses.
    // Stamping `restoredAt` before crediting and calling it done was the old
    // shape, and a crash in between excluded the entry from every future pass:
    // the buyer's money gone, no flag, no reader, while the ledger asserted
    // they had been made whole. `restoring` is distinguishable from finished.
    live.restoring = true;
    live.restoringAt = new Date(now).toISOString();
    // Re-arm the dedup in the SAME save as the intent, not after the credit.
    // Doing it afterwards left a window where the buyer had been credited and
    // the txid was not in the ledger, so a re-report credited them again — the
    // third path through a rule that is supposed to admit exactly two.
    if (!fresh.processed.some((r) => r && r.txid === cand.txid)) {
      fresh.processed.push({
        txid: cand.txid,
        buyerVerusId: live.buyerVerusId,
        amount: live.amount,
        confirmations: confs,
        creditedAt: new Date(now).toISOString(),
        restoredFromReversal: true,
      });
    }
    _rememberCreditedTxid(fresh, cand.txid);
    _trimProcessed(fresh);
    saveDeposits(agentId, fresh);

    creditDeposit(agentId, live.buyerVerusId, live.amount, live.txid);

    const settle = loadDeposits(agentId);
    const entry = (settle.reversed || []).find((r) => r && r.txid === cand.txid && r.restoring);
    if (entry) {
      delete entry.restoring;
      delete entry.restoringAt;
      entry.restoredAt = new Date(now).toISOString();
      entry.resolvedBy = 'automatic restore — the funding tx confirmed after all';
    }
    // The dedup entry was already written with the intent above; this save only
    // settles the ledger row.
    saveDeposits(agentId, settle);

    restored++;
    console.warn(`[Deposits] ${agentId}: ↩️  RESTORED ${live.amount} VRSC to ${live.buyerVerusId} — ` +
      `reversed tx ${String(live.txid).substring(0, 12)}… has confirmed (${confs} block(s)) after all. ` +
      'The reversal was wrong; the credit is back.');
    _emit(emit, 'deposit.restored', { agentId, txid: live.txid, buyerVerusId: live.buyerVerusId, amount: live.amount, confirmations: confs });
  }
  return restored;
}

// ── Cross-process serialisation ─────────────────────────────────────────────
//
// `deposits.json` and `credit-meters.json` are read-modify-written by the
// daemon continuously — the poller every 60s, the meter on every proxied
// request — and now also by a SECOND process, because `deposits credit` runs
// out-of-band while the daemon is up. That is the documented operator workflow,
// not an edge case.
//
// Atomic tmp→rename protects against a TORN file. It does nothing about a lost
// update: two processes load the same snapshot, both save, and whichever lands
// second silently erases the other. If the erased write was a dedup entry, that
// txid can be credited again; if it was a reversal, the reconciler runs the
// whole miss cycle a second time and debits the buyer twice.
//
// This is the third time this codebase has met this bug (refund sends, send
// history, now deposits), so it uses the same discipline rather than a new one.
// Its own lock namespace, deliberately: a deposits bug must not be able to
// reach into the hardened refund path.
const DEPOSIT_LOCK_TIMEOUT_MS = 15000; // holds span network calls; be patient
const DEPOSIT_LOCK_STALE_MS = 2000;    // below the timeout — see file-lock.js

function depositLockPath(agentId) {
  return path.join(AGENTS_DIR, agentId, 'deposits.lock');
}

// In-process serialisation, because the file lock alone is not enough: one
// process can have the webhook's reportDeposit and the poller in flight at the
// same time, and O_EXCL says nothing about two async tasks in the SAME process.
// A queue rather than a reentrancy counter on purpose — a counter would let a
// second concurrent task see "already held" and sail straight through.
const _agentQueues = new Map(); // agentId -> tail promise

function _withAgentQueue(agentId, fn) {
  const prev = _agentQueues.get(agentId) || Promise.resolve();
  const run = prev.then(fn, fn); // a rejected predecessor must not block the queue
  // Keep the chain alive but never let it accumulate unhandled rejections.
  _agentQueues.set(agentId, run.then(() => {}, () => {}));
  return run;
}

/**
 * Run `fn` with exclusive access to this agent's deposit state.
 *
 * Fails CLOSED: if the lock cannot be taken, the work does NOT happen. A poller
 * pass skipped is retried in 60 seconds; a report refused is retried by the
 * buyer. Proceeding unserialised is the one option that silently loses money.
 */
async function withDepositLock(agentId, fn) {
  const { acquireFileLock, releaseFileLock } = require('./file-lock.js');
  return _withAgentQueue(agentId, async () => {
    const lockPath = depositLockPath(agentId);
    const token = await acquireFileLock(lockPath, {
      timeoutMs: DEPOSIT_LOCK_TIMEOUT_MS,
      staleMs: DEPOSIT_LOCK_STALE_MS,
    });
    if (!token) {
      const e = new Error(`could not acquire the deposit lock for ${agentId} — another process holds it`);
      e.code = 'DEPOSIT_LOCK_BUSY';
      throw e;
    }
    try {
      return await fn();
    } finally {
      releaseFileLock(lockPath, token);
    }
  });
}

// ── Read model ──────────────────────────────────────────────────────────────
//
// Every `needsOperator` state this file writes was, until now, write-only: four
// write sites and a single console.error between them. That is the same shape as
// the 2026-08-05 fee-tank failure — an agent silently unable to write on-chain
// while everything reported healthy — and the fix is the same one that worked
// there: one builder, consumed by every transport, so the socket, the HTTP
// health document and the CLI cannot drift apart.
//
// `needsOperator` lives in two structurally different places: on a `processed`
// record (the reversal-state ambiguity) and on a `reversed[]` entry (a restore
// that could not be proven). A reader that scans only one of them is the
// "guard at one of two sites" bug this codebase keeps re-finding, so both are
// folded into one list here rather than at each call site.

/**
 * Fire a control-API event, never letting the notification break the money path.
 * Optional by design: the reconciler is also called from tests and from a second
 * process, neither of which has an event bus.
 */
function _emit(emit, type, data) {
  if (typeof emit !== 'function') return;
  try { emit(type, data); } catch {}
}

// A `crediting` record older than this is not "in flight", it is wreckage: the
// process died between the intent and the money, and only a human can say
// whether the meter moved. Generous enough that a slow credit is never mistaken
// for a crashed one.
const STUCK_CREDITING_MS = 5 * 60 * 1000;

/**
 * A crash between the credit intent and the credit itself.
 *
 * This is the state chunk 1 deliberately creates, described at the time as
 * reading "a human must check" — but nothing read it. It was counted only among
 * open 0-conf credits, which deliberately do not degrade health, so the ONE
 * state that is not bounded by the 2 VRSC tier (it applies to the 6-confirmation
 * >10 VRSC path too) was the least visible thing in the file.
 */
function _isStuckCrediting(r, now = Date.now()) {
  if (!r || !r.crediting || r.resolvedAt) return false;
  const at = Date.parse(r.intentAt || '');
  return !Number.isFinite(at) || (now - at) >= STUCK_CREDITING_MS;
}

function _stuckCreditingReason(r) {
  return `credit intent recorded ${r.intentAt} but never finalized — ${r.amount} VRSC ` +
    `for ${r.buyerVerusId} may or may not have reached the meter`;
}

/** Unresolved means a human still has to decide. Resolving stamps `resolvedAt`. */
function _isUnresolvedAnomaly(r, now = Date.now()) {
  if (!r || r.resolvedAt) return false;
  return !!r.needsOperator || _isStuckCrediting(r, now);
}

// /health is polled continuously and a deposits file can hold a thousand records
// plus ten thousand dedup txids, so re-parsing on every hit would be a real cost
// for data that changes at most once a minute. Keyed on the file's mtime+size:
// unchanged file, no re-parse; changed file, no stale answer.
const _anomalyCache = new Map(); // agentId -> { mtimeMs, size, value }

/**
 * Everything an operator needs to see about one agent's deposits, from disk.
 *
 * Pure read: opens no session, touches no network, writes nothing. Safe to call
 * from a second process while the daemon runs, which is what `deposits list`
 * does.
 */
function listDepositAnomaliesForAgent(agentId) {
  const p = depositsPath(agentId);
  let st = null;
  try { st = fs.statSync(p); } catch { st = null; }
  if (!st) return { agentId, open: [], reversed: [], needsOperator: [] };

  const hit = _anomalyCache.get(agentId);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;

  const d = loadDeposits(agentId);
  const open = d.processed
    .filter((r) => r && (r.unconfirmed || r.crediting))
    .map((r) => ({
      txid: r.txid,
      buyerVerusId: r.buyerVerusId || null,
      amount: r.amount ?? null,
      state: r.crediting ? 'crediting' : 'unconfirmed',
      misses: r.misses || 0,
      creditedAt: r.creditedAt || r.intentAt || null,
    }));

  const needsOperator = [
    ...d.processed.filter((r) => _isUnresolvedAnomaly(r)).map((r) => ({
      txid: r.txid,
      buyerVerusId: r.buyerVerusId || null,
      amount: r.amount ?? null,
      where: 'processed',
      reason: r.needsOperator || _stuckCreditingReason(r),
    })),
    ...d.reversed.filter((r) => _isUnresolvedAnomaly(r)).map((r) => ({
      txid: r.txid,
      buyerVerusId: r.buyerVerusId || null,
      amount: r.amount ?? null,
      where: 'reversed',
      reason: r.needsOperator,
    })),
  ];

  const reversed = d.reversed
    .slice(-25)
    .map((r) => ({
      txid: r.txid,
      buyerVerusId: r.buyerVerusId || null,
      amount: r.amount ?? null,
      reversedAt: r.reversedAt || null,
      debited: r.debited === true,
      restoredAt: r.restoredAt || null,
      restoring: r.restoring === true,
    }));

  const value = { agentId, open, reversed, needsOperator };
  _anomalyCache.set(agentId, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/**
 * Fleet-wide deposit anomalies plus the two scalars /health publishes.
 *
 * @param {string[]} agentIds
 */
function listDepositAnomalies(agentIds) {
  const agents = (agentIds || []).map((id) => listDepositAnomaliesForAgent(id));
  return {
    agents,
    summary: {
      deposits_unconfirmed_open: agents.reduce((n, a) => n + a.open.length, 0),
      deposits_needs_operator: agents.reduce((n, a) => n + a.needsOperator.length, 0),
    },
  };
}

/**
 * Poll pending deposits and credit any that have reached required confirmations.
 * Called periodically by the dispatcher's polling loop.
 *
 * @param agentId - Seller agent ID
 * @param client - Authenticated J41Client
 */
async function pollPendingDeposits(agentId, client, emit) {
  // Reconcile first. This is the only caller, so a 0-conf credit that never
  // lands is only ever clawed back from here — and unlike the pending sweep it
  // must run even when `pending` is empty, because a 0-conf credit is not
  // pending, it is already credited.
  //
  // The two halves take the lock SEPARATELY rather than sharing one hold. The
  // lock is not reentrant, so nesting them would deadlock the agent for the
  // full acquire timeout on every single poll.
  try {
    const r = await reconcileUnconfirmedDeposits(agentId, client, Date.now(), emit);
    // The commit that added this claimed it "reports inert-no-flag rather than
    // doing so silently". It did not: the state was returned and discarded, so
    // an inert reconciler looked exactly like a working one — the precise
    // failure the fail-closed design is supposed to avoid. Log it, once per
    // transition, so a reconciler that has quietly stopped being able to act is
    // visible without reading the source.
    if (r && r.state && r.state !== "armed" && r.state !== "idle") {
      if (_lastReconcileState.get(agentId) !== r.state) {
        _lastReconcileState.set(agentId, r.state);
        console.warn(`[Deposits] ${agentId}: reconciler is ${r.state} — ` +
          (r.state === "inert-no-flag"
            ? "the backend does not advertise tx.status-notfound-code, so 0-conf credits will NOT be reconciled."
            : "the platform node is not reporting a trustworthy view; credits left standing."));
      }
    } else if (r && r.state) {
      _lastReconcileState.set(agentId, r.state);
    }
  } catch (e) {
    console.warn(`[Deposits] ${agentId}: reconcile pass failed (${e.message}) — credits left standing`);
  }

  try {
    return await withDepositLock(agentId, () => _pollPendingSweep(agentId, client));
  } catch (e) {
    if (e && e.code === 'DEPOSIT_LOCK_BUSY') return; // retried on the next tick
    throw e;
  }
}

async function _pollPendingSweep(agentId, client) {
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
        if (_hasCreditedTxid(fresh, dep.txid)) {
          continue; // already credited by another path
        }
        // Intent first, then the money — see _recordCreditIntent. Crediting
        // before the record meant a failed save left the deposit in `pending`
        // with a credited meter, and the very next poll tick credited it again.
        _recordCreditIntent(agentId, fresh, {
          txid: dep.txid,
          buyerVerusId: dep.buyerVerusId,
          amount: dep.amount,
          confirmations: txStatus.confirmations,
        });
        committed = true;
        creditDeposit(agentId, dep.buyerVerusId, dep.amount, dep.txid);
        _finalizeCredit(agentId, dep.txid);
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
        await pollPendingDeposits(agentInfo.id, agent._client || agent.client,
          (type, data) => { try { state.emitEvent?.(type, data); } catch {} });
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

module.exports = { STUCK_CREDITING_MS, reportDeposit, verifyDepositReport, pollPendingDeposits, reconcileUnconfirmedDeposits, listDepositAnomalies, listDepositAnomaliesForAgent, creditDepositAnomaly, dismissDepositAnomaly, reconcileMeterAgainstLedger, withDepositLock, _recheckReversals, _settleReversedForTxid, _classifyLookupFailure, _syncedView, RECONCILE_MIN_MISSES, RECONCILE_MISS_SPAN_MS, RECONCILE_MIN_ADVANCE_BLOCKS, REVERSAL_RECHECK_WINDOW_MS, REVERSAL_BUDGET_MAX_DEFAULT, PROCESSED_AUDIT_CAP, startDepositPoller, requiredConfirmations, notifyJ41DepositConfirmed, notifyJ41CreditLow, setNotifyContext, getNotifyContext, DEPOSIT_REPORT_MAX_AGE_MS };
