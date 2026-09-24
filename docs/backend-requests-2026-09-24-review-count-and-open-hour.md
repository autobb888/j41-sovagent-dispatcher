# Backend request — a written review has to show on the profile, and the dispute hour has to stay open while the buyer reviews

**Date:** 2026-09-24
**From:** dispatcher, branch `execute-plan/ca3106a1-integrate`
**Live API:** `https://api.junction41.io`

The buyer CLI now asks for a rating when the buyer is holding a delivered job, and it waits until `chainReviewCount` on the seller profile moves. Two live facts block that from finishing.

## 1. The review is public and the profile count is still 0

Dataset job `f204e91f-331a-4bda-bb96-d74ab523d839`.

| Field | Value |
|---|---|
| Buyer | `i4S5nnFJEfuPxq8gZBFn8Xnm4aeseDmLXB` |
| Seller | `pippinapples.agentplatform@` / `i3xJfnFrAcgJZsG5gYpzx6FDXASchgDMLs` |
| Delivered | `2026-09-24T18:25:13.008Z` |
| Completed | `2026-09-24T18:45:22.642Z` |
| Review | `ccb5bb34-2e61-45e5-859b-2e2f3b60e115`, rating 5, `verified: true`, `isPublic: true` |
| Review indexed | `2026-09-24 18:46:20.541961+00` |
| Review `blockHeight` | `0` |
| Seller inbox | `[Inbox] ✅ Review accepted 3889dee2-9a74-4c4c-9db5-17cf5f5da989` |
| Identity tx | `bc1a234d8758ac26f0ece43f37051ce8e9e373d475a164d8e24799e70c68576d` |
| Tx status | `confirmed: true`, 10 confirmations, block `000000055fe0e31fc138d1bcb7ab318c605283dc77ddcd033067be69cc38471c` |
| `GET /v1/reviews/agent` | `meta.total` 1 |
| `GET /v1/reputation` | `totalReviews` 1, `verifiedReviews` 1, score 5 |
| `GET /v1/agents` `chainReviewCount` | `0` at 18:57Z, after the accept tx already had 10 confirmations. A later read the same evening was `1`. Profile `updatedAt` was still `2026-09-24T18:51:51.817Z` |

`GET /v1/reviews/job/5b431969ca196ff45fe6a038e855c646` returns that review. The seller profile the catalogue prints does not.

Please make `chainReviewCount` move when the identity write that accepts the review is confirmed. The buyer command waits for that field and treats a public review with a stuck count as unfinished (`REVIEW_COUNT_LAGGING`). A half-hour indexer lag was recorded on 2026-08-01. This count was still 0 after the accept tx had 10 confirmations, and only later became 1.

If a different field is the one that moves at confirm time, name it. The CLI will poll that field instead.

## 2. Review during the open hour, without completing

The dispute window on that job was until `2026-09-24T19:25:13Z`. The buyer completed at `18:45:22Z`. The seller `GET /v1/jobs/:id` then showed `reviewWindowExpiresAt: null`.

The dataset bearer is valid only while that field is in the future. Completing the job ended the bearer about 40 minutes early. The buyer was holding the rows and waiting out the hour. The review has to be signed in that hour, while status is still `delivered`.

`POST /v1/reviews` already accepts `delivered`. The CLI was the side that refused until `completed`. It now signs a `delivered` job. Please keep that acceptance.

If `complete` is not supposed to clear `reviewWindowExpiresAt` before the original timestamp, that clear is the bug. The window should stay until the clock the delivery set. The bearer then stops at the hour, which is the check we still have not seen.

## What this request is not

- A review signed by the seller. The buyer signs `J41-REVIEW|` from `GET /v1/reviews/message`.
- A default rating. A skipped prompt sends nothing.
- Escrow, or a change to the 60-minute dispute window.
