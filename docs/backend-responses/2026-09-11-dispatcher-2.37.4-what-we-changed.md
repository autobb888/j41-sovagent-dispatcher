# Dispatcher 2.37.4 — what we changed (sync before we push)

**Date:** 2026-09-11  
**From:** dispatcher (`@junction41/dispatcher`)  
**To:** Junction41 backend  
**Live npm today:** `@junction41/dispatcher@2.37.3` / alias `j41-dispatcher@2.37.3` (git `1a340d8`)  
**This report:** code assembled on `execute-plan/ca3106a1-integrate` @ `1c6834e`. **Not merged to `main`. Not published.** Version still 2.37.3.  
**SDK we call:** `@junction41/sovagent-sdk@2.16.1`  
**API:** `https://api.junction41.io` (VRSCTEST), last known live pin `baf8af8df925`

**Need from you before we code the remaining chat/session-review bits or push:**  
`docs/backend-responses/2026-09-11-dispatcher-2.37.4-need-before-code.md` (five acks).

This file is the longer page-align. Earlier asks still stand:

- `docs/backend-responses/2026-09-05-buyer-lifecycle-asks.md`
- `docs/backend-responses/2026-09-06-dispatcher-2.37.4-full-path.md`

We did **not** rewrite `Junction41 Review` into a fake `J41-` prefix. We did **not** homemade-write buyer VDXF.

---

## Why this note

2.37.3 could decrypt a model grant, pay a GPU job, and browse data — and still leave the buyer with a NVIDIA 404, a LAN SSH host, a 402 they could not top up, and `REVIEW_NOT_CANONICAL`.

2.37.4 is the dispatcher half of finishing all four kinds. Most of it is **our CLI + seller process**. A few calls now hit **your** API with signatures you need to verify the same way as complete/dispute. Reviews still fail-closed until you emit `J41-REVIEW|`.

We will **not** tag npm `latest` claiming reviews until live `GET /v1/reviews/message` starts with `J41-` (binding jobHash+rating) **and** a review lands on seller inbox / buyer attestation.

---

## Buyer path we now implement (all four kinds)

```
listings
    ├─ kind=agent    → hire → pay --wait → job-chat (signed) → complete → review
    ├─ kind=compute  → hire gpu-rental → pay --wait → public SSH → complete → extend → review
    ├─ kind=model    → NOT hireable → access → deposit --wait → chat (seller proxy) → review-session
    └─ kind=data     → NOT hireable → browse GET website/endpoints (never description)

cancel     only while status=requested
dispute    signed J41-DISPUTE|  →  seller respond-dispute / refunds (already existed)
```

Unchanged gates:

- `hire --pay` still runs `planHirePayment` **before** `createJob` (`PAY_PENDING`).
- Models: `MODEL_NOT_A_LABOUR_JOB` — we do not `POST /v1/jobs` for `api-endpoint`.
- Data: `DATA_NOT_HIREABLE`.
- Testnet access pin still `RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb`.
- `wallet send` is still fleet agent-id → fleet agent-id only. Deposits use `sendMultiPayment` to the seller **i-address**.

---

## What hits **your** API (please match these)

### 1. Labour `job-chat` — signed third arg

```
j41-dispatcher job-chat <buyer> <job-id> --message <text> [--wait]
```

Bytes we sign (content is hashed, not concatenated):

```
J41-CHAT|Job:<jobHash>|Ts:<unix>|<hex sha256 of utf8 content>
```

**Assembled 2.37.4** calls SDK `sendChatMessage(jobId, content, signature)` → POST `{ content, signature }` (**no `timestamp` in the JSON**). `Ts:` is only inside the signed string.

If you verify by rebuilding the line from `{ content, signature, timestamp }`, **this POST cannot verify**. Ack whether the body must include `timestamp` before we wrap/bump the SDK. Do **not** 4xx unsigned chat on live until 2.37.4 npm is out (see need-before-code #4).

`--wait` polls `getChatMessages` up to 180s for a line whose role/sender is not the buyer. Timeout is warning, exit 0.

### 2. `dispute` / `cancel` / `rework-accept`

```
j41-dispatcher cancel <buyer> <job-id>
j41-dispatcher dispute <buyer> <job-id> --reason <text>
j41-dispatcher rework-accept <buyer> <job-id>
```

- `cancelJob` only when `GET /v1/jobs/:id` status is `requested`. Else we fail `CANCEL_NOT_REQUESTED` and do not call you. Delivered/in_progress cancel is your 4xx if someone bypasses us.
- `disputeJob(jobId, reason, signature, timestamp)` with SDK `buildDisputeMessage`:

```
J41-DISPUTE|Job:<jobHash>|Reason:<reason>|Ts:<unix>|I am raising a dispute on this job.
```

- `acceptRework` signs `J41-REWORK-ACCEPT|…` (SDK `buildReworkAcceptMessage`).
- Seller `respond-dispute` + `refunds list|approve` already existed. After `--action refund`, money still moves on your refund queue.

`inspect <agent-id> <job-id>` prints `status`, dispute action, `refund_txid` when present. We read that from the job object you already return.

### 3. `extend` — same dual-pay as hire

```
j41-dispatcher extend <buyer> <job-id> --amount <n> [--reason] [--pay|--no-pay] [--wait]
```

1. `GET /v1/jobs/:id` — buyer must own it.
2. Labour: status must be `in_progress` or `paused`. **Delivered labour → we fail `EXTEND_NOT_OPEN` and do not call `requestExtension`** (your 400 on delivered labour `957f51ad…` is proven).
3. GPU Cat-1: `in_progress` / `paused` / **`delivered`** is open — payment extends the lease. We still call `POST /v1/jobs/:id/extensions` even if the seller process is down.
4. `requestExtension(jobId, amount, reason)`.
5. Default `--pay`: `planHirePayment` **before** broadcast; dual outputs if `payment.feeAmount` is on the extension/job; `sendMultiPayment`; `payExtension(jobId, extensionId, agentTxid, feeTxid)`.
6. `--wait` after broadcast is local `getTxStatus` (same as hire). Timeout warning, exit 0, no second send.

Seller `handleExtensionRequest` already auto-approves gpu-rental on the lease. No new seller verb.

Please keep:

- labour extend on `delivered` = 400
- Cat-1: **only payment** extends a delivered GPU lease (not a free clock bump)

### 4. Job `review` — still fail-closed on your bytes

```
j41-dispatcher review <buyer> <job-id> --rating <1-5>
```

Unchanged: SDK `submitReview` signs **exactly** `GET /v1/reviews/message`. If the body is not `/^J41-/` or does not contain `jobHash` + `String(rating)`, we refuse (`REVIEW_NOT_CANONICAL`). We will not locally rewrite `Junction41 Review`.

**Ack the exact line** (need-before-code #1), including `Agent:`, `Msg:`, and the trailing sentence. Do not ship a different template than the one we sign.

`/v1/version` features: `reviews.j41-review-v2` when that line is live.

**Done when:** `submitReview` on a `completed` labour/compute job does not throw “do not start with J41-”.

### 5. Model `review-session`

```
j41-dispatcher review-session <buyer> <seller> --rating <1-5>
```

Model grants have `sessionId`, no `jobHash`. After a successful `chat` we persist `sessionId` on the grant file (0600).

**Assembled homemade** `J41-REVIEW|Session:<id>|Rating:…` will **401** if you verify `J41-REVIEW-SESSION|` from GET. We will not keep homemade.

Need GET canonical `J41-REVIEW-SESSION|…` (ack exact bytes). Then `submitApiSessionReview({ agentVerusId, buyerVerusId, sessionId, rating, message, timestamp, signature, model? })`.

- HTTP 404 → `REVIEW_SESSION_UNSUPPORTED`.
- `Junction41 Review` / non-`J41-` → `REVIEW_NOT_CANONICAL`. We still will not rewrite it.

Do not ask us to fake a jobHash for a grant.

### 6. Buyer inbox after complete + accepted review — still missing

Seller inbox already journals `review.record` / `job.record`. Buyer `getAttestations` was `[]` after complete.

Please emit the **same** inbox types with `recipient_verus_id` = **buyer i-address**:

| type | when |
|---|---|
| `job_record` | after `completed` (body matches `GET /v1/jobs/:id/witness` JCS datahash) |
| `review` | after the review is accepted |
| `attestation` | as today, allowlisted |

We will consume them with the existing seller allowlist-passthrough. We will **not** `buildIdentityUpdateTx` onto the buyer.

**Done when:** as that buyer, `GET /v1/me/inbox?type=job_record,review,attestation` is non-empty after complete+review.

Until 4+6, 2.37.4 **cannot** pass the review/attestation bar. CLI still ships fail-closed.

### 7. Keep refusing model labour jobs

We already refuse `POST /v1/jobs` for `kind=model` / `serviceType=api-endpoint`. Please keep the API on that side too. Product is `POST /v1/proxy/access/:seller` then the seller’s `/j41/proxy/v1/*`.

`GET /v1/jobs/:id` for GPU leftovers often omits `serviceType` / `kind` (SDK `Job` has `serviceId`). Buyer `complete` now probes `getRentalAccess` instead of trusting those fields. If you can put `serviceType` (or `kind`) on `GET /v1/jobs/:id`, other integrators will not reprint a success checkmark on a LAN SSH host. Not blocking for us.

### 8. Unchanged SDK we already used (still the contract)

| Verb | Call |
|---|---|
| hire | `createJob` after `PAY_PENDING` gate |
| pay | dual `sendMultiPayment` + `payJob` |
| complete | `completeJob` (`J41-COMPLETE\|Job:<hash>\|…`) |
| access | `requestApiAccess` / ECDH (testnet pin above) |
| GPU deliver | `getRentalAccess` → `access.ssh.host` / `.port` |
| deposit report (seller HTTP, not you) | signed `J41-DEPOSIT-REPORT` POST `/j41/deposit/report` |

---

## What we changed that is **not** your API (so you do not chase it)

These look like platform bugs in tester logs. They were ours / the seller box.

### Model envelope + chat

2.37.3 minted `endpointUrl: cfg.endpointUrl` (NVIDIA `integrate.api.nvidia.com/v1`). Buyer `chat` then doubled `/v1`.

We now mint `{origin(publicUrl)}/j41/proxy/v1` into the ECDH envelope. Missing `publicUrl` refuses mint (`ENVELOPE_NO_PUBLIC_URL`). Same host as NVIDIA refuses (`ENVELOPE_UPSTREAM_URL`). Chat path is `/chat/completions` when the base already ends in `/v1`.

Buyer `access` / seller `onAccessRequest` require `serviceType === 'api-endpoint'` **before** nonce (`ACCESS_NOT_API_ENDPOINT`). Kind=model alone is not enough. Labour never hits `verifyAccessRequest`.

Stale NVIDIA grants: we do **not** treat a minted pathname as proof. Listing website/endpoints must pass `GET {origin}/j41/health` JSON `service === 'dispatcher'` before we rewrite the grant (0600). Failure: `ACCESS_GRANT_UPSTREAM` / `ACCESS_GRANT_STALE`, file unchanged, `callProxied` not invoked.

Proxy HTTP **402** maps to `CHAT_NEEDS_DEPOSIT` from `statusCode` / `responseBody` (`topupAddress`, `estimatedCost`, `balance`). Suggested-topup header is a hint, never a default `--amount`.

### Buyer deposit (seller HTTP + chain, not a new platform route)

```
j41-dispatcher deposit <buyer> <seller> --amount <n> [--wait]
j41-dispatcher report-deposit <buyer> <seller> --txid <txid> --amount <n> [--wait]
```

- Broadcast: `sendMultiPayment` **single** output to seller **i-address** (not `wallet send`, not R-address).
- Report URL: saved grant if pathname is `/j41/proxy/v1`; else listing public URL after dispatcher `/j41/health`. NVIDIA `/v1` is never the report origin.
- `--wait`: POST once → poll **local** `getTxStatus` → POST a **freshly signed** report (new nonce). No `GET /j41/deposit/…`.
- First POST `REPLAY` with no accepted report this invocation → `DEPOSIT_REPLAY` exit 1.
- `Deposit already processed` / `REPLAY` after an accepted report this invocation → success, do not re-spend.
- Timeout: warning, exit 0, JSON `{ ok: true, pending: true }`.

Seller reconciler: missing `deposits.json` no longer throws `d.reversed is not iterable` (credits were left standing on live `model-*`).

`--amount` is required. We do not silently send 10 VRSC.

### GPU SSH

Orchard `ssh_hostname=192.168.1.69` was accepted. We now refuse RFC1918 / loopback / `.local` **before** `acceptJob` and before `state.seen.set` (poll, webhook, `accept-job`, `startRentalJobWired`). Job stays `requested`. No auto-refund. Override is `J41_ALLOW_LAN_RENTAL=1` only.

Leftover delivered LAN jobs: `complete` still closes the job, but stdout does **not** print `✅ Job … completed`. JSON `warning: COMPLETE_LAN_ONLY`.

`tunnel-setup` writes a named Cloudflare HTTP+TCP YAML (print-only unless `--run`). Doctor fails `rental.ssh_public`, `model.public_url`, `model.webhook`.

### Data browse

```
j41-dispatcher browse <seller> [--path /apples]
```

GET listing `networkEndpoints[0]` → `website` → typed `endpoints[].url`. **Never description.** A trycloudflare blurb is not fetched. `"10 apples"` in the marketplace text is allowed; dotted-quad RFC1918 / trycloudflare in `--profile-description` is refused (`DESCRIPTION_EPHEMERAL_URL`).

### Seller process honesty

- `activate-all` / `deactivate-all` print `activated` / `deactivated`, not SDK `result.status`.
- Webhook mode (`--webhook-url`) now also polls `pollForJobs` every 60s. J41 webhooks stay best-effort. Banner says so. Recovered-job log only when poll is the discoverer (not after a webhook that already accepted).
- Labour job-agent image: `package.docker.json` pins `json-canonicalize@2.0.0` (2.0.1 `main` pointed at a missing file → `MODULE_NOT_FOUND`). Docker SDK stays 2.14.1.

### Wallet stamp

`pay --wait` / `hire --pay --wait` now wait **after** broadcast too. `wallet-pending.json` unlinks only when `getTxStatus` confirmations **> 0**. `{ confirmed: true, confirmations: 0 }` keeps the stamp. Missing `getTxStatus` is loud, not a silent leftover.

Your confirmed-UTXO lag after pay is still real. We workaround with the stamp. Prefer omitting spent-but-unconfirmed outpoints from `getUtxos` so strangers not on our CLI do not rebuild from a dead input.

---

## Signing strings (do not fork)

| Verb | Bytes |
|---|---|
| complete | `J41-COMPLETE\|Job:<jobHash>\|Ts:<unix>\|I confirm the work has been delivered satisfactorily.` |
| dispute | `J41-DISPUTE\|Job:<jobHash>\|Reason:<reason>\|Ts:<unix>\|I am raising a dispute on this job.` |
| rework-accept | SDK `buildReworkAcceptMessage` (`J41-REWORK-ACCEPT\|…`) |
| job-chat | `J41-CHAT\|Job:<jobHash>\|Ts:<unix>\|<sha256 hex of utf8 content>` |
| job review | **your** `GET /v1/reviews/message` — ack exact line (`Agent:` / `Msg:` / trailing sentence) |
| session review | **your** GET `J41-REVIEW-SESSION\|…` — homemade `J41-REVIEW\|Session:` will 401; we will not ship it |
| deposit report | existing `J41-DEPOSIT-REPORT` (seller `/j41/deposit/report` already verifies) |

---

## What we need from you before we claim 2.37.4 latest

| # | Ask | Blocking `latest` “reviews done”? |
|---|---|---|
| 1 | `GET /v1/reviews/message` starts `J41-REVIEW\|` (or any `J41-` that binds jobHash+rating). Feature flag `reviews.j41-review-v2`. | **Yes** |
| 2 | Buyer-directed inbox `job_record` / `review` / `attestation` after complete+review. | **Yes** |
| 3 | Reject unsigned `POST /v1/jobs/:id/messages` (4xx). | Same week if you can — we already sign |
| 4 | Keep refusing `POST /v1/jobs` for model/api-endpoint listings. | Keep current |
| 5 | `/v1/reviews/api-session` (or tell us 404 is forever). | Optional; we fail `REVIEW_SESSION_UNSUPPORTED` |
| 6 | Labour extend on `delivered` stays 400. Cat-1 delivered GPU extends only via payment. | Keep current |
| 7 | Fresh `registerWithJ41` 400 → prefer 409 `IDENTITY_NOT_INDEXED`. | Workaround in CLI |
| 8 | `getUtxos` omit spent-but-unconfirmed. | Workaround via `wallet-pending.json` |

---

## What we are **not** asking you to do

- Cloudflare named tunnels (seller `tunnel-setup` + doctor).
- Minting NVIDIA vs dispatcher URL in the access envelope (our mint bug, fixed).
- Buyer `wallet send` to a foreign i-address (deposits are `sendMultiPayment` to i-address).
- `GET /v1/me/privacy` (unused; `privacy` CLI is seller deletion files).
- Frontend SovData / kind tabs.
- Bringing dt3worker2 online (that seller). Orchard labour listing `start` is operator infra.
- Making RFC1918 SSH reachable (we refuse it).

---

## Tell us when

1. `GET /v1/reviews/message` starts with `J41-REVIEW|` (or any `J41-` + bound fields).  
2. Buyer inbox is non-empty after complete+review.  
3. Unsigned `POST …/messages` is 4xx (or you confirm the canonical chat line).

We will then retest review / attestation / labour chat on live VRSCTEST and only then tag npm `latest` as reviews done. Until then we can still merge/publish **code** with changelog that does **not** claim reviews shipped.

If any signing string above disagrees with what you verify, answer with the exact bytes. We will match you; we will not guess.
