# Backend → Dispatcher, 2026-09-12: what is still needed (no live deploy yet)

**To:** `@junction41/dispatcher` (`execute-plan/ca3106a1-integrate`)  
**Re:** `docs/backend-responses/2026-09-11-dispatcher-2.37.4-what-we-changed.md` + five-answer lock.  
**Their letter we already have:** `docs/backend-responses/2026-09-11-backend-five-answers.md`  
**Their API:** local `main` `dca3e8f` (17 commits ahead of `origin/main`). **Not pushed. Not on `api.junction41.io`.**  
**Live API today:** still `0.1.0` commit `baf8af8df925` `builtAt 2026-09-05T16:43:40Z`. **Do not code against live.** Gate on `GET /v1/version` `.features`.  
**Our branch:** `execute-plan/ca3106a1-integrate` @ `e14c2af` (docs) / chat wrap `8de8061`. `package.json` still `2.37.3`. **Not on `main`. Not npm `latest`.**  
**SDK:** `@junction41/sovagent-sdk@2.16.1`.

They will **not** rebuild `api.junction41.io` until a private stack proves the four buyer paths.

Full text as received is in this file’s sibling reply. Locked five answers unchanged. Product split: API is a **blind relay**. They will not decrypt/rewrite envelopes, build deposit CLI, auto-start labour, or auto-cancel in-flight model jobs. Unpaid accept stays intended. No `/v1/me/privacy`. Witness 409 until `completed`. `getAttestations` is deletion.

## Five-answer status (their table)

| # | Lock | Their local | Live |
|---|---|---|---|
| 1 | Job `J41-REVIEW\|Agent:…\|Job:…\|Rating:…\|Msg:…\|Ts:…\|I submit this review for a completed job.` | shipped (`reviews.j41-review-v2`) | **absent** |
| 2 | Chat `{ content, signature, timestamp }` | verify behind `JOBS_REQUIRE_SIGNED_CHAT` default **off** | unsigned REST still 200 |
| 3 | Session GET xor `J41-REVIEW-SESSION\|…` | shipped | **absent** |
| 4 | Unsigned 4xx **after** 2.37.4 is npm `latest` | flag off | still unsigned |
| 5 | Buyer inbox flatten + JCS | shipped (`buyer.inbox-attestation-v1`) | **absent** |

They already shipped on local `dca3e8f` (not live): `MODEL_NOT_A_LABOUR_JOB`, `ACCESS_NOT_A_MODEL` before nonce, utxos omit spent-unconfirmed, getTxStatus never `{confirmed:true, confirmations:0}`, register 409 `IDENTITY_NOT_INDEXED`, `GET /v1/config` unsigned pin, new rental-secret RFC1918 400 `RENTAL_HOST_NOT_PUBLIC`, labour extend on delivered 400.

Staging go/no-go features (all required; `jobs.signed-chat-v1` **must be absent**):

- `reviews.j41-review-v2`
- `platform.config-v1`
- `buyer.inbox-attestation-v1`
- `rental.public-host-v1`
- `listings.data-service-v1`
- `discovery.dispatcher-url-v1`

Publish order: joint staging walk → they Docker-rebuild live with signed-chat **false** → we npm 2.37.4 **not** claiming reviews → live retest → then `latest` reviews + maybe signed-chat true.
