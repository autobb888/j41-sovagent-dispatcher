# Dispatcher spend-policy consolidation — design

- **Date:** 2026-08-18
- **Status:** Approved — Fable spec review APPROVE-WITH-CHANGES; C1–C5 folded in, ready to build
- **Repo:** `j41-sovagent-dispatcher` (HEAD `f6651cb`, past v2.6.0)
- **Author:** Claude (Opus 4.8) — spec; design origin: Fable code-grounded rescan

## 1. Motivation

Evaluating chainvue's **Peculium** ("safe wallet for AI agents") as an optional
dispatcher signer surfaced the real question: *why would our unattended signer
adopt an external wallet's policy engine — does ours have one?*

A code-grounded rescan (Fable, against real `src/`) established two things:

1. **The dispatcher already implements most of Peculium's model**, and the
   original premise ("payouts fire unattended") is **false**. In J41 the buyer
   pays the agent directly; the dispatcher's only external-destination send is a
   **refund to a buyer**, and refunds are **owner-approved** with re-verification
   at approval time. Peculium's headline property (human approval per external
   send) is already present, dispatcher-native, and in several respects stronger.
2. There are **three genuine residual gaps**, verified in code — the subject of
   this spec.

**Decision on Peculium: HOLD.** Nothing in this spec depends on it. It may return
post-mainnet as an experimental "bring-your-own-wallet" escape hatch, once it
ships mainnet support and an embeddable API. This work is *consolidation of what
we already have*, plus closing two bypasses.

## 2. Verified current state (with cites)

External / value-moving send sites in the repo:

| Site | What it does | Value to a counterparty? | Gated today? |
|---|---|---|---|
| `src/cli.js:7217` `agent.sendCurrency(buyerAddress, refundAmount)` | buyer **refund** | **Yes (external)** | Yes — full policy layer |
| `scripts/pay-jobs.js` `agent.sendMultiPayment(outputs)` | manual buyer→agent **payment** backfill | **Yes (external)** | **No — total bypass** |
| `src/wallet.js:432` `executeSend` → `broadcast` | operator fleet-internal transfer | No — own R-address only (invariant) | Structurally, not ledgered |
| `src/fee-tank.js:218` `executeFeeSweep` → `broadcast` | i→R fee sweep, same agent | No — own R-address only (invariant) | Structurally, not ledgered |
| `broker-executors.js:250`, `job-agent.js:2356`, `cli.js:1595/9285/11304/12107/12375` | identity/record/attestation raw-tx writes | No — fee-bearing only | Out of scope |

`grep -rnoE "\.(sendCurrency|sendMultiPayment|sendMany|sendToAddress)\b" src/`
returns exactly one hit (`cli.js:7217`); `pay-jobs.js` lives in `scripts/`.

The existing policy layer (all in `cli.js`, to be extracted):

- **Allowlist** `cli.js:246-316` — `~/.j41/financial-allowlist.json`, tiers
  `permanent`/`operator`/`active_jobs`; **deny-all on load failure**; atomic
  `tmp`+`rename` (mode `0600`) on approve-add.
- **Rate limiter** `cli.js:589-659` — `dispatcherRateLimits()` reads
  `refund_limits` config; `checkDispatcherRateLimit()` enforces per-job lifetime
  cap (default 3), value ceiling (`price × 1.1`, with NaN-price fail-closed),
  fleet hourly cap (10), 30 s per-job cooldown. Returns `{allowed, retryable,
  reason}`; **retryable** = "wait, will pass" vs terminal = "needs operator".
- **Locked durable send-history** `cli.js:661-698` (`withSendHistoryLock`,
  `recordDispatcherSend`); `perJob` deliberately never pruned (lifetime cap),
  `global` pruned to the 1 h window.
- **Kill switch** `cli.js:575-587` `setFinancialSuspended` + the sweep timer —
  suspends all sends on platform outage.
- **Refund-target resolution** `src/refund-target.js` — the ONLY place a refund
  address is chosen: `isIAddress` + `notSelf` + `notPlatformFee` +
  `disputeSigner` + `nameRoundTrip`; any failure → `confident:false` →
  `needs_review` (which `approve --all` refuses to touch).
- **Refund approval rail** `cli.js:7150-7365` — refunds enter as
  `pending_approval`; only `approved` drains; the dispute sweep auto-signs the
  *acknowledgement* but enqueues the *send* for owner approval.

**The three gaps (verified):**

- **G1 — no compiled hard ceiling.** `refund_limits` is fully config/env-tunable
  with no upper clamp (`config-loader.js:80-85`, env `J41_REFUND_MAX_VALUE_MULT`
  etc. at `:151-154`; limiter applies no bound at `cli.js:589-604`). The code
  documents this as *philosophy*, not oversight (`config-loader.js:77-79`: "a
  limit you cannot raise is a limit operators disable").
- **G2 — no unified append-only ledger with denials.** Send-history records
  successful refund sends only; denials go to console/events; wallet sends and
  fee sweeps are ledgered nowhere shared.
- **G3 — `scripts/pay-jobs.js` bypass.** Raw `J41_WIF` from env,
  `parseFloat(job.amount)` (the exact float hazard `wallet.js:58-70` bans),
  `sendMultiPayment` to arbitrary addresses, none of the gates above.

## 3. Decisions (approved)

| Fork | Choice | Rationale |
|---|---|---|
| Hard-ceiling calibration | **Generous** | Bounds tampering/fat-fingers only; never pinches the operator workflows the docs endorse (backlog drains). |
| `pay-jobs.js` | **Gate + fix** | Keep the ops capability; remove the bypass and the float bug. |
| Attended-mode (P6) | **Formalize only** | Document existing always-approve as explicit config; **add no new unattended automation** before the mainnet-bound audit. |

## 4. Architecture

### 4.1 New module: `src/spend-policy.js`

Single home for the gate. **P1 is move-verbatim** of the functions cited in §2
(allowlist, limiter, history-lock, kill switch), exposing one funnel:

```
gateExternalSend({ jobId, toAddress, amountSats, jobPriceSats, kind,
                   expectedRecipients? })
  → { allowed: boolean, retryable: boolean, reason?: string, checks: object }

recordSendOutcome({ kind, jobId, toAddress, amountSats, txid?, denial? })
  → void   // updates limiter working-state AND appends the ledger
```

- `amountSats` / `jobPriceSats` are **integer satoshis** (`BigInt` or a checked
  integer), never floats — consistent with `wallet.js` amount discipline.
- `kind ∈ { "refund", "payment", "fleet_transfer", "fee_sweep" }` — drives which
  checks apply (see 4.3) and labels the ledger.
- **`expectedRecipients`** (optional) — the set of addresses an *authoritative*
  source has declared valid for this send. Its meaning is kind-specific and is
  what generalizes today's refund allowlist:
  - `refund` — omitted; the counterparty is authorized by the existing
    allowlist + `resolveRefundTarget` (buyer i-address from the job).
  - `payment` — required; `[job.payment.address, job.payment.platformFeeAddress]`.
    `toAddress` must be a member. (The refund allowlist does **not** apply — the
    agent's payout address is not a refund recipient.) **Provenance is not fully
    trustable and the spec must say so:** the codebase treats the platform as
    *semi-trusted* for "where a payment goes" — `mainnet-guard.js:48` makes
    `J41_TRUST_PLATFORM_RESOLUTION=1` a violation, and the SDK's `sendCurrency`
    H2 note (`@junction41/sovagent-sdk` `agent.d.ts:631-638`) refuses platform
    identity-resolution by default. Passing raw `getJob()` addresses as
    `expectedRecipients` would *launder* platform-supplied addresses into
    "authorized." Mitigation: pin `platformFeeAddress` to a config/compiled
    constant (it is a fixed platform value, not per-job); corroborate the payout
    address where possible; and where it cannot be corroborated, label it
    **platform-trusted** explicitly rather than pretending the gate authorized it.
  - `fleet_transfer` / `fee_sweep` — omitted; own-R-address invariant already
    proven by `wallet.js` / `fee-tank.js`.
- `checks` is the structured decision detail (which gate passed/failed), for the
  ledger and for tests.

Gate order inside `gateExternalSend` (preserves today's semantics exactly, adds
one step):

1. financial-suspension (kill switch) → `retryable:true`
2. counterparty authorization (external kinds only) → terminal
3. per-job lifetime cap → terminal
4. value ceiling (`price × effectiveMultiplier`) → terminal
5. fleet hourly cap → `retryable:true`
6. per-job cooldown → `retryable:true`
7. **absolute per-tx cap** (`HARD_MAX_SINGLE_SEND_SATS`) → terminal *(new)* —
   **external kinds only** (`refund`, `payment`). For self-directed kinds
   (`fleet_transfer`, `fee_sweep`) this cap is **advisory: ledger + loud WARN,
   never a deny** (see C1 / §4.2). A self→self sweep has no counterparty risk, and
   terminally blocking a &gt;1000 VRSC sweep would strand the fee tank — the exact
   liveness outage `fee-tank.js` exists to prevent.

### 4.2 The seam (where the funnel is wired)

- **`cli.js:7217` (refund):** replace the inline check/record sequence with
  `gateExternalSend(...)` and `recordSendOutcome(...)`. **Exact ordering is
  load-bearing (C3)** — the gate decision (and its ledger line) must land
  *before* the inflight marker, or a denied send leaves a marker behind and the
  next drain treats a send that never happened as "may have paid, cannot tell":
  ```
  gate → decision-append → markRefundInflight (cli.js:7215)
       → broadcast (cli.js:7217) → markJobRefunded (cli.js:7228, dedup guard)
       → clearRefundInflight → recordSendOutcome (outcome-append)
  ```
  This preserves the existing "count AFTER broadcast" invariant
  (`recordDispatcherSend`, cli.js:7230-7232) and the `markJobRefunded` double-send
  guard, both unmoved. `kind:"refund"`. Proven by a live-path wiring test.
- **`scripts/pay-jobs.js` (payment):** BigInt amount parse. `sendMultiPayment` is
  **one atomic tx**, so gate it **as a unit, not per-output**: check every output's
  membership in `expectedRecipients`, sum the outputs against the value ceiling,
  and consume **one** per-job / hourly slot for the tx. If *any* output fails the
  gate, deny the whole tx (nothing broadcasts). One broadcast, then one
  `recordSendOutcome` carrying all outputs. Refuse on mainnet unless the whole tx
  is within caps.
- **`wallet.js:432` / `fee-tank.js:218` (fleet-internal):** call
  `recordSendOutcome({kind:"fleet_transfer"|"fee_sweep"})` for the ledger, and
  apply the absolute per-tx cap **only as an advisory WARN, never a deny (C1)**.
  These keep their own own-address structural invariants; the counterparty/
  value-ceiling/cooldown gates do **not** apply (there is no external counterparty).
- **Identity/record raw-tx writes:** out of scope (no counterparty value).

### 4.3 Which checks apply by kind

**Only external kinds pass through `gateExternalSend`.** Fleet-internal kinds are
ledgered via `recordSendOutcome` and never enter the gate — so the suspension /
counterparty / rate checks below simply do not apply to them (routing them through
the gate would newly subject an operator's fleet transfer/sweep to the financial
kill switch, a behavior change we deliberately avoid). Their only spend-policy
touch is the ledger line and the **advisory** absolute-cap warning.

| Check (gate) | refund | payment | fleet_transfer / fee_sweep |
|---|---|---|---|
| unknown-kind / bad-amount fail-closed | ✓ terminal | ✓ terminal | n/a (not gated) |
| suspension | ✓ | ✓ | not gated |
| counterparty authorization | allowlist + refund-target | `expectedRecipients` (pinned fee addr + platform-trusted payout) | own-addr invariant (in wallet.js) |
| per-job cap / value ceiling / hourly / cooldown | ✓ (kind-scoped key) | ✓ (kind-scoped key) | — |
| absolute per-tx cap | ✓ terminal (null → deny) | ✓ terminal (null → deny) | ⚠ advisory via recordSendOutcome |
| ledger | ✓ (gate + outcome) | ✓ (gate + outcome) | ✓ (outcome only) |

**⚠ advisory** = ledger the breach + loud WARN, but **do not deny** — a
self-directed sweep/transfer has no counterparty risk and a terminal deny there
strands the fee tank (C1). **Kind-scoped key:** refunds use `jobId`; payments use
`payment:${jobId}` so the two never share a per-job/value/cooldown budget. **null →
deny:** an amount the cap cannot evaluate is a terminal deny on external kinds
(fail-closed), never a silently-skipped `pass`.

The **counterparty authorization** row is the one gate whose *source of truth*
differs by kind (allowlist for refunds, authoritative job record for payments,
structural own-address invariant for fleet moves) — the check itself ("is this
destination authorized for this send?") is uniform.

## 5. Component specs

### P1 — Extract `src/spend-policy.js` (behavior-preserving)

Move the §2 functions verbatim into the module. **Re-export is mandatory, not
conditional (C5):** `cli.js`'s test-mode `module.exports` (`cli.js:12934`) already
exports `checkDispatcherRateLimit`, `recordDispatcherSend`,
`_resetDispatcherRateLimit`, `setFinancialSuspended`, `isFinanciallySuspended`,
`loadSendHistory`, `SEND_HISTORY_PATH`, `FINANCIAL_SUSPENDED_PATH`,
`acquireSendLock`, and the existing suites import them **from `cli.js`**. Every
moved name must stay aliased from `cli.js` (re-imported from the new module and
re-exported), or the un-ported suites break silently. Verified-clean couplings:
`untrusted()` is already in `src/untrusted.js`; `loadDispatcherConfig`
(`config-loader.js:453`) has no cycle back to `cli.js`; `DISPATCHER_DIR`-derived
paths (`SEND_HISTORY_PATH` cli.js:342, `FINANCIAL_SUSPENDED_PATH` cli.js:365,
`ALLOWLIST_PATH` cli.js:246) move with the module. `startDispatcherSweep` stays in
`cli.js` and imports `setFinancialSuspended` from the new module.

`attemptPendingRefund` calls the funnel. **No behavior change** — the only
observable differences are the ledger append (P3) and the new absolute cap (P2),
each introduced in its own step. Ordering: move first, prove with wiring tests,
then layer P2/P3.

### P2 — Compiled hard ceilings

```js
// src/spend-policy.js — un-widenable. min(config, HARD) always wins.
const HARD_MAX_VALUE_MULTIPLIER = 2.0;
const HARD_MAX_SENDS_PER_JOB    = 10;
const HARD_MAX_SENDS_PER_HOUR   = 100;
const HARD_MAX_SINGLE_SEND_SATS = 1000n * 100_000_000n; // 1000 VRSC
```

`effectiveLimits()` = `dispatcherRateLimits()` then `min` against each constant.
When a config/env value exceeds its ceiling, **clamp and log loudly** (one WARN
per distinct clamped key per process). The absolute per-tx cap has no config
equivalent today — it is a pure new backstop, **terminal for external kinds only**
(§4.2/§4.3 C1). Doctrine preserved: config is still raisable *up to* the ceiling,
so the endorsed backlog-drain workflow still works.

**Relief valve for large refunds (document in operator-facing text):** the
1000 VRSC per-tx cap never permanently strands a legitimate larger refund — it
splits into 2–3 sends (per-job cap 3, cumulative ≤ `price × 1.1` &lt; the ×2.0
ceiling) and passes. The un-raisable cap bounds a single catastrophic send
without blocking real refunds.

### P3 — Unified append-only ledger

- File: `~/.j41/spend-ledger.jsonl`, `O_APPEND`, one JSON object per line.
- Written on **every** `gateExternalSend` decision (allow **and** deny) and every
  `recordSendOutcome`. A line's `checks` object can exceed `PIPE_BUF` (4 KB), so a
  bare concurrent `O_APPEND` could interleave across processes — the append is
  therefore taken **under a lock**. **Discipline is single-`write()` of the full
  line to an `O_APPEND` fd, under the lock (C4)** — *not* `tmp`+`rename`, which is
  whole-file-rewrite semantics and would destroy the append-only log. Use a
  **dedicated `spend-ledger.lock`** (same stale-steal discipline as
  `acquireSendLock`), **not** `withSendHistoryLock`: reusing the history lock would
  drag daemon fee-sweep ledger appends into the refund limiter's critical section
  for no correctness gain (needless coupling).
- Line schema (stable keys):
  ```json
  { "ts": "<ISO8601>", "event": "gate_decision|broadcast_outcome",
    "kind": "refund|payment|fleet_transfer|fee_sweep",
    "jobId": "<id|null>", "toAddress": "<addr|null>", "amountSats": "<int-string>",
    "allowed": true, "retryable": false, "reason": "<str|null>",
    "checks": { }, "txid": "<txid|null>", "denial": "<str|null>" }
  ```
  `amountSats` is a **decimal string** (satoshi integer) to avoid any JSON float.
- **Fail-closed:** a ledger write that must precede an irreversible broadcast
  (the gate-decision line) failing → the send is **denied in the `retryable`
  class** (so the refund drain retries; a full disk never strands owed money).
  The post-broadcast outcome line is best-effort (the money already moved; losing
  the audit line must not crash the process) but a failure is logged loudly.
- Send-history (`cli.js`) stays the limiter's working state — the ledger is the
  immutable record, **not** a second source of truth for limits.

### P4 — Close the bypasses

- **`pay-jobs.js`:**
  - Replace `parseFloat(job.amount)` (`scripts/pay-jobs.js:51`) with a
    BigInt/satoshi parse (reuse `wallet.js parseVrscAmount`).
  - **Delete the fabricated fee (C2):** `parseFloat(job.payment?.feeAmount || 0)
    || amount * 0.05` (`:52`) both does the banned float math **and** invents a
    5% fee client-side when the platform states none. A stated fee → a fee output;
    **no stated fee → no fee output** (never a locally computed one).
  - `expectedRecipients` = `[job.payment.address, PLATFORM_FEE_ADDRESS]` where
    `PLATFORM_FEE_ADDRESS` is the pinned config/compiled constant (C2), not the
    per-call `job.payment.platformFeeAddress`; the payout address is passed with
    its provenance labeled platform-trusted per §4.1.
  - **Gate the multi-output tx as a unit** (§4.2): all outputs checked, summed
    against the ceiling, one slot consumed, deny-all-or-broadcast-all; one
    `recordSendOutcome` for the tx.
  - **Refuse to run on mainnet** (`mainnet-guard`) unless the whole tx is within
    caps. Header comment updated — it is no longer a bypass.
- **`wallet.js` / `fee-tank.js`:** add `recordSendOutcome` calls (ledger +
  absolute cap backstop). No change to their own-address invariants.

### P5 — Mainnet gating

Extend `mainnet-guard.js findMainnetSecurityViolations`:

- Any `refund_limits` value that P2 had to clamp on this host = **violation**
  ("config asks above the compiled ceiling — someone edited it").
- `~/.j41/spend-ledger.jsonl` not writable at startup = **violation** (P3 is
  fail-closed; an unwritable ledger would stall all sends).

Follows the file's own rule: each downgrades a security default. **Preserve
purity:** `findMainnetSecurityViolations(env, opts)` is deliberately pure
(`mainnet-guard.js:19-21`) and its tests rely on that — pass the computed facts
(the clamped-key list from P2, the ledger-writable boolean) in as arguments, or
add a sibling impure check that gathers them and calls the pure core. Do **not**
make the pure function read `cfg`/`fs`.

### P6 — Attended-mode formalization (formalize only)

Add config `spend_policy.approval`, default `"always"` = today's behavior
(every external send requires owner approval). Documented + surfaced in `status`.
**No `auto_approve_below_sats`; no new unattended send path.** This is a naming/
documentation step so the existing guarantee is explicit and greppable.

## 6. Invariants & error handling

- **Fail-closed** everywhere (per `feedback_failclosed_security`): auth/policy/
  ledger failure denies the send; it never degrades to "send anyway".
- **Retryable taxonomy preserved** exactly (`cli.js:609-614`): transient causes
  (suspension, hourly cap, cooldown, pre-broadcast ledger failure) are
  `retryable:true`; terminal causes (allowlist, per-job cap, value ceiling,
  absolute cap) are `retryable:false`. Callers must not drop a retryable send.
- **Move-verbatim before cleanup:** P1 changes no logic; any readability cleanup
  happens only after the wiring tests are green.
- **Amounts are integer satoshis** across the module and the ledger — never a JS
  float, never `parseFloat(x) * 1e8`.

## 7. Testing

- Port `test/refund-rate-limit.test.js`, `refund-rate-limit-wiring.test.js`,
  `send-history-lock-race.test.js`, `send-lock-race.test.js` to exercise the
  extracted module (pure functions port directly).
- **Clamp property test:** for arbitrary config/env inputs, `effectiveLimits()`
  ≤ every hard constant.
- **Live-path wiring test:** assert `attemptPendingRefund` actually calls
  `gateExternalSend` on the real path (not just that the export exists).
- **Denial ledger test:** a blocked send leaves a `gate_decision` line with
  `allowed:false` and the reason.
- **Fail-closed ledger test:** an unwritable ledger → refund denied `retryable`.
- **`pay-jobs.js` tests:** BigInt amount correctness; a bad output is gate-denied;
  mainnet refuses.
- Gate: `npm test` green (existing suite + new).

## 8. Rollout / back-compat

- P1 is a pure refactor. P2 clamps only *above-generous* values, so no existing
  operator config changes behavior. P3 is additive (new file). P6 defaults to
  today's behavior. **No migration, no config change required of operators.**
- The ledger file is created on first send if absent.

## 9. Sequencing

`P1 → P2 → P3 → P4 → P5 → P6`, each TDD, each landing green before the next.
Then a **3–5 pass Fable audit** of the finished change.

## 10. Risks & mitigations

1. **Refactoring the highest-consequence code out of `cli.js`.** Mitigate:
   move-verbatim + live-path wiring tests *before* any cleanup; diff behavior via
   the ported existing tests.
2. **Hard-cap miscalibration.** Generous profile chosen precisely so caps bound
   tampering, not operations; clamping logs loudly so a legitimately-needed
   raise is visible rather than silent.
3. **Ledger fail-closed stranding money.** The pre-broadcast deny is `retryable`,
   so the drain retries; only the audit line (post-broadcast) is best-effort.

## 11. Open questions

None. (Peculium: HOLD, out of scope. All three forks decided in §3.)
