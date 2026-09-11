# Backend → Dispatcher, 2026-09-11: five answers (2.37.4)

**Re:** `docs/backend-responses/2026-09-11-dispatcher-2.37.4-need-before-code.md`  
**Context:** `docs/backend-responses/2026-09-11-dispatcher-2.37.4-what-we-changed.md`  
**SDK we call:** `@junction41/sovagent-sdk@2.16.1`  
**Live API today:** still `Junction41 Review` / no `reviews.j41-review-v2`. **Do not code against live.** Gate on `GET /v1/version` `.features`.

These five are the contract.

---

## 1. Exact job-review template — ACK

`GET /v1/reviews/message?agentVerusId=<agent>&jobHash=<jobHash>&rating=<1-5>`  
optional: `&message=<text>&timestamp=<unix>`

If `timestamp` omitted, they fill `Math.floor(Date.now()/1000)` and return it as `data.timestamp`. Sign **exactly** `data.message`. Do not sign `data.instructions`. Rating is required integer 1–5 (`Number` + `Number.isInteger`; `1.5` → 400). Empty `message` → empty `Msg:` (not `No message`).

**`data.message`:**

```
J41-REVIEW|Agent:<agentVerusId>|Job:<jobHash>|Rating:<1-5>|Msg:<text>|Ts:<unix>|I submit this review for a completed job.
```

Worked example (`rating=5`, empty message, `timestamp=1700000000`):

```
J41-REVIEW|Agent:testgpu01.agentplatform@|Job:abc123|Rating:5|Msg:|Ts:1700000000|I submit this review for a completed job.
```

`Agent:`, `Msg:`, trailing sentence `I submit this review for a completed job.` are load-bearing — POST rebuilds this line. A sketch without `Agent:` will 401.

`data.formatVersion` = `2`. Feature token: `reviews.j41-review-v2`.

**Not live today.** Until that token is on `api.junction41.io`, GET still serves the 9-line `Junction41 Review` block. Keep fail-closed. Do not claim reviews on npm `latest`.

---

## 2. Chat body — `{ content, signature, timestamp }` — YES

They verify:

```
J41-CHAT|Job:<jobHash>|Ts:<unix>|<hex sha256 of utf8 content>
```

**POST** `/v1/jobs/:id/messages`:

```json
{ "content": "<text>", "signature": "<base64>", "timestamp": 1700000000 }
```

| Field | Required when they verify | Rule |
|---|---|---|
| `content` | yes | UTF-8 string. Hash is `sha256(utf8 bytes of this field as received)` **before** they sanitize for storage. |
| `signature` | yes (once flag on) | Over the `J41-CHAT|…` line, not over raw `content`. |
| `timestamp` | **yes** | JSON number, unix seconds. **Must equal `Ts:` in the signed line.** They will not parse `Ts:` out of the signature. No time window. |

SDK 2.16.1 `sendChatMessage(jobId, content, signature)` POSTs `{ content, signature }` only. **That cannot verify `J41-CHAT`.** Dispatcher must wrap the POST so the body includes `timestamp` matching `Ts:`.

Until that wrap exists **and** 2.37.4 is what VRSCTEST buyers run, they will **not** 4xx unsigned POSTs on live. Dashboard website chat is WS and is not this path.

---

## 3. Session-review GET — route will exist; homemade `J41-REVIEW|Session:` will 401

**Not live today.** `GET /v1/reviews/message` currently **requires** `jobHash` → 400 `MISSING_PARAMS` if omitted (not 404). `POST /v1/reviews/api-session` already exists and today verifies the multiline `Junction41 API Session Review` block.

After their PR 1 (`reviews.j41-review-v2`):

`GET /v1/reviews/message?agentVerusId=<agent>&sessionId=<uuid>&rating=<1-5>`  
optional: `&message=<text>&timestamp=<unix>`

- `jobHash` xor `sessionId`. Both or neither → 400.
- Same rating / empty-`Msg:` rules as job review.
- Sign `data.message`. Fail-closed `/^J41-/` plus bound `sessionId` and `String(rating)`.

**`data.message`:**

```
J41-REVIEW-SESSION|Agent:<agentVerusId>|Session:<sessionId>|Rating:<1-5>|Msg:<text>|Ts:<unix>|I submit this review for an API session.
```

Worked example (`rating=5`, empty message, `timestamp=1700000000`):

```
J41-REVIEW-SESSION|Agent:duskseek.agentplatform@|Session:11111111-1111-1111-1111-111111111111|Rating:5|Msg:|Ts:1700000000|I submit this review for an API session.
```

POST `/v1/reviews/api-session` will verify that line (v2 then v1 dual-accept). They accept **`sessionId` or `apiSessionId`**.

SDK `getReviewMessage` still requires `jobHash`. Extra `{ sessionId }` is ignored. **Raw-GET** the query above. **Do not homemade** `J41-REVIEW|Session:<id>|Rating:|Ts:|<text>` — they will 401 it.

Until the token is live: if GET cannot return a `J41-REVIEW-SESSION|` line, fail `REVIEW_SESSION_UNSUPPORTED`. Optional for npm `latest` “reviews done”; job review (1) is the bar.

---

## 4. Publish order — ACK

1. We publish **2.37.4 npm**. Changelog **does not** claim reviews shipped.
2. **Then** they flip unsigned `POST /v1/jobs/:id/messages` to 4xx on live (`JOBS_REQUIRE_SIGNED_CHAT=true`, token `jobs.signed-chat-v1` only while that flag is on).

They will **not** 4xx unsigned chat on live while 2.37.3 is still `latest`.

Verify-`J41-CHAT` code can land behind their flag default-off before our npm; the **live** flip waits on our publish **and** on the wrapped `{ content, signature, timestamp }` body.

---

## 5. Buyer inbox — ACK, same allowlist + JCS flatten

Buyer-directed items use the **same** inbox types, VDXF i-addresses, and `vdxf_data` shapes as seller. Consume with the existing seller allowlist-passthrough. Do **not** `buildIdentityUpdateTx` homemade buyer VDXF.

| inbox type | VDXF key | i-address (fallback; chain map may replace) |
|---|---|---|
| `review` | `review.record` | `iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad` |
| `attestation` | `review.attestation` | `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv` |
| `job_record` | `job.record` | `iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn` |

`GET /v1/jobs/:id/witness` stays **409 `NOT_WITNESSABLE` until `completed`**. Skip. No hire-time `job_record`.

**`job_record` equality (not HTTP-body identity):**

GET returns `{ data: { record, witness } }`.

Inbox hex under `job.record` is `encodeVdxfValue({ ...signed.record, witness: signed.witness })` — flattened JSON, **not** `{ record, witness }`. Those two JSON documents are **not** the same bytes.

Once:

1. Decode inbox hex under `job.record`.
2. `decoded.witness` deep-equals `GET.data.witness`.
3. `JCS(decoded without witness)` equals `JCS(GET.data.record)` (RFC 8785 `json-canonicalize` → same `datahash` as `jobRecordDataHash`).
4. `verifyWitness` on that witness as we do today.

Do **not** `JSON.stringify(GET.data)` against the hex JSON.

Sibling `jobId` (for inbox `jobDetails`) lives on the **shared** `vdxf_data` object next to the i-address key, **never inside the hex**.

Review / attestation copies are opaque hex under those keys. No witness gate. Buyer `review` after seller accept of the standalone seller item (or inline complete+rating in the same `completeJob` block). Skip `reviews.insert` on the given-copy (recipient is the buyer).

`GET /v1/agents/:id/attestations` is **deletion**, not hire proof. Empty `[]` after GPU complete is not a miss of this inbox.

Feature token when live: `buyer.inbox-attestation-v1`. Until then, print `getJobWitness`.

---

## When to tag npm `latest` as reviews done

Wait until **all** of:

- Live `GET /v1/reviews/message?…&rating=5` `data.message` equals the template in (1) (prefix `J41-REVIEW|`, binds that hash + `5`).
- `GET /v1/version` `.features` includes `reviews.j41-review-v2`.
- `submitReview` on a `completed` labour/compute job does not throw.
- As that buyer, `GET /v1/me/inbox?type=job_record,review,attestation` is non-empty after complete+review (`buyer.inbox-attestation-v1`).

Session review (3) is **not** on that bar.
