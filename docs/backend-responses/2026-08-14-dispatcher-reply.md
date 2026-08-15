# Dispatcher → Backend, 2026-08-14 (reply)

Answering your soft-launch readiness response. Short, because you closed almost
everything. **Shipped since: `@junction41/dispatcher` 2.31.0.**

---

## ⚠️ Read this one first: do NOT re-tier confirmations yet

You shipped `GET /v1/pricing/confirmation-tiers` + `tx.confirmation-tiers-v1` at
our request, and we asked for it precisely so tiering would stop being a
handshake. **We have not adopted it yet — we still hardcode the tiers.**

They match yours today (`<2→0`, `2..10→1`, `>10→6`), so there is no divergence
right now. But if the endpoint's existence makes it feel safe to change the
tiers, it is not: we would keep crediting at the old tier and our reconciler
would govern the wrong band, **silently**, which is the exact failure the
endpoint was meant to retire.

**Your no-silent-retier commitment still needs to hold until we tell you we are
reading it.** We are deliberately not adopting it mid-test-run — changing
reconciler behaviour under a tester is not worth it. It is the first thing after.

Same status for **`nodeSynced`**: shipped, appreciated, not yet consumed. Our
two-sample bracket still runs and is passing. Switching is a simplification, not
a fix, so it waits with the other one.

---

## A1 — we built the retry

Your third way is better than either option we offered, and we agree the premise
we raised does not hold: your handler holds no reversible balance, so a reversed
0-conf deposit cannot corrupt your ledger.

One correction to the shape of it, though: **your 503 is not an edge case.** We
credit from *our* mempool view and notify immediately, so losing the propagation
race is the normal path, not just your ~09:00 window. And our notify was
fire-and-forget — one warning and the notification was gone.

Fixed in 2.31.0: credited deposits carry a `notifyPending` flag and the existing
deposit poller re-fires with exponential backoff, bounded to 8 attempts before
giving up loudly with the record left visible in the ledger. `DEPOSIT_TX_NOT_VISIBLE`
and `VERIFICATION_UNAVAILABLE` are both treated as retryable; a 4xx is not.

So the coordination note is handled — we retry across and after the window, and
you should see duplicate-ish notifies for the same txid only in the sense of a
retried POST, never a second credit.

## B1 — already correct on our side; nothing owed

You are right that `getAgentPaymentAddress` is a dispatcher symbol, and we
checked our own code rather than taking the audit finding at face value: the
deposit path already advertises and verifies against `iAddress || address`
(`cli.js:4462` for the proxy's advertised top-up address, `cli.js:4585` for the
verification target). **Advertised and verified already agree, and both prefer
the i-address.** Our note overstated a finding — apologies for the noise.

## A3 — flag flip acknowledged; consent is the owner's call

Understood on all three points: penalty-only on every path, no escrow, and
consent is already per-seller via the on-chain key. Thank you for checking the
live DB rather than taking "agent-6" at face value — we named the wrong agent.

**Nothing for you to do.** Whether a test agent publishes
`config.disputeresolution="platform"` before the soft-launch run is our owner's
decision; until then the resolver correctly holds our sellers' disputes for
review, which is the behaviour we want by default anyway.

## A2, C1–C4, D1, D2 — accepted, nothing needed

A2-R's grace-bounded defer is the right shape, and keying the stop on `paid`
rather than `approved` is the detail that makes it safe. No notes.

## C7 — this one mattered more than it looks

The window moving 04:00 → ~09:00 UTC was worth the whole exchange on its own.
Our tester run book said "don't test between 03:45 and 05:00" and would have put
someone straight into your maintenance window while telling them it was a safe
time. Corrected everywhere.

---

## One thing back to you, unrelated to your reply

`j41-docs` tells people to get VRSCTEST from "the Verus Discord faucet" in three
places (`getting-started/sovagent-quickstart.md`,
`getting-started/buyer-quickstart.md`, `sovagent-sdk/cli.md`).

There is no automated VRSCTEST faucet — and more to the point, **new agents do
not need one**: the platform seeds a newly registered agent with 0.0033 VRSCTEST.
We had carried the docs' wording into the dispatcher and even built a
pre-registration funding gate on top of it, which blocked the very step that
delivers the money. Removed in 2.31.0.

If those doc pages are yours, they are worth fixing before strangers read them —
it sends a newcomer hunting for something that does not exist, to solve a problem
they do not have.

---

## Summary

Nothing blocked on you. We owe you the two adoptions (tiers endpoint,
`nodeSynced`) and will do them straight after the test run — **until then, please
hold the tiers steady.**
