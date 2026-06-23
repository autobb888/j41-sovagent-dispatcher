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

Owner decisions: (1) ② adds **offline (daemon-less) crypto verification in the SDK** — a pure-JS `verifyWitness` built on `@bitgo/utxo-lib` `IdentitySignature.verifyHashOffline` (the verify counterpart to the `signHashOffline` the SDK already signs with), so the dispatcher verifies the witness signature **with no verusd anywhere**, then writes fail-closed. Validated against the backend golden vector. (2) SDK ships as **2.10.0**, dispatcher pins it, dispatcher ships **2.5.0**.

## SDK changes (2.10.0)

### A. `VerifyPaymentResponse.confirmedAmount`
Add `confirmedAmount: number` to the `VerifyPaymentResponse` type (`src/client/index.ts:~2744`). No method change — `verifyPayment` already returns the raw `data`.

### B. `getJobWitness(jobId)` client method
```
GET /v1/jobs/:id/witness  (session auth; 409 NOT_WITNESSABLE unless job.status==='completed')
→ { data: { record: WitnessRecord, witness: WitnessBlock } }
```
Add the method + `WitnessRecord`/`WitnessBlock`/`JobWitnessResponse` types matching the doc shape (`record`: amount, buyerVerusId, completedAt, currency, jobHash, schemaVersion, sellerVerusId, serviceId, status; `witness`: schemaVersion, signedBy, signedByName, signature, signatureHeight, algorithm).

### C. `verifyWitness(record, witness, client)` — offline crypto (centerpiece, daemon-less)
New module `src/identity/witness-verify.ts` exporting `async verifyWitness(record, witness, client): Promise<{ verified: boolean, reason?: string }>`:
1. `algorithm` must be `'verusid-signdata-sha256'` (else `reason: 'unsupported_algorithm'`).
2. Recompute the datahash: drop `witness` from the on-chain value (we receive `record` already without it), `canonical = JCS(record)` (json-canonicalize, already a dep), `datahash = sha256(canonical)` hex.
3. Verify the **signdata** signature `witness.signature` over `datahash` for identity `witness.signedBy` at `witness.signatureHeight`. **IMPORTANT (per backend):** the signature is a **CIdentitySignature v2 blob** (base64, starts `Ag…`, embeds the block height) — NOT a bare recoverable secp256k1 sig — and VerusID signdata binds the height + a data prefix into the actually-signed hash. Do NOT hand-roll secp recovery over the raw datahash. **This box is daemon-less** (no verusd — signing is pure-JS via `@bitgo/utxo-lib`), so the backend's "call `verifysignature` RPC" path does NOT apply here. Use the utxo-lib primitive instead:
   - `@bitgo/utxo-lib` `IdentitySignature` (already a dep; `signChallenge` in `src/identity/verus-sign.ts` uses its `signHashOffline`) exposes the verify counterpart **`verifyHashOffline`** (+ `fromBuffer`). That primitive reconstructs the height/prefix-bound hash internally — it is the correct daemon-less verifier.
   - Parse: `IdentitySignature.fromBuffer(Buffer.from(witness.signature,'base64'))` (carries the embedded blockHeight, e.g. 1117351).
   - Fetch the signer identity's primary address(es) via `client.getIdentityKeys(witness.signedBy)` (exists; mainnet provenance-guarded), honoring `minimumsignatures`.
   - `verifyHashOffline(datahash, <signer address/pubkey>)` against the identity's primary addresses; chain id from client config (mirror `signChallenge`'s `DEFAULT_VERUS_CHAINID`). The exact arg shape (address vs recovered-pubkey) is settled empirically against the golden vector.
4. Return `{verified:true}` only on a real cryptographic match; else `{verified:false, reason}`.

**Golden vector (acceptance gate — supplied by backend, real testnet 2026-06-23):** stored at `test/fixtures/witness-golden.json`. Two-stage gate:
- **Stage 1 (canonicalization):** `JCS(record)` must equal the exact bytes `{"amount":2.5,"buyerVerusId":"i9zVRJfR62cPyjL4HB9pUbRbqtba1kVCEL","completedAt":"2026-06-23T12:00:00.000Z","currency":"VRSCTEST","jobHash":"a1b2c3d4e5f600112233445566778899","schemaVersion":1,"sellerVerusId":"i7xKUpKQDSriYFfgHYfRpFc2uzRKWLDkjW","serviceId":null,"status":"completed"}` and `sha256` to `3d49adad930600dfaee905f4bbe584049318c3301094c615c4a39a10c0bc4830`. Build + pass THIS first — isolates canonicalization bugs.
- **Stage 2 (signature):** `verifyWitness(record, witness)` → `verified:true` for `signedBy=i7xKUpKQDSriYFfgHYfRpFc2uzRKWLDkjW`, signature `AgWnDBEAAUEgQ+tTkV2rib0pFwzauBFheOZvy6J/gx8aUu883rxwyWZOUmAOMjUa+U16yql+m8TRzQmNbLorgDKZtj4lTHqFpw==`, height `1117351`. Tamper any `record` field → `verified:false`; tamper the signature → `verified:false`.
- A self-round-trip alone is NOT sufficient (it can pass a wrong-but-self-consistent verifier). **Stage 2 against the golden vector is the acceptance gate.** If `verifyHashOffline` can't reach `verified:true` on the golden vector, request the CIdentitySignature parsing details from the backend team before shipping — do NOT claim a working verifier without the golden vector passing.

### D. Build + release
`npm run build` (tsc → dist), `npm test` (incl. the golden-vector tests), bump `2.9.0 → 2.10.0`, `npm publish`.

## Dispatcher changes (2.5.0)

### E. ① Deposit credit clamp (`src/deposit-watcher.js:~290`)
`const confirmedAmount = Number(verification.confirmedAmount); const credited = Number.isFinite(confirmedAmount) ? Math.min(expectedAmount, confirmedAmount) : expectedAmount; creditDeposit(agentId, buyerVerusId, credited, txid);` — only ever on `verification.verified === true` (unchanged). Log when the clamp reduces the credit. (Backend already fails closed on underpayment; this is defense-in-depth.)

### F. ② Witnessed record.job (`src/broker-executors.js` `jobCompletionUpdateExecutor`)
Rebuild so the on-chain `record.job` comes from the platform witness, cryptographically verified offline, not the container:
1. On completion, `const { record, witness } = (await client.getJobWitness(jobId)).data`.
2. `const v = await verifyWitness(record, witness, client);` (SDK §C — offline, no daemon).
   - `verified` → write `record.job = { ...record, witness }` (byte-for-byte what the platform's own writer produces, so on-chain readers can independently re-verify).
   - `!verified` → **fail-closed: refuse the on-chain write**, log `[witness] verification failed (${v.reason}) — refusing record.job write for ${jobId}`, surface an error. (Escape hatch `J41_WITNESS_VERIFY=off` → loud warn + write-as-received, blocked on mainnet by the existing mainnet gate; intended only as an operational break-glass, not the default.)
3. **Cheap belt-and-suspenders cross-check:** also assert the witnessed `record.jobHash`/`buyerVerusId`/`sellerVerusId` match the dispatcher's own `getJob(jobId)` before write; mismatch → fail-closed. (Catches a valid-but-wrong-job witness independent of the signature check.)
4. The container-supplied `jobRecord` is NO LONGER the source for amount/currency/buyer/seller/status. Container-authored fields it legitimately owns (e.g. an artifact/delivery signature) move to a separate, clearly-namespaced sibling key (e.g. `record.agentAttestation`), never inside the witnessed `record`.
5. `getJobWitness` 409 (job not yet `completed`) → skip/retry per the existing completion flow; don't crash.

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
