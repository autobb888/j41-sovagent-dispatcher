# Dispatcher 2.37.4 — need from backend before we code / push

**Date:** 2026-09-11  
**From:** dispatcher  
**To:** Junction41 backend  
**Live npm:** `@junction41/dispatcher@2.37.3`  
**Assembled, not pushed:** `execute-plan/ca3106a1-integrate` @ `1c6834e`  
**SDK:** `@junction41/sovagent-sdk@2.16.1`

**Answered 2026-09-11:** `docs/backend-responses/2026-09-11-backend-five-answers.md`

Please answer these five. We will not guess. Longer context: `docs/backend-responses/2026-09-11-dispatcher-2.37.4-what-we-changed.md`.

---

## 1. Ack the exact job-review line

SDK `submitReview` signs **exactly** `GET /v1/reviews/message` (no rewrite). Live today is `Junction41 Review` → `REVIEW_NOT_CANONICAL`.

We need you to **ack the exact bytes**, including:

- `Agent:`
- `Msg:`
- the **trailing sentence**

Prefix must be `J41-` and the line must contain `jobHash` and `String(rating)` (SDK 2.16.1). Do not tell us “something like `J41-REVIEW|Job:…|Rating:…|Ts:…`” — paste the live template with those fields filled as placeholders.

Until you ack that string, we will not change job-review code and we will not claim reviews on npm `latest`.

---

## 2. Chat POST body — `{ content, signature, timestamp }`?

We sign:

```
J41-CHAT|Job:<jobHash>|Ts:<unix>|<hex sha256 of utf8 content>
```

**Assembled 2.37.4 today** calls SDK `sendChatMessage(jobId, content, signature)`, which POSTs:

```json
{ "content": "<text>", "signature": "<base64>" }
```

**No `timestamp` field in the JSON.** `Ts:` lives only inside the signed string.

**Question:** will you verify `J41-CHAT` from `{ content, signature, timestamp }` on `POST /v1/jobs/:id/messages`?

- If **yes** — we cannot ship verifiable chat on SDK 2.16.1 as-is. Say so; we will wrap the POST (or wait on an SDK bump) so the body includes `timestamp` matching `Ts:`.
- If **no** (you recover `Ts:` from the signed line, or you do not verify yet) — say so. Then 2.37.4 can POST `{ content, signature }` and still sign.

If we do not POST `timestamp` and you require it to rebuild the line, **you cannot verify `J41-CHAT`.** Do not flip unsigned POSTs to 4xx until this is agreed (see 4).

---

## 3. Session review — `J41-REVIEW-SESSION|` from GET, not homemade

Model grants have `sessionId`, no `jobHash`.

**Assembled 2.37.4 today** homemade-signs:

```
J41-REVIEW|Session:<sessionId>|Rating:<n>|Ts:<unix>|<text>
```

unless a GET message helper is injected.

You said **homemade will 401**. We will not keep that line.

**Question:** will `GET /v1/reviews/message` (or a session-specific GET) return canonical:

```
J41-REVIEW-SESSION|…
```

for us to sign, same fail-closed as job review (`/^J41-/` + bound sessionId + rating)?

If that GET 404s, we fail `REVIEW_SESSION_UNSUPPORTED`. We will **not** homemade `J41-REVIEW|Session:` against a verifier that 401s it.

Ack the exact session line the same way as (1), or tell us the route does not exist.

---

## 4. Publish order

1. We publish **2.37.4 npm** (changelog **does not** claim reviews shipped).
2. **Then** you flip unsigned `POST /v1/jobs/:id/messages` to **4xx** on live.

Do not 4xx unsigned chat on live while 2.37.3 is still `latest` — labour chat there is unsigned. Confirm this order.

---

## 5. Inbox consume — existing seller allowlist + JCS flatten

We still consume inbox with the **existing seller allowlist-passthrough**. We will **not** `buildIdentityUpdateTx` homemade buyer VDXF.

Types / keys:

| inbox type | VDXF | i-address |
|---|---|---|
| `review` | `review.record` | `iLbUN8TFvMZR9uaZYY1qBmL99bJE2uYdad` |
| `attestation` | `review.attestation` | `i76fJX1DreN81CoRVJHSkrcqHq9nsLomYv` |
| `job_record` | `job.record` | `iPsXc7vcBzAxyjFYfPAs9PUtMLh1EJPHSn` |

`job_record` gate (unchanged):

1. Decode inbox `vdxfData[job.record]` (live shape: hex JSON of `{ ...record, witness }`).
2. `GET /v1/jobs/:id/witness`.
3. `verifyWitness` on that witness.
4. Cross-check **JCS datahash** (RFC 8785 `json-canonicalize` → sha256), **not** `JSON.stringify`:
   - inbox record minus `witness` vs `witness.record`
   - inbox `witness` vs `witness.witness`

Confirm buyer-directed items use the **same** vdxf_data shapes so that flatten/JCS matches `GET /v1/jobs/:id/witness`. If you stringify or nest differently, we refuse and nothing lands on the buyer identity.

`job_record` 409 `NOT_WITNESSABLE` until `completed` is fine — we skip.

---

## Reply shape we can code against

Please reply 1–5 with:

1. Exact job-review template (copy-paste).
2. Chat body: `{ content, signature, timestamp }` **yes/no**. If yes, field names and whether `timestamp` must equal `Ts:`.
3. Exact session-review GET line **or** “no route, 404 forever”.
4. Ack: unsigned chat 4xx **after** 2.37.4 npm, not before.
5. Ack: buyer inbox = same allowlist + JCS flatten vs `/v1/jobs/:id/witness`.

Then we code the remaining chat/session-review POST shape, push, and only later tag `latest` as reviews done.
