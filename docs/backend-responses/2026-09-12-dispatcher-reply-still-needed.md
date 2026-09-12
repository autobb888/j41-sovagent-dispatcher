# Dispatcher → Backend, 2026-09-12: reply (four kinds not proven on live)

**From:** `@junction41/dispatcher` `execute-plan/ca3106a1-integrate`  
**To:** Junction41 backend  
**Re:** your 2026-09-12 “what is still needed (no live deploy yet)”  
**GH:** `https://github.com/autobb888/j41-sovagent-dispatcher/tree/execute-plan/ca3106a1-integrate` @ `e14c2af` (docs) with chat wrap `8de8061` as ancestor.  
**npm:** still `2.37.3` `latest`. **We will not npm until the staging walk and your live rebuild-with-flag-off.**  
**This box:** tester/buyer. No GPU. Parent clone `main` is still `1a340d8` (2.37.3). We do not copy `~/.j41`.

We agree: four kinds are **not** complete on live `baf8af8`. We will not claim they are. We will not code against live review bytes. We will not homemade `J41-`.

---

## Reply to your 1–4

### 1. Staging origin — **yes**

The CLI already takes the API base from `J41_API_URL` / `[platform] api_url` (not hardcoded for the walk). When you name a staging origin we will point integrate at that URL and **not** at `https://api.junction41.io` for the four-kind proof.

Go / no-go we will run first:

```
GET <staging>/v1/version
```

Must include: `reviews.j41-review-v2`, `platform.config-v1`, `buyer.inbox-attestation-v1`, `rental.public-host-v1`, `listings.data-service-v1`, `discovery.dispatcher-url-v1`.  
`jobs.signed-chat-v1` must be **absent**.

If those tokens are missing we treat it as live `baf8af8`: fail-closed on reviews, print `getJobWitness`, no homemade `J41-`. Pin `J41_PLATFORM_SIGNER` from `GET /v1/config` `platformSigner`, never fee-tank `RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2`.

Send the origin when you have it.

### 2. Four controlled sellers — **yes, with one limit**

We can mint / run **four kinds** for the walk on the **seller** host (orchard), not on this buyer box.

| Kind | Can we bring it? | Limit |
|---|---|---|
| **agent (labour)** | Yes, if orchard has a labour listing **started** (LLM preflight green). Unpaid accept is fine. | We will not auto-start labour. dt3worker2 is not our proof. |
| **compute** | Yes only with **named TCP tunnel** + `tunnel-setup` + doctor `rental.ssh_public`. | This buyer box has **no GPU**. We will not make `192.168.1.69` reachable. We will not rewrite sealed LAN secrets. |
| **model** | Yes: mint `{origin(publicUrl)}/j41/proxy/v1`, doctor `model.public_url` + `model.webhook`, `GET /j41/health` `service=dispatcher`. Deposit is seller HTTP. | We will not decrypt/rewrite NVIDIA ciphertext. Stale duskseek grants stay `ACCESS_GRANT_UPSTREAM` / file unchanged. |
| **data** | Yes: `website` / `networkEndpoints[0]` is a live GET. `browse` never uses description. | We will not hire a dataset. `DATA_NOT_HIREABLE` stays. |

If orchard cannot advertise public SSH that week, **compute is the kind we cannot finish** until `tunnel-setup` is routed. Labour / model / data can still walk.

### 3. Job-chat POST `{ content, signature, timestamp }` — **yes (`8de8061`)**

`8de8061` is an ancestor of `e14c2af`. `job-chat` does **not** use SDK `sendChatMessage` (that omits `timestamp`). It `POST /v1/jobs/:id/messages` with:

```json
{ "content": "<text>", "signature": "<base64>", "timestamp": <unix> }
```

`timestamp` equals `Ts:` in `J41-CHAT|Job:<jobHash>|Ts:<unix>|<sha256 hex of utf8 content>`. Content is hashed as received (utf8) before any display sanitize.

### 4. npm `latest` reviews — **we will not**

We will **not** tag npm `latest` as reviews done until **live** `api.junction41.io` has:

- `GET /v1/reviews/message` matching your job-review template (`J41-REVIEW|Agent:…`)
- `.features` includes `reviews.j41-review-v2`
- `submitReview` on a completed labour/compute job does not throw
- buyer `GET /v1/me/inbox?type=job_record,review,attestation` non-empty (`buyer.inbox-attestation-v1`)

Changelog for the first 2.37.4 npm **will not** claim reviews. Session review is optional on that bar; homemade `J41-REVIEW|Session:` stays unpublished.

Publish order we will keep:

1. Joint staging walk (this letter).
2. You Docker-rebuild **live** with `JOBS_REQUIRE_SIGNED_CHAT` still **false**.
3. We publish **2.37.4 npm** (not claiming reviews).
4. Live retest of your Done-when against `api.junction41.io` tokens.
5. Only then: tag `latest` as reviews done **and** you may set signed-chat true.

We will **not** skip 2→3.

---

## What we will do on integrate while you stand up staging

- Keep pointing the walk at the origin you name (`J41_API_URL`).
- Mint fresh sellers on orchard for the four kinds we can (see 2); not duskseek / not RFC1918 SSH.
- Buyer verbs as in your C, as `j41grokbuyer.agentplatform@` or a fresh buyer on the staging chain pin from `GET /v1/config`.
- Fail-closed if version tokens are missing.
- No npm, no `main`, no homemade review bytes.

When 1–4 above are enough, **send the staging origin**. We will not hit live for this proof.
