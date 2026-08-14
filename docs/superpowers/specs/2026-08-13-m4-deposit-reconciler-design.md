# M4 — 0-conf deposit reconciler: unblocking design

**Date:** 2026-08-13
**Status:** design agreed, NOT implemented
**Code:** `feature/m4-deposit-reconcile` @ `51ec7a9` — `src/deposit-watcher.js`, `src/credit-meter.js`, 29 tests

> **Why this doc exists.** The branch cannot be pushed to GitHub (`GH007`: commit
> `51ec7a9` is authored with a private email). Its *content* is safe — `51ec7a9` is an
> ancestor of `origin/main`, so `git show 51ec7a9:src/deposit-watcher.js` works from any
> clone — but there is no branch label on the remote. This doc on `main` is therefore
> the durable record of the design and of five real defects found in that code.

## What M4 does

Deposits under 2 VRSC are credited from the mempool at 0 confirmations, matching the
platform's tiering. The reconciler claws the credit back if the transaction turns out
never to have landed. Two blockers stood between it and shipping.

---

## Blocker 1 — node-lag false positives

`GET /v1/tx/status/:txid` returns a tx-specific `code: "TX_NOT_FOUND"`, distinguishable
from a route-level 404 (`code: "NOT_FOUND"`). But it reflects **that node's current
view**: a node behind the tip returns `TX_NOT_FOUND` for a transaction that really
landed. Node-down is a safe 502; node-lag is a 404 that takes money from a buyer who
genuinely paid.

### What the platform actually exposes

`client.getChainInfo()` → `GET /v1/tx/info`, public and sessionless (which is why the
financial-suspension probe at `src/cli.js:487-495` already leans on it). Typed shape:

```
{ chain, testnet, blockHeight, longestChain, connections, version, protocolVersion, relayFee, payTxFee }
```

`blockHeight` vs `longestChain` is verusd's `blocks` vs `longestchain` — the
purpose-built "is this node caught up to its peers' best header" comparison. A lagging
node has `blockHeight < longestChain`. `connections` covers the degenerate case where an
isolated node's `longestChain` equals its own stale tip.

There is **no tip timestamp**, so "tip age" cannot be computed client-side.

### Decision: caught-up gate + block-denominated grace

One `getChainInfo()` per reconcile pass, taken *after* the `open.length === 0`
early-return so idle agents cost nothing.

```
syncedView = Number.isFinite(ci.blockHeight) && Number.isFinite(ci.longestChain)
          && ci.connections > 0
          && ci.blockHeight >= ci.longestChain
```

1. `getChainInfo` throws, or `syncedView` is false → **the whole pass counts nothing.**
   Same treatment as the existing `systemic` verdict: no miss increments, no
   persistence, log once. A lagging or unreachable node produces zero evidence.
2. Misses accumulate only under a synced view. Stamp `firstMissHeight = ci.blockHeight`
   alongside the existing `firstMissAtMs`.
3. Reversal additionally requires `syncedView === true` at the reversing pass **and**
   `ci.blockHeight - live.firstMissHeight >= RECONCILE_MIN_ADVANCE_BLOCKS` (≈30).

Point 3 is the substance: it converts the grace window from "time passed" to "**this
node ingested ≥30 blocks, stayed at its peers' tip throughout, and still says the txid
does not exist**". It also kills the failure where wall-clock elapses while the node is
frozen — frozen node, height static, no reversal. That is the same reasoning
`shouldDeferForPendingWrite` (`src/inbox-deadletter.js:273-284`) already uses, whose
comment says outright that wall-clock windows lie about chain progress.

`_recheckReversals`' restore path needs **no** gate — it acts only on positive
confirmations, which are trustworthy from any node.

### Two contract-driven simplifications that ship with it

- **Delete the weak tier** (`RECONCILE_WEAK_MIN_MISSES` / `RECONCILE_WEAK_SPAN_MS` and
  the `'weak'` classification). Its own comment says it exists only because the
  tx-specific code was unconfirmed. It is now confirmed. Keeping it keeps a path where
  a bare 404 moves money — and see finding 1 below, where it is actively dangerous.
- **Gate the strong classification on the `tx.status-notfound-code` feature flag**,
  reusing the `decidePlatformStatusSupport` / `backendSupportsPlatformStatus` pattern
  from `fe0abb0`. Match `err.code === 'TX_NOT_FOUND'` only; **drop the message-regex
  patterns** — match the code, not the text.

Keep the systemic all-identical-failures guard; it covers route faults and is
orthogonal.

### Money direction

Every missing input results in *no reversal*. The only path that debits a buyer
requires: backend advertises the code contract, AND the node self-reports peer-parity
with >0 peers, AND ≥30 blocks ingested across the miss run, AND ≥3 misses over ≥10 min,
all tx-specific `TX_NOT_FOUND`, AND not systemic. The 24h `_recheckReversals` restore
sits behind all of it.

### Considered and rejected

- **Backend-attested sync** (`nodeSynced` / `tipAgeSeconds` in the response itself, behind
  a `tx.status-sync-attested` flag). Strictly stronger — sync state and tx verdict
  sampled atomically from one node, no TOCTOU. Rejected *for now* only because it blocks
  M4 on a second repo's deploy; it can be added later as an extra conjunct with no
  redesign. Worth asking backend for.
- **Sentinel-transaction corroboration.** Proves the node is responsive and advancing,
  not caught up — a node 500 blocks behind still returns growing confirmations for an old
  sentinel. It cannot distinguish node-lag, which is the entire blocker.

---

## Blocker 2 — `needsOperator` and the `reversed` ledger are write-only

Write sites (all in `src/deposit-watcher.js`; zero readers anywhere in `src/`):

| site | what | when |
|---|---|---|
| :585 | `needsOperator` on a `processed` record | tx confirmed while a reversal was mid-flight (`debiting`/`recredited` crash states) — cannot tell if the meter moved |
| :731 | `needsOperator` on a `reversed` entry | `debited !== true` entry whose tx later confirmed — restore forbidden |
| :664-679 | push onto `deposits.reversed[]`, trim to 1000 | every reversal |
| :473-483 | `restoredAt` / `resolvedBy` stamp | re-credit via re-report or pending-poller |
| :754 | `restoredAt` stamp | automatic restore |
| `credit-meter.js`:176 | `buyer.lastReversedTxid` | every `reverseDeposit` |

Both `needsOperator` states are **terminal**: :585's record loses `unconfirmed` so the
reconciler never revisits it; :731's entry is skipped by the `debited !== true` guard
forever. Their entire read surface today is one `console.error`.

### Decision: all three surfaces, in different roles, plus a `deposits` CLI

The precedent is exact — fee tanks got a builder, a `/health` counter and an
`agents[].feeTank` field after the 2026-08-05 "log line nobody greps" failure, whose
comment in `control.js` is literally this blocker's thesis.

1. **`listDepositAnomalies(agentIds)`** exported from `deposit-watcher.js` (the file that
   owns the on-disk format): pure disk read returning per-agent `open` / `reversed` /
   `needsOperator`. `control.js` wraps it as `buildDepositSurface(state)` beside
   `buildInboxSurface`, so both transports consume one builder.
2. **`ctl deposits`** — new `case 'deposits'` in `handleCommand`. The `ctl <command>`
   wiring passes action strings through generically, so the CLI side is free.
3. **`/health`** — two additive `summary` scalars, `deposits_unconfirmed_open` and
   `deposits_needs_operator`, and **`deposits_needs_operator > 0` joins the `degraded`
   OR-chain**. A needsOperator entry means "a buyer's balance may be wrong and only a
   human can say", which is strictly worse than a dead-lettered inbox item — and those
   already degrade. Durable disk state, so no `startupComplete` gating. Additive fields
   respect the versioned-path contract; the new degrade trigger is a contract change and
   belongs in the changelog.
4. **`GET /v1/deposits`** in `control-api.js` off the same builder, plus
   `state.emitEvent('deposit.reversed' | 'deposit.restored' | 'deposit.needs_operator')`
   at the three write moments. Plumbing: `reconcileUnconfirmedDeposits` has no `state`;
   thread an optional `emit` from `startDepositPoller` (which does), defaulting to no-op.
5. **`j41-dispatcher deposits`**, mirroring the `refunds` verbs and reading disk directly
   so it works out-of-band while the daemon runs:
   - `deposits list [--all]` — needsOperator items first (the `refunds list`
     "blocked entries are loudest" ordering), then open 0-conf credits, then recent
     reversals. Each needsOperator line prints the check to run and the resolution command.
   - `deposits credit <agent-id> <txid> --yes` — **re-verifies on-chain first** (≥1 conf,
     fail closed on any doubt, per `refundsApprove`), then credits, then stamps
     `{resolvedAt, resolvedBy, resolution}` rather than deleting the entry.
   - `deposits dismiss <agent-id> <txid> --reason <text>` — clears the flag with an audit
     stamp, moves nothing.

### Should ambiguous reversals block on human approval, like refunds?

**No for the automatic reversal; yes — and already true — for the two `needsOperator`
states.**

Refunds gate on approval because approval causes an irreversible on-chain send. A
deposit reversal is internal bookkeeping on a meter, bounded to <2 VRSC by the tier that
creates 0-conf credits, and it has an automatic 24h undo. Queuing every reversal for
approval recreates the manual operator-script workflow that the 2026-07-16 refund event
proved does not scale — i.e. equivalent to not shipping. The Blocker-1 gate is what makes
automation safe.

The two `needsOperator` states already implement "block on a human": the code moves no
money and stops. What was missing was visibility and a resolution verb.

**Do not route them into `pending-refunds.json`** — different ledger, different money
direction (meter adjustment vs on-chain send). Cross-wiring would let a deposits bug
drain the hardened refund path.

---

## Independent defects found in the M4 code

Not blockers, but all present on the branch and all to be fixed before it re-lands.

1. **The systemic guard is dead when exactly one 0-conf credit is open.**
   `lookups.length > 1` — with a single open credit a route-level 404 outage can never be
   classified systemic, so the weak tier reverses that buyer on no tx-specific evidence.
   At current volume the lone-credit case is the *common* one. Deleting the weak tier
   closes it.
2. **Restore does not re-add the txid to `processed` → double credit.** `_recheckReversals`
   re-credits and stamps `restoredAt`, but the txid was removed from `processed` at
   reversal and never returns. `claimTxid` checks only `processed`, and
   `_settleReversedForTxid` only touches entries *without* `restoredAt`. So: reverse →
   auto-restore → buyer re-reports the same confirmed txid → credited again.
3. **The pending-path save clobbers concurrent writes.** `reportDeposit`'s
   under-confirmed branch saves the snapshot loaded *before* its `verifyPayment` /
   `getTxStatus` awaits, overwriting a poller commit that landed during them and deleting
   that txid's dedup entry → re-credit exposure. The credit path already re-loads fresh
   for exactly this reason; the pending path must too.
4. **The 1000-entry trims can discard unresolved money states.** `processed.slice(-1000)`
   can drop a record still flagged `unconfirmed` or `needsOperator`; `reversed.slice(-1000)`
   can drop an unrestored reversal inside its 24h recheck window. Exempt records with open
   flags, or move the flags to a separate small file. (The processed trim also evicts old
   txids from the dedup ledger, so a >1000-deposits-old txid could be re-reported and
   re-credited — that half predates M4, but the reconciler raises the stakes.)
5. **0-conf credits fire `notifyJ41DepositConfirmed` for a mempool tx, and reversal never
   un-notifies.** The platform is told "deposit-confirmed" for money that may be clawed
   back, so its ledger and ours diverge on every reversal. Either defer the webhook until
   ≥1 conf, or spec a `deposit-reversed` counterpart with backend.
6. Minor: legacy/absent `creditedAtMs` makes `pastGrace` instantly true (grace silently
   skipped); `const unknown = strength !== null` is dead code; `RECONCILE_GRACE_MS`'s
   comment says "~30 blocks" but measures wall time — superseded by the block-denominated
   grace above.

**Findings 2, 3 and 4 are all double-credit paths.** That is the same class as the "two
credit mints" defect found in review round 5 of 2.29.0. Whatever re-lands M4 should treat
"can this txid be credited twice?" as the standing question, not a one-off check.

---

## Testing

The execution harness (`test/helpers/dispatcher-harness.js`, `fake-chain.js`,
`start-action.test.js`) can cover both blockers, with these additions:

- `sdk-stub.js` `getChainInfo` currently returns only `{ blockHeight }` — needs
  `longestChain` and `connections`, with lag controls on `FakeChain` (`networkHeight`
  distinct from node `height`, `setLag(n)`, `setConnections(n)`).
- `FakeChain` needs a per-txid `getTxStatus` script: txid → a sequence of
  `{confirmations}` results or `J41Error`-shaped throws carrying `code` / `statusCode`.
- `writeFixture` needs to seed `agents/<id>/deposits.json` and `credit-meters.json`.
- The version stub needs a controllable `features` list (it already accepts one).

Scenarios worth having: a lagging node returning `TX_NOT_FOUND` for a landed tx → no
reversal, then catch-up → credit intact; chain info unavailable across the whole grace
window → nothing counted; genuine drop with a synced node and 30-block advance →
reversal fires; frozen node (height static, wall clock advancing) → no reversal; single
open credit + route-level 404 → no reversal.

Blocker 2's builders and CLI verbs are disk-pure, so mostly plain unit tests over a
seeded temp `~/.j41`; harness-level, assert the real `/health` serves `degraded` plus the
counters.
