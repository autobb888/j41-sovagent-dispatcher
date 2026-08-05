# For backend — two things we need, plus what we fixed and where round 4 stands

**Date:** 2026-08-05
**Shipped:** dispatcher **2.11.0** (SDK 2.14.1 unchanged — nothing here needs an SDK release)
**Fleet:** 9/9 available, inbox clean, no dead letters

Two things happened since the round-4 report. Most of it is a defect class we own and
have fixed. **Two items need work from you** — §1 is a platform inconsistency to
reconcile, §2 is a hard dependency we've just created for mainnet. Everything else is
context.

---

## 1. `getAgentPaymentAddress` disagrees with where money lands

`getAgentPaymentAddress` advertises the **R-address**, but job payments demonstrably
arrive at the **i-address**.

```
getAgentPaymentAddress('dt3worker6.agentplatform@')
  → { address: "RWoeXSRs4WHQYauzUg6bPowNyBRsz5bW51",   ← advertised (R)
      iAddress: "i9j8RkZcqmdU8gMiTHvggtRAdwv4Q3VWJf" } ← where the money actually lands
```

Evidence: agent-6's i-address held **27 UTXOs of exactly 0.00500000 VRSCTEST** — its job
price, 27 times over. Paying the VerusID `dt3worker6.agentplatform@` resolves to the
i-address, which is presumably what buyers do.

**Why it matters.** Identity-update fees (reviews, attestations, job records — ~0.0001
each) are payable **only** from the R-address: an identity output carries a different
script that the identity-update path cannot sign. So payments land in one pocket and
fees drain the other, and a busy agent eventually goes silent on-chain while holding
unspent earnings.

**What we'd like:** either the advertised address matches where money lands, or you
confirm the i-address is intentional and the advertisement is what should change. Right
now the two fields disagree and we've had to build around the disagreement.

This is not urgent for us — we've solved the operational half (below) — but it's a
latent trap for anyone else integrating against `getAgentPaymentAddress`.

**One correction to an earlier message from us:** we cited `getMyEarnings` when first
diagnosing this. It reported *"0.05 across 10 completed jobs"* while 27 payments had in
fact arrived. It appears to count only **completed** jobs, so it substantially
undercounts actual receipts. Worth knowing if anyone treats it as a balance.

---

## 2. `senderVerified` is now a mainnet blocker for you

**This one is new as of 2.11.0 and it is the item most likely to bite.**

Since the 2026-06 audit our deposit watcher has **refused** to credit a deposit on
signature auth alone when your `verifyPayment` response omits `senderVerified` — the
self-credit risk (M-funds-1): anyone observing a public funding tx could otherwise claim
its credit. `J41_DEPOSIT_ALLOW_AUTH_ONLY=1` was the escape hatch that restored the old
behaviour.

In **2.11.0 that escape hatch is refused on mainnet.** The dispatcher will not start with
it set on `network = verus`.

The consequence for you: **on mainnet, if `verifyPayment` does not return
`senderVerified`, deposits will not be credited at all, and there is no longer a flag to
work around it.** That is deliberate — it is the fail-closed behaviour — but it means
shipping `senderVerified` is now a prerequisite for mainnet, not a nice-to-have.

Testnet is unaffected; the flag still works there.

**What we need:** confirmation of whether `verifyPayment` returns `senderVerified` today,
and if not, whether it is on the path to mainnet. If it is not going to happen, tell us
and we will reconsider the gate rather than have you discover this at cutover.

Five other flags were added to the same mainnet gate in 2.11.0 (unpriced-job admission,
disabling buyer-chat scanning, plaintext HTTP, a test-mode signer path, and trusting
platform identity resolution). None of the others create a dependency on you — they are
all dispatcher- or SDK-side debug hatches. This one does, which is why it is called out
separately.

---

## 3. What we fixed on our side (no action needed)

**The outage.** On 2026-08-05 agent-6's R-address hit zero, it stopped being able to
write anything on-chain, and **three valid inbox items** — an attestation, a review and
a job record — were wrongly quarantined as dead letters. Nothing was lost; all three
were recovered into batch tx `345022a4` after we refunded the agent.

**Cause, ours:** the SDK throws the dry-wallet error as a bare `Error` with no `code`
and no `statusCode`, so our classifier hit its `hard` default and burned the per-item
dead-letter budget. An unfunded wallet is *environmental* — every item fails identically
and every one succeeds after funding. It now classifies `transient`: never counted,
never escalated, and logged loudly with the address to fund.

**Fix, ours (2.9.0):** agents now sweep their own earnings i→R automatically when their
tank drops below ~100 writes. It is self-funding — the sweep pays its own fee out of the
inputs it moves, so it works at a zero balance, which is exactly when it's needed.

**Fix, ours (2.10.0):** a `wallet` command so an operator can see every tank, force a
sweep, and fund an agent that has never earned (those can't self-fund — nothing to
sweep). Previously there was no balance visible anywhere in the product and we were
doing this with ad-hoc scripts.

Proven live on testnet: sweeps `4e4f3bf7`, `6b93ec62`, `4baacfff`, `9f75b9da`; transfer
`aee19739`; a fleet-internal send `2f35335f9294`. Every figure the tooling predicted
matched the chain exactly.

---

## 4. Still open from round 4 — unchanged, still yours

`DISPUTE_RESOLVER_ENABLED` is blocked on two answers we asked for on 2026-08-05 and
haven't had yet:

1. **With `defaultAction: rework`, can the resolver move funds, or only offer rework?**
   If it can refund on a rework policy, say so explicitly before flipping.
2. **Per-seller or global?** We'd prefer per-seller, starting with **agent-6** alone.

Our side is ready and has been since the round-4 report: 9/9 agents carry an on-chain
dispute policy, and the response mechanism is proven (dispute `41d723fa`:
`pending → rework`, `deadline_owner` seller→buyer, no funds moved).

Also still open on your side, unchanged: `fcc0fb82` expiry, and confirming the `?type=`
inbox filter deploy.

**Carried buyer finding, still unresolved:** the signed `J41-JOB` payload has
inconsistent currency labels — url2/dt3worker2/5 sign `VRSC` while dt3worker6/7 sign
`VRSCTEST` for identical VRSCTEST jobs. Our service listings are uniformly VRSCTEST now,
so if the signed payload still disagrees, the label isn't coming from the service record.
Worth checking its provenance in the hire flow.

---

## 5. One thing worth flagging for your own codebase

While auditing ours, we found a pattern worth checking on your side: our sweep took its
destination from the platform's `getUtxos().address` **in preference to** the local key
material. Because the sweep classifies UTXOs by comparing against that address, a wrong
value there would have reclassified an agent's entire balance as sweepable and signed it
to that address — unattended, every 30 minutes.

It was our bug and it's fixed (destinations now derive from the WIF; the platform's value
is corroboration only, and a disagreement is a hard refusal). We mention it because the
general shape — *a semi-trusted API response deciding where money goes* — is worth
grepping for anywhere it might exist on your side too. The SDK already had the right
pattern for identity updates and we simply hadn't applied it to payments.
