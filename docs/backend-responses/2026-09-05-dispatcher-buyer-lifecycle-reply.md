# Backend → Dispatcher, 2026-09-05: buyer lifecycle asks

Copied from backend `docs/backend-responses/2026-09-05-dispatcher-buyer-lifecycle-reply.md` so this repo has the letter. Status only — gate on live `GET /v1/version` `.features`. Do not wrap a shape not on `api.junction41.io`.

**Re:** `docs/backend-responses/2026-09-05-buyer-lifecycle-asks.md`
(`@junction41/dispatcher@2.37.1` / SDK `@junction41/sovagent-sdk@2.16.1`).
**Buyer:** `j41grokbuyer.agentplatform@` / `iDdjzshM51SLccyKcVvfpLZ1zaa2mW8gCW`.

Full contract (answers 1–10, Done-when, PR order):
backend `docs/superpowers/specs/2026-09-05-buyer-attestation-and-lifecycle-design.md`

---

## What is code in this repo (not yet the live `api.junction41.io` contract)

Purchaser identity is **j41General**, internal `kind=general`. Get Free ID fifth card. Mint is still `name.agentplatform@` with `platform.config.kind=general`. Hire-gate: `SELLER_NOT_AGENT`. Indexer does not persist it as a listing.

`POST /v1/onboard` and `/v1/onboard/provision/*` now **require** `kind` (`agent | compute | data | model | general`). Missing → `400 MISSING_KIND`.

None of that unblocks `j41-dispatcher review`. Do not wait on j41General for the review CLI.

---

## Dispatcher asks — locked answers, **not** live on `api.junction41.io` yet

| # | Answer | Live today? |
|---|---|---|
| **1** Review bytes | **confirm.** GET `/v1/reviews/message?agentVerusId=&jobHash=&rating=5` will return `J41-REVIEW\|…` whose first characters are `J41-` and which contains that hash and `5`. Human block is `instructions` only. We will not ask you to special-case `Junction41 Review`. | **No.** GET still serves the multi-line `Junction41 Review` block. Do not ship `review` against live until we say 1 is up. |
| **2** Register lag | **confirm.** Well-formed profile POST while the mint is unindexed → **409** `{ code: "IDENTITY_NOT_INDEXED" }` + `Retry-After: 10`. Malformed body stays 400. Today this path is **401 `SIGNATURE_INVALID`**, not Zod 400. | **No.** |
| **3** Buyer inbox | **confirm.** After `completed` (+ accepted review): `job_record` / `review` / `attestation` with `recipient_verus_id` = buyer i-address. Same types you already consume as seller. You do **not** `buildIdentityUpdateTx` onto the buyer. Inbox `job_record` JCS-matches `GET /v1/jobs/:id/witness` (flatten/hash, not `JSON.stringify(GET.data)`). | **No.** Until this ships, buyer on-chain hire attestation is **not** a dispatcher feature. Print `getJobWitness`. |
| **3b / 7** Witness | **confirm.** GET witness stays **409 `NOT_WITNESSABLE`** until `completed`. No hire-time witness this pass. | **Yes** (already). |
| **4** UTXO | **confirm.** Omit spent-unconfirmed outpoints from `getUtxos`. You can ship `pay` without this. | **No.** |
| **5** Model hire | **pick (b).** New `POST /v1/jobs` against `kind=model` **or** `serviceType=api-endpoint` → **400** `{ code: "MODEL_NOT_A_LABOUR_JOB" }`. Use `POST /v1/proxy/access/:sellerVerusId`. We will not auto-cancel in-flight duskseek/moonkimi jobs. | **No.** |
| **6** Unpaid accept | **confirm.** Stacked `accepted` without pay is intended. We must not set `in_progress` / `payment.verified` on an unpaid job. | **Yes** (already). |
| **8** `/v1/me/privacy` | **confirm do not build.** | n/a |
| **9** Identity refresh | **optional.** 409 `IDENTITY_NOT_INDEXED`, not 500. | **No.** |
| **10** Empty kind tabs | **bounce.** `GET /v1/services?kind=` already lists duskseek/moonkimi. Website `/sovmodel` is dashboard. | API already; website is not this repo. |

---

## Ship order (theirs)

1. J41-REVIEW prefix — unblocks dispatcher `review` CLI. They ping when it is on `api.junction41.io`.
2. 409 `IDENTITY_NOT_INDEXED`
3. Buyer inbox `job_record` / `review` after complete
4. `MODEL_NOT_A_LABOUR_JOB`
5. UTXO omit
6. Kind tabs (dashboard)

Feature tokens when those PRs land: `reviews.j41-review-v2`, `buyer.inbox-attestation-v1`. Until they appear in `GET /v1/version` `.features`, treat live API as the old shape.
