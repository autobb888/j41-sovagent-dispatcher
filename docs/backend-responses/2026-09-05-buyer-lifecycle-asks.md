# Dispatcher → backend: what we need from the 2026-09-05 buyer / bootstrap run

**Date:** 2026-09-05
**From:** dispatcher (`@junction41/dispatcher@2.37.1`, SDK `@junction41/sovagent-sdk@2.16.1`)
**To:** Junction41 backend (you said you are already fixing — this is the contract we will code against)
**Live surface:** `api.junction41.io` (verustest)
**Buyer:** `j41grokbuyer.agentplatform@` / `iDdjzshM51SLccyKcVvfpLZ1zaa2mW8gCW`

We reviewed the tester docs and wrote two dispatcher specs. We will implement
our half. **This file is only the platform half.** Please confirm or correct
each numbered ask before you ship, so we do not wrap the wrong shape.

Dispatcher specs (our work, not yours):

- `docs/superpowers/specs/2026-09-05-buyer-lifecycle-design.md`
- `docs/superpowers/specs/2026-09-05-world-bootstrap-polish-design.md`

Tester evidence (same day): compute job `423cd09c-8a1c-4785-b799-a25b461dcde6`
paid + completed; model jobs `f46bf8be-…` (duskseek) and `3262d626-…`
(moonkimi) paid, still `requested`; data listing correctly `DATA_NOT_HIREABLE`.

We do **not** have the tester’s companion `j41-backend-buyer-attestation.md`.
If that doc disagrees with this one, send it and we will reconcile.

---

## What we will do ourselves (do not duplicate)

| Item | Our plan |
|---|---|
| `j41-dispatcher pay` for jobs created without `--pay` | New CLI. Same dual-output as `hire --pay`. |
| Sequential `hire --pay` double-spend | Stamp `wallet-pending.json` and refuse `PAY_PENDING`. We will not wait on your UTXO view to become mempool-aware before shipping that gate. |
| `j41-dispatcher complete` | Wrap SDK `completeJob` (`J41-COMPLETE\|Job:<hash>\|…`). Already worked live via SDK on the compute job. |
| `j41-dispatcher review` | Wrap SDK `submitReview`. **Fail-closed** until your review bytes start with `J41-`. We will not locally rewrite `Junction41 Review`. |
| Darwin doctor / listings default 20 / TUI “View listings” | Dispatcher-only copy and defaults. |
| Register wait copy + 3× retry on 400 | Workaround. Your 409 (ask 2) is still the real fix. |
| Never start a jail/container on unpaid `accepted` | Dispatcher `isPaid` gate. Stacked **accept** without pay stays allowed. |
| Buyer on-chain `job.record` / `review.record` | We will **not** `buildIdentityUpdateTx` those keys onto the buyer. Seller path is inbox passthrough + allowlist. Buyer gets the same only if you emit buyer-directed inbox items (ask 3). Until then we print `getJobWitness`. |
| `GET /v1/me/privacy` | We do **not** need this. `privacy` CLI is seller deletion attestation on local job files. |
| Model `request-access` / OpenAI `chat/completions` buyer client | Later dispatcher spec. Not this pass. |
| Frontend Sign In / Hire / kind tabs | Not this repo. Listed under “bounce” if the empty tabs are your BFF. |

---

## BLOCKING — we cannot ship a working `review` CLI without this

### 1. Canonical review message must start with `J41-`

**Live (2026-09-05), after compute `423cd09c-…` reached `completed`:**

```
Refusing to sign platform-supplied bytes that do not start with J41-
```

`GET /v1/reviews/message` first line is `Junction41 Review`, not `J41-…`.

SDK 2.16.1 `submitReview` (this is load-bearing, not style):

1. `typeof message === 'string' && /^J41-/.test(message)` else refuse.
2. `message` must **include** the caller’s `jobHash` and `String(rating)`.
3. Buyer signs **those exact bytes**. We will not transform them.

Same confused-deputy gate as `createJob` (`getJobRequestMessage`). A
compromised platform that returns `J41-COMPLETE` / `J41-DEPOSIT-REPORT`
must not harvest a fund-loss signature from a review call. Binding
jobHash + rating is the defense; the `J41-` prefix is the cheap first
filter. **`Junction41 Review` fails the filter, so every agent signer is
dead**, not just our missing CLI.

**Please emit** (field order may vary; prefix and bound fields may not):

```
J41-REVIEW|Job:<jobHash>|Rating:<1-5>|Ts:<unix>|…
```

The rest of the line can carry the free-text message. Preferred prefix
is `J41-REVIEW|` so it cannot be mistaken for `J41-COMPLETE`. Any
`J41-…` prefix is accepted by the SDK **if** jobHash and rating are
embedded as substrings.

**Done when:** `GET /v1/reviews/message?agentVerusId=<seller>&jobHash=<hash>&rating=5`
returns a string whose first characters are `J41-`, containing that
hash and `5`. Re-run submitReview on job `423cd09c-…` (or a new
completed labour/compute job) and the SDK no longer throws the refuse
line above.

Do **not** ask us to special-case `Junction41 Review`. We will not.

---

## P1 — first-run and two-pays-in-one-block (strangers will hit these)

### 2. Fresh identity: `registerWithJ41` 400 `Invalid request format`

Mint then immediately `POST` profile → 400. Retry after indexer lag
succeeds. First-run looks like a broken identity.

We will retry 3× / 5s and tell the operator to `finalize` later. That
is a bandage. **400 is the wrong class** — it looks like a bad payload.

**Please return a retryable machine code**, e.g.

- HTTP **409** (or 503) with `error.code = "IDENTITY_NOT_INDEXED"`
- not 400, not `Invalid request format`

**Done when:** a profile POST within ~1s of `register` identity mint is
either 2xx or 409 `IDENTITY_NOT_INDEXED`. A genuinely malformed body
stays 400.

### 3. Buyer-directed inbox after `completed` (+ accepted review)

Seller inbox already understands, and we already write:

| type | VDXF | i-address |
|---|---|---|
| `review` | `review.record` | `iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad` |
| `attestation` | `review.attestation` | `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv` |
| `job_record` | `job.record` | `iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn` |

Buyer `getIdentityRaw` after finalize: profile keys only. Inbox
`?type=review,attestation,job_record` was `[]`. `getAttestations(buyer)`
was `[]`. `getJobWitness` **does** work after `completed` (signed by
`agentplatform@`) and is not applied to the buyer identity.

We will print the witness from `complete`. We will **not** stuff those
keys onto the buyer ourselves (bypasses the seller `verifyInboxJobRecord`
gate and the pending-write batch).

**Please emit the same inbox types with `recipient_verus_id` = the
buyer’s i-address** (here `iDdjzshM51SLccyKcVvfpLZ1zaa2mW8gCW`), using
the same `vdxf_data` shapes you already send sellers:

- `job_record` after `completed`, body = `{ ...witness.record, witness: witness.block }`
  hex under `job.record`. Must match `GET /v1/jobs/:id/witness` byte-for-byte
  on JCS datahash (our gate cross-checks).
- `review` after the review is accepted, opaque hex under `review.record`
  (passthrough, no witness gate).
- `attestation` as today, allowlisted to `review.attestation` only.

`job_record` still 409 `NOT_WITNESSABLE` until `completed` is fine. We
already skip 409.

**Done when:** after complete (+ review) on a job the buyer hired,
`GET /v1/me/inbox?type=job_record,review,attestation` **as that buyer**
is non-empty, `recipient_verus_id` is the buyer i-address, and a
dispatcher running `start` as that identity would consume them with
the existing seller code path.

Until this ships, buyer on-chain hire attestation is **not** a
dispatcher feature. Say so in your own docs if the website claims it.

### 4. UTXO view still lists spent outputs until confirm

After duskseek pay (`ad784485…`), moonkimi `--pay` failed
`Transaction rejected by the network` until `wallet show` dropped
UTXO `29058bcf…:0` (~70s) and showed change `ad784485…:2`.

We know the platform serves the **confirmed** UTXO set. That is the
same hazard as inbox pending-write. We will stamp `wallet-pending.json`
and refuse a second spend.

**Still please:** omit spent-but-unconfirmed outputs from `getUtxos`,
or mark them `spent: true` / `confirmations: 0` so a naive integrator
does not rebuild from a dead input. Strangers will not have our stamp.

**Done when:** immediately after a dual-output hire pay, `getUtxos` for
that R-address does not offer the spent outpoint as spendable.

We can ship `pay` without this. World bootstrap will still bite anyone
not going through our CLI.

---

## P1 — product: paid model hires are not labour jobs

### 5. `POST /v1/jobs` against a `kind=model` / `serviceType=api-endpoint` listing

Tester paid duskseek + moonkimi. Jobs stayed `requested`, 0 chat, no
API-access envelope. Dispatcher hire already requires `--service` with
`api-endpoint` for models (`MODEL_REQUIRES_API_ENDPOINT`). So these were
not accidental labour hires on our gate.

A model listing is metered inference (ECDH grant + OpenAI-compatible
proxy), not a chat labour job. Sitting in `requested` waiting for a
seller to accept and talk is the wrong state machine.

**Please pick one and tell us:**

- **(a)** Paid model hire auto-grants access (envelope / API key path)
  and the job is not `requested` labour. Document the response shape
  (`request-access` or job field we should print).
- **(b)** `POST /v1/jobs` for model listings is refused with a stable
  code (`MODEL_NOT_A_LABOUR_JOB` / use `POST /v1/proxy/access/…`). We
  will stop creating jobs against models.
- **(c)** Job is created but status/type makes “not labour” obvious
  (`serviceType` / `kind` on `GET /v1/jobs/:id` we can branch on), and
  you document the buyer’s next call.

**(b) is safest if the grant path is not ready.** Taking coins into a
labour `requested` job that will never chat is the hole.

We are **not** building the OpenAI client in this dispatcher pass.
We only need the job not to look like unpaid labour.

**Done when:** a paid hire of duskseek/moonkimi is either an access
grant or a loud refuse — not `requested` with 0 messages.

---

## Confirm / do not change without telling us

### 6. Accept-without-pay vs start-without-pay

Live: unpaid compute `0339ee78-…` went `accepted` with no payment. Paid
twin `423cd09c-…` sat `requested` until later `delivered`.

Our poll **accepts** then waits for `payment.verified` (or
`in_progress`, or `payment.status` in `{confirmed,completed}`) before
`startJobOrRental`. `J41_ALLOW_UNPRICED_JOBS=1` is the only way a
missing payment object starts work.

**Confirm:**

- Seller `acceptJob` without `payment.verified` is **intended** (stack
  accept, wait for coins).
- Platform must **not** set `in_progress` or `payment.verified` on an
  unpaid job.
- If `0339ee78` ever became `in_progress` without a pay tx, that is
  yours; if it only became `accepted`, that is ours and we will pin
  “no start”.

### 7. `getJobWitness` only after `completed`

We accept this for the current pass. CLI `complete` will GET witness
and tolerate 409. Do not need a hire-time buyer witness unless you
are already building it for another reason.

### 8. `GET /v1/me/privacy` 404

Do not build this for us. Not a dispatcher buyer feature.

### 9. Identity refresh fails after a successful VDXF write

Tester: `Failed to refresh identity from chain` on every finalize
that otherwise worked. We will warn, not fail, if the write
succeeded. If your `/identity/raw` is lagging the write you just
accepted, a 409/202 beats a 500. Optional.

### 10. Kind-filtered listing pages empty (maybe not you)

Public API 2026-09-05: 25 agents, 27 services, 2 models, 1 compute, 1
data. `GET /v1/services?kind=model` had duskseek + moonkimi (we **paid**
both). Website `/sovmodel` and `/sovcompute` showed **0**.

If the site calls a different dashboard query than `/v1/services?kind=`,
and you own that query, please make kind tabs equal the public API.
If that is frontend-only, bounce this item — dispatcher `listings --kind`
already uses `/v1/services?kind=` and will raise the default limit to 100.

Sovdata correctly not hireable. UI still needs a browse payload; CLI
already lists data as browse-only.

---

## Acceptance table (retest against `api.junction41.io`)

| # | Call | Pass |
|---|---|---|
| 1 | `GET /v1/reviews/message` for a completed job | body `message` starts `J41-` and contains jobHash + rating |
| 1b | SDK `submitReview` on that job | no `do not start with J41-` throw |
| 2 | `registerWithJ41` immediately after mint | 2xx or 409 `IDENTITY_NOT_INDEXED`, not 400 |
| 3 | Buyer inbox after complete (+ review) | non-empty `job_record` / `review` with buyer `recipient_verus_id` |
| 3b | `GET /v1/jobs/:id/witness` after complete | still works (already did); inbox `job_record` JCS-matches it |
| 4 | `getUtxos` right after a hire `--pay` | spent outpoint not listed as spendable |
| 5 | Paid model hire | grant or loud refuse, not labour `requested` |
| 6 | Unpaid compute | may be `accepted`; must not be `in_progress` / `verified` |

---

## Order we would like you to ship

1. **Review `J41-` prefix** (blocks every agent signer, not just our CLI).
2. **409 on unindexed identity** (first-run).
3. **Buyer inbox `job_record` / `review`** (buyer reputation; we will consume with existing seller code).
4. **Model hire is not labour** (paid coins currently sit dead).
5. UTXO pending-aware (nice; we workaround).
6. Kind tabs if you own the BFF.

When 1 is live on `api.junction41.io`, tell us. We will ship
`j41-dispatcher review` against it without a workaround.
