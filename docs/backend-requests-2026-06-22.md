# J41 Backend / Platform Requests — Security Audit 2026-06-22

From the dispatcher+SDK security audit. These three items **cannot be fully fixed
on the dispatcher side** — they need platform/backend support. For each: the
problem, exactly what we need, why, and the dispatcher-side mitigation we're
shipping in the meantime.

---

## 1. Expose the confirmed on-chain amount from `verifyPayment` (deposit credit)

**Problem.** When crediting a buyer's prepaid proxy deposit, the dispatcher
currently credits the buyer's **self-reported** `expectedAmount`. The on-chain
payment is verified (txid + signature + freshness), but the dispatcher never
reads back the *actual* confirmed amount to clamp against. A buyer who
over-reports the amount could mint excess credit → free proxy compute — unless
the platform's `verifyPayment` already strictly rejects amount mismatches.

**What we need.** Either:
- (a) Confirm that `verifyPayment` (or the deposit-confirm endpoint) **already
  rejects** any tx whose on-chain value ≠ the reported amount (and document the
  tolerance), **or**
- (b) Have the verify response **return the actual confirmed on-chain amount**
  (e.g. `confirmedAmount`) so the dispatcher can credit `min(expectedAmount,
  confirmedAmount)`.

**Why.** Defense-in-depth: the dispatcher should never mint credit larger than
what the chain actually confirms, independent of platform-side checks.

**Dispatcher-side now.** If the verify response exposes an amount, we clamp to
it; otherwise we log the reliance and leave the existing verification in place.

---

## 2. Authoritative job record for on-chain VDXF history (`jobCompletionUpdate`)

**Problem.** When the job container reports completion, it supplies a
`jobRecord` blob (`amount`, `currency`, `buyer`, `seller`, `status`, …) that the
dispatcher writes into the agent's **on-chain VDXF identity** history. The
dispatcher validates the blob's *shape* and cross-checks `jobHash`, but does not
validate the **values** — a prompt-injected/compromised container can write
false amounts or a forged `status: completed` into the permanent on-chain
record. (Reputational/integrity impact, not direct fund theft.)

**What we need.** A way to **reconstruct these fields from authoritative
platform state** instead of trusting the container blob — e.g. `getJob(jobId)`
returning the canonical `amount`, `currency`, `buyer`, `seller`, and `status`
at completion time, so the dispatcher builds the VDXF history entry from trusted
data and only accepts container-authored fields the container legitimately owns
(e.g. a delivery/reviewer signature).

**Why.** On-chain records are permanent and public; they must not be
attacker-writable through a compromised job container.

**Dispatcher-side now.** We keep the shape allowlist + `jobHash` cross-check and
reconstruct whatever fields the current `getJob` already returns authoritatively;
fields only available from the container blob are flagged until the backend can
supply them.

---

## 3. Per-event nonce/ID on platform→dispatcher webhooks, and freshness on
brokered non-protocol signatures

Two related anti-replay asks:

**3a. Webhook replay window.** `/webhook/:agentId` verifies a timestamped HMAC
with a 5-minute freshness window, but there is **no per-event nonce**, so a
captured webhook (e.g. `job.paused`, `job.cancelled`) can be **replayed within
5 minutes** by anyone on-path (or a compromised platform link) — e.g. to stall
an active job. We want to dedupe events.

- **What we need.** Include a unique, stable **event id / nonce** on each
  webhook (e.g. header `X-J41-Event-Id` or a `nonce` field in the signed body).
  The dispatcher will record it in its existing nonce cache and reject replays.

**3b. Generic brokered-signature freshness.** The signing broker's generic
`signMessage` path (used for auth challenges, attestations, status, bounty
payloads) enforces a length cap + the `assertNotProtocolMessage` oracle guard,
but **does not bind a server timestamp/nonce** into non-protocol messages (the
protocol path does). Replay risk depends on whether the **platform independently
enforces freshness** when it later verifies these signatures.

- **What we need.** Either confirm the platform **independently enforces a
  timestamp/nonce window** when verifying non-protocol message signatures, **or**
  define a server-supplied nonce+timestamp the agent must bind into the signed
  payload.

**Why.** Closes the residual replay surface on both inbound events and outbound
non-protocol signatures.

**Dispatcher-side now.** We can add nonce-dedupe on `/webhook/:agentId` only
once the platform supplies an event id; until then we note the window. For 3b we
keep the oracle guard + length cap.

---

## (Secondary, non-security) Open question carried over

**VerusID funding for service listing.** Does the free J41-issued VerusID arrive
funded with enough VRSC to cover the on-chain VDXF **service-listing writes**, or
must the seller separately fund their own VRSC before they can list services?
This affects onboarding friction, not security.

---

*Contact / context: dispatcher security audit 2026-06-22 (dispatcher 2.3.0 +
sovagent-sdk 2.9.0). Remediation branch `security/audit-remediation-0622`.*
