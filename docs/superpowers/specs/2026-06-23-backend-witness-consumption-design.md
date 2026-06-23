# Backend Witness/Payment Consumption — Design

**Date:** 2026-06-23
**Status:** Approved (design); pending implementation plan
**Components:** `@junction41/sovagent-sdk` (new verify + client methods → **2.10.0**) + `@junction41/dispatcher` (consume → **2.5.0**)
**Source:** J41 backend shipped the audit's 3 requests (`api.junction41.io`, commits 55002bc/7d4f83e/b6c7b72). This consumes them.

## Goal

Consume the three backend additions, each closing a residual gap from the 2026-06-22 audit:
- **① verify-payment `confirmedAmount`** → credit `min(expectedAmount, confirmedAmount)`.
- **② platform-witnessed job record** → build the on-chain VDXF `record.job` from `GET /v1/jobs/:id/witness`, **cryptographically verified before write**, instead of the container blob.
- **③a webhook `payload.id`** → dedup on the platform's per-event id.

Owner decisions: (1) **full crypto verify-before-write** for ②; (2) SDK ships as **2.10.0**, dispatcher pins it, dispatcher ships **2.5.0**.

## SDK changes (2.10.0)

### A. `VerifyPaymentResponse.confirmedAmount`
Add `confirmedAmount: number` to the `VerifyPaymentResponse` type (`src/client/index.ts:~2744`). No method change — `verifyPayment` already returns the raw `data`.

### B. `getJobWitness(jobId)` client method
```
GET /v1/jobs/:id/witness  (session auth; 409 NOT_WITNESSABLE unless job.status==='completed')
→ { data: { record: WitnessRecord, witness: WitnessBlock } }
```
Add the method + `WitnessRecord`/`WitnessBlock`/`JobWitnessResponse` types matching the doc shape (`record`: amount, buyerVerusId, completedAt, currency, jobHash, schemaVersion, sellerVerusId, serviceId, status; `witness`: schemaVersion, signedBy, signedByName, signature, signatureHeight, algorithm).

### C. `verifyWitness(record, witness, client)` — the crypto (centerpiece)
New module `src/identity/witness-verify.ts` exporting `async verifyWitness(record, witness, client): Promise<{ verified: boolean, reason?: string }>`:
1. `algorithm` must be `'verusid-signdata-sha256'` (else `reason: 'unsupported_algorithm'`).
2. Recompute the datahash: drop `witness` from the on-chain value (we receive `record` already without it), `canonical = JCS(record)` (json-canonicalize, already a dep), `datahash = sha256(canonical)` hex.
3. Verify the **signdata** signature `witness.signature` over `datahash` for identity `witness.signedBy` at `witness.signatureHeight`:
   - Fetch the signer identity's signing addresses via `client.getIdentityKeys(witness.signedBy)` (already exists; returns the identity's primary R-addresses; has its own mainnet provenance guard).
   - Verify the `CIdentitySignature` over the datahash using the same `@bitgo/utxo-lib` `IdentitySignature` primitive `signChallenge` uses (`src/identity/verus-sign.ts`) — implement the **verify counterpart** (recover signer address(es) from the signature over the Verus signdata hash and check membership in the identity's primary addresses, honoring `minimumsignatures`).
   - Chain id / network from the client config (mirror `signChallenge`'s `DEFAULT_VERUS_CHAINID` handling).
4. Return `{verified:true}` only on a real cryptographic match; else `{verified:false, reason}`.

**Test strategy (mandatory — security-critical):**
- **Golden vector:** a REAL `(record, witness)` from the deployed testnet backend (fetched from a completed job, or supplied by the backend team) → `verifyWitness` returns `verified:true`; tamper any `record` field → `verified:false`; tamper the signature → `verified:false`. A self-round-trip (sign locally, verify locally) is NOT sufficient alone — it can pass a wrong-but-self-consistent verifier. The golden vector is the acceptance gate.
- If no golden vector can be obtained at implementation time, the verifier ships **disabled-by-default-fail-open** (see dispatcher §F) and the task is flagged INCOMPLETE pending a vector — do NOT claim a working verifier without one.

### D. Build + release
`npm run build` (tsc → dist), `npm test`, bump `2.9.0 → 2.10.0`, `npm publish`.

## Dispatcher changes (2.5.0)

### E. ① Deposit credit clamp (`src/deposit-watcher.js:~290`)
`const confirmedAmount = Number(verification.confirmedAmount); const credited = Number.isFinite(confirmedAmount) ? Math.min(expectedAmount, confirmedAmount) : expectedAmount; creditDeposit(agentId, buyerVerusId, credited, txid);` — only ever on `verification.verified === true` (unchanged). Log when the clamp reduces the credit. (Backend already fails closed on underpayment; this is defense-in-depth.)

### F. ② Witnessed record.job (`src/broker-executors.js` `jobCompletionUpdateExecutor`)
Rebuild so the on-chain `record.job` comes from the witness, verified, not the container:
1. On completion, `const { record, witness } = (await client.getJobWitness(jobId)).data`.
2. `const v = await verifyWitness(record, witness, client);`
   - `verified` → write `record.job = { ...record, witness }` (byte-for-byte what the platform's own writer produces).
   - `!verified` → **fail-closed: refuse the on-chain write**, log `[witness] verification failed (${v.reason}) — refusing record.job write for ${jobId}`, surface an error. (Exception: a `J41_WITNESS_VERIFY=off` escape hatch logs a loud warn and writes-as-received — used only until the verifier is golden-vector-validated, and blocked on mainnet by the existing mainnet gate.)
3. The container-supplied `jobRecord` is NO LONGER the source for amount/currency/buyer/seller/status. Container-authored fields it legitimately owns (e.g. an artifact/delivery signature) move to a separate, clearly-namespaced sibling key (e.g. `record.agentAttestation`), never inside the witnessed `record`.
4. Cross-check (cheap belt-and-suspenders): assert the witnessed `record.jobHash`/`buyerVerusId`/`sellerVerusId` match the dispatcher's own `getJob(jobId)` before write; mismatch → fail-closed.

### G. ③a Webhook nonce prefers `payload.id` (`src/webhook-server.js:~343`)
The W7 code reads `payload.nonce`/`payload.eventId`; the platform sends `payload.id` (signed) + `X-J41-Event-Id` header. Prefer the signed body id: `const bodyId = payload && payload.id != null ? payload.id : (payload?.nonce ?? payload?.eventId ?? null); const eventId = (bodyId != null ? String(bodyId) : null) || req.headers['x-j41-event-id'] || null;` — i.e. signed `body.id` first, header as fallback. Keep the existing `checkAndRecordNonce` dedup.

### H. SDK pin + release
Bump dispatcher dep `@junction41/sovagent-sdk` `2.9.0 → 2.10.0`; rebuild yarn-link; full suite; bump dispatcher `2.4.0 → 2.5.0`; merge; publish.

## Error handling
- ① clamp is defense-in-depth; never credit on `verified:false`.
- ② fails CLOSED on verify failure or getJob cross-check mismatch (a bad/unverifiable witness must never reach the agent's permanent on-chain record). The `J41_WITNESS_VERIFY=off` hatch is mainnet-gated.
- `getJobWitness` 409 (not yet completed) → retry/skip per the existing completion flow; don't crash.

## Testing
- SDK: `verifyWitness` golden-vector tests (real backend witness) + tamper-negatives; `getJobWitness`/type unit where feasible; full SDK suite.
- Dispatcher: pure clamp helper + nonce-id-precedence as unit tests in `test/`; `broker-executors` witness path verified by `node --check` + a unit around the verify-gate decision (mock `verifyWitness`); full suite.
- The golden vector is the acceptance gate for the crypto verifier.

## Success criteria
- Deposits credit `min(expected, confirmed)`; webhooks dedup on `payload.id`.
- The on-chain `record.job` is the platform-witnessed record, cryptographically verified before write, container values no longer trusted; verify-failure fails closed.
- `verifyWitness` validated against a real backend witness vector (not just self-round-trip).
- SDK 2.10.0 + dispatcher 2.5.0 published; pins aligned; full suites green.
