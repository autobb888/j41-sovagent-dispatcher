# Dispatcher → Backend: what we need before soft launch 2.0

**Date:** 2026-08-14
**From:** dispatcher side
**Shipped today:** `@junction41/dispatcher` **2.30.0**, `@junction41/sovagent-sdk` **2.14.2** (both on npm)

We have just closed every dispatcher-side blocker from a four-part readiness
audit. **One item is blocked on your decision, six more need an answer, and two
are behaviour changes you will observe whether or not you act.** Ordered by what
hurts a real user first.

---

## A. Decisions we cannot make for you

### A1. `deposit-confirmed` fires at 0-conf and nothing un-tells you on a reversal — **BLOCKS SOFT LAUNCH**

Deposits under 2 VRSC are credited straight from the mempool, and we fire
`POST /v1/webhooks/dispatcher/deposit-confirmed` at credit time. Our reconciler
can later claw that credit back when the funding transaction never confirms —
**and there is no message that tells you so.** Your ledger permanently believes a
reversed deposit confirmed.

Bounded at <2 VRSC per event, but it generates support incidents nobody can
reconstruct: the buyer's balance disagrees with what you told them.

**Pick one:**

- **(a) We defer the notify to ≥1 confirmation.** No backend change. Cost: your
  ledger learns about small deposits a block later than the buyer's balance does.
- **(b) You spec `dispatcher.deposit-reversed`** and we send it. Cost: one new
  endpoint, and you decide what it does to a spent balance.

We have built neither, deliberately — building the wrong one is worse than
waiting. **Today's behaviour is the divergent one.** This is the only remaining
item in our audit marked BLOCKS SOFT LAUNCH.

### A2. The budget top-up money path is structurally unreachable (R9-1)

The worker asks for a budget extension from a **non-blocking** 80%-usage
callback and then continues to delivery. By the time the ask is visible the job
is `delivered`, and `approve` returns **400 INVALID_STATUS**. We observed four
overruns at 107–138% — the seller absorbs the cost of every long rework with no
route to bill it.

Asked 2026-08-08, unanswered. **Pick one:**

- Allow `approve` of a budget request while the job is `delivered` or `rework`, or
- Tell us to build a **blocking** gate — and say what the worker should do when
  the buyer never answers (we will not hold a container open indefinitely).

We deliberately built neither.

### A3. `DISPUTE_RESOLVER_ENABLED` — still off

Two questions from 2026-08-05 are still open: **can the resolver move funds when
`defaultAction: rework`?** and **is the flag per-seller** (we proposed starting
with agent-6)? The dispatcher side has been live-proven since July; this is a
flag flip plus those two answers.

---

## B. A platform-side defect that will bite a stranger, not us

### B1. `getAgentPaymentAddress` advertises the R-address; money lands at the i-address

Raised 2026-08-05, never answered — your 2026-08-12 reply covered only the four
other asks.

We have engineered around it (fee-tank sweep, the `wallet` command), so it costs
*us* nothing. **It costs anyone else integrating against the platform
everything**: they read the advertised field, model their payouts against it, and
are wrong. With soft launch inviting strangers, this stops being our private
workaround and becomes a trap.

Either make the advertised address match where money lands, or bless the
i-address and change the advertisement. Either is fine; the current split is not.

---

## C. Confirmations we need before we trust a soft-launch run

1. **Is the `?type=` inbox filter actually deployed?** It was merged; deployment
   was never confirmed. Without it we risk review starvation.
2. **Are `cleanupExpired` / `deleteOld` wired?** 330 expired-pending rows was the
   root cause of a review-starvation incident. Nothing confirms this runs.
3. **Please expire `fcc0fb82`** — still outstanding from an earlier round.
4. **Is the >10 VRSC verify-payment auto-verify bug fixed?** Last recorded
   unfixed 2026-08-06; your 2026-08-11 tiered-confirmations change may have
   fixed it. We branch on this and cannot tell from outside.
5. **Confirmation tiering is a handshake, not a contract.** We hardcode
   `<2 → 0 conf`, `2–10 → 1`, `>10 → 6`. If you re-tier and don't tell us, we
   credit at the wrong tier and our reconciler governs the wrong band —
   **silently.** Either commit to telling us, or add a `/v1/version` flag we can
   read.
6. **Ship `tx.status-sync-attested` before a second `verusd` goes behind the load
   balancer.** Our reconciler currently brackets its lookups with two chain-info
   samples to detect a lagging node. That workaround is load-bearing and it does
   not survive two nodes at different heights.
7. **The daily ~04:00 UTC maintenance window** (fleet-wide `503 CHAIN_SYNCING`,
   ~50 min). Please confirm it still runs and its exact window, so the tester
   does not spend a morning debugging your maintenance. Our auth backoff handles
   it correctly — we just need to not schedule around it blindly.

---

## D. Two behaviour changes you will observe from 2.30.0

Neither needs action; both change what your API sees.

1. **Extension requests are now REJECTED instead of silently dropped** when a
   seller has `extension_auto_approve = false`. Previously we logged "ignoring"
   and the buyer waited forever. You will now see `rejectExtension` calls that
   never existed before, on jobs where nothing used to happen. If your side has
   any assumption that a non-approved extension simply times out, it will now be
   an explicit rejection instead.
2. **Deposits, refunds and bounty posts now refuse a non-interactive terminal**
   with **exit code 2**. This is dispatcher-local, but it means a seller running
   headless automation against our CLI gets a hard refusal rather than a silent
   no-op. If you have any tooling or docs that shell out to `j41-dispatcher`,
   `--yes` is now required where a confirmation exists.

---

## E. Context: what we fixed, in case it changes your read

For your awareness — every one of these was a stranger-facing blocker on our
side, now closed and published:

- **Every fresh `npm install` of the dispatcher AND the SDK was dead** since
  `json-canonicalize@2.0.1` shipped a broken `main`. Any clean resolve threw
  `MODULE_NOT_FOUND` before printing anything. Pinned both sides; SDK 2.14.2 is
  the durable fix and **anything else depending on the SDK should move to it.**
- The npm artifact predated the two-status-axes model, so a stranger's restart
  stranded their chain axis `inactive` while your hire gate ANDs both — earning
  nothing, with every local health surface reading green. Fixed by publishing.
- Onboarding had no faucet, no amount, and told users to fund with **VRSC** on a
  **VRSCTEST** network.
- Buyer-authored text (dispute reasons, display names, VerusIDs) was printed raw
  into our money-approval screens. Now neutralised and fenced — relevant to you
  only because **it is your API that carries that text to us.**

---

## What we would most like back

**A1 decided** — it is the only thing standing between us and a clean run.
Then A2 and A3. Everything in section C can be a one-line yes/no.


---

# ANSWERED — backend reply 2026-08-14, and what we did with it

Their reply resolved or closed **every** item. Recording the deltas that
changed our code, so this file is the whole exchange.

## What we changed in response (shipped in 2.30.1)

**A1 — they solved it a third way, and it created work for us.** Rather than
deferring the notify or specing a reversal webhook, they now verify the funding
tx is visible on *their* node before routing, and **503** when it is not
(`DEPOSIT_TX_NOT_VISIBLE` / `VERIFICATION_UNAVAILABLE`).

Their premise is right — their handler holds no reversible balance, so a
reversed 0-conf deposit cannot corrupt their ledger. **But their 503 is not
rare.** We credit from OUR mempool view and notify immediately, so losing the
propagation race is the *normal* case, not just their 09:00 window. Our notify
was fire-and-forget: one warning and the notification was gone forever.

Fixed: credited deposits carry `notifyPending`; the deposit poller re-fires with
exponential backoff, bounded to 8 attempts, then gives up loudly with the record
left visible. Local signing failures are classified permanent by position in the
flow, so they cannot burn the retry budget.

**C7 — the window moved and we were testing against the wrong hour.** ~04:00 →
**~09:00 UTC**, memory-pressure driven, ~45 min. Corrected in the tester run
book and the deposit runbook. This alone would have cost a tester a morning.

## What we accept as closed with no action

- **A2** — the core fix shipped 08-09 and we never knew; A2-R now defers the
  60-min auto-complete while a top-up is mid-flight, grace-bounded.
- **A3** — penalty-only on every path, no escrow, so "can it move funds under
  `defaultAction: rework`" is moot. **Correction accepted:** `agent-6` never
  published consent; the on-chain consenters are `vari1`/`vari2`. Our note named
  the wrong agent.
- **B1 — our bug, not theirs.** `getAgentPaymentAddress` is a dispatcher symbol;
  they advertise the i-address and settle the whole set. Verified our side: the
  deposit path already uses `iAddress || address` (`cli.js:4585`, `:4462`), so
  the advertised and verified addresses already agree. **No change needed** —
  the audit finding overstated it.
- **C1–C4** confirmed live. **D1/D2** acknowledged.

## Deferred deliberately (not needed for the test run)

They shipped two things at our request that we have **not yet adopted**:

- **`GET /v1/pricing/confirmation-tiers`** + `tx.confirmation-tiers-v1`. We still
  hardcode the tiers. They match today, so there is no divergence to fix — but
  the silent-retier risk is only closed once we read the endpoint. **Next.**
- **`nodeSynced` on `/v1/tx/status/:txid`** + `tx.status-sync-attested`. Our
  reconciler still double-samples chain info to detect a lagging node. That
  workaround is correct and passing; switching to `nodeSynced` is a
  simplification, not a fix. **Next.**

Adopting either mid-test-run would change reconciler behaviour under the tester's
feet, which is why both wait.

## Still owed to them

- If we want dispute resolution exercised during the test run, a test agent must
  publish `config.disputeresolution="platform"` on-chain. **Owner's call** —
  nothing happens for our fleet until then, and the resolver correctly holds
  non-consenting sellers' disputes for review.
