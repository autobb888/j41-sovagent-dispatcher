# Backend Witness/Payment Consumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consume the backend's `confirmedAmount`, platform-witnessed job record, and webhook `payload.id` — with an offline (daemon-less) `verifyWitness` in the SDK.

**Architecture:** SDK 2.10.0 adds `confirmedAmount`, `getJobWitness`, and a pure-JS `verifyWitness` (utxo-lib `IdentitySignature.verifyHashOffline`, gated on a real backend golden vector). Dispatcher 2.5.0 then: clamps deposit credit to `min(expected,confirmed)`, dedups webhooks on `payload.id`, and rebuilds the on-chain `record.job` from the witness (verified fail-closed) instead of the container blob. SDK ships first; dispatcher pins it.

**Tech Stack:** SDK = TypeScript (tsc→dist), `node:test`/`tsx`, `@bitgo/utxo-lib`, `json-canonicalize`. Dispatcher = Node CJS, `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-23-backend-witness-consumption-design.md`
**Backend contract + golden vector:** the backend's integration doc (golden vector also at SDK `test/fixtures/witness-golden.json`).

---

## File Structure
- SDK `src/client/index.ts` — `VerifyPaymentResponse.confirmedAmount`; `getJobWitness` + witness types.
- SDK `src/identity/witness-verify.ts` (new) — `verifyWitness` (pure-JS, no daemon).
- SDK `src/index.ts` — export `verifyWitness` + witness types.
- SDK `test/witness-verify.test.ts` (new) + `test/fixtures/witness-golden.json` (present).
- Dispatcher `src/deposit-watcher.js` — credit clamp; new pure `src/deposit-credit.js` (clamp helper) + test.
- Dispatcher `src/webhook-server.js` — prefer `payload.id`.
- Dispatcher `src/broker-executors.js` — witnessed `record.job` build + verify gate.
- Dispatcher `package.json` — SDK pin + version.

---

## Task 1 (SDK): `confirmedAmount` on VerifyPaymentResponse
**Files:** `src/client/index.ts` (the `VerifyPaymentResponse` interface, ~line 2744).

- [ ] **Step 1:** Read the `VerifyPaymentResponse` interface. Add the field:
```ts
  confirmedAmount: number;
```
right next to `actualAmount`. (No method change — `verifyPayment` returns the raw `data`.)
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** Commit: `git commit -am "feat(sdk): add confirmedAmount to VerifyPaymentResponse"`.

---

## Task 2 (SDK): `getJobWitness(jobId)` client method + types
**Files:** `src/client/index.ts`.

- [ ] **Step 1:** Add the witness types (near the other response types):
```ts
export interface WitnessRecord {
  amount: number; buyerVerusId: string; completedAt: string; currency: string;
  jobHash: string; schemaVersion: number; sellerVerusId: string;
  serviceId: string | null; status: string;
}
export interface WitnessBlock {
  schemaVersion: number; signedBy: string; signedByName: string;
  signature: string; signatureHeight: number; algorithm: string;
}
export interface JobWitnessResponse { record: WitnessRecord; witness: WitnessBlock; }
```
- [ ] **Step 2:** Add the method (mirror the existing `getJob`/`verifyPayment` request style):
```ts
  async getJobWitness(jobId: string): Promise<{ data: JobWitnessResponse }> {
    return this.request<{ data: JobWitnessResponse }>('GET', `/v1/jobs/${encodeURIComponent(jobId)}/witness`);
  }
```
- [ ] **Step 3:** `npx tsc --noEmit` clean. Commit: `git commit -am "feat(sdk): add getJobWitness client method + witness types"`.

---

## Task 3 (SDK): `verifyWitness` — offline crypto (CENTERPIECE, golden-vector-gated)
**Files:** Create `src/identity/witness-verify.ts`, `test/witness-verify.test.ts`; export from `src/index.ts`. Fixture `test/fixtures/witness-golden.json` (present).

> This is the security-critical task. The signature is a **CIdentitySignature v2** blob (base64, starts `Ag…`, embeds the block height); VerusID signdata binds the height + a data prefix into the signed hash, so naive secp recovery over the raw datahash FAILS. Use `@bitgo/utxo-lib` `IdentitySignature` — the SAME primitive `src/identity/verus-sign.ts` `signChallenge` signs with (`signHashOffline`) — and its **`verifyHashOffline`** counterpart. NO daemon. The golden vector is the acceptance gate; if `verifyHashOffline` cannot reach `verified:true` on it, STOP and report BLOCKED — request the CIdentitySignature parsing details from the backend team (do not ship an unvalidated verifier).

- [ ] **Step 1 (Stage-1 gate — canonicalization): failing test.** `test/witness-verify.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import golden from './fixtures/witness-golden.json' assert { type: 'json' };
import { jcsDatahash } from '../src/identity/witness-verify.js';

test('jcsDatahash reproduces the backend JCS + datahash', () => {
  assert.equal(canonicalize(golden.record), golden._jcs);          // independent JCS check
  assert.equal(jcsDatahash(golden.record), golden._datahash);      // our helper
});
```
Run `npx tsx --test test/witness-verify.test.ts` → fails (no module).
- [ ] **Step 2:** Implement the canonicalization half in `src/identity/witness-verify.ts`:
```ts
import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
/** RFC8785 JCS over the record (which already excludes `witness`), then sha256 hex. */
export function jcsDatahash(record: object): string {
  return createHash('sha256').update(canonicalize(record), 'utf8').digest('hex');
}
```
Run → Stage-1 test passes. **Do not proceed until `jcsDatahash(golden.record) === golden._datahash`.**
- [ ] **Step 3:** Obtain the signer's primary address(es) for a self-contained Stage-2 test. The verifier needs `agentplatform@`'s primary R-address(es) to confirm the recovered signer. Run a ONE-TIME lookup against testnet and record it into the fixture as `_signerAddresses` (array): e.g. via a throwaway script using the SDK client `getIdentityKeys(golden.witness.signedBy)` against `https://api.junction41.io` (verustest), or `verus -chain=VRSCTEST getidentity <signedBy>` if a daemon is reachable. Add `"_signerAddresses": ["R..."]` to `test/fixtures/witness-golden.json`. If neither is reachable, report NEEDS_CONTEXT (ask the controller for the address).
- [ ] **Step 4 (Stage-2 gate — signature): failing test.** Add:
```ts
import { verifyWitness } from '../src/identity/witness-verify.js';
test('verifyWitness accepts the golden vector and rejects tampers', async () => {
  const client = { getIdentityKeys: async () => ({ data: { addresses: golden._signerAddresses, minimumsignatures: 1 } }) } as any;
  assert.equal((await verifyWitness(golden.record, golden.witness, client)).verified, true);
  const badRec = { ...golden.record, amount: golden.record.amount + 1 };
  assert.equal((await verifyWitness(badRec, golden.witness, client)).verified, false);
  const badWit = { ...golden.witness, signature: golden.witness.signature.replace(/.$/, 'A') };
  assert.equal((await verifyWitness(golden.record, badWit, client)).verified, false);
});
```
(Adapt the mock `getIdentityKeys` return shape to the REAL `getIdentityKeys` response — read `src/client/index.ts:705` first and match it exactly.)
- [ ] **Step 5:** Implement `verifyWitness` using utxo-lib. Study `src/identity/verus-sign.ts` `signChallenge` (how it builds `IdentitySignature` v2 + `signHashOffline`) and mirror it for verify:
```ts
import * as utxolib from '@bitgo/utxo-lib';
const IdentitySignature = (utxolib as any).IdentitySignature;
export async function verifyWitness(record: any, witness: any, client: any, network: 'verus'|'verustest' = 'verustest'): Promise<{ verified: boolean; reason?: string }> {
  try {
    if (witness?.algorithm !== 'verusid-signdata-sha256') return { verified: false, reason: 'unsupported_algorithm' };
    const datahash = jcsDatahash(record);                                  // hex
    const sigBuf = Buffer.from(witness.signature, 'base64');
    // Parse the CIdentitySignature v2 blob (carries the embedded blockHeight).
    const idSig = IdentitySignature.fromBuffer(sigBuf, /* network params — match signChallenge */ );
    // Resolve the signer identity's primary addresses (honor minimumsignatures).
    const idk = await client.getIdentityKeys(witness.signedBy);
    const addrs: string[] = /* extract from idk per the real shape */ [];
    // verifyHashOffline reconstructs the height/prefix-bound hash internally and
    // recovers/checks the signer against `addrs`. Settle the exact arg shape
    // (datahash hex vs Buffer; address vs pubkey; per-signature loop) against the
    // golden vector — iterate until Stage-2 passes.
    const ok = /* idSig.verifyHashOffline(Buffer.from(datahash,'hex'), ...) honoring minimumsignatures */ false;
    return ok ? { verified: true } : { verified: false, reason: 'signature_mismatch' };
  } catch (e: any) { return { verified: false, reason: `error:${e.message}` }; }
}
```
Iterate the utxo-lib call (arg shapes, chain id like `signChallenge`'s `DEFAULT_VERUS_CHAINID`) until the Stage-2 test passes on the golden vector AND both tampers return false. **If you cannot reach `verified:true` on the golden vector after genuine effort, STOP → BLOCKED with what you tried** (don't fake it).
- [ ] **Step 6:** Export from `src/index.ts`: `export { verifyWitness, jcsDatahash } from './identity/witness-verify.js';` and the witness types from the client. `npx tsc --noEmit` clean.
- [ ] **Step 7:** `npm test` (full SDK suite incl. the new tests). Commit: `git commit -am "feat(sdk): offline verifyWitness (utxo-lib, daemon-less) + golden-vector tests"`.

---

## Task 4 (SDK): build + release 2.10.0
- [ ] **Step 1:** `npm run build` (tsc → dist). `npm test` green.
- [ ] **Step 2:** Bump `package.json` `2.9.0 → 2.10.0`. Commit `chore(release): 2.10.0 — confirmedAmount, getJobWitness, offline verifyWitness`.
- [ ] **Step 3:** `npm publish`. Confirm live: `curl -s https://registry.npmjs.org/@junction41%2Fsovagent-sdk | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['dist-tags'].latest))"` → `2.10.0`.

---

## Task 5 (dispatcher): ① deposit clamp + ③a webhook payload.id
**Files:** new `src/deposit-credit.js` + `test/deposit-credit.test.js`; modify `src/deposit-watcher.js`, `src/webhook-server.js`. (Branch: continue on `feature/witness-consumption`.)

- [ ] **Step 1 (TDD ①):** `test/deposit-credit.test.js`:
```js
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { clampCredit } = require('../src/deposit-credit.js');
test('clampCredit takes min(expected, confirmed); falls back when confirmed missing', () => {
  assert.equal(clampCredit(10, 10), 10);
  assert.equal(clampCredit(10, 8), 8);          // confirmed lower → clamp
  assert.equal(clampCredit(10, undefined), 10); // missing → expected
  assert.equal(clampCredit(10, NaN), 10);
});
```
- [ ] **Step 2:** `src/deposit-credit.js`:
```js
'use strict';
function clampCredit(expectedAmount, confirmedAmount) {
  const c = Number(confirmedAmount);
  return Number.isFinite(c) ? Math.min(Number(expectedAmount), c) : Number(expectedAmount);
}
module.exports = { clampCredit };
```
Run the test → pass.
- [ ] **Step 3:** Wire into `src/deposit-watcher.js`: read `deposit-watcher.js:~204` where `verifyPayment` resolves and `:~290` `creditDeposit(agentId, buyerVerusId, expectedAmount, txid)`. Change to: `const credited = clampCredit(expectedAmount, verification.confirmedAmount);` and pass `credited` to `creditDeposit` (+ the notify/event amounts). Add `require('./deposit-credit.js')`. Log when `credited < expectedAmount`. Only on `verification.verified === true` (unchanged).
- [ ] **Step 4 (③a):** In `src/webhook-server.js` (~line 343) prefer the signed `payload.id`:
```js
    const bodyId = payload && payload.id != null ? payload.id
                 : (payload && payload.nonce != null ? payload.nonce
                 : (payload && payload.eventId != null ? payload.eventId : null));
    const eventId = (bodyId != null ? String(bodyId) : null) || req.headers['x-j41-event-id'] || null;
```
(Keep the existing `checkAndRecordNonce(String(eventId))` dedup below.)
- [ ] **Step 5:** `node --check src/deposit-watcher.js src/webhook-server.js src/deposit-credit.js`; `node --test test/*.test.js` (all pass). Commit: `git commit -am "feat(payment): clamp deposit credit to confirmedAmount; dedup webhooks on payload.id (①,③a)"`.

---

## Task 6 (dispatcher): ② witnessed record.job
**Files:** `src/broker-executors.js` (`jobCompletionUpdateExecutor`, ~line 70).

- [ ] **Step 1:** Read `jobCompletionUpdateExecutor` fully + how it gets the client (`getClient`) and writes the identity update. Read how `verifyWitness`/`getJobWitness` are imported elsewhere (lazy `require('@junction41/sovagent-sdk/dist/...')` per CLAUDE.md).
- [ ] **Step 2:** Rebuild the executor to source `record.job` from the witness (no container trust):
```js
const client = getClient(agentInfo);
const { record, witness } = (await client.getJobWitness(jobId)).data;
// belt-and-suspenders cross-check vs the dispatcher's own authoritative job
const job = await client.getJob(jobId);
for (const f of ['jobHash','buyerVerusId','sellerVerusId']) {
  if (String(record[f]) !== String(job[mapField(f)] ?? record[f]) /* map to getJob's field names — read Job type */) {
    throw new Error(`[witness] record/getJob mismatch on ${f} — refusing record.job write for ${jobId}`);
  }
}
const { verifyWitness } = require('@junction41/sovagent-sdk/dist/index.js');
const net = /* dispatcher network: 'verus'|'verustest' from config */;
const v = await verifyWitness(record, witness, client, net);
const allowOff = process.env.J41_WITNESS_VERIFY === 'off' && !IS_MAINNET; // break-glass, mainnet-gated
if (!v.verified && !allowOff) {
  throw new Error(`[witness] verification failed (${v.reason}) — refusing record.job write for ${jobId}`);
}
if (!v.verified && allowOff) console.warn(`[witness] J41_WITNESS_VERIFY=off — writing UNVERIFIED record.job for ${jobId}`);
const jobRecordToWrite = { ...record, witness };
// ...write jobRecordToWrite as the on-chain record.job (replace the container `jobRecord` source).
// Move any legitimately container-authored field to a namespaced sibling (e.g. record.agentAttestation), NOT inside the witnessed record.
```
Read the executor's existing on-chain write to wire `jobRecordToWrite` in place of the container `jobRecord`. Map `getJob`'s real field names (read the `Job` type) for the cross-check; if a field isn't on `getJob`, skip that field's check rather than crash.
- [ ] **Step 3:** `node --check src/broker-executors.js`. Add a focused unit test if the verify-gate decision can be isolated (mock `verifyWitness` true/false → write vs throw); otherwise verify by `node --check` + the final review. Run `node --test test/*.test.js`.
- [ ] **Step 4:** Commit: `git commit -am "feat(integrity): build on-chain record.job from verified platform witness, drop container trust (②)"`.

---

## Task 7 (dispatcher): pin SDK 2.10.0 + version 2.5.0
- [ ] **Step 1:** `package.json`: `"@junction41/sovagent-sdk": "2.10.0"`. Re-link/rebuild the yarn-linked SDK (`cd ../j41-sovagent-sdk && npm run build`) so local tests run against 2.10.0.
- [ ] **Step 2:** Bump dispatcher `2.4.0 → 2.5.0`.
- [ ] **Step 3:** `node --check src/*.js src/executors/*.js`; `node --test test/*.test.js` (all green against linked 2.10.0). Commit: `chore(release): dispatcher 2.5.0 — consume SDK 2.10.0 witness/confirmedAmount/nonce`.

---

## Task 8: final review + ship
- [ ] **Step 1:** Final whole-branch reviewer over `main..HEAD` (focus: ② fail-closed correctness, no container trust leak into the witnessed record, the clamp only-on-verified, payload.id precedence).
- [ ] **Step 2:** `superpowers:finishing-a-development-branch` → merge `feature/witness-consumption` → main → push.
- [ ] **Step 3:** `npm publish` dispatcher 2.5.0; confirm live. Update memory.

---

## Notes for implementers
- SDK is TypeScript shipping from `dist/` — `npm run build` after changes; dispatcher consumes the linked/published dist.
- `verifyWitness` (Task 3) is the gate: the golden vector MUST pass before the dispatcher relies on it. If it can't be made to pass, the whole ② chain stays behind `J41_WITNESS_VERIFY=off` and the task is BLOCKED pending backend parsing details — surface it, don't fake a passing verifier.
- Do NOT trust container-supplied job values for the witnessed record. Don't touch the HTTP control API.
