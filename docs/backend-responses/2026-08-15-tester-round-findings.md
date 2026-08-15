# Dispatcher → Backend, 2026-08-15: tester round results + one live incident

**Source:** independent tester run, 2026-08-15, against backend `46a80a6` /
dispatcher 2.31.0 / SDK 2.14.2, buyer `subid.agentplatform@`.
**Tester's verdict:** every buyer-executable item passed.

Three things need you. The first is happening right now.

---

## 1. INCIDENT — seller auth is down fleet-wide, and it is not the 09:00 window

**As of 2026-08-15 15:10 UTC**, every agent on our fleet fails to authenticate:

```
Sign-in temporarily unavailable while the chain catches up — try again shortly
[Auth] agent-6: platform unavailable ... (145 failure(s)), retrying in 176s
```

All 9 agents. **137–145 consecutive failures each**, so this has been running for
hours, not minutes.

Two things make it worth a look rather than a shrug:

- **It is 15:10 UTC.** Your note said the shed happens at ~09:00 for ~45 minutes,
  with opportunistic RAM-pressure sheds on top. Either this is a very long
  opportunistic shed or something else is wrong.
- **`GET /v1/version` returns 200.** The public API is healthy while seller
  sign-in is not, so any health check pointed at the public surface reports green
  through this.

**What it is blocking right now:** we cannot post dispute responses, so the two
disputes below stay open, and our fleet cannot accept work. Our backoff handles
it correctly (no hammering) — the issue is duration and invisibility, not
behaviour.

**Ask:** confirm what this is, and whether the ~09:00 characterisation still
holds. If seller auth can be down for hours while `/v1/version` is 200, we would
like a signal we can distinguish — a flag, or `CHAIN_SYNCING` surfaced on a
public endpoint.

---

## 2. QUESTION — an approved-but-unpaid budget top-up silently expires

From the tester's **8.8** (the A2-R defer test), which otherwise **passed
cleanly**: job `229d2c00`, top-up of 0.001235 approved but deliberately not paid.

- The defer worked exactly as you designed it — at ~32 minutes past the
  review-window expiry the job was still `delivered`, no premature auto-complete,
  and none of the BLOCKER signatures appeared.
- **But the approved-unpaid top-up vanished** from `budget-requests` and
  `extensions` *before* the 120-minute `BUDGET_DEFER_GRACE_MINUTES`. Base amount
  stayed 0.005, nothing was stranded — so this is clean, not broken.

**What we need is the number.** What is the actual TTL on an approved-unpaid
top-up, is it intended, and is it deliberately shorter than the defer grace? A
seller quoting a rework price needs to know how long the buyer has to pay before
the offer evaporates, because right now we tell them nothing and the answer is
apparently "less than two hours".

If it is intended, we will document it seller-side. If the two windows are
independent by accident, they will drift.

---

## 3. GAP — a buyer cannot withdraw a dispute

Tester finding, and it is asymmetric enough to matter for soft launch:

> *Buyers can only clear a dispute by accepting a rework offer — there is no
> buyer withdraw / close / accept-delivery route (all 404).*

The seller has three ways out (`rework`, `refund`, `rejected`). **The buyer has
one, and it requires the seller to offer first.**

Concretely: a buyer who files a dispute by mistake, or changes their mind, or
simply wants to accept the delivery after all, **cannot**. They wait for a seller
offer or the job sits until the deadline. With strangers arriving, "I clicked
dispute and now I'm stuck" will happen.

Not a blocker for us — we can always respond — but it is a hole on your side and
we would rather raise it than let a real buyer find it.

---

## 4. Confirmations — the things you shipped work

Verified independently by the tester, not by us:

| # | check | result |
|---|---|---|
| 8.7 | budget top-up approve **+ pay**, mid-`rework` | **`200`** — the Round-9 `400 INVALID_STATUS` is gone. Billed 0.005 → 0.006793, worker used the extra budget. **`590ed50` confirmed live.** |
| 9.1 | `GET /v1/pricing/confirmation-tiers` | `<2→0, 2–10→1, >10→6`, `maxConfirmations:6`, `rescanDepth:10` — matches the contract |
| 9.2 | `/v1/version` flags | `agent.platform-status-v1`, `tx.status-notfound-code`, `tx.status-sync-attested`, `tx.confirmation-tiers-v1` all present |
| 9.3 | `/v1/tx/status/<txid>` | returns `nodeSynced: true` alongside confirmations |
| 9.4 | tx-status error codes | nonexistent 64-hex → `404 TX_NOT_FOUND`; malformed → `400 INVALID_TXID` |
| 8.5 | payment → advertised address | 0.005 landed at exactly the advertised `payment.address`, verified on-chain via `getrawtransaction` vout |
| 8.9 | dispute reason with XSS payload | **inert in your web UI** — `window.__XSSFIRED` never set, whole payload in one escaped text node, zero injected elements |

**8.7 is the headline.** That money path was structurally unreachable in Round 9
and is now working end to end, including the payment leg. Thank you.

**8.9 matters more than it looks.** We sanitise buyer text on our operator
screens, but that only protects our terminals. The tester confirmed *your* DOM
escapes it too, which is the half we could not test.

---

## 5. Hand-off — 9.5–9.8 need you

The tester could not run these from a buyer seat; they need DB, RPC and logs:

- **9.5** tiering depth on a >10 VRSC payment (does it really wait for 6?)
- **9.6** no-double-credit on a txid replay
- **9.7** resolver hold-vs-penalty for a consenting vs non-consenting seller
- **9.8** deposit-visibility 503 behaviour (`DEPOSIT_TX_NOT_VISIBLE`)

**9.8 is the one we would most like back**, because we built retry logic against
your visibility gate this week and have never seen it fire against a real
absent-tx. We now re-fire owed notifications with bounded backoff (8 attempts);
if your side sees duplicate POSTs for one txid, that is us retrying, never a
second credit.

Also unrun: **8.1–8.3**, minting a fresh `name.agentplatform@` via QR + Verus
Mobile. Needs a phone. That is the actual cold-start question — *can a stranger
with no wallet get an identity and hire someone* — and it remains unanswered by
anyone.

---

## Summary

- **Acknowledge/fix:** the auth outage (§1).
- **Answer:** the top-up TTL (§2), the buyer dispute-withdraw gap (§3).
- **Run:** 9.5–9.8 (§5).
- Everything else you shipped this week checks out.
