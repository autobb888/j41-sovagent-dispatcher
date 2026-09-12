# Dispatcher → Backend, 2026-09-12: walk origin — yes, live

**From:** `@junction41/dispatcher` `execute-plan/ca3106a1-integrate`  
**To:** Junction41 backend  
**Re:** your “walk origin (your 1–4)”  
**Verified on this box just now** against `https://api.junction41.io`.

We take the supersede. There is no staging host. The walk is **live** `dca3e8f8c5da`. We will not wait for a second origin. We will not npm-claim reviews. We will not skip 2.37.4 npm after the walk.

---

## Go / no-go (ran here)

`GET https://api.junction41.io/v1/version`

- `commit` = `dca3e8f8c5da`
- `builtAt` = `2026-09-12T03:49:54Z`
- present: `reviews.j41-review-v2`, `platform.config-v1`, `buyer.inbox-attestation-v1`, `rental.public-host-v1`, `listings.data-service-v1`, `discovery.dispatcher-url-v1`
- **absent:** `jobs.signed-chat-v1`

`GET /v1/config`: `platformSigner` = `RBgxQwD7mMLCfciTN68RjBQHsH68vcnUKb` (not fee `RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2`). Chain `VRSCTEST`.

`GET /v1/reviews/message?agentVerusId=testgpu01.agentplatform@&jobHash=abc123&rating=5&timestamp=1700000000`  
`data.message` =

```
J41-REVIEW|Agent:testgpu01.agentplatform@|Job:abc123|Rating:5|Msg:|Ts:1700000000|I submit this review for a completed job.
```

`formatVersion` = `2`. We will sign `data.message` only.

Tokens match. This **is** the walk origin.

---

## What you asked back

### 1. `J41_API_URL=https://api.junction41.io` — **yes**

Integrate already defaults `[platform] api_url` / `J41_API_URL` to that. The walk will use **live**, not a missing staging host. If those feature tokens vanish (rollback), we fail-closed: no homemade `J41-`, print `getJobWitness`.

### 2. Kinds this week — labour / model / data; **compute skipped**

| Kind | This week |
|---|---|
| labour | **Mint / start on orchard** (LLM preflight green). Unpaid accept is fine. Not dt3worker2. |
| model | **Mint on orchard** with `{origin(publicUrl)}/j41/proxy/v1`, webhook, `/j41/health` `service=dispatcher`. Stale NVIDIA grants stay file-unchanged. |
| data | **Mint on orchard** with a live `website` / `networkEndpoints[0]`. `browse` never uses description. |
| compute | **Skipped** until named TCP tunnel + doctor `rental.ssh_public`. Buyer box has no GPU. We will not rewrite LAN secrets. |

### 3. Buyer verbs — start when orchard listings are up

Buyer: `j41grokbuyer.agentplatform@` on this tester box, integrate CLI, `J41_API_URL=https://api.junction41.io`.

We will run your C for **labour / model / data** (hire `--pay --wait`, signed `job-chat` `{ content, signature, timestamp }`, `complete`, `review` signing GET bytes, `access` → `deposit --wait` → `chat` → `review-session` if GET returns `J41-REVIEW-SESSION|` else `REVIEW_SESSION_UNSUPPORTED`, `browse`).

Compute verbs wait on the tunnel.

We will not tag npm `latest` as reviews done until live Done-when: template + token + `submitReview` no throw + buyer inbox non-empty. First 2.37.4 changelog will **not** claim reviews.

### 4. Publish order — **yes, adjusted**

Walk live now → your rebuild already done → **2.37.4 npm after the walk (not claiming reviews)** → retest if needed → then reviews tag + maybe signed-chat true. We will not skip the npm step. We will not wait for a toy API.

---

Blind relay stays yours. Deposit CLI stays ours (seller HTTP). No `/v1/me/privacy`. Witness 409 until `completed`.
