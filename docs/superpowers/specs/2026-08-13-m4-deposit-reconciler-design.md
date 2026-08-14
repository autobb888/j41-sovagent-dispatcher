# M4 — 0-conf deposit reconciler: unblocking design

**Date:** 2026-08-13 · **revised 2026-08-13 after three adversarial review passes**
**Status:** design agreed and reviewed, NOT implemented
**Code:** `feature/m4-deposit-reconcile` @ `51ec7a9` — `src/deposit-watcher.js`, `src/credit-meter.js`, 29 tests

> **Why this doc exists.** The branch cannot be pushed to GitHub (`GH007`: commit
> `51ec7a9` is authored with a private email). Its *content* is safe — `51ec7a9` is an
> ancestor of `origin/main`, so `git show 51ec7a9:src/deposit-watcher.js` works from any
> clone — but there is no branch label on the remote. This doc on `main` is therefore
> the durable record of the design and of five real defects found in that code.

> **Revision note.** Three independent reviews (money-safety, Blocker-1 soundness,
> Blocker-2 + testability) ran against this doc and the branch source. They confirmed
> all six original defect claims, found **four more money defects**, showed the
> Blocker-1 predicate as written is bypassable in three node states, and demonstrated
> that **six mutations of the planned implementation would pass every planned test**.
> Everything below is the revised design. Original claims that survived unchanged are
> unmarked; new material is tagged **[R2]**.

## What M4 does

Deposits under 2 VRSC are credited from the mempool at 0 confirmations, matching the
platform's tiering. The reconciler claws the credit back if the transaction turns out
never to have landed. Two blockers stood between it and shipping.

**[R2] The exposure is open on production right now.** `requiredConfirmations`
(`src/deposit-watcher.js:124-127`) returns `0` below 2 VRSC on current `main`, and
`9dc7d7e` stripped the reconciler out. The live fleet credits sub-2-VRSC deposits
from the mempool with no claw-back at all. M4 is not a hardening nicety; it closes a
hole that is live.

### [R2] Facts verified against the live platform, 2026-08-13

Do not re-derive these; do re-check them if more than a few weeks have passed.

| Premise | Verified |
|---|---|
| `tx.status-notfound-code` advertised by the backend | **YES** — present in `/v1/version` `features`. The strong path is armed, not dead code. |
| `GET /v1/tx/info` public/sessionless, returns the documented shape | **YES** — `{chain:"VRSCTEST", testnet:true, blockHeight, longestChain, connections, …}`, no auth. |
| `GET /v1/tx/status/:txid` public | **NO** — returns `401`. The reconciler correctly uses per-agent authenticated sessions, so the daily 04:00 auth outage surfaces as auth errors → transient → safe. |
| SDK surfaces `err.code` untouched | **YES** — `J41Error(message, error.code \|\| 'HTTP_ERROR', status, detail)`; 404s are not retried and not rewritten. |
| SDK has a *cached* feature helper | **YES** — `dist/backend-features.js`, `hasFeature()`, 5-min TTL. **Use it; do not clone `backendSupportsPlatformStatus`,** which does an uncached GET per call and would fire per-agent per-poll. |
| `/health` is already `degraded` on the live fleet | **YES** — `containers_unhealthy: 1`, 33h uptime. See the Blocker-2 revision. |

---

## Blocker 1 — node-lag false positives

`GET /v1/tx/status/:txid` returns a tx-specific `code: "TX_NOT_FOUND"`, distinguishable
from a route-level 404 (`code: "NOT_FOUND"`). But it reflects **that node's current
view**: a node behind the tip returns `TX_NOT_FOUND` for a transaction that really
landed. Node-down is a safe 502; node-lag is a 404 that takes money from a buyer who
genuinely paid.

### What the platform actually exposes

`client.getChainInfo()` → `GET /v1/tx/info`, public and sessionless (which is why the
financial-suspension probe at `src/cli.js:572-588` already leans on it — **[R2]** the
original `487-495` cite had drifted). Typed shape:

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

**[R2] The predicate below is the REVISED one.** As originally written
(`isFinite && connections > 0 && blockHeight >= longestChain`) it passes trivially
when `longestChain === 0` — a real Komodo-lineage startup state, reached daily,
because the backend node restarts in the ~04:00 UTC maintenance window. An
arbitrarily-behind node would have read as synced. It also never checked which
*chain* it was talking to.

```
syncedView =
     Number.isFinite(ci.blockHeight)  && ci.blockHeight  > 0
  && Number.isFinite(ci.longestChain) && ci.longestChain > 0   // [R2] 0 == "peers not polled yet"
  && ci.connections > 0
  && ci.blockHeight >= ci.longestChain
  && ci.testnet === (J41_NETWORK !== 'verus')                  // [R2] chain pinning, see below
```

**[R2] Chain pinning.** `ChainInfo` already carries `chain` and `testnet` and the
reconciler never looked at them. A backend node swapped to the wrong chain, or with a
corrupt `txindex`, is fully "synced" by the height test and returns `TX_NOT_FOUND` for
every genuinely-landed txid. Pinning the chain costs one comparison and closes the
whole class.

**[R2] Bracket the pass with two samples.** Take `getChainInfo()` before the lookups
*and again after*, and require both synced with non-decreasing height before any
reversal in that pass. This closes the temporal TOCTOU (chain-info at T0, node
restarts, lookups at T0+n return lag-404s) and detects a mid-pass node swap, for the
price of one extra public GET. Evidence says the backend runs a single verusd today —
a *fleet-wide* `503 CHAIN_SYNCING` during maintenance is inconsistent with a
load-balanced pool — but nothing contractual keeps it that way, and the day a second
node appears behind the LB, a single sample makes this gate decorative.

1. `getChainInfo` throws, or `syncedView` is false → **the whole pass counts nothing.**
   Same treatment as the existing `systemic` verdict: no miss increments, no
   persistence, log once. A lagging or unreachable node produces zero evidence.
2. Misses accumulate only under a synced view. Stamp `firstMissHeight = ci.blockHeight`
   alongside the existing `firstMissAtMs`.

   **[R2] `firstMissHeight` lifecycle — specify it or the grace silently dies.**
   It must be **deleted at every site that deletes `firstMissAtMs`** — the mempool
   sighting reset (`:602-609`) and the confirm path (`:591-594`). The existing stamp
   idiom is `if (!live.firstMissAtMs)`; copy that idiom without adding the reset and a
   flapping index leaves an ancient `firstMissHeight` behind, so the next miss run
   satisfies "≥30 blocks" *immediately* and the block grace degrades to nothing. A
   legacy record with `misses` but no `firstMissHeight` stamps at the current pass
   height, restarting the block clock — the safe direction.
   `RECONCILE_GRACE_MS` / `pastGrace` are **deleted**, along with the defect-6
   `creditedAtMs` hole they contain; the block-denominated grace replaces them.
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
- **Gate the strong classification on the `tx.status-notfound-code` feature flag.**
  Fail closed: flag absent or `/v1/version` unreachable → classify nothing strong →
  never reverse. **[R2]** Use the SDK's cached `hasFeature()` (`dist/backend-features.js`,
  5-min TTL), *not* a clone of `backendSupportsPlatformStatus` — that one re-fetches per
  call and this runs per-agent per-poll. Match `err.code === 'TX_NOT_FOUND'` only; **drop
  the message-regex patterns** — match the code, not the text.
  **[R2] Fail-closed here is silent.** An inert reconciler reproduces today's live
  exposure with nobody noticing — the exact "write-only safety feature" failure Blocker 2
  exists to fix. Log the state once and surface it in the Blocker-2 health output as
  `reconciler: armed | inert-no-flag | inert-unsynced`.

**[R2] The systemic guard must be REDEFINED, not "kept".** Its predicate is
`lookups.length > 1 && weakUnknowns === lookups.length` (`:537-538`) — written over the
very class this simplification deletes. With `weak` gone it can never be true: a
safety layer that ships dead. All three reviews found this independently.

Redefine it over the strong class: *all* lookups in a pass returning identical
`TX_NOT_FOUND`, with `lookups.length > 1`, counts nothing that pass. That is the case
that actually matters — a backend `txindex` wipe or rebuild returns tx-specific
`TX_NOT_FOUND` for every txid while the node is genuinely at its peers' tip, so the
sync gate passes and every open 0-conf credit on the fleet reverses together.

`lookups.length > 1` still cannot protect a **lone** open credit against any
fleet-identical fault, and at current volume the lone credit is the common case. Add a
fleet-level circuit breaker — more than N reversals in one pass across all agents →
stop, reverse nothing, flag `needsOperator` — which bounds the blast radius and gives
the single-credit residue an upper limit too.

### Money direction

Every missing input results in *no reversal*. The only path that debits a buyer
requires: backend advertises the code contract, AND the node self-reports peer-parity
with >0 peers on the **right chain** with non-zero heights **at both ends of the pass**,
AND ≥30 blocks ingested across the miss run, AND ≥3 misses over ≥10 min, all tx-specific
`TX_NOT_FOUND`, AND not systemic, AND under the fleet circuit breaker. The 24h
`_recheckReversals` restore sits behind all of it.

### [R2] Known residuals, accepted

Both need a reorg *plus* a double-spend, both cap at <2 VRSC, and both lose **seller**
money, not buyer money — the same exposure the 0-conf tier already accepts:

- A record that sees `confirmations >= 1` loses `unconfirmed` permanently (`:591`). If
  that block is later orphaned and the tx double-spent away, the credit stands unfunded
  and nothing revisits it.
- `_recheckReversals` restores on any `confs >= 1` (`:739-756`). A stale node can report
  confirmations for a tx the true tip has orphaned.

Optionally clear `unconfirmed` only at ≥2 confs. Not doing so is a defensible choice;
not *recording* the choice is not.

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
   `deposits_needs_operator`, and `deposits_needs_operator > 0` joins the `degraded`
   OR-chain. Durable disk state, so no `startupComplete` gating. Additive fields respect
   the versioned-path contract; the new degrade trigger is a contract change and belongs
   in the changelog.

   **[R2] The degrade join conveys almost nothing today — the counter is the real
   contract.** The live fleet's `/health` is *already* `degraded` and stays that way for
   the rest of any run containing one container crash: `state._containerCrashes` only
   ever increments (`cli.js:10084, 10391, 10434` — no delete, no reset anywhere) and
   `containersUnhealthy > 0` is the first term of the OR-chain (`control.js:491`).
   Verified live: `status: degraded`, `containers_unhealthy: 1`, 33h uptime. Keep the
   join for consistency with dead-letters, but name `summary.deposits_needs_operator`
   `above: 0` as the canonical watch in the monitor-room contract (`control.js:92-96`),
   mirroring the `containers_unhealthy` note. The sticky crash counter devalues every
   degrade trigger and deserves its own fix — out of scope here, worth a line item.

   **[R2] Counter predicate, stated so it cannot be guessed wrong:** count
   `needsOperator && !resolvedAt`, **across both homes** — `processed` records (`:585`)
   and `reversed[]` entries (`:731`). Those are structurally different collections; a
   reader that scans one is the "guard at one of two sites" recurrence this codebase
   keeps re-finding. Omit the `!resolvedAt` term and `/health` degrades forever after a
   successful resolution.
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
     fail closed on any doubt), then credits, then stamps
     `{resolvedAt, resolvedBy, resolution}` rather than deleting the entry.
     **[R2]** `refundsApprove` is a loose precedent, not a literal one: its re-verify is a
     *target-address* re-resolution with drift-abort (`cli.js:7403-7431`), not a
     confirmation check. And unlike the builders, this verb needs an authenticated
     session, so it is **not disk-pure** — say what it does when the platform is down
     (fail closed, refuse, exit non-zero).
   - `deposits dismiss <agent-id> <txid> --reason <text>` — clears the flag with an audit
     stamp, moves nothing.

#### [R2] These verbs MUST take an inter-process lock. The original design skipped it.

Two of the three reviews landed on this independently, and it is the same bug class this
repo has already fixed twice. `refunds` is protected by `acquireSendLock` — an O_EXCL
lock file with PID-liveness and a gated steal (`cli.js:6626-6680`) — used by both the
daemon drain and the out-of-band approve (`cli.js:6871-6873`). The design borrowed
`refundsApprove`'s re-verification idea and left its locking behind. Cross-process safety
in `deposit-watcher.js` today rests entirely on the **in-process** `_claimsInProgress` set
(`:146`), which is worthless against a second process.

Three concrete races, all with the 60s poller running continuously:

- **Lost stamp → double credit.** The daemon's load→await→save clobbers the operator's
  `resolvedAt`, resurrecting `needsOperator`; the next actor credits again. Same clobber
  shape as defect 3 below.
- **Lost meter update.** `deposits credit` is the **first second-process writer of
  `credit-meters.json` in this system's history.** Every existing writer lives in the
  daemon. `saveMeters` is atomic per writer but last-writer-wins across processes, so a
  CLI credit interleaved with live proxy traffic's `reserveCredit`/`adjustCredit`
  silently erases one or the other.
- **Re-report double credit.** After crediting a `:731` reversed entry the txid is still
  absent from `processed`, so `claimTxid` (`:162-168`) will not block a buyer re-report.
  This is defect 2, reintroduced through the operator door.

Required: a per-agent O_EXCL lock (`deposits-<agentId>.lock`, `acquireSendLock`
discipline — **its own lock namespace**, never the refund locks, per this design's own
cross-wiring rule) held across every load→save of both files in **daemon and CLI**; the
CLI must re-read inside the lock after its network awaits; and `deposits credit` must
push the txid into `processed` in the same save.

Also: `_settleReversedForTxid` (`:473-483`) stamps `restoredAt`/`resolvedBy` but **never
clears `needsOperator`**. Left as-is, an auto-settled entry keeps its flag, `deposits
list` prints it as actionable, and the operator follows the tool's own instruction into a
second credit. Fix the settle path when the flag is introduced, not after.

#### [R2] The operator cannot actually answer the question the flags pose

Walk it: `:585` says "check the meter against the chain and correct it by hand". The
chain half is answerable from the txid. The meter half is not — `credit-meters.json`
stores only `balance`/`totalDeposited`/`totalSpent`/`usage` with **no journal**, and
`balance` moves with every proxy request, so no arithmetic on it can isolate whether one
historical ≤2 VRSC debit executed. Both `needsOperator` states ask exactly that question.
An operator who cannot answer it will always-credit (seller pays twice) or always-dismiss
(buyer robbed) — a coin flip wearing a CLI.

Cheapest sufficient fix, and it belongs in scope: `deposits list` prints, per anomaly,
the buyer's meter record **and** the ledger-derived expected `totalDeposited`, flagging
the discrepancy direction. That single number turns the verbs from judgement into
arithmetic. (It degrades if the 1000-entry trim already dropped records — defect 4
compounds here, which is another reason to fix defect 4 first.)

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
   **[R2] Unstated precondition:** the in-memory claim is never released after a
   committed credit (`:349`), so the same-process re-report is blocked — the exploit
   needs a **daemon restart** in between. Restarts here are routine (daily maintenance,
   deploys), so the defect stands; the branch's own test calls `_forgetClaimForTest` to
   "model the restart" (`branch-reconcile.test.js:680`).
3. **The pending-path save clobbers concurrent writes.** `reportDeposit`'s
   under-confirmed branch saves the snapshot loaded *before* its `verifyPayment` /
   `getTxStatus` awaits, overwriting a poller commit that landed during them and deleting
   that txid's dedup entry → re-credit exposure. The credit path already re-loads fresh
   for exactly this reason; the pending path must too.
   **[R2] Understated twice.** (a) If the clobbered write is a *reversal*, the stale save
   resurrects the record as `unconfirmed` and drops the `reversed` entry — the reconciler
   then runs the whole miss cycle again and calls `reverseDeposit` a **second time**.
   Double *debit*, buyer down 2×, no ledger trace of the first. (b) **This one is live on
   `main` today** (`src/deposit-watcher.js:283-296`) — it does not wait for M4 and
   deserves a standalone fix.
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

### [R2] Four more, found in review

7. **Every forward CREDIT path credits the meter before persisting the dedup record.**
   The reversal path got a two-phase intent protocol (`debiting` → debit → `debited`);
   the credit paths never did. `reportDeposit`: `creditDeposit` at `:320`, `saveDeposits`
   at `:348`. Poller: `:800` then `:809`, with `catch` at `:821` explicitly keeping the
   entry pending on error. A crash in between leaves the meter credited with no
   `processed` entry, and the restart credits **again**.
   **This one is not capped by the 2 VRSC tier** — it applies to the 6-conf 50 VRSC path
   too, making it the largest single exposure in the file. A persistent disk error turns
   it into a credit *loop*. Also pre-exists on `main`.
   *Fix:* persist a `crediting` intent stamp before `creditDeposit`, finalize after;
   `crediting` without finalize on restart → `needsOperator`. Exactly the protocol the
   reversal path already has.
8. **The restore crash window loses a buyer's money silently and terminally.**
   `:754-756` stamps `restoredAt`, saves, *then* credits. Crash in between and the
   `!r.restoredAt` filter at `:715` excludes the entry forever — no flag, no reader, no
   recheck. The comment at `:751-753` claims the loss is "visible, recorded, fixable";
   nothing recorded distinguishes stamped-and-credited from stamped-and-crashed, and
   `deposits list` would render it *resolved*. The recredit path (`:571-573`) recovers to
   `needsOperator` via `:577-589` — the asymmetry is the bug.
   *Fix:* stamp `restoring`, credit, then finalize `restoredAt`; `restoring` on restart →
   `needsOperator`. One extra save.
9. **Pre-port 0-conf credits are invisible to the reconciler.** `main` never stamps
   `unconfirmed` (zero occurrences in `src/deposit-watcher.js`), and the reconciler's
   `open` filter keys on `d.unconfirmed` (`:487`). Every sub-2-VRSC mempool credit minted
   by the fleet *before* the port keeps its credit forever. Bounded and one-time, but
   silently deciding it is out of scope is the wrong default for a money feature. Decide:
   one-shot migration sweep flagging recent `processed` entries with `confirmations: 0`,
   or explicitly accept and record the write-off.
10. **The never-released claim blocks the re-report the code promises.** `:466-470` says a
    buyer whose payment did confirm should be able to re-report it; the in-memory claim
    from the original credit is never released (`:349`) and reversal never calls
    `releaseTxid`, so until a restart the buyer gets "Deposit already processed" for a
    credit they no longer hold. Low severity, mostly masked by auto-restore and restarts.
    *Fix only together with defect 2* — releasing the claim without making restore re-add
    to `processed` widens defect 2 from "after restart" to "immediately".

**Findings 2, 3, 4, 7 and the operator-door variant in Blocker 2 are all double-credit
paths.** That is the same class as the "two credit mints" defect found in review round 5
of 2.29.0. Whatever re-lands M4 should treat "can this txid be credited twice?" as the
standing question, not a one-off check.

### [R2] What review tried to break and could not

Recorded so implementation does not re-litigate it: `claimTxid`'s synchronous
check-and-set genuinely closes the same-process report-vs-poller race; the credit commit,
reconcile phase-3, and restore sections have no `await` between re-load and save, so they
are atomic against each other within the process (the pending path really is the only
same-process clobber); every crash permutation of the `debiting`/`debited` state machine
lands on "forgive" or "needsOperator", never "debit twice"; every ambiguous *input*
resolves to keeping the credit (unparseable shapes, unknown errors, auth failures → all
transient); the phase-1/phase-2 restructure genuinely killed the "outage accumulates its
way to a reversal" bug; the no-gate restore path is correct; and keeping deposits out of
`pending-refunds.json` is right for the stated reason.

---

## Testing

The execution harness (`test/helpers/dispatcher-harness.js`, `fake-chain.js`,
`start-action.test.js`) can cover both blockers, with these additions:

- `sdk-stub.js` `getChainInfo` currently returns only `{ blockHeight }`
  (`test/helpers/sdk-stub.js:98` — verified) — needs `longestChain`, `connections`,
  `chain`, `testnet`, with lag controls on `FakeChain` (`networkHeight` distinct from node
  `height`, `setLag(n)`, `setConnections(n)`).
- `FakeChain` needs a per-txid `getTxStatus` script: txid → a sequence of
  `{confirmations}` results or `J41Error`-shaped throws carrying `code` / `statusCode`.
- `writeFixture` needs to seed `agents/<id>/deposits.json` and `credit-meters.json`.
- The version stub needs a controllable `features` list (it already accepts one).
- **[R2] A fifth, without which three of the four above are unreachable:** seed an
  **api-endpoint capability**. `startDepositPoller` lives inside
  `if (apiAgents.length > 0)` (`cli.js:4145`, poller at `:4365`) and the stub's
  `getAgentServices` defaults to `{ data: [] }` (`sdk-stub.js:93`), so **no harness
  scenario can execute the poller at all** — not its 60s cadence, not the `emit`
  threading, not `agent._client || agent.client`. Everything would be tested by calling
  `reconcileUnconfirmedDeposits` directly, which is the "two-part fixes can be jointly
  dead" shape.
- **[R2]** `FakeChain.height` advances only when an identity write confirms or
  `mineBlock()` runs, and each `mineBlock()` force-confirms pending identity writes as a
  side effect. The 30-block scenarios need a height-advance mechanism **decoupled from
  write confirmation**, or deposit-grace scenarios will interfere with pending-write ones.

### [R2] Six mutations the originally-planned suite would NOT catch

This is the part of the review that earned its keep. Each mutation is a plausible
implementation slip that leaves all five originally-planned scenarios green. Every one of
these needs a scenario **written to fail against the mutation**.

1. **Delete the feature-flag gate** (classify `TX_NOT_FOUND` strong unconditionally). The
   stub's *default* version response already advertises `tx.status-notfound-code`
   (`sdk-stub.js:116` — verified), and no planned scenario manipulates `features`. The
   entire flag gate would ship with zero tests that can fail if it is missing.
   → Scenario: version response **without** the flag, full miss run, assert credit intact.
2. **Delete `ci.connections > 0`.** No planned scenario sets `connections: 0` with equal
   heights. `setConnections(n)` is specified as a harness addition that no scenario ever
   calls — a knob nobody turns.
   → Scenario: isolated node, heights equal, height advancing, strong `TX_NOT_FOUND` →
   nothing counted.
3. **Weaken the block grace from `>= 30` to `>= 1`.** Scenario 3 tests 30 (passes),
   scenario 4 tests 0 (passes). Nothing probes 1-29, so "the substance" of this design
   can shrink by 97% with the suite green.
   → Scenario: ~10 blocks advanced → no reversal; then past 30 → reversal.
4. **Fail to reset `firstMissHeight` on a sighting.** No planned scenario mixes flap and
   height grace; the existing sighting test asserts only balance, never stamps.
   → Scenario: flap, then drop, asserting the height stamp restarted.
5. **Leave `emit` at its no-op default** — the mutation *is* the default. Unreachable
   today for the capability reason above.
   → Scenario: api-endpoint agent seeded, assert `deposit.reversed` lands in
   `events.jsonl` / the control-API bus.
6. **Count `needsOperator` from only one of its two homes, or ignore `resolvedAt`.**
   → Scenarios: seed both shapes; and resolve-then-recheck asserting `/health` returns to
   baseline.

### [R2] The branch's 29 existing tests are not the regression cover they look like

`mockClient` (`branch-reconcile.test.js:68-78`) has **no `getChainInfo`**. Under new rule
1 (throws → the pass counts nothing), the file splits three ways and the original design
did not acknowledge the rewrite:

- **Fail loudly** — every reversal-driving test: `:136`, `:217`, `:293`, `:398`, the
  `fullMissRun` restore tests (`:516, :540, :553, :566, :583, :608`), both mint tests
  (`:633, :662`), `:695`.
- **Pass vacuously** — every no-reversal assertion (`:160, :177, :245, :257, :271, :424,
  :451`) now passes because of the sync gate rather than the guard it was written for. *A
  mutant deleting all miss-counting logic passes every one of them.* Each must be
  re-verified after the mock gains `getChainInfo`, not just made green.
- **Assert deleted behaviour** — `_isTxUnknown` (`:200`) pins four message-regex strongs
  that must all flip to `false`; `'ISOLATED weak 404 still reverses'` (`:468`) must be
  **inverted**; `'weak tier is slower'` (`:493`) deleted; the imports of
  `RECONCILE_WEAK_MIN_MISSES` / `RECONCILE_WEAK_SPAN_MS` (`:36-37`) break at load.
- Both systemic tests build `code: 'NOT_FOUND'` errors and will pass forever without
  touching the redefined guard.

The file is genuinely execution-based — no grep/source-text assertions — which is a real
strength. Treat it as a rewrite input, not as a safety net.

### [R2] "Disk-pure" is only partly true

`deposits list`, `dismiss` and the builders are disk-pure. `deposits credit` is not — it
needs an authenticated session and an on-chain read. The `/health` degrade join is
maskable (see Blocker 2). The harness's `health()` helper calls `buildHealthDocument`
directly (`dispatcher-harness.js:474-478`), so asserting through it never exercises the
HTTP route; that is acceptable since the route is a serializer, but say which is meant.

---

## [R2] Implementation sequence — this is four units, not one

The original doc implied "+420 lines into one file plus a test file". Measured against
the real precedents that understates it by roughly 3×: the `refunds` CLI block the
deposits verbs mirror is ~450 lines (`cli.js:7201-7650`); the surfaces add a builder, a
`ctl` case, health fields, an API route and event threading; and ~29 existing tests need
triage or rewriting mid-flight. Realistic total: **1,200-1,600 changed lines.**

Landing that as one commit is precisely how [[feedback_fix_induced_regressions]]
happened — 34 defects across five rounds, most of them caused by the previous round's
fixes. Chunk it:

| # | Chunk | Contents | Independently shippable? |
|---|---|---|---|
| 1 | **Money-correctness fixes** | defects 2, 3, 4, 6, 7, 8, 10 + unit tests | **Yes** — no dependency on the sync gate, smallest reviewable diff, and defects 3 and 7 are live on `main` today |
| 2 | **Blocker 1** | sync gate (revised predicate + chain pin + two-sample bracket), `firstMissHeight` lifecycle, weak-tier deletion, redefined systemic guard, circuit breaker, cached flag gate | **Yes** — the reconciler becomes safe to run automatically |
| 3 | **Read surfaces** | `listDepositAnomalies` → `buildDepositSurface`, `ctl deposits`, health counters + degrade join, `GET /v1/deposits`, `emit` threading | **Yes** — read-only, zero money movement; the natural home for the changelog contract note |
| 4 | **`deposits` CLI verbs** | `list` / `credit` / `dismiss`, inter-process lock, `processed` re-add, meter-reconciliation printout | **Yes, and it needs its own review round** — it hand-moves money, exactly like `refunds approve` did |

Chunk 2's test work includes the six mutation-driven scenarios and the full triage of the
existing 29. Chunks 1 and 2 carry essentially all the money risk; 3 is low-risk; 4 is
high-risk but small and isolable.

**Defect 5 (webhook divergence) is not implementable in this repo alone.** Deferring the
`deposit-confirmed` notify to ≥1 conf vs. speccing a `deposit-reversed` counterpart is a
backend decision. Split it out and send the ask; it currently sits in the "fix before
re-land" list with no owner. One trap if the defer option wins: the *only* place a
sub-2-VRSC deposit reaches ≥1 conf in this code is the reconcile confirm branch
(`:559-599`), which has no notify call today — defer without adding one there and the
platform never hears about small deposits at all.

**Also worth sending to backend now:** the `tx.status-sync-attested` ask (`nodeSynced` /
`tipAgeSeconds` in the `/v1/tx/status` response itself). Deferring it was the right call
— it blocks M4 on a second repo for a risk that is near-zero against a single-node
backend — but it is the only complete fix for the TOCTOU, and "worth asking for" should
become a filed request rather than a sentence in a design doc.
