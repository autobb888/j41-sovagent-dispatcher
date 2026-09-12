# Deposit sender match + access nonce replay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the Mac retest, make `deposit --wait` credit the proxy meter when the buyer spent from their primary R, and let `access` retry with a new nonce / refresh a stale NVIDIA grant without `NONCE_REPLAY`.

**Architecture:** Seller `reportDeposit` already calls platform `verifyPayment({ expectedSender: buyerVerusId })`. Live `tx.sender-verification` treats the vin as the i-address string, so an R-primary spend from that same VerusID is `SENDER_MISMATCH`. Accept a vin that is any **primary R** of the claiming identity (`getIdentityKeys`). Buyer still `sendMultiPayment` to the **seller i-address**; we do not invent i-address UTXOs. Access: record nonce only after signature verify (v1 today records inside `verifyAccessRequest`); buyer maps `NONCE_REPLAY` and refreshes stale NVIDIA grants from listing `publicUrl` without a second `requestApiAccess` when health is a dispatcher.

**Tech Stack:** Node 20, existing `src/deposit-watcher.js`, `src/buyer-deposit.js`, `src/buyer-access.js`, `src/cli.js`, `src/nonce-cache.js`, SDK 2.16.1 `verifyPayment` / `getIdentityKeys`.

**Spec:** `docs/backend-responses/2026-09-12-mac-buyer-retest.md` + `docs/superpowers/specs/2026-09-06-buyer-lifecycle-2.37.4-design.md` §3 (deposit) and access/chat.

**Evidence:** Mac live 2026-09-12, integrate `8518d2a`, buyer `j41grokbuyer.agentplatform@`. Deposit txid `4c288327e61db9a955c5c38b0a3f9b4b72447a8f71fba899e4cef5140e11b16d` then seller `SENDER_MISMATCH`. duskseek chat 402. moonkimi grant still NVIDIA; `access` `NONCE_REPLAY`.

## Global Constraints

- Build on `execute-plan/ca3106a1-integrate`. Do not merge `main`. Do not npm. Do not claim reviews.
- Never print WIFs, minted apiKeys, NVIDIA keys. Do not copy `~/.j41`.
- `wallet send` stays fleet-only. Deposit destination stays **seller i-address**.
- Do not homemade `J41-REVIEW|Session:`. Do not bump `package.json` in these fix tasks (ship task later).
- This box builds; GPU Mac retests. TDD on this box; live retest is not this plan's execute.

**Out of scope (not dispatcher, or not this PR):** backend `Agent:undefined`/`Job:undefined` on GET with dummy ids; GPU listing Offline; labour `requested` because dt3worker2 never accepted; npm 2.37.4 bump (after Mac retest of 1–2).

## File map

- `src/deposit-watcher.js` — sender match via primary R-addresses
- `test/deposit-zeroconf-reconcile.test.js` or new `test/deposit-sender-match.test.js`
- `src/cli.js` — v1 access nonce after verify; deposit fail still unlinks pending on confirmations
- `src/buyer-access.js` — map `NONCE_REPLAY`; NVIDIA grant rewrite without `requestApiAccess`
- `test/buyer-access.test.js`
- `src/buyer-deposit.js` / CLI rind — surface `SENDER_MISMATCH` with txid, do not pretend credited
- `test/buyer-deposit.test.js`

---

### Task 1: Seller deposit accepts buyer primary R as sender

**Files:**
- Modify: `src/deposit-watcher.js` (`_reportVerifiedDeposit` sender block ~387–422)
- Test: `test/deposit-sender-match.test.js` (new)

**Interfaces:**
- Consumes: `client.verifyPayment`, `client.getIdentityKeys(buyerVerusId)` → `{ primaryAddresses: string[] }`
- Produces: `senderMatchesBuyer({ vinAddress, buyerVerusId, keys })` → boolean. Credit proceeds if vin is buyer i-address **or** a primary R of that identity.

Live: vin is buyer R (`RE4dzh…`), claim is `j41grokbuyer@` / `iDdjzsh…`. Platform may set `verified: false` `reason: sender_mismatch` **or** `senderVerified: false`.

- [ ] **Step 1: Write failing tests**

```javascript
test('primary R of claiming VerusID is not SENDER_MISMATCH', async () => {
  // verifyPayment returns verified:false reason sender_mismatch
  // getIdentityKeys(buyerVerusId) returns { primaryAddresses: ['REbuyerPrimary'] }
  // vin/sender address in verification is REbuyerPrimary
  // reportDeposit must credited:true (or not code SENDER_MISMATCH)
});

test('unrelated R stays SENDER_MISMATCH', async () => {
  // primaryAddresses: ['REbuyerPrimary'], vin Rstranger → SENDER_MISMATCH, not credited
});
```

- [ ] **Step 2: Run tests — expect FAIL** (`SENDER_MISMATCH` on the primary-R case)

Run: `node --test test/deposit-sender-match.test.js`

- [ ] **Step 3: Implement**

In `_reportVerifiedDeposit`, after `verifyPayment`:

If reason is `sender_mismatch` **or** `senderVerified === false`, load `getIdentityKeys(buyerVerusId)`. Collect primary R-addresses (and i-address if present). If `verification.senderAddress` / `verification.from` / vin field is in that set (case-sensitive R, or normalized i-address), treat as matched and continue credit (still require `expectedAddress` payAddress and amount). If keys empty or vin not in set, keep `SENDER_MISMATCH`.

Do **not** set `J41_DEPOSIT_ALLOW_AUTH_ONLY`. Do not credit if `verifyPayment` failed for amount/address.

If the SDK only returns `reason: sender_mismatch` without the vin, pass `expectedSender` as the first primary R **and retry once**, or pass both identity and R if the SDK field allows an array. Prefer one `verifyPayment` plus local R-set check using whatever address field the live payload already has (`senderAddress`, `sender`, `fromAddress`). Pin the field name from a fixture copied from the Mac error JSON if present; otherwise accept those three names.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/deposit-watcher.js test/deposit-sender-match.test.js
git commit -m "fix: credit deposit when vin is buyer primary R not i-address"
```

---

### Task 2: Deposit CLI — SENDER_MISMATCH is loud; stamp unlinks on confirmations

**Files:**
- Modify: `src/cli.js` deposit action (~3895–3920)
- Modify: `src/buyer-deposit.js` if the wait helper swallows seller 403
- Test: `test/buyer-deposit.test.js`

**Interfaces:**
- Consumes: Task 1 seller codes
- Produces: JSON `{ ok: false, code: 'SENDER_MISMATCH', txid, credited: false }` exit 1. `waitWalletPendingUnlink` still runs so `wallet-pending.json` does not sit after a confirmed spend.

- [ ] **Step 1: Failing test** — report 403 `SENDER_MISMATCH` after broadcast → CLI not `{ ok: true, credited: true }`; pending file unlinked when `getTxStatus` confirmations > 0.

- [ ] **Step 2: Run — FAIL** (today stamp remains)

- [ ] **Step 3: After broadcast, always `waitWalletPendingUnlink` (same as hire `--wait`). On seller `SENDER_MISMATCH`, fail with txid. Do not `--force` a second send of the same amount.**

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit** `fix: deposit SENDER_MISMATCH keeps txid; unlink pending on confirmations`

---

### Task 3: v1 access records nonce only after verify

**Files:**
- Modify: `src/cli.js` v1 branch ~6276–6285
- Test: existing access/nonce tests or `test/nonce-cache.test.js` + discovery test if one drives `isReplay`

**Interfaces:**
- Consumes: `checkNonceAfterVerify` (already used on v2)
- Produces: v1 `verifyAccessRequest` **must not** call `checkAndRecordNonce` inside `isReplay`. Pass `isReplay: (nonce) => seen.has(nonce)` (lookup only), then `checkNonceAfterVerify(true, nonce, …)` after `verified === true`.

Today v1 `isReplay` **records** on first sight, so a failed verify burns the nonce; a retry should use a new nonce. Live still said `NONCE_REPLAY` on a new nonce — also map platform errors in Task 4. This task stops burning nonces on the seller process.

- [ ] **Step 1: Test** — first v1 verify failure does not make a **second** envelope with a **new** nonce return replay.

- [ ] **Step 2: FAIL** if current `isReplay` records

- [ ] **Step 3: Lookup-only isReplay + checkNonceAfterVerify after verified**

- [ ] **Step 4: PASS**

- [ ] **Step 5: Commit** `fix: v1 access nonce recorded only after signature verifies`

---

### Task 4: Buyer access — map NONCE_REPLAY; rewrite NVIDIA grant without re-access

**Files:**
- Modify: `src/buyer-access.js` `requestAndOpenAccess`, `chatCompletions` / grant refresh
- Test: `test/buyer-access.test.js`

**Interfaces:**
- Consumes: PR 8 `resolveListingDispatcherBase`, `isDispatcherProxyBase`
- Produces: `errorCode` maps `Nonce already used` / platform `NONCE_REPLAY` → `{ ok: false, code: 'NONCE_REPLAY', message }`. Chat/deposit on a saved NVIDIA `/v1` grant: **do not** call `requestApiAccess`; rewrite from listing website/endpoints after `/j41/health` `service===dispatcher`. Failure: `ACCESS_GRANT_UPSTREAM`, file unchanged.

Mac: moonkimi disk grant is NVIDIA (2026-09-06). Fresh `access` hit `NONCE_REPLAY`, so they never rewrote. Chat should not need a new access if the listing has a dispatcher public URL.

- [ ] **Step 1: Tests**

```javascript
test('requestAndOpenAccess maps Nonce already used to NONCE_REPLAY');
test('NVIDIA saved grant + listing dispatcher health rewrites endpointUrl without requestApiAccess');
test('NVIDIA grant + listing health fail does not call requestApiAccess and does not overwrite file');
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Implement mapping + chat/deposit path already in PR 8; if `access` CLI always hits `requestApiAccess`, skip it when `loadAccessGrant` exists and listing rewrite succeeds (`j41-dispatcher access` becomes refresh).**

- [ ] **Step 4: PASS** focused `buyer-access` tests

- [ ] **Step 5: Commit** `fix: NONCE_REPLAY mapped; refresh NVIDIA grants from listing without re-access`

---

### Task 5: Push integrate; Mac retest only (no npm)

**Files:** none on this box except the GH push

- [ ] **Step 1:** `git push origin execute-plan/ca3106a1-integrate`
- [ ] **Step 2:** GPU Mac: `git pull`, `node src/cli.js` (not npm 2.37.3)
- [ ] **Step 3:** Retest duskseek `deposit --wait` then `chat` (expect credit, not 402). Retest moonkimi `chat` against old NVIDIA grant (expect rewrite or `ACCESS_GRANT_UPSTREAM`, not `NONCE_REPLAY` for chat). `access` retry with a new process still allowed.
- [ ] **Step 4:** Bump `package.json` to 2.37.4 **only after** that retest, in a separate ship commit. Changelog: do not claim reviews shipped.

---

## Spec coverage

- Deposit credit despite R-primary vin — Task 1–2
- Access replay / stale NVIDIA — Task 3–4
- Wallet leftover after failed report — Task 2
- Version lie 2.37.3 — Task 5 after retest
- Labour never accepted / GPU offline / backend `Agent:undefined` — out of scope
