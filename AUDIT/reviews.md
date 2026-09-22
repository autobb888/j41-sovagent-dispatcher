# Reviews audit — j41-sovagent-dispatcher

Date: 2026-09-15 · Domain: **reviews** (job `review` + model `review-session`) · Read-only pass, no code changed.

Scope: `src/buyer-review.js`, `src/buyer-review-session.js`, the CLI rinds in
`src/cli.js`, the TUI `api_review` path that POSTs the same session endpoint,
`test/buyer-review.test.js`, `test/buyer-review-session.test.js`, and the
contracted templates in `docs/backend-responses/2026-09-11-backend-five-answers.md`
and `2026-09-12-dispatcher-reply-walk-origin.md`.

**Headline:** the CLI buyer paths are the contract, implemented. Job review
signs GET `J41-REVIEW|` bytes only, binds `Job:`/`Rating:`/`Agent:`, POSTs
`client.submitReview` (HTTP, not `agent.submitReview`), and treats inbox
failure as `ok: true` + `inboxWarning`. Session review raw-GETs
`J41-REVIEW-SESSION|` (which does not start with `J41-REVIEW|`), never
assembles `J41-REVIEW|Session:`, and maps 404/non-canonical to
`REVIEW_SESSION_UNSUPPORTED`. CHANGELOG/README do not say "reviews shipped".

Two holes sit *next to* that helper, not inside it: the TUI still homemade-signs
JSON onto `POST /v1/reviews/api-session`, and `review-session` cannot see a
`sessionId` once the access grant's `expiresAt` has passed.

---

## Findings

| # | Sev | File:line | Summary |
|---|---|---|---|
| R1 | **med** | `src/dashboard.js:1968-1985` | TUI "Submit review for a buyer session" homemade-signs JSON (`canonicalize(payload)`), invents `sessionId = api-session-${agentId}-${buyerVerusId}`, and POSTs `client.submitApiSessionReview` with the **seller** WIF — no GET bytes, no `J41-REVIEW-SESSION\|` gate |
| R2 | low | `src/buyer-review-session.js:71-78` via `src/buyer-access.js:95-98` | CLI `review-session` has no `--session-id`; the only source is `loadAccessGrant`, which returns `null` on expiry, so a persisted `sessionId` becomes `REVIEW_SESSION_NO_SESSION` |

---

### R1 — med — TUI `api_review` homemade-signs JSON onto the session-review POST

**File:** `src/dashboard.js:1940-1992` (menu entry `:1614`)

**Path to it.** Seller agent detail → API Key Management (shown when the
agent has an `api-endpoint` service) → "Submit review for a buyer session".
`getMetrics(agentId)` lists credit-meter buyer ids. After confirm:

```js
const timestamp = Date.now();
const sessionId = `api-session-${agentId}-${buyerVerusId}`;
const payload = { agentVerusId: keys.iAddress || keys.identity, buyerVerusId, sessionId, ... rating, timestamp };
const signature = signMessage(keys.wif, canonicalize(payload), loadCfg().platform.network);
const result = await agent.client.submitApiSessionReview({ ...payload, signature });
```

That is the opposite of the contracted session path in
`submitBuyerApiSessionReview` (`buyer-review-session.js:129-191`):

1. No `GET /v1/reviews/message?sessionId=`.
2. Signature is over JSON, not `data.message`.
3. `sessionId` is synthesized, not the chat grant's UUID.
4. `timestamp` is `Date.now()` milliseconds, not unix seconds.
5. Signer is the **seller** (the TUI user), with `agentVerusId` set to that
   same identity — a self-review shape.
6. Prefix gate `startsWith('J41-REVIEW-SESSION|')` is never applied.

`test/buyer-review-session.test.js:47-57` and `:199-222` pin the CLI/helper
to never homemade `J41-REVIEW|Session:` and never POST without GET bytes.
They do not read `dashboard.js`. Five-answers §3: POST verifies the GET line
(v2 then v1 multiline dual-accept); homemade `J41-REVIEW|Session:` 401s.
JSON-canonicalize of a dispatcher-invented object is neither v2 nor the v1
multiline block.

**Trigger.** Operator with an `api-endpoint` service opens the TUI, picks a
buyer from credit meters, rates 5, confirms.

**Outcome.** Against the contracted v2 verifier this 401s (`❌ Failed: …`) —
availability / operator confusion, not a landed CLI review. If v1 dual-accept
is looser than the five-answers letter (platform-side, **UNVERIFIED**), a
seller-signed homemade payload could land a session review of the seller
with a fake `sessionId`. Either way the TUI is the one remaining homemade
writer onto `POST /v1/reviews/api-session`.

**Proposed fix (do not apply).** Delete the TUI action, or stop POSTing from
it. A seller-rates-buyer product is not `submitApiSessionReview`. Do not
"fix" it by assembling `J41-REVIEW|Session:` or `J41-REVIEW-SESSION|` locally.
If a seller-side review API exists, GET its bytes and sign those; otherwise
the menu item should say the buyer runs `j41-dispatcher review-session`.

---

### R2 — low — expired grant hides the only `sessionId` the CLI can use

**File:** `src/buyer-review-session.js:113-121` ← `resolveSessionId` `:71-78`
← `loadAccessGrant` `src/buyer-access.js:88-99`

**Path to it.** CLI `review-session` (`cli.js:3547-3556`) passes
`agentsDir` + `buyerId` + `seller` and does **not** expose `--session-id`.
Helper:

```js
const rec = grant || loadAccessGrant(agentsDir, buyerId, seller);
const sid = resolveSessionId({ sessionId, grant: rec, agentsDir, buyerId, seller });
if (!sid) return fail('REVIEW_SESSION_NO_SESSION', 'No sessionId on the grant. Chat the seller first …');
```

`loadAccessGrant` is the chat/access gate:

```js
if (!rec || !rec.apiKey || !rec.endpointUrl) return null;
if (rec.expiresAt) {
  const exp = Date.parse(rec.expiresAt);
  if (Number.isFinite(exp) && exp <= now) return null;
}
```

`persistGrantSession` (`buyer-access.js:102-107`) writes `sessionId` onto
that same file after `chat` (`cli.js:3898-3899`). The file still contains
`sessionId` after expiry; the loader pretends the file does not exist.

**Trigger.** `access` → `chat --message …` (sessionId saved) → wait until
`expiresAt` → `review-session <buyer> <seller> --rating 5 --yes`.

**Outcome.** `REVIEW_SESSION_NO_SESSION` / "Chat the seller first". Chat
will also fail (expired key), so the printed remedy does not recover the
id. Reviewing a finished model session after the grant TTL is a normal
buyer action; labour `review` has no equivalent clock.

TTL itself is platform-supplied on the access envelope
(`buyer-access.js:237`) — not re-measured here.

**Proposed fix (do not apply).** Read `sessionId` from the grant file
without the expiry/apiKey gate (a `loadGrantSessionId` that only needs
the JSON to parse), and/or add CLI `--session-id` as an override. Keep
`loadAccessGrant`'s expiry check for `chat`.

---

## Claims checklist

48 claims in `AUDIT/reviews-claims.md` — 45 VERIFIED · 3 DRIFT (B2 → R1,
B7 → R2, B11 help-text only, not reported) · 0 MISSING · 0 UNVERIFIED.

---

## Adversarial pass

Question: shortest path from untrusted input (platform GET, job record,
grant file, operator flags, TUI) to a *landed* review that is unbound,
homemade, double-GET, or a buyer VDXF write.

**1. Platform GET returns `Junction41 Review` (the live-until-v2 body).**
`submitBuyerJobReview` `buyer-review.js:159-164` → `REVIEW_NOT_CANONICAL`,
`signed = 0`, `posted = 0`. Session GET of the v1 multiline block →
`REVIEW_SESSION_UNSUPPORTED` (`buyer-review-session.js:149-154`). No sign.

**2. Platform GET returns `J41-COMPLETE|…` containing the hash and rating.**
`isJobCanonical` requires `startsWith('J41-REVIEW|')`. Refused
(`test/buyer-review.test.js:157-175`).

**3. Platform GET returns `J41-REVIEW-SESSION|…` on the job route.**
Does not start with `J41-REVIEW|`. Refused. The pipe after `REVIEW` is
the whole point of the two prefixes.

**4. Platform GET returns `J41-REVIEW|Session:<uuid>|…` on the session route.**
`isSessionCanonical` requires `J41-REVIEW-SESSION|`. Refused; never
reassembled (`test/buyer-review-session.test.js:199-222`).

**5. Wrap `agent.submitReview` (double GET, new timestamp, signature
mismatch).** Not done. CLI and helper call `client.submitReview` /
`client.submitApiSessionReview` only. SDK `agent.submitReview`
(`sovagent-sdk/dist/agent.js:2066-2102`) is the helper the comments tell
you not to wrap; `test/buyer-review.test.js:342` pins it absent from
`cli.js`.

**6. Confused-deputy bind via `includes`.** `canonicalNotBound` is
substring, not a field parse. A GET line that names our `Job:`/`Rating:`/
`Agent:` inside `Msg:` would pass the client check. Five-answers §1: POST
**rebuilds** the line from POST fields, so the signature over the GET
bytes would 401. Client-side we would have signed junk; we would not land
a review for the wrong job. Not reported — fail-closed at the verifier
the contract named. The tests already cover the rating-vs-timestamp
substring (`Rating:1` vs `Ts:…0001`).

**7. After 2xx, write buyer VDXF or call `getAttestations`.** After POST
the only extra call is `getInbox('pending', 20, ['review','attestation'])`.
Throw is swallowed into `inboxWarning`. No `buildIdentityUpdateTx` on this
path.

**8. TUI homemade POST (R1).** This is the shortest path that *sends*
something the contract forbade. Landing is platform-dependent (v2 401
vs undocumented v1 looseness).

**9. Untrusted `--message` / `--rating`.** Rating is `/^[1-5]$/` before
any network call. Message is sent as the GET `message` query (omitted if
empty) and echoed on POST; the signed bytes are still the GET body, not
the operator string.

There is no path from a buyer CLI `review` / `review-session` invocation
to a homemade template or a buyer identity write. The TUI is the stray
writer.

---

## Checked and found clean

- Job prefix is `startsWith('J41-REVIEW|')`; session prefix is
  `startsWith('J41-REVIEW-SESSION|')`; the second does not satisfy the first.
- `parseRating` `/^[1-5]$/` in the helper and again in both CLI rinds
  before `confirmHire`.
- Bind checks for `Job:`/`Session:`, `Rating:`, `Agent:<seller>` with tests
  for missing Agent, wrong seller, wrong hash, rating-vs-timestamp.
- `client.submitReview` / `client.submitApiSessionReview` are HTTP POSTs
  (`sovagent-sdk/dist/client/index.js:1461-1468`). No second GET.
- Session message fetch is raw `client.request GET /v1/reviews/message?sessionId=`
  because SDK `getReviewMessage` always sets `jobHash`.
- Empty message omitted from GET query (empty `Msg:`, not `No message`).
- POST timestamp taken from GET `data.timestamp`.
- Job gates: `getJob`, `buyerOwnsJob`, `status === 'completed'`, missing
  `jobHash` / seller — CLI duplicates the first three before confirm.
- 2xx + throwing/empty `getInbox` still `{ ok: true, inboxWarning }`.
- No `getAttestations` in either review module or rind.
- No homemade `toSign = \`J41-REVIEW|…\`` in `buyer-review.js` /
  `buyer-review-session.js` / either CLI rind.
- CHANGELOG 2.37.2/2.37.3 and Unreleased do not say "reviews shipped";
  package is still 2.37.3. README omits the buyer review verbs (aligned).
- CLI `--json` requires `--yes`; JSON/result objects do not echo the WIF
  (pinned in tests).
- Seller `review.received` webhook no longer loops `acceptReview` (prior
  T2; now kicks `checkPendingInbox`; `test/review-webhook-batching.test.js`).
- `test/buyer-review.test.js` and `test/buyer-review-session.test.js` exist
  and pin the load-bearing refuses.

---

## Deliberately NOT covered, and why

- **Whether live `api.junction41.io` currently emits `J41-REVIEW|`.**
  Walk-origin (2026-09-12) and still-needed (same day) disagree about the
  live feature token. Dispatcher gates on **bytes**, not `/v1/version`.
  This pass did not call the network.
- **Platform POST verifier (rebuild vs signed-bytes, v1 dual-accept).**
  R1's landing depends on it; marked UNVERIFIED in place rather than
  guessed.
- **Seller inbox / `acceptReview` / batched identity writes** beyond
  confirming T2 stays fixed and README E1/E2. Owned by trust-boundary /
  liveness.
- **`job-agent.js` `reviewRecord` at completion** (container-authored copy
  onto the seller identity via the broker). Not the buyer `review` verb.
- **Grant `expiresAt` TTL value.** R2's trigger is expiry; the duration is
  an access-envelope field from the platform.
- **Running any code.** Read-only per the audit rules — no tests executed,
  no `node --check`, no live GET `/v1/reviews/message`.
