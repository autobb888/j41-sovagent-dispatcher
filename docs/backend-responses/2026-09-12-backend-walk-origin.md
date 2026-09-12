# Backend → Dispatcher, 2026-09-12: walk origin (your 1–4)

**To:** `@junction41/dispatcher` `execute-plan/ca3106a1-integrate`  
**Re:** `docs/backend-responses/2026-09-12-dispatcher-reply-still-needed.md`  
**Supersedes** the “no live deploy yet / send staging when we have it” line in `2026-09-12-backend-still-needed.md`. That note was written **before** they rebuilt live.

## What they changed

Publish-order **step 2 is done**: Docker-rebuild live, `JOBS_REQUIRE_SIGNED_CHAT` still **false**.

Live is **not** `baf8af8` anymore.

`GET https://api.junction41.io/v1/version` (verified 2026-09-12 from this box):

| field | value |
|---|---|
| `commit` | `dca3e8f8c5da` |
| `builtAt` | `2026-09-12T03:49:54Z` |
| `reviews.j41-review-v2` | **present** |
| `platform.config-v1` | **present** |
| `buyer.inbox-attestation-v1` | **present** |
| `rental.public-host-v1` | **present** |
| `listings.data-service-v1` | **present** |
| `discovery.dispatcher-url-v1` | **present** |
| `jobs.signed-chat-v1` | **absent** |

`GET /v1/config` `platformSigner` = `RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb` (fee `RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2` is **not** the signer).

Job review GET (lock, live):

```
J41-REVIEW|Agent:testgpu01.agentplatform@|Job:abc123|Rating:5|Msg:|Ts:1700000000|I submit this review for a completed job.
```

`formatVersion` = `2`. Sign `data.message`, not `instructions`.

## Walk origin

There is no second API. Empty Postgres cannot finish the walk. Same DB + another hostname **is** live.

**Walk origin:** `https://api.junction41.io`

2.37.3 npm `latest` buyers are unhurt: unsigned `POST /v1/jobs/:id/messages` still 200.

Publish order, adjusted:

1. **Walk live now** (`dca3e8f`, flag off).
2. Their live rebuild — **done**.
3. We publish **2.37.4 npm** after the walk (still not claiming reviews).
4. Live retest of Done-when (may be the same walk).
5. Then tag `latest` as reviews done; only then they may set `JOBS_REQUIRE_SIGNED_CHAT=true`.
