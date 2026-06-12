# Junction41 platform/SDK changes for dispatcher v3

> **Who this is for.** The owner, working in the **junction41 platform** repo
> (and `@junction41/sovagent-sdk`), implementing the server-side half of the
> dispatcher v3 work. The dispatcher-side changes (WP-D4 budget hardening,
> WP-D1/D2 control API) are already on the `dispatcher-v3` branch; this doc is
> the *backend* counterpart so the deferred halves close and WP-D3 (the buyer
> "hirer") can be built.
>
> Companion docs: `docs/plans/2026-06-11-dispatcher-v3-headless-hirer-brainbox.md`
> (the master plan; WP-D3/D4/D5 referenced below).

Each item below states **what exists today** (grounded in the installed SDK
`@junction41/sovagent-sdk@2.6.3`), **the change**, the **wire shape**, the
**fail-closed rule**, and an **acceptance check**. Items are ordered by
priority: **P0** unblocks WP-D4 correctness already shipped on the dispatcher;
**P1** unblocks WP-D3 (the hirer).

> **Status update (2026-06-11).** The **SDK/client halves of P0-1, P0-2, and
> P1-1 are implemented** in `j41-sovagent-sdk` on branch
> `dispatcher-v3-budget` (commit `ee43d2c`, +10 tests, build clean) — pending
> an npm publish. What remains is **platform-server** work plus P1-2's
> answers. Each item below now marks ✅ what the SDK already does and ⬜ what
> the server still owes, so you can implement straight against the shapes the
> client already sends/expects.

---

## P0-1 — Signed token-usage in the deletion attestation (WP-D4 finding #6)

**Why.** Extension requests are only *trustable* if both sides sign over the
same usage story. The dispatcher already meters `{promptTokens,
completionTokens, llmCalls, extensions[]}` per job and now writes it into the
attestation **sidecar** and the on-chain job record. But the sidecar field is
**unsigned** — it sits next to the signature, not inside the signed bytes — so
a buyer can't cryptographically trust it. Making it trustworthy requires it to
be part of the **canonical, signed** attestation payload.

**What exists today.**
- `generateAttestationPayload(params)` (SDK `dist/privacy/attestation.js`)
  returns a *fixed* object: `{ attestedBy, containerId, createdAt, dataVolumes,
  deletionMethod, destroyedAt, jobId }`, keys sorted. The signature is the
  Verus signature over the JCS canonicalization of exactly this object.
- `verifyAttestationFormat()` checks required string fields + `dataVolumes`
  array. It does **not** reject unknown fields (lenient), but it also doesn't
  validate a usage field.
- Backend route: `POST /v1/jobs/:id/deletion-attestation` (submit) and
  `GET /v1/jobs/:id/deletion-attestation` (read). The backend re-canonicalizes
  the received payload (minus `signature`) and verifies the signature against
  `attestedBy`'s key.

**✅ SDK — DONE (`ee43d2c`).** `generateAttestationPayload` accepts an optional
`tokenUsage` and, when present, adds it plus `schemaVersion: 2` to the canonical
payload. Input is **normalized** to a whitelisted, integer-coerced shape (counts
floored to non-negative ints, unknown keys dropped, `amountVrsc` forced to a
finite number or `null`) so the signed bytes are deterministic and can't carry
caller-injected fields. Without `tokenUsage` the payload is byte-identical to
v1. `verifyAttestationFormat` now validates the usage block and **throws** on
anything malformed. `verifyAttestationSignature` already covers the new fields
(it canonicalizes all non-signature keys), so tampering breaks the signature —
tested. New exports: `AttestationTokenUsage`, `AttestationExtension`,
`ATTESTATION_SCHEMA_VERSION`.

**The exact canonical shape the SDK now emits (server must match byte-for-byte).**
JCS sorts keys recursively, so the server just needs the same field set and the
same JCS lib (`json-canonicalize`). A v2 payload (pre-signature) is:
```jsonc
{
  "attestedBy": "myagent.agentplatform@",
  "containerId": "container-abc",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "dataVolumes": ["/tmp/vol1"],
  "deletionMethod": "container-destroy+volume-rm",
  "destroyedAt": "2025-01-01T00:05:00.000Z",
  "jobId": "job-123",
  "schemaVersion": 2,
  "tokenUsage": {
    "completionTokens": 12000,
    "extensions": [
      { "amountVrsc": 0.42, "estimatedTokens": 8000, "granted": true, "grantedTokens": 8000 },
      { "amountVrsc": null, "estimatedTokens": 5000, "granted": false }
    ],
    "llmCalls": 7,
    "promptTokens": 30000,
    "totalTokens": 42000
  }
}
```
Note `grantedTokens` is present only on granted extensions; `amountVrsc` is
`null` when no rate was available at request time. (The normalizer omits
`grantedTokens` rather than emitting `null`, so the server must treat it as an
optional key, not a nullable one.)

**⬜ Backend — still owed.**
1. When re-canonicalizing the received attestation for signature verification,
   include `tokenUsage` + `schemaVersion` (don't strip unknown keys before
   hashing) — use the same JCS lib. v1 attestations (no `tokenUsage`, no
   `schemaVersion`) must keep verifying unchanged.
2. Persist the usage with the job record; surface it on
   `GET /v1/jobs/:id/deletion-attestation`. Mirror the SDK's format validation
   (counts non-negative integers; `extensions` an array of
   `{estimatedTokens:int, granted:bool, amountVrsc:number|null, grantedTokens?:int}`).
3. The dispatcher also writes `jobRecord.tokenUsage` into the **on-chain** VDXF
   job record (summary counts + `extensionsRequested`/`extensionsGranted`). If
   the marketplace indexes job records, surface these so a buyer browsing
   history sees "N tokens, M extensions" per completed job.

**Fail-closed rule.** A v2 attestation whose `tokenUsage` is malformed or whose
signature doesn't cover it must be **rejected** (treated as an invalid
attestation), never accepted-and-ignored. Silent acceptance would let a seller
forge usage.

**Acceptance check.** The SDK test `test/attestation-usage.test.ts` already
proves: a v2 attestation verifies with a known WIF; mutating any byte of
`tokenUsage` (a count or an extension flag) fails `verifyAttestationSignature`;
a v1 attestation still verifies. The server side passes when it reaches the same
verdicts on those same payloads.

**Dispatcher follow-up (I'll do once the SDK is published/linked).** Switch
`performCleanup()` in `src/job-agent.js` from writing `tokenUsage` into the
sidecar JSON to passing it into `generateAttestationPayload({ …, tokenUsage })`
so it's inside the signed bytes. (Search `_usageRecord` in job-agent.js — the
data is already assembled; only the plumbing target changes.) This needs no
backend change to *produce*; the backend only needs item ⬜1 to *verify* it.

---

## P0-2 — Platform VRSC/USD rate endpoint (WP-D4 finding #3)

**Why.** Job payments are in VRSC; LLM costs are in USD. The dispatcher must
convert to derive token budgets and price extensions. Today there is **no rate
source**: the operator hand-sets `[budget].vrsc_usd_rate` in `config.toml`, and
if it's unset/stale the dispatcher fails closed (fallback budget, no
auto-priced extensions). That's safe but means budgets are only as good as a
manually-maintained number. The master plan (WP-D4 #3, WP-D3 spend safety)
calls for a "platform-provided VRSC rate, cached, with a stale-rate
fail-closed."

**What exists today.** `queryPricingOracle`/`recommendPrice` (SDK) and
`GET /v1/pricing/recommend` **take** `vrscUsdRate` as an *input* param — nothing
*provides* it. Confirmed: no rate endpoint in the SDK client.

**✅ SDK — DONE (`ee43d2c`).** `client.getVrscUsdRate()` calls
`GET /v1/pricing/vrsc-rate` and returns the typed `VrscUsdRate`
(`{ usdPerVrsc, asOf, source?, ttlSeconds? }`).

**⬜ Backend — still owed.** Implement `GET /v1/pricing/vrsc-rate` →
```jsonc
{
  "usdPerVrsc": 0.47,          // USD value of 1 VRSC
  "asOf": "2026-06-11T09:00:00Z", // ISO-8601; the dispatcher fails closed on staleness
  "source": "coingecko|internal-oracle|manual",
  "ttlSeconds": 300            // suggested cache life before re-fetch
}
```
Source can be whatever you already trust (an exchange feed, an internal oracle,
or a manually-set value to start). The contract is just: a number, a timestamp,
and a TTL. `usdPerVrsc` must be `> 0` and finite; `asOf` must be present (the
dispatcher treats a missing/old `asOf` as "no rate").

**Fail-closed rule (dispatcher side, already implemented for the env path —
mirror it for the endpoint).** If the endpoint is unreachable, returns a
non-positive/non-finite rate, or the cached value is older than its TTL ×
a slack factor, the dispatcher treats the rate as **missing**: jobs fall back
to `fallback_token_budget` and extensions are **not** auto-priced. A bad rate
must never produce an unlimited budget or an invented price.

**Acceptance check.** `GET /v1/pricing/vrsc-rate` returns the shape above with a
fresh `asOf`. Stopping the feed makes `asOf` go stale; the dispatcher (once
wired) reverts to fallback budgets rather than pricing off a stale number.

**Dispatcher follow-up (I'll do once endpoint lands).** Add a poller that
fetches the rate on `ttlSeconds`, caches `{usdPerVrsc, asOf}`, and stamps it
into job containers as `J41_VRSC_USD_RATE` + `J41_VRSC_USD_RATE_AT` — replacing
the operator-set value as the *default* source. `src/token-budget.js` already
consumes exactly those two env vars with staleness checks, so no math changes.

---

## P1-1 — Round-trip the extension token count (bug + WP-D4 #6)

**Why.** When the dispatcher requests a budget extension it knows the token
count it needs; when the buyer approves, the dispatcher must grant **exactly
that many** tokens. Today the platform never learns the count, so the approval
webhook can't echo it and the dispatcher has to guess / hold it in memory
(lost on restart).

**✅ SDK — DONE (`ee43d2c`).** `client.requestExtension(jobId, amount, reason,
estimatedTokens?)` now sends `estimatedTokens` in the POST body when supplied
(omitted otherwise — backward-compatible). `JobExtension` gains an optional
`estimatedTokens` field so it round-trips through `GET …/extensions`.

**⬜ Backend — still owed.**
1. Accept the optional `estimatedTokens` (non-negative integer) on
   `POST /v1/jobs/:id/extensions`; persist it on the extension record.
2. Echo it back on:
   - the extension record (`GET /v1/jobs/:id/extensions`), and
   - the `job.extension_approved` webhook payload as `data.estimatedTokens`
     (and, if the approved amount can differ from the requested, an explicit
     `data.grantedTokens`).

**Fail-closed rule.** If `estimatedTokens` is absent on approval, the
dispatcher keeps its current conservative fallback (re-derive from the granted
VRSC amount, or re-request) — so this is a robustness upgrade, not a hard
dependency. Nothing should *over*-grant from a missing field.

**Acceptance check.** Request an extension with `estimatedTokens: 8000`; the
`job.extension_approved` webhook carries `estimatedTokens: 8000`.

---

## P1-2 — WP-D3 "hirer" (buyer mode): what the platform already gives us

Good news: the platform is largely **symmetric** — most buyer-side operations
already exist. The hirer is mostly dispatcher-side glue over these. This
section is **confirmation + a few open questions**, not a big build.

**Already present (SDK `dist/client/index.js` + `dist/buyer/session.js`):**

| Hirer need | Existing platform surface |
|---|---|
| Discover services | `GET /v1/search`, `GET /v1/services` (q/category/min-max price/sort) |
| Build + sign a job request | `GET /v1/jobs/message/request` → sign → `POST /v1/jobs` (`createJob`) |
| Pay | `POST /v1/jobs/:id/payment`, `/payment-combined`, `/platform-fee`; `getPaymentQr`, `GET /v1/tx/verify-payment` |
| Chat relay | `POST /v1/jobs/:id/messages`, `GET …/messages`; `BuyerSession.send/sendAndWait` |
| Delivery | `GET /v1/jobs/:id` (delivery hash/status), `GET …/files`, `GET …/deletion-attestation` |
| Accept / dispute | `POST /v1/jobs/:id/complete`, `/dispute`, `/reject-delivery` |
| Extensions (buyer side) | `GET /v1/jobs/:id/extensions`, `/approve`, `/reject`, `/extension-invoice` |
| Buyer session lifecycle | `BuyerSession.start/send/sendAndWait/connectWorkspace/endSession/getJob` |

So `/v1/hire/*` in the master plan is a **dispatcher-local** API that wraps the
above; it does **not** require new platform job/payment endpoints. The hirer
adds its own caps + custody on top (dispatcher side).

**Open questions for you (these decide whether WP-D3 needs *any* backend work):**

1. **Buyer identity.** `createJob` needs a signed request from a buyer VerusID.
   The hirer will use its own VerusID + WIF (`~/.j41/hirer/keys.json`). **Does
   the platform require the buyer VerusID to be onboarded/registered as an
   agent, or can any valid VerusID (or even a transparent R-address) post and
   pay for jobs?** If onboarding is required, the hirer needs an onboarding
   step and we should reuse `dist/onboarding/*`; if not, the hirer is much
   thinner. *This is the single most important answer for scoping WP-D3.*

2. **Payment handshake.** Confirm the exact buyer pay→verify sequence for a job:
   does the buyer (a) call `POST /v1/jobs/:id/payment` with a signed intent,
   (b) send VRSC to a platform-provided address from `getPaymentQr`, then (c)
   the platform confirms via `verify-payment`/tx watch? A 4-line sequence
   diagram in your reply is enough; the hirer just needs the canonical order.

3. **Discovery filters.** `GET /v1/search` vs `GET /v1/services` — which is the
   intended buyer discovery entry point, and does either already support
   `max_price` + `category` + free-text `q` together? (The SDK `getServices`
   params suggest yes; just confirming the canonical one to proxy.)

4. **Held-messages / SovGuard on the buyer leg.** The chat relay has
   `held-messages` (release/appeal/reject). For a headless hirer relaying a
   buyer brief, what's the expected behavior when an outbound buyer message is
   held — does the buyer get a webhook, and is there an auto-release policy, or
   must a human/agent always adjudicate? Affects whether the hirer can run
   fully unattended.

**No backend change anticipated for WP-D3 beyond answering the above** — but
flag anything in the buyer flow that assumes a human in a browser (CSRF tokens,
session cookies, captcha, email confirmation), since the hirer is headless and
authenticates by signature/bearer like the seller side.

---

## P2 — Nice-to-haves (not blocking; note if cheap)

- **Extension invoice symmetry.** `GET /v1/jobs/:id/extension-invoice?amount=`
  exists; confirm it returns the platform-fee breakdown so the hirer can show
  the buyer the true cost (fee + seller pay) before approving.
- **Webhook event vocabulary.** The dispatcher's new `/v1/events` feed
  normalizes platform webhook names (e.g. `job.extension_approved` →
  `extension.approved`). If the platform ever renames webhook events, a
  heads-up keeps the mapping (`WEBHOOK_EVENT_MAP` in `src/cli.js`) honest.
- **Reputation/usage display.** If P0-1's on-chain `tokenUsage` lands, consider
  surfacing per-agent aggregate usage/extension stats on
  `GET /v1/reputation/:verusId` so buyers can see who runs lean.

---

## Summary checklist

| # | Change | SDK/client (✅ done `ee43d2c`) | Server still owes |
|---|---|---|---|
| P0-1 | `tokenUsage` in **signed** attestation (+schema v2) | ✅ payload + validation + types + tests | ⬜ re-canonicalize incl. `tokenUsage` on verify; persist + surface; mirror validation |
| P0-2 | VRSC/USD rate | ✅ `client.getVrscUsdRate()` + `VrscUsdRate` type | ⬜ implement `GET /v1/pricing/vrsc-rate` value |
| P1-1 | `estimatedTokens` round-trip | ✅ `requestExtension(…, estimatedTokens?)` + field | ⬜ accept/persist/echo on record + `extension_approved` webhook |
| P1-2 | WP-D3 buyer-flow | n/a (mostly dispatcher glue) | ⬜ answer 4 questions (esp. buyer-identity onboarding) |

**Net for you:** publish the SDK branch (so the dispatcher can consume it), then
the four ⬜ server items above. Once the SDK is published/linked I wire the two
dispatcher follow-ups (sign `tokenUsage` into the attestation; add the
VRSC-rate poller) — both degrade closed if the matching server item isn't live
yet, so they're safe to land ahead of the platform. P1-2's answers determine how
much WP-D3 there is to build.
