# Buyer lifecycle — design

**Date:** 2026-09-05
**Status:** implementing
**Against:** dispatcher `1e46c96` / npm `@junction41/dispatcher@2.37.1`
**Source:** tester `docs/buyer-lifecycle-dispatcher.md` + overlapping
holes in `docs/world-bootstrap-gap-report.md` (2026-09-05, buyer
`j41grokbuyer.agentplatform@` vs `api.junction41.io`).

Live money moved. Live work product did not. This spec is the dispatcher
half of pay / complete / review / buyer attestation / sequential-spend.

Must not regress: `start` refuse-before-accept on local without
`--dev-unsafe`; TUI Start cannot pass `--dev-unsafe`; job-image preflight;
`HOME_GPU_NO_DISK_QUOTA`; hire `fail()` exit 1; fee-tank LOW vs EMPTY;
`DATA_NOT_HIREABLE`; model hire still requires `api-endpoint`.

Companion first-run polish (doctor Darwin, listings default, TUI label,
register wait copy): `2026-09-05-world-bootstrap-polish-design.md`.

---

## What 2.37.1 already does

| Claim | Code | Keep |
|---|---|---|
| `hire <buyer> <seller> --amount --service --yes` creates a job | `cli.js` hire | yes |
| `hire … --pay` dual-output + `recordPaymentCombined` | `hire.js` `paymentOutputs` + `agent.sendMultiPayment` | yes, **share with `pay`** |
| Data listings refuse | `assertHireAllowed` `DATA_NOT_HIREABLE` | yes |
| Model listings refuse unless `serviceType === api-endpoint` | `MODEL_REQUIRES_API_ENDPOINT` | yes |
| Compute listings refuse unless `gpu-rental` | `COMPUTE_REQUIRES_GPU_RENTAL` | yes |
| Mainnet `--yes` without TTY needs `J41_HEADLESS_MAINNET_PAY=1` | hire action | apply to `pay` too |
| Seller inbox consumes `review` / `attestation` / `job_record` | `processInboxForAgent` | seller-only until backend emits buyer items |
| SDK `completeJob` / `submitReview` / `getJobWitness` | `@junction41/sovagent-sdk` | wrap, do not reimplement |
| `wallet-pending.json` 30 min fail-closed stamp | `loadWalletPending` / `saveWalletPending` / `resolveWalletPending` | **hire --pay does not call these today** |

## Live evidence (do not re-debug)

| Kind | Seller | jobId | Result |
|---|---|---|---|
| sovcompute | testgpu01@ | `423cd09c-8a1c-4785-b799-a25b461dcde6` | paid + seller delivered + buyer `completeJob` → **completed** |
| sovmodel | duskseek@ | `f46bf8be-205b-4070-81fa-6f9f87271b3e` | paid, still `requested`, 0 chat |
| sovmodel | moonkimi@ | `3262d626-0e9b-48e4-9b2a-3828898b17a0` | paid, still `requested`, 0 chat |
| sovdata | pippinapples@ | — | `DATA_NOT_HIREABLE` (correct) |

Second `--pay` in the same block: `Transaction rejected by the network`
until `wallet show` dropped spent UTXO `29058bcf…:0` (~70s). Platform fee
address on all pays: `RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2`.

`submitReview` after complete: `Refusing to sign platform-supplied bytes that do not start with J41-`. Platform first line is `Junction41 Review`, not `J41-REVIEW|…`. That is a **backend** bug. Dispatcher must keep the SDK fail-closed.

---

## Out of scope (not this spec)

- Frontend kind tabs empty vs `/v1/services?kind=` (website).
- Backend canonical review bytes (`J41-REVIEW|…`). CLI `review` ships fail-closed until they do.
- `GET /v1/me/privacy` 404.
- Buyer `request-access` / OpenAI-compatible `chat/completions` client. Model hires are metered api-endpoint, not labour. Separate spec later; this pass only stops implying labour delivery.
- Sovcompute SSH into `192.168.1.69:2222` (RFC1918, seller has no public tunnel). Cat-1 already requires a named TCP tunnel on the **seller**. Not a buyer CLI verb.
- `scripts/pay-jobs.js` env-WIF backfill. Do not tell operators to use it. Do not promote it.
- Self-writing `job.record` / `review.record` onto the buyer identity from locally built VDXF. Seller path is inbox passthrough + allowlist. Buyer gets the same **when the backend emits a buyer-directed inbox item**. Until then, print `getJobWitness`; do not invent a second writer.
- `privacy` becoming a buyer hire record. It stays seller deletion attestation.

---

## Order

1. Extract one pay path; stamp + honour `wallet-pending.json` on `hire --pay` and the new `pay` command (stops the double-spend).
2. `j41-dispatcher pay <buyer-id> <job-id>`.
3. Hire create-only / post-pay copy (no “pay later with --pay”; kind-specific next step).
4. `j41-dispatcher complete <buyer-id> <job-id>`.
5. `j41-dispatcher review <buyer-id> <job-id> --rating N` (fail-closed on non-`J41-`).
6. After `completed`, print verified `getJobWitness`. Do not write buyer VDXF in this pass.

Unpaid-accept / Darwin doctor / listings default live in the companion spec.

---

## 1. Shared pay path + pending stamp

**Bug.** `hire --pay` is the only money-broadcast site that does **not**
read or write `wallet-pending.json` (comment at hire action: spend gate is
`confirmHire` plus autonomous `gateExternalSend` only). `wallet send` /
`wallet sweep` stamp after broadcast and refuse while `isPendingBlocked`.
Platform UTXO view is confirmed-only, so a second `hire --pay` rebuilds
from the spent output and the network rejects it.

**Extract.** One helper used by hire `--pay` and `pay`:

```
planHirePayment({ job, amount, pending, now, force })
  → { ok, code, outputs, reason }
broadcastHirePayment({ agent, buyerId, job, outputs, autonomous, expectedRecipients })
  → { txid }
  stamps wallet-pending.json { txid, at, kind: 'hire-pay' } mode 0600
```

`outputs` stay `paymentOutputs(job, amount)` — dual seller + platform fee,
refuse doctored fee. Amounts stay the job’s decimal strings; do not
`parseFloat * 1e8`.

**Pending rules**

| State | Default | `--wait` | `--force` |
|---|---|---|---|
| no stamp | pay | pay | pay |
| stamp, `resolveWalletPending` still in flight | **refuse** `PAY_PENDING` (print txid + “wait for wallet show to drop it”) | CLI polls `resolveWalletPending` every 5s until clear or 180s, then pay or `PAY_WAIT_TIMEOUT`. Helper stays pure (refuse/allow). | pay (same as wallet `--force`) |
| stamp, tx confirmed / stamp dropped | pay | pay | pay |
| malformed stamp (`at` not a number) | refuse `PAY_PENDING` fail-closed | same refuse | pay |

Do **not** auto-wait without `--wait`. A script must not hang 70s.

After a successful broadcast, always `saveWalletPending`. `wallet show`
already prints the stamp when present; hire was silent so show looked empty.

`hire --pay` create-then-pay in **one** invocation is one spend. Two
invocations (two jobs, or pay-later) must hit the gate.

Malformed pending is already fail-closed in `loadWalletPending`. Reuse it.

---

## 2. `pay` command

```
j41-dispatcher pay <buyer-id> <job-id> [--yes] [--json] [--wait] [--force]
```

**Rules**

- Buyer keys: same as hire (`BUYER_NOT_FOUND` / `BUYER_NOT_REGISTERED`).
- `--json` requires `--yes` (same as hire).
- Load job via authenticated buyer client. Buyer identity must match
  `job.buyerVerusId` (qualified name or i-address). Else `PAY_NOT_BUYER`.
- Already `payment.verified` or `payment.status` in `{confirmed,completed}`
  → `PAY_ALREADY_PAID` (exit 1, no broadcast).
- Job status `cancelled` / `refunded` / `disputed` → `PAY_NOT_PAYABLE`.
- `paymentOutputs(job, job.amount)` — amount from the job record, not a
  new `--amount` flag (prevents paying a different price than create).
- Mainnet TTY / `J41_HEADLESS_MAINNET_PAY` identical to hire `--pay`.
- Autonomous (`--json` or headless mainnet): `gateExternalSend` with
  expected recipients from `getAgentPaymentAddress` + listing payaddress,
  never from `job.payment.address` alone (same as hire).
- Interactive without `--yes`: confirm “Broadcast dual payment of N for
  job <id>? This spends the buyer’s wallet. (y/N)”. Cancel → exit 0.
- Success: `recordPaymentCombined`, stamp pending, human line truncates
  txid to 16 chars, **JSON includes the full txid**.
- Fail paths `process.exitCode = 1` then `process.exit(1)` (hire `fail()`).

Do not accept a raw WIF. Do not pay from `scripts/pay-jobs.js`.

---

## 3. Hire copy

Create-only today prints: `Pay later with --pay, or from the website.`
There is no later `--pay` on an existing job. After this spec:

- Create-only: `Pay later: j41-dispatcher pay <buyer-id> <job-id> [--yes]`
  plus “or from the website”. Never “pay later with --pay”.
- After `--pay` / `pay`: `Wait until wallet show drops the spent UTXO
  before another pay (~one block). A second pay in this block will be
  refused (PAY_PENDING) or rejected by the network.`
- Kind `model`: `This is api-endpoint (metered inference), not a labour
  chat job. request-access / chat/completions is not a dispatcher verb yet.`
- Kind `compute`: `Seller delivers sealed SSH via getRentalAccess. This
  CLI does not open the jail. Seller must publish a public TCP tunnel,
  not RFC1918.`
- Kind `agent`: labour chat still requires the **seller** `start` + LLM.

---

## 4. `complete` command

```
j41-dispatcher complete <buyer-id> <job-id> [--yes] [--json]
```

Wraps SDK `agent.completeJob(jobId)` (signs `J41-COMPLETE|Job:<hash>|…`).

**Rules**

- Same buyer identity match as `pay`.
- Allowed only when job status is `delivered` (gpu-rental is delivered
  for the life of the lease; labour after seller deliver). Else
  `COMPLETE_NOT_DELIVERED` with current status.
- Already `completed` → `COMPLETE_ALREADY` exit 1, no second sign.
- `--json` requires `--yes`. Without `--yes`, confirm (y/N).
- After success, call `getJobWitness`. If 409 / not witnessable, print
  that witness lands after completed and retry `inspect` later. If
  present, print `signedByName` + jobHash. Do **not** identity-update.

---

## 5. `review` command

```
j41-dispatcher review <buyer-id> <job-id> --rating N [--message …] [--yes] [--json]
```

Wraps SDK `agent.submitReview`. Keep the SDK’s confused-deputy checks:
message must start with `J41-` and bind `jobHash` + rating. Do not
locally rewrite `Junction41 Review` into `J41-REVIEW|`.

**Rules**

- `--rating` integer 1–5. Else `REVIEW_BAD_RATING`.
- Job must be `completed` (same live constraint as the tester). Else
  `REVIEW_NOT_COMPLETED`.
- Buyer identity match as `pay`.
- On SDK `do not start with J41-`: map to `REVIEW_NOT_CANONICAL`, exit 1,
  human text: `Platform review bytes are not J41-…; backend must emit
  J41-REVIEW|. Review on the website or retry after that fix. Dispatcher
  will not sign Junction41 Review.`
- `--json` requires `--yes`.

Until the backend ships the prefix, this command is a **loud refusal**,
not a workaround. That is the feature.

---

## 6. Buyer identity attestation (this pass = read, not write)

Seller inbox already understands:

| VDXF | i-address | Who writes it today |
|---|---|---|
| `review.record` | `iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad` | seller inbox, accepted review |
| `review.attestation` | `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv` | seller inbox type `attestation` |
| `job.record` | `iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn` | seller inbox type `job_record` (witness-gated) |

Buyer `getIdentityRaw` after finalize: profile keys only. Inbox
`type=review,attestation,job_record` was `[]`. `getAttestations(buyer)`
was `[]`. `getJobWitness` works after `completed` and is not copied onto
the buyer identity.

**This pass**

- After `complete`, print the witness (section 4).
- Do not call `buildIdentityUpdateTx` to stuff `job.record` onto the
  buyer. That bypasses the seller `verifyInboxJobRecord` gate and the
  inbox pending-write batch.
- When the backend later emits a **buyer-directed** inbox item with the
  same types, reuse `processInboxForAgent` on the buyer identity (same
  allowlist + job_record witness gate). That is a follow-on spec, gated
  on backend inbox. Not this pass.

`privacy` stays seller deletion proof. Do not document it as a hire record.

---

## TUI

Hire screen already creates + optional pay. After extract, TUI pay
**must** use the shared helper (pending gate included). This pass is
CLI-only for `complete` and `review` — no new TUI screens.

Do not add a TUI “Pay twice” affordance.

---

## Tests (pin before wiring if the helper is new)

- `planHirePayment` refuses when `isPendingBlocked`; `--force` passes.
- `broadcastHirePayment` writes `wallet-pending.json` 0600 `{txid,at,kind:'hire-pay'}`.
- `pay` on already-verified payment → `PAY_ALREADY_PAID`, no send.
- `pay` as the wrong buyer → `PAY_NOT_BUYER`.
- `pay --json` without `--yes` → `JSON_REQUIRES_YES`.
- Hire create-only stdout does not contain `Pay later with --pay`.
- `complete` on `requested` → `COMPLETE_NOT_DELIVERED`.
- `review` with platform bytes `Junction41 Review…` → `REVIEW_NOT_CANONICAL`,
  no sign (mock `getReviewMessage`).
- `review` with `J41-REVIEW|…` binding jobHash+rating → signs (mock).
- Hire fail paths still exit 1.

No live chain in unit tests. No WIFs in fixtures.

---

## Operator copy until backend review prefix exists

- Pay at create: `hire … --pay --yes` **once**, or `pay` later. Wait for
  `wallet show` to drop the spent UTXO (or rely on `PAY_PENDING`).
- Complete from CLI after `delivered`.
- Review: website, or wait for `J41-REVIEW|`. Dispatcher will refuse
  `Junction41 Review`.
- Buyer on-chain hire attestation is not a dispatcher write yet; witness
  is printable after complete.
