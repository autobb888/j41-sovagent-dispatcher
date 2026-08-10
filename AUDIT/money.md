# Money audit — j41-sovagent-dispatcher

Date: 2026-08-10 · Domain: **money** · Read-only pass, no code changed.

Scope: everything that moves, holds, prices or accounts for value —
fee-tank sweep (`src/fee-tank.js`), operator wallet (`src/wallet.js` + the
`wallet` CLI), refunds/disputes (`src/refund.js`, `src/refund-target.js`,
`src/dispute-sweep.js`, the `refunds`/`respond-dispute` CLI), the financial
allowlist, token-budget pricing (`src/token-budget.js`), and the API-endpoint
proxy's deposit + credit-meter path (`src/deposit-watcher.js`,
`src/credit-meter.js`, `src/proxy-handler.js`).

**Headline:** the on-chain money paths (sweep, `wallet`, refunds) are in good
shape — the invariants the docs claim are actually enforced in code, and the
hard parts (BigInt satoshi parsing, address provenance, in-flight markers,
inter-process locks) are done properly. The findings cluster in two places the
docs oversell: the **API-endpoint proxy's billing settle** and the **financial
rate limits**, which are documented but not wired up.

---

## Findings

| # | Sev | File:line | Summary |
|---|---|---|---|
| M1 | **high** | `src/proxy-handler.js:507-509` | Streaming settle charges the full worst-case reservation when the upstream returns an HTTP error, because "no usage frame" is not distinguished from "no response" |
| M2 | **med** | `src/proxy-handler.js:554-565` | Non-streaming settle falls back to the flat estimate when the response carries no `usage` — under-bills a non-compliant upstream and over-bills every upstream error |
| M3 | **med** | `src/cli.js:228-272` | The financial rate limits and the outage suspension documented in README:819-820 are dead code — no caller anywhere |
| M4 | **med** | `src/deposit-watcher.js:110-114` | Deposits under 2 VRSC are credited at **0 confirmations** with no later reconciliation, so a never-confirming tx is permanent credit |
| M5 | **med** | `src/dispute-sweep.js:45-50,61` | A seller-agreed refund whose `refund_percent` is absent or outside `(0,100]` is silently dropped — never queued, never logged |
| M6 | low | `src/cli.js:9190` | `respond-dispute --refund-percent` is documented as 1-100 but never range-checked |
| M7 | low | `src/cli.js:8002-8004` | An operator-configured `vrsc_usd_rate` is re-stamped with `Date.now()` per container, so `rate_max_age_ms` can never fire for it |
| M8 | low | `src/cli.js:9904-9921` / `src/control.js:330` | The daemon's in-flight fee sweep is invisible to the `wallet` CLI, and the CLI's pending stamp is invisible to the daemon |
| M9 | low | `src/cli.js:10279` | `wallet sweep` does not take the per-agent spend lock that `wallet send` takes |
| M10 | low | `src/cli.js:3412-3415` | `--fee-sweep-floor 0` is silently discarded by the `\|\|` precedence chain |

---

### M1 — high — streaming settle bills the worst case for an upstream error

**File:** `src/proxy-handler.js:507-509` (and the same defect at `:527-531`)

**Path to it.** `handleProxyRequest` decides `isStreaming` from the *request*
body only (`proxy-handler.js:272`). The upstream response's status code is never
consulted anywhere in the response handler (`proxy-handler.js:447-583`). The
streaming branch accumulates the body, scans for `data:` frames carrying
`usage`, and then:

```js
if (!sawUsage) {
  outputTok = reserveOutput;      // proxy-handler.js:507-509
}
adjustCredit(agentId, buyerVerusId, model, inputTok, outputTok, creditCheck.reserved, ...)
```

`reserveOutput` is `worstCaseOutputTokens(parsedBody, cfg)` — the buyer's
declared `max_tokens`, bounded by `proxy.max_output_tokens_cap` (default
**200 000**, `config-loader.js:46`).

The comment at `:500-509` explains the intent: an upstream that ignores the
force-injected `stream_options.include_usage` must not be exploitable for free
output. That is correct for a *successful* response. But an upstream **error**
response — `429`, `500`, `503`, `400 model not found` — is a plain JSON body
with no `data:` frames, so it takes the same branch.

**Trigger.** Buyer POSTs to `/j41/proxy/v1/chat/completions`:

```json
{"model":"<a priced model>","stream":true,"max_tokens":200000,"messages":[...]}
```

The seller's upstream replies `503` (overloaded, model cold, out of VRAM —
whatever). `proxyReq.on('error')` does **not** fire, because the connection
succeeded; the error arrives through `proxyRes`. `proxyRes.on('end')` runs,
`sawUsage` is false, `outputTok` becomes 200 000, `adjustCredit` computes
`actualCost === reservedCost`, `diff === 0`, and the reservation taken at
`proxy-handler.js:358` is never given back. The buyer is charged for
4 000 input + 200 000 output tokens and received an error page.

At a plausible `outputTokenRate` of 1e-5 VRSC/token that is ~2 VRSC per failed
request, and it repeats for every request while the upstream is down. The
circuit breaker (`proxy-handler.js:308-327`) only opens *after*
`circuit_threshold` consecutive failures, so the first N are billed in full.

`proxyRes.on('error')` at `:522-532` has the identical defect — it settles at
`reserveOutput` for a mid-stream transport failure.

**Not covered by tests.** `test/proxy-handler.test.js:211-237` exercises
`stream-no-usage` only against a **200** mock; no test drives a non-2xx
upstream status.

**Proposed fix (not applied).** Branch on `proxyRes.statusCode` before
settling:

- `statusCode >= 400` → `refundReservation(...)` and skip `adjustCredit`
  entirely; nothing billable was produced. (Optionally still bill input tokens
  if the upstream reports a prompt it actually processed.)
- `2xx` with no usage frame → keep the existing worst-case settle.
- Apply the same branch in the `proxyRes.on('error')` handler: if no bytes of
  SSE payload were ever written, refund rather than settle at worst case.

---

### M2 — med — non-streaming settle silently falls back to the flat estimate

**File:** `src/proxy-handler.js:554-565`

**Path to it.**

```js
let inputTok = estimatedInput;    // cfg default 4000
let outputTok = estimatedOutput;  // cfg default 2000
try {
  const parsed = JSON.parse(responseBody.toString());
  if (parsed.usage) {
    inputTok = parsed.usage.prompt_tokens || estimatedInput;
    outputTok = parsed.usage.completion_tokens || estimatedOutput;
  }
} catch {}
const result = adjustCredit(agentId, buyerVerusId, model, inputTok, outputTok, creditCheck.reserved, ...);
```

The H2 hardening applied to the streaming path (`:500-509`) was never applied
here. Two concrete outcomes:

1. **Under-billing the seller.** An OpenAI-compatible upstream that omits
   `usage` on non-streaming responses (several local servers do) serves an
   arbitrarily long completion and the buyer is billed for exactly
   `estimated_output_tokens` = 2 000. A buyer who discovers this simply sets
   `stream:false` and pays a flat 6 000-token rate for every request regardless
   of size. This is the same hole M1's comment says was closed — closed on one
   branch only.
2. **Over-billing the buyer.** Any non-2xx upstream response (error JSON, no
   `usage`) settles at 4 000 + 2 000 tokens for a request that produced
   nothing.

A third, smaller edge: `parsed.usage.prompt_tokens || estimatedInput` treats a
legitimate `0` as missing and bills 4 000.

**Trigger.** `{"model":"<priced>","stream":false,...}` against an upstream whose
response body has no `usage` object — either because it is non-compliant, or
because it is an error.

**Proposed fix (not applied).** Mirror the streaming logic and add the status
check M1 needs:

- `statusCode >= 400` → refund the reservation, do not bill.
- `2xx` and `usage` absent → settle at `reserveOutput` (worst case), not
  `estimatedOutput`.
- Use `Number.isFinite(parsed.usage.prompt_tokens)` rather than `||` so a real
  zero is honoured.

---

### M3 — med — documented financial rate limits are dead code

**Files:** `src/cli.js:228-259` (`checkDispatcherRateLimit`),
`src/cli.js:261-272` (`recordDispatcherSend`), `src/cli.js:226`
(`dispatcherFinancialSuspended`)

**Claim.** README:819-820:

> - **Rate limiting** — max 3 sends/job, max value = job price + 10%, max 10 sends/hour, 30s cooldown
> - **Fail-closed sweep** — every 10 min checks active jobs against platform API; suspends all sends if API unreachable for 30 min

**Path to it — there isn't one.** `grep -rn 'checkDispatcherRateLimit\|recordDispatcherSend' src/ test/ scripts/`
returns only the definitions. The single outbound-value call site in the whole
codebase is `attemptPendingRefund`:

```js
const allowlist = loadFinancialAllowlist();
if (!isAddressInAllowlist(allowlist, buyerAddress)) { ... return true; }
...
const txid = await agent.sendCurrency(buyerAddress, refundAmount);   // cli.js:5834
```

No rate-limit call, no `recordDispatcherSend`. `dispatcherSendHistory` is never
written, so even if the check were called it would always pass.

`dispatcherFinancialSuspended` is *set* by the sweep (`cli.js:317, 323-324`)
but its only reader is the uncalled `checkDispatcherRateLimit` (`cli.js:229`).
So the "suspends all sends if the API is unreachable for 30 min" guarantee does
not exist. The sweep's *other* half — pruning completed jobs out of
`active_jobs` — does work (`cli.js:304`).

**Trigger / impact.** Any condition the limits were meant to bound: a bug or a
malicious platform response that queues many refund entries, an operator running
`refunds approve --all` against an inflated ledger, or a platform outage during
which the dispatcher keeps paying out. The remaining defences are real and
non-trivial (owner approval, allowlist, `refunded-jobs.json` de-dup, in-flight
markers, per-job locks), so this is a defence-in-depth loss rather than an open
door — but the README states a guarantee the code does not provide, and an
operator will size their risk against it.

**Proposed fix (not applied).** Either wire the check in — call
`checkDispatcherRateLimit(jobId, refundAmount, entry.orphan?.jobAmount)` inside
the lock in `attemptPendingRefund` (before `markRefundInflight`) and
`recordDispatcherSend(jobId, refundAmount)` immediately after a successful
`sendCurrency` — or delete the dead code and strike the two README bullets.
Wiring it in is the smaller change and matches the documented intent; note that
the per-job cap of 3 interacts with the existing `refunded-jobs.json` de-dup,
which already caps a job at one send, so the meaningful limits here are the
hourly global cap and the suspension flag.

---

### M4 — med — sub-2-VRSC deposits are credited from the mempool and never reconciled

**File:** `src/deposit-watcher.js:110-114`

```js
function requiredConfirmations(amount) {
  if (amount < 2) return 0;   // mempool OK for small amounts
  ...
}
```

**Path to it.** `POST /j41/deposit/report` → `webhook-server.js:158-196` →
`reportDeposit` (`deposit-watcher.js:185`). After signature/nonce/freshness auth
and `client.verifyPayment`, the confirmation gate is:

```js
const txStatus = await client.getTxStatus(txid);
const required = requiredConfirmations(expectedAmount);   // 0 for <2 VRSC
if (txStatus.confirmations < required) { ...pending... }  // 0 < 0 is false
...
creditDeposit(agentId, buyerVerusId, credited, txid);     // deposit-watcher.js:300
fresh.processed.push({...}); saveDeposits(agentId, fresh);
```

The txid lands in `processed` permanently. There is **no** reverse path: nothing
in `deposit-watcher.js` or `credit-meter.js` ever re-checks a processed deposit
or debits a balance for a tx that dropped out of the mempool.

**Trigger.** A buyer broadcasts a 1.9 VRSC payment to the seller's payAddress,
signs a deposit report, and gets credited immediately from the mempool. They
then spend the same input in a conflicting transaction that actually confirms.
Each conflicting attempt has a distinct txid, so `claimTxid`'s per-txid
idempotency does not help: report, get credit, replace, repeat. The credit is
spent through the proxy before anything confirms.

The exposure per cycle is bounded by 2 VRSC of inference, but the cycle is
repeatable, and the seller's cost is real upstream LLM spend.

Note this is *documented in the code* as "from spec" and is a deliberate
latency/UX tradeoff — but it is not mentioned in the README, and the tradeoff
was presumably sized for a chain where mempool replacement is hard. It should be
an explicit, tunable decision before a real-money launch.

**Proposed fix (not applied).** Make the tier table configurable
(`[deposit] confirmation_tiers` in `config.toml`) and default the lowest tier to
1 confirmation on mainnet; keep 0 available for testnet. If 0-conf is kept, add
a reconciliation pass in `pollPendingDeposits` that re-checks `processed`
entries credited at 0 confirmations and debits the meter (or flags the buyer)
if the txid is not on-chain after N minutes.

---

### M5 — med — a seller-agreed refund silently vanishes when the percentage is out of range

**File:** `src/dispute-sweep.js:45-50` and `:61`

```js
function agreedRefundPercent(d) {
  const raw = d && (d.refund_percent ?? d.refundPercent);
  const n = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  return n;
}
...
if (d.action === 'refund') return agreedRefundPercent(d) !== null;   // :61
```

**Path to it.** `sweepDisputesForRefund` (`cli.js:5977`) → `selectRefundableDisputes`.
A dispute at `action === 'refund'` with a percent of `0`, `150`, `null`, or
absent returns `null` → the filter returns `false` → the job is not in
`refundable` → `cli.js:6012` `continue`s the agent. No ledger entry, no
`refund.pending_approval` event, **no log line**. The buyer is owed money the
seller explicitly agreed to and nobody is ever asked to pay it.

This is the same failure class the module header at `dispute-sweep.js:18-23`
documents as fixed in 2.12.2 ("agreeing to pay was the thing that guaranteed
nobody was ever asked to pay"), reached by a different door.

**Trigger.** Two concrete ones:

1. Operator runs `j41-dispatcher respond-dispute <jobId> --action refund
   --refund-percent 150 ...` (see M6 — the CLI accepts it). The platform records
   `refund_percent: 150`; the sweep then drops the job forever.
2. The platform omits `refund_percent` on a refund-action dispute, or returns it
   under a third key name. `??` covers `refund_percent`/`refundPercent` only.

The `alreadyPaid` / already-in-ledger guards above it mean this cannot be
recovered by a later sweep either — the entry is simply never created.

**Proposed fix (not applied).** Do not conflate "unparseable" with "not
refundable". In `selectRefundableDisputes`, keep `action === 'refund'` jobs in
the result set regardless, and let `buildDisputeRefundEntry` mark the entry
`status: 'needs_review'` with `reason: 'refund_percent out of range: <raw>'`
when `agreedRefundPercent` returns null — the queue already has exactly this
state for un-verifiable addresses (`dispute-sweep.js:89-91`), and it puts the
decision in front of the operator instead of dropping it.

---

### M6 — low — `respond-dispute --refund-percent` is not range-checked

**File:** `src/cli.js:9190`

```js
.option('--refund-percent <percent>', 'Refund percentage (1-100, required for refund action)')
...
refundPercent: options.refundPercent ? parseInt(options.refundPercent, 10) : undefined,
```

The only validation is presence (`cli.js:9125-9128`). `--refund-percent 150`,
`--refund-percent 0` (a non-empty string, so it passes the presence check),
and `--refund-percent abc` (→ `NaN`, serialised as `null`) all reach
`agent.respondToDispute`. Whether the platform rejects them is UNVERIFIED from
this repo; locally, an accepted out-of-range value re-creates M5.

**Proposed fix (not applied).** Parse and validate before the call: reject
unless `Number.isInteger(pct) && pct >= 1 && pct <= 100`, with the same
`process.exit(1)` shape as the existing action check.

---

### M7 — low — an operator-set exchange rate can never go stale

**File:** `src/cli.js:8002-8004`

```js
if (cfg.budget.vrsc_usd_rate > 0) {
  env.J41_VRSC_USD_RATE = String(cfg.budget.vrsc_usd_rate);
  env.J41_VRSC_USD_RATE_AT = String(Date.now());      // <-- always "now"
} else if (_polledVrscRate && _polledVrscRate.usdPerVrsc > 0) {
  env.J41_VRSC_USD_RATE_AT = String(_polledVrscRate.at);   // real timestamp
}
```

README:477 presents `rate_max_age_ms` as a fail-closed staleness guard
("Rate older than this counts as missing"). `getVrscUsdRate`
(`token-budget.js:141-146`) does implement it — but for the config-file source
the timestamp is regenerated at every container start, so the age is always
~0 ms and the guard is unreachable. It only ever protects the polled source.

**Impact.** A `vrsc_usd_rate` set once in `config.toml` and forgotten keeps
sizing token budgets and pricing extension requests at a rate that may be months
stale. VRSC moving 3× against the configured rate means every job is budgeted 3×
too generously (operator eats the LLM cost) or 3× too tightly (jobs beg for
extensions immediately). Neither fails closed.

**Proposed fix (not applied).** Persist the rate's provenance —
`[budget] vrsc_usd_rate_at` written next to the value when an operator sets it
via the dashboard, and stamped through verbatim here. If no timestamp is
recorded, stamp the config file's `mtime` rather than `Date.now()`, and warn at
startup when `now - mtime > rate_max_age_ms`.

---

### M8 — low — daemon and CLI cannot see each other's in-flight spends

**Files:** `src/cli.js:9904-9921` (`walletPendingWrites`),
`src/control.js:330-335` (`buildInboxSurface`), `src/cli.js:7813`

`walletDaemonBlocks` asks the running dispatcher what it has in flight, but
`buildInboxSurface` builds `pendingWrites` from `state._inboxLastWrite` only —
inbox identity writes. The daemon's fee-sweep in-flight map
(`state._feeSweepPending`, set at `cli.js:7813`) is not exposed. Symmetrically,
`checkFeeTanks` never reads the CLI's `wallet-pending.json` stamp.

**Trigger.** Operator runs `wallet sweep agent-6`; the daemon's 30-minute
`checkFeeTanks` fires two minutes later. The daemon reads the platform's
*confirmed* UTXO view, still sees the i-address outputs as unspent, finds the
tank below floor, and broadcasts a second sweep over the same inputs. The
reverse ordering has the same shape.

**Impact is low, and deliberately stated as such.** Both transactions spend the
same input set to the same key-derived destination, so the worst case is a
rejected or duplicate broadcast logged as `sweep failed`, not a loss of funds —
this is the same reasoning the code already applies at `cli.js:9896-9898`
("the residual race costs a rejected broadcast, not money"). It is listed
because the log line reads like a real failure and will send an operator hunting.

**Proposed fix (not applied).** Add the fee-sweep map to the control-socket
surface (a `feeSweepPending` array alongside `pendingWrites`, built from
`state._feeSweepPending`) and have `walletDaemonBlocks` consult both; have
`checkFeeTanks` call `loadWalletPending(agentId)` and treat a fresh stamp the
same way it treats its own `_feeSweepPending` entry.

---

### M9 — low — `wallet sweep` skips the per-agent spend lock

**File:** `src/cli.js:10279` (`walletSweepOne`), vs `src/cli.js:10522-10525`
(`walletSend`)

The comment introducing `acquireWalletLock` (`cli.js:10441-10457`) describes the
hazard precisely: the pending stamp guards a *sequence* of commands, not two
running at once, so both processes read "no stamp", both sit at the confirmation
prompt, and both broadcast. `walletSend` takes the lock; `walletSweepOne` does
not.

**Trigger.** Two terminals both run `j41-dispatcher wallet sweep agent-6`.

**Why it is low.** A sweep passes *every* sweepable UTXO with an amount of
`sweepable - fee`, so both builds select the identical input set and produce an
identical transaction — the second broadcast is a duplicate, not a double-spend.
The only way the input sets differ is if a new i-address payment confirms
between the two `getUtxos` calls, and then the two transactions conflict and one
is rejected at no cost. Unlike `send`, funds cannot leave the agent either way.

**Proposed fix (not applied).** Wrap the body of `walletSweepOne` in
`acquireWalletLock(id)` / `releaseWalletLock(id)` with the same try/finally
shape as `walletSend`, returning `{reason:'locked'}` when it cannot be acquired.
Note `wallet sweep --all` loops agents, so the lock must be per-agent inside the
loop (which it already is by construction).

---

### M10 — low — `--fee-sweep-floor 0` is silently discarded

**File:** `src/cli.js:3412-3415`

```js
floorWrites: Math.max(1,
  parseInt(options.feeSweepFloor, 10)
  || cfg.fee_sweep?.floor_writes
  || DEFAULT_FLOOR_WRITES),
```

`parseInt('0', 10)` is `0`, which is falsy, so the CLI value falls through to
config and then to the default of 100. README:256 states "Precedence is CLI flag
> config/env > default"; for this one value it is not. `Math.max(1, …)` would
have coerced 0 to 1 anyway, so the operator's intent ("effectively never sweep
on the floor") is unreachable from the flag either way — but they get 100
silently instead of 1, which is a 100× difference in when the daemon starts
broadcasting.

The same `||` shape at `:3416-3419` is safe, because `parseInt(x) * 60000` is
only falsy for `NaN` and `0`, and a 0-minute interval is correctly rejected by
the `Math.max(60000, …)` floor.

**Proposed fix (not applied).** Use an explicit presence test:

```js
const cliFloor = Number.parseInt(options.feeSweepFloor, 10);
floorWrites: Math.max(1, Number.isFinite(cliFloor) ? cliFloor
  : (cfg.fee_sweep?.floor_writes ?? DEFAULT_FLOOR_WRITES)),
```

---

## Adversarial pass — shortest path from untrusted input to a bad money outcome

Ranked by how short the path is.

1. **Buyer HTTP → proxy → buyer's own credit destroyed (M1).** One request. No
   attacker needed; a flaky seller upstream does it. `POST /j41/proxy/v1/...`
   with `stream:true` and a large `max_tokens`, upstream returns any 4xx/5xx →
   the buyer is billed the full worst-case reservation. This is the shortest
   real path in the domain and it needs no special conditions.

2. **Buyer HTTP → proxy → free inference (M2).** One request, but requires the
   seller's upstream to omit `usage` on non-streaming responses. The buyer
   discovers this by trying `stream:false` once and comparing
   `X-J41-Credit-Remaining`; from then on every request is flat-rated at 2 000
   output tokens regardless of size.

3. **Buyer HTTP → deposit report → free credit (M4).** Two steps: broadcast a
   ≤2 VRSC payment, report it (correctly signed — the auth is genuinely sound),
   get credited from the mempool, then replace the transaction. Repeatable with
   fresh txids. Bounded at ~2 VRSC of inference per cycle.

4. **Platform API response → refund amount/address.** *No short path.*
   `job.amount` and `job.buyerVerusId` are platform-supplied and feed
   `buildDisputeRefundEntry` (`dispute-sweep.js:71-97`), but nothing is sent
   without: `resolveRefundTarget` confidence (i-address, not self, not the
   platform fee address, dispute-signer match, name round-trip)
   → `status:'pending_approval'` → an explicit operator `refunds approve`
   → re-verification at approve time including an address-changed abort
   (`cli.js:6286-6296`) → allowlist membership → the in-flight marker → the
   per-job lock → `refunded-jobs.json` de-dup. A hostile platform can inflate
   the *displayed* amount, but the operator reads it on the approval prompt, and
   it cannot redirect the destination without failing `resolveRefundTarget`.

5. **Buyer chat / LLM output → any signature or payment.** *No path.*
   `sign-broker.js` is a constrained signer: `buildBrokeredMessage` rebuilds
   `accept`/`deliver`/`dispute_respond` from the authoritative job record and
   default-denies everything else (`sign-broker.js:97-102`); the generic path
   refuses anything shaped like a `J41-<ACTION>|…` protocol message
   (`sign-broker.js:157-164`) and caps at 4 KiB. A fully prompt-injected
   container cannot request a payment, an identity update, or a signature for
   another job.

6. **Platform `getUtxos()` response → funds leaving the fleet.** *No path.*
   `resolveOwnRAddress` (`wallet.js:472-485`) makes the WIF-derived address
   authoritative and treats any platform disagreement as a hard refusal, on all
   three paths that use it (`cli.js:7739`, `:10070`, `:10293`, `:10531`). The
   two executors then enforce mirror-image input-class invariants
   (`fee-tank.js:199-201`, `wallet.js:413-415`). The failure mode this closes
   (a supplied address making every UTXO look sweepable) is documented at
   `wallet.js:443-470` and is genuinely closed.

7. **Webhook → free token budget.** *No path.* `job.extension_approved` carries
   `data.estimatedTokens` straight into `budget_increased` (`cli.js:7398-7401`),
   but every `/webhook/:agentId` request is HMAC-verified against that agent's
   own secret (`webhook-server.js:313-327`) with a replay nonce
   (`:344-355`). Reaching it requires the webhook secret.

---

## Checked and found clean

Traced, and either the claim holds or no defect was found:

- **`parseVrscAmount` (`wallet.js:77-121`)** — regex + BigInt, no float path.
  Correctly rejects non-strings, `''`, `'.'`, `'1.'`, `'.5'`, signs, exponents,
  thousands separators, hex, >8 decimal places, zero, and anything above 2^50
  satoshis. The 2^50 cap is justified in-comment by the SDK's
  `Math.round(amount*1e8)` round-trip, which is a real concern and correctly
  sized.
- **`formatVrsc` (`wallet.js:134-141`)** — BigInt division, and returns `'—'`
  rather than a plausible zero for any non-integer input. The `null` vs `0`
  discipline holds end-to-end through `buildWalletRow`, `summarizeFleet`,
  `walletRowJson`, `walletSats` and `buildEarningsRow`.
- **`summarizeUtxos` (`fee-tank.js:66-91`)** — `Number.isSafeInteger` guard on
  `satoshis` correctly rejects string amounts (the concatenation bug),
  fractional satoshis and out-of-range values before they reach any sum.
- **`planFeeSweep` / `planManualSweep` / `planFleetSend`** — all three fail
  closed on invalid balances, on a malformed pending record, and return
  all-zero numbers on refusal so a caller ignoring `ok` cannot build a
  transaction from the result.
- **`executeFeeSweep` / `executeSend`** — mirror-image input-class invariants,
  both never throw, both return structured failures so `--all` loops survive.
- **Refund idempotency chain** — `markJobRefunded` before the platform-record
  step (`cli.js:5843`), in-flight marker written before the broadcast
  (`cli.js:5833`), unreadable marker still blocks (`cli.js:5580`), funding
  failures distinguished from ambiguous failures (`cli.js:5886-5902`). The
  residual window is correctly identified and documented at `cli.js:5838-5842`.
- **`acquireSendLock` (`cli.js:5594-5781`)** — liveness (`kill(pid,0)`) before
  age, O_EXCL steal gate with re-check inside, empty-lock mtime bound,
  read-back ownership proof. The measured failure rates in the comments match
  the logic that replaced them.
- **`refund-target.js`** — send destination is `job.buyerVerusId` only; the
  friendly name is display-only and its round-trip is a *check*, never a source.
- **`refundsApprove` re-verification** — re-fetches job + dispute, re-runs
  `resolveRefundTarget`, and aborts to `needs_review` if the re-resolved address
  differs from the stored one (`cli.js:6286-6296`).
- **Financial allowlist deny-all** — `loadFinancialAllowlist` returns the empty
  deny-all structure on a missing file *and* on any parse error
  (`cli.js:149-164`), so a corrupted allowlist blocks rather than opens.
- **`token-budget.js`** — single conversion point confirmed by grep; unknown
  models fall back to the most expensive table entry; `MIN_TOKEN_BUDGET` floor
  and the `FALLBACK_MIN_VRSC` proportional cap both present; `priceExtension`
  returns `amountVrsc: null` with no rate and the caller refuses to ask for
  money (`job-agent.js:952-958`).
- **Deposit report authentication (`deposit-watcher.js:51-95`)** — freshness
  window, single-use nonce recorded past the window, signature verified against
  the buyer's on-chain primary addresses, multisig explicitly refused rather
  than waved through, and `KEYS_UNSIGNED`/`KEYS_BAD_SIGNATURE` correctly
  surfaced as 502 rather than mislabelled as client errors.
- **Deposit double-credit (`deposit-watcher.js:120-152, 285-321`)** — the
  synchronous `claimTxid` before any `await` is genuinely atomic under Node's
  single-threaded model, the persisted `processed` list is re-checked after the
  awaits, and `saveDeposits` is tmp→rename.
- **`clampCredit` (`deposit-credit.js`)** — clamps to `[0, expectedAmount]`, so
  a compromised backend can neither inflate a credit nor debit via a negative.
- **`credit-meter.js` arithmetic** — `calculateCost` fails closed to `Infinity`
  on a NaN/negative/infinite rate (which makes `reserveCredit` deny);
  `adjustCredit` deliberately allows a negative balance so an overage is
  recovered rather than absorbed; `saveMeters` is tmp→rename.
- **Proxy pre-flight gates** — unpriced models rejected before any cost math
  (`proxy-handler.js:277-285`), per-(agent,buyer) token bucket, circuit breaker,
  per-buyer in-flight cap, worst-case reservation bounded by
  `max_output_tokens_cap`, SSRF host match + private-IP block + DNS-rebind pin.
- **`sign-broker.js`** — default-deny on message type; amount, buyer and job
  hash all come from the authoritative record.
- **Control API auth (`control-api.js:49-76, 172-175`)** — 32-byte token, 0600,
  constant-time compare with a length-mismatch path that still runs a comparison.
- **Mainnet gate (`mainnet-guard.js`)** — both money-relevant escape hatches
  (`J41_DEPOSIT_ALLOW_AUTH_ONLY`, `J41_ALLOW_UNPRICED_JOBS`) are listed, and
  `resolveIsMainnet` is sticky so `J41_NETWORK` cannot downgrade past the gate.
- **`buildBountyAwardMessage` (`bounty-award.js`)** — binds recipient
  i-addresses rather than opaque row ids, sorts for determinism, and throws
  loudly when handed a UUID-shaped application row id.
