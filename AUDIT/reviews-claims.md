# reviews — claims checklist

Every claim README, CLAUDE.md, CHANGELOG, or the contracted backend docs
make that an operator would *act on* for job `review` and model
`review-session`: a default, a guarantee, a "refuses to", a prefix, a
threshold. Each is marked VERIFIED / DRIFT / MISSING / UNVERIFIED against
the implementing code.

Domain: buyer job review (`src/buyer-review.js` + CLI `review`) and buyer
model-grant session review (`src/buyer-review-session.js` + CLI
`review-session`). Seller inbox auto-accept of `review` items is included
where README/CLAUDE.md claim it. Findings **R1..R2** are in
`AUDIT/reviews.md`.

Sources read: `README.md` (review-adjacent bullets), `CLAUDE.md` (fee-tank
+ `review.record`), `CHANGELOG.md` 2.37.2/2.37.3, `docs/backend-responses/2026-09-11-backend-five-answers.md`,
`docs/backend-responses/2026-09-12-dispatcher-reply-walk-origin.md`,
`src/buyer-review.js`, `src/buyer-review-session.js`, `src/cli.js` rinds,
`src/dashboard.js` `api_review`, `src/buyer-access.js` grant load,
`test/buyer-review.test.js`, `test/buyer-review-session.test.js`,
SDK `agent.submitReview` / `client.submitReview` / `client.getReviewMessage`.

---

## A. Job review — sign GET bytes only

| # | Claim | Source | Verdict |
|---|---|---|---|
| A1 | Sign **exactly** `GET /v1/reviews/message` `data.message`. Do not sign `data.instructions`. | five-answers §1 | **VERIFIED** — `buyer-review.js:158-173` takes `msgResult.message` as `toSign`; `instructions` is never read |
| A2 | Job bytes must **start with** `J41-REVIEW\|` (the pipe). `J41-REVIEW-SESSION\|` does **not** start with `J41-REVIEW\|`. | task; five-answers §1; `buyer-review.js:3` | **VERIFIED** — `isJobCanonical` is `startsWith('J41-REVIEW\|')` at `:41-42`. `'J41-REVIEW-SESSION\|'.startsWith('J41-REVIEW\|')` is false (`-` vs `\|` after `REVIEW`) |
| A3 | Homemade `J41-REVIEW\|` / `Junction41 Review` is `REVIEW_NOT_CANONICAL` — never send it | `buyer-review.js:3-4`; CHANGELOG 2.37.2/2.37.3 | **VERIFIED** — `:159-164` refuses before `signMessage`; tests pin no sign/POST (`test/buyer-review.test.js:76-96`, `:157-175`) |
| A4 | Bind `Job:<jobHash>`, `Rating:<n>`, `Agent:<seller>` | task; five-answers §1 (`Agent:` is load-bearing) | **VERIFIED** — `canonicalNotBound` `:45-48`; missing `Agent:`, wrong seller, wrong hash, wrong rating all `REVIEW_NOT_CANONICAL` (`test/buyer-review.test.js:216-241`, `:177-195`) |
| A5 | `parseRating` is `/^[1-5]$/` — reject 1.5, 01, 1.0, empty, 9 | five-answers §1 (`Number` + `Number.isInteger`; `1.5` → 400); code comment `:32` | **VERIFIED** — `buyer-review.js:33-38`; CLI rind re-checks before confirm (`cli.js:3488-3489`); tests `:63-74`, `:243-260` |
| A6 | POST via `client.submitReview` (HTTP). Do **not** wrap SDK `agent.submitReview` (it GETs again with its own timestamp) | `buyer-review.js:5-6`; task | **VERIFIED** — `:201` is `client.submitReview(payload)`. SDK `agent.submitReview` (`sovagent-sdk/dist/agent.js:2066-2102`) calls `getReviewMessage` then `submitReview`. `test/buyer-review.test.js:60,338,342` pin no `agent.submitReview` in helper or `cli.js` |
| A7 | Empty `message` is omitted from the GET query (backend fills empty `Msg:`, not `No message`) | five-answers §1 | **VERIFIED** — `getJobReviewMessage` `:82` `if (params.message)`; test `:302-321` |
| A8 | POST `timestamp` equals GET `data.timestamp` | five-answers §1 | **VERIFIED** — `:174-177` + payload `:195`; test `:143` |
| A9 | Job must be `completed`; else `REVIEW_NOT_COMPLETED` | buyer-lifecycle design; CLI description | **VERIFIED** — helper `:125-130` and CLI rind `:3498-3500` (before confirm) |
| A10 | Buyer identity must match the job (`PAY_NOT_BUYER`) | design §5 | **VERIFIED** — `buyerOwnsJob` (`hire-pay.js:28-34`) at helper `:122-124` and CLI `:3497` |
| A11 | `--json` requires `--yes` (`JSON_REQUIRES_YES`) | design §5 | **VERIFIED** — `cli.js:3485` |
| A12 | CLI `review` is a thin rind over `submitBuyerJobReview` | tests | **VERIFIED** — `cli.js:3476-3526`; `test/buyer-review.test.js:323-343` |
| A13 | Source never homemade-templates `toSign = \`J41-REVIEW\|…\`` | tests | **VERIFIED** — `test/buyer-review.test.js:58-59` against `src/buyer-review.js` |

---

## B. Model `review-session` — `J41-REVIEW-SESSION\|` from GET

| # | Claim | Source | Verdict |
|---|---|---|---|
| B1 | Sign GET `/v1/reviews/message?sessionId=…` `J41-REVIEW-SESSION\|…` only | five-answers §3; `buyer-review-session.js:4` | **VERIFIED** — `isSessionCanonical` `:50-51`; `toSign = platformBytes` `:163` |
| B2 | Homemade `J41-REVIEW\|Session:` is a 401 — never send it | five-answers §3; task | **VERIFIED** for the CLI/helper — no template construction in `buyer-review-session.js` (tests `:47-57`, `:199-222`). **DRIFT** — TUI `api_review` homemade-signs JSON and POSTs the same endpoint → **R1** |
| B3 | Session bytes start with `J41-REVIEW-SESSION\|`, which does **not** start with `J41-REVIEW\|` | task | **VERIFIED** — `:50-51` vs job `:41-42`; job GET returning a session line is `REVIEW_NOT_CANONICAL`; session GET returning `J41-REVIEW\|Session:` is `REVIEW_SESSION_UNSUPPORTED` (tests `:199-222`) |
| B4 | Bind `Session:<id>`, `Rating:<n>`, `Agent:<seller>` | task; five-answers §3 | **VERIFIED** — `canonicalNotBound` `:81-84`; tests `:267-312` |
| B5 | SDK `getReviewMessage` still requires `jobHash`. Extra `{ sessionId }` is ignored. **Raw-GET** the query. | five-answers §3 | **VERIFIED** — `getSessionReviewMessage` `:54-68` uses `client.request('GET', /v1/reviews/message?…sessionId…)`. Comment `:56` names the SDK constraint. SDK `getReviewMessage` (`client/index.js:1471-1482`) always `query.set('jobHash', …)` |
| B6 | Until GET cannot return `J41-REVIEW-SESSION\|`, fail `REVIEW_SESSION_UNSUPPORTED` | five-answers §3 | **VERIFIED** — GET 400/404/`MISSING_PARAMS`/`jobHash` `:42-47,138-144`; non-canonical body `:149-154`; POST 404 `:194-199` |
| B7 | `sessionId` comes from the access grant after `chat` — no extra `--session-id` required | tests; five-answers (chat then review-session) | **VERIFIED** as the happy path — CLI `chat` `:3898-3899` `persistGrantSession`; helper `resolveSessionId` `:71-78`. **DRIFT** — `loadAccessGrant` returns `null` once `expiresAt` is past (`buyer-access.js:95-98`), so a persisted `sessionId` becomes invisible and CLI has no `--session-id` override → **R2** |
| B8 | Missing sessionId is `REVIEW_SESSION_NO_SESSION` and never submits | tests | **VERIFIED** — `:115-121`; test `:141-155` |
| B9 | POST via `client.submitApiSessionReview` (HTTP), not a second GET | five-answers §3 payload shape | **VERIFIED** — `:191`; payload fields `:177-187` match `{ agentVerusId, buyerVerusId, sessionId, rating, message, timestamp, signature, model? }` |
| B10 | CLI rind is thin; `parseRating` before `confirmHire`; no homemade in the rind | tests | **VERIFIED** — `cli.js:3528-3571`; `test/buyer-review-session.test.js:369-393` |
| B11 | CLI help: fail-closed unless bytes start with `J41-`; 404 is `REVIEW_SESSION_UNSUPPORTED` | `cli.js:3530` | **DRIFT** — help says `J41-`; code requires `J41-REVIEW-SESSION\|`. Stricter than advertised (safe direction). Job CLI help (`:3477`) names `J41-REVIEW\|` correctly |
| B12 | Feature token `reviews.j41-review-v2` gates session GET | five-answers §3; walk-origin | **VERIFIED** as *bytes-gated*, not a `/v1/version` check — non-canonical / 400 / 404 → `REVIEW_SESSION_UNSUPPORTED`. Load-bearing defence is the prefix, which is what the contract asked for |

---

## C. After 2xx — buyer inbox read, never write

| # | Claim | Source | Verdict |
|---|---|---|---|
| C1 | After 2xx: `getInbox('pending', N, ['review','attestation'])` | task | **VERIFIED** — `readBuyerReviewInbox` `buyer-review.js:58-68` uses `getInbox('pending', 20, ['review', 'attestation'])`. Session reuses it (`:211`) |
| C2 | Inbox throw → still `{ ok: true, inboxWarning }` | task | **VERIFIED** — `:65-67` catch → `BUYER_INBOX_READ_FAILED`; tests job `:262-280`, session `:314-333` |
| C3 | Empty inbox after 2xx is ok with `BUYER_INBOX_EMPTY` | tests | **VERIFIED** — `:64` + job test `:282-300` |
| C4 | NEVER `getAttestations` (that endpoint is deletion, not hire proof) | five-answers §5; task | **VERIFIED** — no `getAttestations` in `src/buyer-review.js` / `src/buyer-review-session.js` / either CLI rind (source tests pin this) |
| C5 | NEVER write buyer VDXF (`buildIdentityUpdateTx`) after review | five-answers §5; CHANGELOG 2.37.2/2.37.3; task | **VERIFIED** — after POST the helper only reads inbox. No `buildIdentityUpdateTx` in either review module. CLI rind only prints `inboxWarning` |
| C6 | Do not claim a landed record when inbox is empty — warn, don't flip `ok` | task (throw → ok + warning) | **VERIFIED** — `ok: true` plus `inboxWarning`; CLI prints the warning (`cli.js:3515,3559`) |

---

## D. Docs must NOT say "reviews shipped"

| # | Claim | Source | Verdict |
|---|---|---|---|
| D1 | CHANGELOG / docs must NOT say "reviews shipped" | task; five-answers §4; walk-origin:59 | **VERIFIED** — `CHANGELOG.md` has no `reviews shipped` / `live reviews` (pinned by `test/buyer-review-session.test.js:395-404` and `test/friend-boot-docs.test.js:157-165`). 2.37.2/2.37.3 say fail-closed until `J41-REVIEW\|` |
| D2 | First 2.37.4 changelog will **not** claim reviews | walk-origin:59; five-answers §4 | **VERIFIED** as of this tree — `package.json` is still `2.37.3`; there is no `## 2.37.4` section |
| D3 | README does not advertise buyer `review` / `review-session` as a shipped verb | (implied by D1; README command table) | **VERIFIED** — README command table lists `hire` / `access` / `chat` / `deposit` / `browse` / `job-chat` and omits `review` / `review-session` / `complete`. Consistent with not claiming reviews shipped |
| D4 | CHANGELOG 2.37.2: `review --rating N` exists but is fail-closed until platform `J41-REVIEW\|` (`reviews.j41-review-v2`) | CHANGELOG:29-31 | **VERIFIED** — command exists (`cli.js:3476`); refuse path is `REVIEW_NOT_CANONICAL` (`buyer-review.js:159-164`) |
| D5 | CHANGELOG 2.37.3: still fail-closed; no buyer VDXF write | CHANGELOG:19-20 | **VERIFIED** — same as A3 + C5 |
| D6 | Live GET template (walk-origin) equals five-answers §1 worked example | walk-origin:23-30; five-answers:22-28 | **VERIFIED** as a documentation contract — both files paste the same `J41-REVIEW\|Agent:testgpu01.agentplatform@\|Job:abc123\|Rating:5\|Msg:\|Ts:1700000000\|I submit this review for a completed job.` line. Dispatcher signs whatever GET returns if it passes A2+A4; it does not hardcode this string |

---

## E. README / CLAUDE.md seller-side review claims

| # | Claim | Source | Verdict |
|---|---|---|---|
| E1 | Auto-processes `job_record` and `review` inbox items, writes to identity | README:23 | **VERIFIED** — `dispatchInboxAccept` `cli.js:11383-11387` (`review` → `acceptReview`); batched in `processInboxForAgent`. Webhook `review.received` (`cli.js:10995-11017`) no longer loops `acceptReview` (T2 fix; `test/review-webhook-batching.test.js`) |
| E2 | Job lifecycle step 9: buyer review is auto-accepted and the agent's on-chain identity is updated | README:303 | **VERIFIED** — same as E1 (seller inbox). Buyer CLI does not write the seller identity |
| E3 | `review.record` / `review.attestation` VDXF keys populated when reviews/attestations are accepted | README:284-285; CLAUDE.md CMM note | **VERIFIED** as wiring — inbox types map to those keys via SDK vdxf-gate (trust-boundary F4). TUI `ALL_VDXF_KEYS` still omits `review.attestation` (docs-truth **D9**, not re-derived) |
| E4 | On-chain identity-write fees (~0.0001/write — reviews, attestations, job records) debit the R-address only | README:310; CLAUDE.md fee-tank | **VERIFIED** in the money pass; not re-derived. Review *accept* is an identity write on the seller |
| E5 | Empty R-address → silent: no reviews, no attestations, no job records | README:312; CLAUDE.md | **VERIFIED** in the money/liveness passes (`No spendable R-address UTXOs for fee` is `transient` in `inbox-deadletter.js`) |
| E6 | Container stays alive through the review window; killed on completed / dispute-resolved | README:696-698 | **VERIFIED** in isolation I-c / liveness (job-agent post-delivery wait). Adjacent, not the buyer `review` verb |
| E7 | `update-profile` copies existing CMM so `review.record` survives | CLAUDE.md | **VERIFIED** in docs-truth / VDXF notes; not the buyer path |

---

## F. Tests that pin the contract

| # | Claim | Source | Verdict |
|---|---|---|---|
| F1 | `test/buyer-review.test.js` exists and pins GET-bytes, no homemade, no `getAttestations`, no `agent.submitReview`, inbox throw → ok | task | **VERIFIED** |
| F2 | `test/buyer-review-session.test.js` exists and pins `J41-REVIEW-SESSION\|`, never `J41-REVIEW\|Session:`, 404 → `REVIEW_SESSION_UNSUPPORTED`, changelog/help do not claim shipped | task | **VERIFIED** |
| F3 | CLI rind source-slice tests cover both commands | both test files | **VERIFIED** |

---

## Outcome

48 claims — 45 **VERIFIED** · 3 **DRIFT** (B2 → R1, B7 → R2, B11 help-text only) · 0 **MISSING** · 0 **UNVERIFIED**.

B11 is recorded as DRIFT and not raised as a finding: the code is stricter than the help string, in the safe direction.
