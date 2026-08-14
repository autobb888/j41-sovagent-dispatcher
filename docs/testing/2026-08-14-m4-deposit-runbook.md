# M4 deposit reconciler — operator runbook

**For:** validating M4 on a live dispatcher before publishing 2.29.0 to npm.
**Time:** step 1 ≈ 5 min, step 2 ≈ 10 min. Steps 3–4 need a real api-endpoint sale.

## Before you start

Two facts about the current fleet, measured 2026-08-14:

- **No agent has a `deposits.json`.** The fleet has never taken a deposit.
- **No agent has an api-endpoint service configured.** `startDepositPoller` is
  gated on `apiAgents.length > 0`, so on today's fleet the reconciler never runs
  at all.

That makes the restart into this code near-zero-risk on the deposit side — there
is nothing to migrate and nothing to reconcile — and it also means steps 3 and 4
cannot happen until an agent actually sells an endpoint.

**Do not run this near 09:00 UTC** (window moved from 04:00; backend confirmed 2026-08-14).** Seller auth dies fleet-wide for ~50 minutes
during scheduled backend maintenance.

**A restart deactivates the fleet.** `start` does not reactivate; run
`j41-dispatcher activate-all` afterwards and confirm on `/health`.

---

## Step 1 — surfaces exist and are wired (no money, no deposits)

Restart the dispatcher into the new code, then:

```bash
curl -s localhost:9842/health | jq '{
  status,
  open:  .summary.deposits_unconfirmed_open,
  needs: .summary.deposits_needs_operator,
  block: (.deposits | type)
}'
```

Expect `open: 0`, `needs: 0`, `block: "object"`. If `block` is `"null"` the
process is still running old code.

```bash
j41-dispatcher ctl deposits          # same document, via the control socket
j41-dispatcher deposits list         # → "No deposits need an operator decision."
```

**On `status`:** it will almost certainly read `degraded`, and that is expected —
`_containerCrashes` only ever increments, so one container crash pins it for the
rest of the run. That is exactly why the counters, not `status`, are the watch.
Alert on `summary.deposits_needs_operator` above 0.

Also confirm the reconciler is armed rather than silently inert:

```bash
curl -s https://api.junction41.io/v1/version | jq '.features | index("tx.status-notfound-code")'
```

A non-null answer means the backend advertises the contract. If it ever returns
null, the dispatcher logs `reconciler is inert-no-flag` once per transition and
will not reconcile anything — fail-closed, but you would want to know.

---

## Step 2 — the operator path, end to end (fabricated data, no money)

Pick a **registered agent that has never taken a deposit** (on today's fleet,
any of them). The script refuses to touch an agent that already has a
`deposits.json`, so it cannot overwrite real history.

```bash
node scripts/seed-deposit-anomaly.js agent-1
```

That writes one `reversed` entry with `needsOperator` and `debited: false` — the
exact shape the reconciler produces when it clawed a credit back but could not
prove the debit ran. Then:

```bash
j41-dispatcher deposits list
```

Expect the anomaly printed **first**, with the reason, the meter-vs-ledger
arithmetic, and both resolution commands. On a fresh agent the meter line reads
`balance —, totalDeposited —` — an em dash, not `0`. That distinction is
deliberate: "we never looked" and "we looked and it is empty" prescribe opposite
actions.

```bash
curl -s localhost:9842/health | jq '{status, needs: .summary.deposits_needs_operator}'
```

Expect `needs: 1`. If `status` was `ok` before this, it should now read
`degraded`.

Now settle it. **Use `dismiss`, not `credit`** — nothing is actually owed, this
is a fixture:

```bash
j41-dispatcher deposits dismiss agent-1 \
  tx_m4_runbook_fixture_0000000000000000000000000000 \
  --reason "runbook fixture"
```

Expect `✅ Dismissed. No money moved.` Then re-check: `deposits list` reports
nothing outstanding and `deposits_needs_operator` is back to 0. That last part
is the point — a counter that never returns to zero after a resolution is worth
nothing as an alert.

Clean up:

```bash
node scripts/seed-deposit-anomaly.js agent-1 --undo
```

`--undo` refuses if the file has gained anything the script did not write, so a
real deposit arriving mid-test cannot be deleted by the cleanup.

### What step 2 does and does not prove

Proves: the read model reads both homes of `needsOperator`, the counters and the
degrade trigger are wired, the CLI resolves an anomaly under the inter-process
lock, and the count returns to baseline.

Does not prove: anything about the on-chain gate, the block-denominated grace,
or a real reversal. Those need steps 3–4.

---

## Step 3 — happy path (needs a real api-endpoint sale)

Configure one agent with an api-endpoint service, then have the buyer identity
deposit **under 2 VRSC** — that is the 0-conf tier, the only one M4 governs.

Expect: credited immediately from the mempool; `deposits list` shows it under
"0-conf credits still open"; within a block or two the reconciler clears
`unconfirmed` and the open count returns to 0, with no reversal. Logs show
`0-conf credit … confirmed at N block(s)`.

This is the path that will actually run in production, and it is the one worth
having before you publish.

---

## Step 4 — the reversal path (the hard one)

You need a funding transaction that never lands. Two ways:

**Real (controlled double-spend).** Broadcast the deposit, then immediately spend
the same UTXO to yourself with a higher fee. The original is displaced and never
confirms.

**Synthetic (no money at all).** Seed an `unconfirmed` record on a scratch agent
with a well-formed txid the chain has never seen. This exercises the real feature
flag, the real two-sample sync gate, the real miss run and the real reversal —
only the buyer is fictional.

Either way, budget **~40 minutes of wall clock**: a reversal requires 3 misses
spanning ≥10 minutes AND ≥30 blocks of chain advance, on a node reporting itself
caught up at both ends of each pass. Nothing will appear to happen for the first
half hour; that is the design working.

Expect at the end: `⛔ REVERSED … VRSC of credit`, the balance debited (going
negative if it was already spent — that is correct, not a bug), a `deposit.reversed`
event on the control API, and the txid gone from the dedup ledger so the buyer
can re-report if the tx ever does confirm.

---

## Known limits, so they are not surprises

- **`credit-meters.json` fails open.** Its cross-process lock gives up after
  250 ms and applies the change unserialised rather than breaking a proxy
  request the buyer has already been served. It logs loudly when that happens.
  Prefer resolving anomalies on a quiet agent.
- **On-chain verification is performed by the platform, not by a local node.**
  See the trust note in the deposit design doc.
- The reconciler is inert on any agent without an api-endpoint service, which
  today is all of them.
