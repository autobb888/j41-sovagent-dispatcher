# scale — audit findings

**Domain as scoped:** what happens to this dispatcher as things get bigger — more
registered agents, more concurrent jobs, more proxy traffic, more accumulated
history. Three questions: (1) does the documented capacity arithmetic match the
code's actual per-cycle cost; (2) does anything grow without bound in memory or
on disk; (3) when the box *is* saturated, does the operator find out and is there
a working way out.

Read-only pass. No code was executed — no tests, no `node --check`, no docker
commands, no network calls. Every finding traces statically to a `file:line` and
a reachable call path; the quantitative claims (S2's thresholds, S8's cycle
times) are computed from constants read in source, not measured.

**Counts:** crit 0 · high 5 · med 7 · low 6 · **total 18**

---

## Findings

| # | Sev | Finding | Anchor |
|---|---|---|---|
| S1 | **high** | Both documented remedies for a saturated poll loop are unusable — there is no interval knob, and "run a second dispatcher" SIGTERMs the running one | `cli.js:3162-3210` |
| S2 | **high** | The poll cycle costs ~3× the README's arithmetic; above 60 agents it overruns at *every* latency above ~167 ms, so the documented "≤500 ms never overruns at any agent count" is false | `cli.js:6904` |
| S3 | **high** | `/j41/deposit/report` burns the shared nonce cache and fires an outbound platform call *before* checking the signature, with no rate limit — the neighbouring route has both defences | `deposit-watcher.js:64` |
| S4 | **high** | `api-keys.json` and `_keyCache` grow one record per discovery request, forever; every proxy request then re-reads and rewrites the whole file | `api-key-manager.js:62` |
| S5 | **high** | `sweepDisputesForRefund` re-fetches every historical dispute every 5 min — uncapped, unstaggered, unguarded — so sweeps pile up and the cost only ever grows | `cli.js:5987-6009` |
| S6 | med | Proxy hot path performs 4 synchronous whole-file reads + 3 whole-file writes per request on the same event loop that runs the job fleet | `proxy-handler.js:358` |
| S7 | med | Startup activation runs after the inbox timer is armed; at fleet scale both broadcast identity txs for the same agent | `cli.js:4181` |
| S8 | med | The inbox sweep's skipped cycles are uncounted and absent from `/health`, unlike poll and fee-tank | `cli.js:7835` |
| S9 | med | Three per-agent fan-out loops have no reentrancy guard; `safeInterval` only catches throws | `cli.js:3553-3561` |
| S10 | med | `ctl resources` reports the registered-agent count as the slot cap, and its per-job memory list is always empty in Docker mode | `control.js:585` |
| S11 | med | Extensions are rejected whenever the pool is full or the queue is non-empty — undocumented, and an extension consumes no slot | `cli.js:6606-6614` |
| S12 | med | The preflight LLM probe caches success but not failure, so an LLM outage stalls the poll cycle by 5 s per pending job request | `preflight-gate.js:49-58` |
| S13 | low | `events.jsonl` compaction counter resets on restart, so a frequently-restarted dispatcher never compacts and reads the whole file at boot | `control-api.js:106` |
| S14 | low | README's "unlimited" max-concurrent default is really a hardware cap (3 on an 8 GB / 4-core box) | `hardware-sizing.js:42-50` |
| S15 | low | Container log lines are mirrored to dispatcher stdout uncapped, and the dashboard launcher appends to unrotated `/tmp/dispatcher.log` | `cli.js:8540-8543` |
| S16 | low | The dispute reconciler skips the response cap the poll loop applies, and its attempts map is never pruned | `cli.js:5327` |
| S17 | low | The egress proxy has no cap on concurrent CONNECT tunnels and no idle timeout | `egress-proxy.js:82-113` |
| S18 | low | `checkFeeTanks` is the only per-agent fan-out with no inter-agent stagger | `cli.js:7730` |

Sorted by severity, then by how little the trigger costs an attacker or operator.

---

### S1 — high — the documented escape hatches from a saturated poll loop do not exist, and one of them takes the fleet down

**Where:** `src/cli.js:3162-3210` (PID handoff), `src/cli.js:3955-3957` (interval),
`src/control.js:20` (fixed socket path), `README.md:366-370`.

**The claim.** README:366-370 is the *only* operator guidance for the condition
the whole Scale section exists to detect:

> **If you see skipped cycles**, you have more agents than the interval allows at
> your API latency. Raise the interval or run a second dispatcher against a
> different subset of agents; a second instance on the same host needs
> `J41_HEALTH_PORT`, `J41_CONTROL_API_PORT` and `J41_EGRESS_PROXY_PORT` set to
> free values.

**Remedy 1 — "raise the interval" — does not exist.** `pollInterval` and
`reviewInterval` are computed inline at `cli.js:3955-3957`:

```js
const pollInterval = Math.max(60000, agentCount * 1000);
```

There is no CLI flag, no `config.toml` key, and no entry in `ENV_OVERRIDES`
(`config-loader.js:103-160`) that touches it. `deposit.poll_interval_ms` and
`health.poll_interval_ms` are unrelated loops. The only way to lengthen the
interval is to register *more* agents, which raises the cost faster than the
budget (see S2).

**Remedy 2 — "run a second dispatcher" — kills the first.** `start` reads
`~/.j41/dispatcher/dispatcher.pid`, and if that PID is alive:

```js
process.kill(oldPid, 'SIGTERM');                       // cli.js:3183
…
while (Date.now() - startedWait < waitMs) { … }        // up to 10 minutes
if (!gone) { …  process.exit(1); }                     // cli.js:3196-3203
```

The three environment variables in the README free the three *ports*
(`config-loader.js:142-143`, `egress-proxy.js:15-19`) but not the three fixed
paths the handoff turns on: `DISPATCHER_DIR/dispatcher.pid` (`cli.js:3162`),
`~/.j41/dispatcher/control.sock` (`control.js:20`), and `DISPATCHER_DIR` itself.
None is overridable.

**Trigger.** An operator sees `poll_cycles_skipped` climbing on `/health`,
follows README:368-370 — sets the three ports, starts a second dispatcher. The
new process SIGTERMs the live one. The live one enters `gracefulShutdown`, which
drains in-flight jobs (up to the 120-minute drain) and deactivates every agent on
the platform. The new process blocks for up to 10 minutes and then either starts
(fleet was down for the whole drain) or prints "Refusing to start a second
dispatcher against the same agents" and exits 1 — leaving the operator with **no**
dispatcher and every agent marked inactive.

**Note.** The refusal logic itself is correct and deliberate — `cli.js:3196-3202`
explains that concurrent dispatchers are the double-spend class the release
exists to prevent. The defect is that the README prescribes exactly the thing the
code is built to refuse.

**Proposed fix (not applied).** Two independent changes:
1. Add `runtime.poll_interval_ms` (0 = auto) to `config-loader.js` DEFAULTS and
   `ENV_OVERRIDES`, consumed at `cli.js:3955-3957` with a floor of 60 s, so
   "raise the interval" becomes true.
2. Rewrite README:366-370. The honest multi-instance story is a **separate
   `HOME`** (hence a separate `~/.j41/dispatcher` with its own agents, PID file
   and socket) *plus* the three ports — or a separate host. If per-`HOME`
   operation is not supported, drop the suggestion entirely and say "register
   fewer agents per dispatcher, or run one per host".

---

### S2 — high — the poll cycle costs ~3× the documented arithmetic, and above 60 agents it always overruns

**Where:** `src/cli.js:6904` (`reconcileOrphanedDisputes` inside the poll cycle),
`src/cli.js:5322-5329` (its 2 un-staggered calls per agent), `src/cli.js:6843`,
`6937`, `6985` (three per-active-job passes), `README.md:338-356`.

**The claim.** README:340-341: "a cycle costs `(agents-1) x 500ms` of stagger plus
**one round trip per agent**", and README:344-345: "**a round trip at or under
500ms never overruns, at any agent count**", with a table giving 250 ms as "~75%
of budget, flat".

**What the cycle actually does.** Everything below runs inside the same
`_polling` guard (`cli.js:6690` … `finally` at `:7034`), so it all counts against
the same budget:

| Step | Site | Cost |
|---|---|---|
| stagger | `cli.js:6695` | `(N-1) × 500 ms` |
| `getMyJobs` default + `in_progress` (parallel) | `cli.js:6704-6707` | `N × 1 RTT` |
| `reconcileOrphanedDisputes` → 2 `getMyJobs` per agent, **serial, no stagger** | `cli.js:5326-5329`, called `:6904` | `N × 2 RTT` |
| post-delivery `getJob` per active job, serial | `cli.js:6846` | `A × 1 RTT` |
| `getExtensions` per unpaused active job, serial | `cli.js:6941` | `A × 1 RTT` |
| `getWorkspaceStatus` per un-notified active job | `cli.js:6994` | `≤ A × 1 RTT` |

So `C(N) = 0.5(N-1) + 3N·RTT (+ up to 3A·RTT)` against `B(N) = max(60, N)`
seconds.

**Concrete triggers.** Ignoring active jobs entirely (the friendliest case):

- **RTT = 500 ms:** `C = 2N − 0.5`. Below 60 agents it overruns from **N = 31**.
  Above 60 the budget is `N` while the cost is `2N − 0.5`, so it overruns
  **always**, at roughly 2× the interval — half of every cycle is skipped.
- **RTT = 250 ms** (the README's "flat, never overruns" row): `C = 1.25N − 0.5`.
  Overruns from **N = 49**, and for all `N > 60` — `1.25N − 0.5 > N` for `N > 2`.
- The break-even latency for `N > 60` is `RTT ≤ (0.5N + 0.5)/(3N) → ~167 ms`, not
  500 ms.

Add active jobs and it gets worse: at the hardware cap `A` can be 30+, adding up
to `3A·RTT ≈ 45 s` at 500 ms.

**Consequence.** The fleet looks for work at half the advertised rate (or worse),
and the same skipped cycle also defers the post-delivery status transitions that
detect `disputed`, `rework`, auto-delivery and pause/resume — so job state
handling slows in lockstep. The condition *is* surfaced (`poll_cycles_skipped`,
B9), so this is a planning failure rather than a silent one — but the operator
plans against a number that is 3× wrong, and S1 means the prescribed response
does not work.

**Proposed fix (not applied).** Either move `reconcileOrphanedDisputes` onto its
own low-frequency timer (it is a durable-side reconciler; it does not need to run
every poll), or run it under the same 500 ms stagger and fold both of its status
queries into one call. Then re-derive the README table from
`0.5(N-1) + kN·RTT + mA·RTT` with the real `k` and `m`, and state the
`N > 60` regime explicitly — that is where the "flat" claim breaks.

---

### S3 — high — `/j41/deposit/report` records the nonce and calls the platform before verifying the signature, unrate-limited

**Where:** `src/deposit-watcher.js:64` (nonce recorded) vs `:70-92` (signature
checked); `src/webhook-server.js:158-196` (route, no rate limit);
`src/nonce-cache.js:79-98` (the guard that exists and is not used here).

**Path.** In webhook mode with at least one api-endpoint agent registered
(`proxyContext` non-null), the server binds `0.0.0.0` (`webhook-server.js:375`,
`server.listen(port)` with no host) because the platform must reach it. An
anonymous `POST /j41/deposit/report` with a syntactically complete body reaches
`reportDeposit` → `verifyDepositReport`, which does, in order:

1. field presence check (`deposit-watcher.js:53`);
2. freshness (`:59`);
3. **`checkAndRecordNonce(...)` — writes into the shared cache** (`:64`);
4. **`await client.getIdentityKeys(buyerVerusId)` — an outbound platform call**
   (`:75`);
5. …and only then verifies the signature (`:89`).

The module those first two steps abuse says so itself. `nonce-cache.js:81-88`:

> The nonce cache must NEVER be populated before the caller's signature has been
> verified — recording first lets an unauthenticated caller burn/churn the
> (bounded, 100k-entry) nonce cache with junk nonces, either evicting legitimate
> entries early or wasting the cache on requests that were never going to be
> honored.

`checkNonceAfterVerify` exists precisely for this and is used correctly on the v2
access path (`cli.js:3741-3746`). The rate limit that exists on the *neighbouring*
route carries the matching rationale — `webhook-server.js:133-134`: "10 req/sec,
burst 30, per source IP **before the outbound getIdentityKeys call to prevent
amplification DoS**". Neither defence is wired to the deposit route.

**Trigger and outcome.** An anonymous client posts fresh random nonces at rate R:

- **Amplification.** Each inbound request produces one outbound
  `getIdentityKeys` to `api.junction41.io` (SDK timeout 30 s, up to 3 attempts,
  `sovagent-sdk/dist/client/index.js:22,155-186`). `maxConnections: 512` bounds
  concurrency but not rate. The dispatcher's own agents share that platform: a
  429 back to `getAgentSession` trips `auth-backoff` (`cli.js:4826-4838`) and the
  fleet stops polling for work.
- **Replay-protection erosion.** `_seen` is a module singleton shared with the v2
  access-envelope path. 100 k junk nonces (`nonce-cache.js:25,58-61`, oldest-
  insertion eviction) flush every legitimately recorded envelope nonce, reopening
  the replay window `cli.js:3738-3746` exists to close — on the paid proxy path.

**Proposed fix (not applied).** Restructure `verifyDepositReport` so the nonce is
recorded through `checkNonceAfterVerify(verified, …)` *after* step 5, and apply
`_checkDiscoveryRate(clientIp)` (or an equivalent bucket) to
`/j41/deposit/report` at `webhook-server.js:158`, before `readBody`. Consider
giving the deposit path its own nonce namespace so it cannot evict access-envelope
entries even when correctly ordered.

---

### S4 — high — per-agent API keys grow forever, and every proxy request rewrites the whole file

**Where:** `src/api-key-manager.js:47-67` (mint, no prune), `:26` (uncapped
cache), `:28-41` (`saveKeys` rewrites + repopulates), `:135-143` (`recordUsage`
on the hot path), `src/cli.js:3760` (mint per discovery request).

**Path.** Every successful `POST /j41/discovery/request-access` mints a *new* key
and appends it:

```js
const keyRecord = mintApiKey(sellerAgent.id, accessRequest.buyerVerusId);  // cli.js:3760
…
const data = loadKeys(agentId); data.keys.push(record); saveKeys(agentId, data); // api-key-manager.js:62-64
```

There is no dedup per buyer and **nothing anywhere prunes revoked or expired
records** — `revokeApiKey` only flips a flag (`:113-121`), and `listActiveKeys`
filters at read time without writing back (`:126-130`). Keys default to a 30-day
expiry (`:47`) and then sit in the file permanently.

Two costs compound:

- **`_keyCache` (`:26`) has no cap and no TTL sweep.** `saveKeys` inserts *every*
  non-expired key in the file into it on every mint (`:34-40`), so the cache is
  O(total keys) in resident memory and is rebuilt O(K) per mint — O(K²) over K
  mints.
- **`recordUsage` runs on every completed proxy request** (`proxy-handler.js:515`,
  `:566`) and is a full `loadKeys` + `saveKeys`: read the whole file, `JSON.parse`,
  mutate one counter, `JSON.stringify`, `writeFileSync`, `chmodSync` — all
  synchronous, plus the O(K) cache repopulation.

**Trigger.** A single valid VerusID holder (the discovery envelope is signed, but
nothing charges for or dedups the handshake) re-runs discovery. The only brake is
the discovery rate limiter: 10 rps sustained, burst 30, **per source IP**
(`webhook-server.js:45-46`). That is 864,000 keys/day from one IP; at ~250 bytes
per record, a ~216 MB `api-keys.json`. Every subsequent proxy request then
parses and rewrites that file twice-over. Long before the pathological case, a
normal SDK that requests access once per session reaches thousands of records in
ordinary use.

**Outcome.** The seller's revenue path degrades monotonically and irreversibly —
each request gets slower, and because the I/O is synchronous it takes the whole
daemon with it (S6).

**Proposed fix (not applied).** Three parts: (a) in `mintApiKey`, drop records
that are revoked or expired before pushing — the file should hold only live keys;
(b) reuse an existing live key for the same `(agentId, buyerVerusId)` instead of
minting a new one, or cap live keys per buyer; (c) replace the read-modify-write
in `recordUsage` with an in-memory counter flushed on a timer / at shutdown, and
bound `_keyCache` the way `proxy-rate-limiter.js:22-38` bounds its buckets.

---

### S5 — high — the dispute refund sweep re-reads every historical dispute every 5 minutes, uncapped and unguarded

**Where:** `src/cli.js:5987-6009` (the loop), `:6020` (the ledger short-circuit,
*after* the fetch), `:4052` (5-minute timer), `src/cli.js:3553-3561`
(`safeInterval` provides no reentrancy guard).

**What it does.** Every 5 minutes, for each agent in the fleet:

```js
const res = await agent.client.getMyJobs({ role: 'seller', status: 'disputed' });  // :5993
for (const job of jobs) {
  const dispute = await agent.client.getDispute(job.id);                           // :6004
}
```

Serial. No stagger. No response cap (contrast `MAX_JOBS_PER_RESPONSE` at
`cli.js:6711`). No reentrancy guard (contrast `_polling`, `_inboxSweepRunning`,
`_feeSweepRunning`). And critically, the already-handled check —
`if (ledger[jobId] || refunded.has(jobId)) continue;` — sits at `:6020`, *after*
`selectRefundableDisputes`, so a dispute that was refunded months ago is
re-fetched on every sweep for the life of the deployment.

**Trigger.** Disputed jobs are never removed from the platform's list, so the per-
cycle cost is `N × D` calls where `D` is the agent's **lifetime** dispute count.
`cli.js:5262-5265` records that this fleet really did accumulate "24 months-old
outage jobs" per agent. Working the arithmetic at 500 ms RTT against the 300 s
interval:

| agents | disputes/agent | calls/cycle | cycle time | vs. 300 s budget |
|---|---|---|---|---|
| 9 | 24 | 225 | ~113 s | fits |
| 30 | 50 | 1,530 | ~765 s | **2.5× over** |
| 100 | 50 | 5,100 | ~2,550 s | **8.5× over** |

**Outcome.** Once a cycle exceeds 300 s, `safeInterval` starts a *new* sweep every
300 s regardless — nothing prevents re-entry. Sweeps accumulate without bound,
each holding its own iteration state and its own in-flight sockets, all hitting
the same platform. The platform 429s, `auth-backoff` engages
(`cli.js:4826-4838`), and the fleet stops accepting work — while `/health` shows
`status: ok`, because no skip counter covers this loop (S8) and dispute-sweep
failures are logged per-agent and swallowed (`cli.js:5996-5997`).

Unlike S2 this has no ceiling: it gets strictly worse with every dispute the
fleet ever handles.

**Proposed fix (not applied).** (a) Move the `ledger`/`refunded` check *before*
the `getDispute` call so settled disputes cost nothing; (b) apply the poll loop's
response cap and its 500 ms stagger; (c) add a
`state._disputeSweepRunning` reentrancy guard with a counter surfaced on `/health`
alongside the other two; (d) bound the per-sweep work the way the reconciler does
with `MAX_RECONCILE_RESPAWNS_PER_SWEEP`, and report deferrals.

---

### S6 — med — the proxy hot path does 7 synchronous whole-file operations per request on the fleet's event loop

**Where:** `src/proxy-handler.js:358` (`reserveCredit`), `:514`/`:565`
(`adjustCredit`), `:515`/`:566` (`recordUsage`), `:517`/`:579`
(`maybeNotifyCreditLow` → `checkAndFlagLow`); `src/credit-meter.js:18-36`,
`src/api-key-manager.js:17-41`.

**Per completed proxy request:**

| Call | File | Sync ops |
|---|---|---|
| `reserveCredit` | `credit-meters.json` | read + parse, stringify + write + rename |
| `adjustCredit` | `credit-meters.json` | read + parse, stringify + write + rename |
| `recordUsage` | `api-keys.json` | read + parse, stringify + write + chmod, O(K) cache rebuild |
| `checkAndFlagLow` | `credit-meters.json` | read + parse (write on first crossing) |

That is 4 whole-file reads and 3 whole-file writes, every one of them
`fs.readFileSync` / `fs.writeFileSync`. Node's event loop is blocked for the
duration.

**Trigger.** This is the *same* event loop that runs the job poll cycle, the
`/health` and control-API servers, the container log streams, and the per-job
signing channels (`sign-channel-host.js:143-146`, a 200 ms `readdir` poll each).
A seller sustaining even modest proxy traffic on a fleet with a large
`api-keys.json` (S4) or many buyers stalls all of it. The proxy's own defences
(`rate_limit_rps: 10` per buyer, `max_inflight_per_buyer: 4`,
`config-loader.js:50,57`) are *per buyer* — aggregate throughput across buyers is
unbounded.

**Also on the unauthenticated side:** `findKeyOwner` on a cache miss does
`readdirSync(AGENTS_DIR)` plus a synchronous read+parse of every agent's
`api-keys.json` (`api-key-manager.js:97-106`), before any authentication has
succeeded. Reported as keys **K9**; noted here because the magnitude is
O(agents × keys) of blocking I/O per junk bearer token.

**Proposed fix (not applied).** Keep the credit meter and key usage counters in
memory behind a write-back (dirty-flag + periodic `flush` + flush on shutdown),
and make the persisted write async (`fs.promises`) under a per-agent mutex. At
minimum, merge `adjustCredit` + `checkAndFlagLow` into one read and drop
`recordUsage`'s file write in favour of an in-memory counter — 7 sync ops become
2.

---

### S7 — med — startup activation runs after the inbox timer is armed, so at fleet scale both write the same identity

**Where:** `src/cli.js:3961-3964` (timers armed), `:4066-4080` (long prelude),
`:4181-4211` (activation loop), `:4194` (`agent.activate({onChain: true})`).

**Ordering.** In `start`, the poll and inbox `safeInterval`s are registered at
`cli.js:3961` and `:3964`. Only *then* does startup run `drainPendingRefunds`
(`:4066`), `handleCrashRecovery` (`:4077`), a full blocking `await
pollForJobs(state)` (`:4080`), the control plane (`:4128`), and finally the
activation loop at `:4181`, which for each agent sleeps 1 s and calls
`agent.activate({ onChain: _toggleOnChain })` — on-chain by default
(`cli.js:4179`, reverted to on-chain in 2.18.1 for the reasons at `:4170-4178`).

Both `checkPendingInbox` and `activate` broadcast an identity update for the same
VerusID, and **neither consults the other's gate**: the inbox pending-write gate
is `state._inboxLastWrite`, private to `processInboxForAgent`, and the SDK's
`activate` path builds and broadcasts directly.

**Trigger.** The inbox timer first fires `max(60 s, N × 1 s)` after `:3964`. The
prelude between arming and activation is dominated by the initial
`await pollForJobs`, which costs `0.5(N-1) + 3N·RTT` (S2) — at N = 60 and 500 ms
RTT that is ~120 s on its own, already past the 60 s inbox tick, and the
activation loop then runs for a further `N × (1 s + activate + refreshAgent)`.
So on any fleet where startup work exceeds one inbox interval (roughly N ≥ 31 at
500 ms RTT), the inbox sweep is broadcasting for agents the activation loop has
not reached yet.

**Outcome.** Two identity transactions against the same confirmed `prevOutput` —
the exact hazard CLAUDE.md documents ("the platform serves the last *confirmed*
`prevOutput`, so the second double-spends"). The loser is rejected;
`inbox-deadletter.js` classifies `TX_REJECTED` as **`contention`**, which never
escalates, so it retries invisibly. The activation half swallows its failure into
a one-line warning (`cli.js:4206-4209`), leaving the agent inactive on-chain
while the log says startup completed.

Liveness **L7** reported the mirror-image defect on the shutdown deactivate. This
is the startup instance, and its trigger is specifically fleet size.

**Proposed fix (not applied).** Arm the poll/inbox timers *after* the activation
loop completes (the initial `await pollForJobs` at `:4080` already covers the
catch-up the early arming was for), or route the activation write through the
same per-agent pending-write gate the inbox sweep uses so the two serialise.

---

### S8 — med — the inbox sweep's skipped cycles are invisible

**Where:** `src/cli.js:7834-7837`, `src/control.js:475-481`, `README.md:361-364`.

The poll loop and the fee-tank sweep both count their skips into `state`
(`cli.js:6685-6686`, `:7718`) and publish them as `poll_cycles_skipped` /
`fee_tank_cycles_skipped` (`control.js:480-481`). README:363-364 presents that as
the design. The inbox sweep — the third loop with the same shape — has only:

```js
if (state._inboxSweepRunning) {
  console.warn('[Inbox] previous sweep still running — skipping this cycle');
  return;
}
```

No count in the message, no `state` mirror, no `/health` field.

**Trigger.** The inbox sweep runs on the *identical* interval as the poll loop
(`cli.js:3957`, `max(60 s, N × 1 s)`) with the *identical* 500 ms per-agent
stagger (`:7857`) plus one `getInbox` per agent and, for any agent with pending
items, a `getIdentityRaw` + witness verification + `broadcast`. At N ≈ 60 with
500 ms RTT the stagger and fetch alone consume ~59.5 s of a 60 s budget; a single
agent with a pending review pushes it over. So it starts skipping at roughly the
same fleet size the poll loop does — the difference is that the poll loop says so
and this one does not.

**Outcome.** Skipped inbox cycles mean reviews, `job_record`s and attestations are
not written on-chain. `/health` reports `status: ok` throughout (the degrade
expression at `control.js:445-449` covers dead-lettered items but not un-swept
ones), and the operator's documented capacity signal (README:358-359, "the
reliable signal is the skip counter") is silent for the loop whose stall has
on-chain reputation consequences.

**Proposed fix (not applied).** Mirror the poll-loop pattern exactly:
`state._inboxSkips = (state._inboxSkips || 0) + 1`, include the count and the
agent count in the warning, and add `inbox_cycles_skipped` to `control.js:475-481`
next to the other two.

---

### S9 — med — three per-agent fan-out loops have no reentrancy guard

**Where:** `src/cli.js:3553-3561` (`safeInterval`), `:3985-4037` (ProfileSync),
`:4044` (`cleanupCompletedJobs`), `:4052` (`sweepDisputesForRefund` — the worst
case, S5).

`safeInterval` wraps the callback in try/catch — it closes the Node-20 async-throw
hazard and nothing more:

```js
const safeInterval = (fn, ms, label) => {
  setInterval(async () => { try { await fn(); } catch (e) { … } }, ms);
};
```

Reentrancy protection is per-function, and only three functions have it:
`pollForJobs` (`_polling`), `checkPendingInbox` (`_inboxSweepRunning`),
`checkFeeTanks` (`_feeSweepRunning`). The loops that do not:

- **ProfileSync** (`:3985`, every 300 s): one `getIdentityRaw` per agent, serial,
  no stagger. At the SDK's worst case per request — 30 s timeout × 3 attempts +
  1 s + 2 s backoff ≈ 93 s (`sovagent-sdk/dist/client/index.js:22,155-186`) — a
  partially-degraded platform (auth succeeds, reads hang) makes one pass take
  `N × 93 s`, while a new pass starts every 300 s. Passes accumulate without
  bound; each holds N in-flight requests.
- **`cleanupCompletedJobs`** (`:4044`, every **10 s**): iterates `state.active`
  with a `container.inspect()` each, and on the retry branch performs a full
  `getAgentSession` + `getJob` + `startJobContainer`. Two overlapping passes can
  both observe the same exited process and both retry it — `state.retries` is
  read-then-written across an `await` (`cli.js:9013-9015`, `:9056-9059`) with no
  lock. In Docker mode `AutoRemove` usually turns this into the catch branch
  (liveness **L2**), but in `--runtime local` the exited child stays observable
  (`:9008`), so a `getJob` slower than 10 s yields two spawns for one job:
  duplicate LLM spend and duplicate delivery.
- **`sweepDisputesForRefund`** (`:4052`) — see S5, where the pile-up is not a
  worst case but the steady state.

**Proposed fix (not applied).** Give `safeInterval` an opt-in guard —
`safeInterval(fn, ms, label, { reentrant: false })` — that skips and counts when
the previous run has not resolved, and turn it on for all four fan-out loops.
That makes the guard the default posture instead of something each function has to
remember, and gives every loop the skip counter S8 asks for.

---

### S10 — med — `ctl resources` reports the wrong slot cap and no per-job memory in Docker mode

**Where:** `src/control.js:542-591`, `README.md:174`, `:663`.

README:663 documents `ctl resources` as "CPU, RAM, per-job memory, capacity
headroom" — it is the operator's capacity instrument. Two of the four are wrong:

**(a) The denominator is the fleet size, not the cap.**

```js
capacity: {
  maxSlots: state.agents.length,      // control.js:585
  active: state.active.size,
  …
}
```

The scheduler admits work while `state.active.size < MAX_AGENTS`
(`cli.js:6819`, `:7015`), and `MAX_AGENTS` is the hardware estimate
(`cli.js:136-138`), not the registered-agent count. **Trigger:** 20 registered
agents on an 8 GB / 4-core box → `MAX_AGENTS = 3`, but `ctl resources` reports
`maxSlots: 20, active: 3` — 85 % headroom — while every further job queues. The
error is always in the direction that hides saturation, because `agents.length`
can only be ≥ the cap in practice.

**(b) `jobs[]` is empty in the default runtime.** The list is built only from
`active.pid` (`control.js:551-552`), and Docker-mode active entries carry no
`pid` — `cli.js:8446-8467` sets `container` and never `pid`; only the local path
does (`cli.js:8874`). So "per-job memory usage" is present exactly in the runtime
that is *not* the default.

**Proposed fix (not applied).** Report `maxSlots: MAX_AGENTS` with
`registeredAgents: state.agents.length` as a separate field (both matter, they
are just different numbers), and populate `jobs[]` in Docker mode from
`container.stats({stream:false})` — or state explicitly that per-job memory is
local-runtime only rather than returning an empty array that reads as "no jobs".

---

### S11 — med — extensions are rejected whenever the pool is full or the queue is non-empty

**Where:** `src/cli.js:6606-6614`, `README.md:396-398`.

```js
const queueEmpty = state.queue.length === 0;
const slotsOpen  = state.active.size < MAX_AGENTS;
…
const canApprove = queueEmpty && slotsOpen && cpuOk && memOk;
```

README documents only the two resource thresholds — `--extension-max-cpu 80` and
`--extension-min-free-mb 512` (README:397-398). The two scheduling conditions are
undocumented, and they are the ones that bind first.

**Why it is wrong on the merits.** An extension extends a session that is
**already running** and already holds its slot. Granting it consumes no
additional container, no additional memory beyond what the job has, and creates
no new queue entry. Gating it on free capacity conflates "can I start a new job"
with "may this job continue".

**Trigger.** `MAX_AGENTS` is small on ordinary hardware — 3 on 8 GB / 4 cores. A
dispatcher running its 3rd job is at `active.size === MAX_AGENTS`, so **every**
extension request is rejected with `reasons: ['no slots']` (`cli.js:6624`), which
is meaningless to a buyer whose job is mid-flight. Likewise a single queued job
rejects all extensions fleet-wide. The busier the operator, the more paid
extensions they refuse — the failure scales with success.

**Proposed fix (not applied).** Drop `queueEmpty` and `slotsOpen` from
`canApprove`; keep `cpuOk` and `memOk`, which are the real "can this host take
more work" signals and are what the README documents. If some backpressure on
extensions is wanted, gate on the *queue* only when the extension would
meaningfully extend wall-clock, and say so in the README.

---

### S12 — med — the preflight LLM probe caches success but not failure

**Where:** `src/preflight-gate.js:49-58`, `src/llm-health.js:7-9`,
`src/cli.js:6758`.

```js
const cached = state.llmHealth.get(agentInfo.id);
if (cached && cached.ok && (Date.now() - cached.at) < PROBE_CACHE_TTL_MS) return true;
const health = await probe(llmCfg);
if (health.ok) { state.llmHealth.set(agentInfo.id, { ok: true, at: Date.now() }); }
// no negative entry written
```

`probeLLM` is a real POST to `${baseUrl}/chat/completions` with a **5 s** timeout
(`llm-health.js:9,19-22`). It is called from inside the per-job accept loop
(`cli.js:6758`), which is inside the per-agent loop, which is inside the poll
cycle's `_polling` guard.

**Trigger.** The LLM provider is down or the key is wrong — exactly when preflight
matters. The success cache never warms, so every `requested` job that has not yet
been accepted re-probes: `J` pending job requests × 5 s, per agent, per cycle.
Jobs stay `requested` because the failed preflight `continue`s without recording
`pendingPayment` (`cli.js:6759-6761`), so the same set re-probes forever. At the
default `J41_MAX_JOBS_PER_POLL` ceiling of 200 that is **1,000 s of stall for one
agent**; even 20 pending requests cost 100 s per agent per cycle. Job requests
are buyer-initiated and free to create, so `J` is not operator-controlled.

**Outcome.** An LLM outage converts into a poll-loop outage whose duration is
proportional to inbound demand — the fleet stops seeing *other* agents' work
entirely while it re-probes a dead endpoint.

**Proposed fix (not applied).** Cache failures too, with a short TTL (the
existing 30 s is fine): `state.llmHealth.set(agentInfo.id, { ok: false, at: now })`
and return `false` on a warm negative entry. Better still, hoist the probe to
once per agent per cycle before the job loop — the result cannot change between
two jobs of the same agent in the same pass.

---

### S13 — low — `events.jsonl` never compacts across restarts and is read whole at boot

**Where:** `src/control-api.js:106-121`, `:92-104`, `README.md:698-700`.

```js
let appendsSinceCompaction = 0;                    // :106 — fresh per process
function emit(type, data = {}) {
  …
  fs.appendFileSync(EVENTS_PATH(), JSON.stringify(ev) + '\n');
  if (++appendsSinceCompaction >= RING_CAP) { fs.writeFileSync(EVENTS_PATH(), …); }
}
```

The in-memory ring is genuinely capped at 1000 (`:113`) and `seq` genuinely
survives restart (`:92-104`), as README:698-700 says. The *file* is capped only
by a counter that starts at zero on every process start. **Trigger:** a
dispatcher that restarts (or crashes, or is bounced by S1's PID handoff) before
emitting 1000 events never compacts — the file grows monotonically. Re-seeding
then does `fs.readFileSync(EVENTS_PATH(), 'utf8')` on the *whole* file before
slicing the last 1000 lines (`:93-95`), so boot cost and peak memory grow with
lifetime event count.

Secondary: `appendFileSync`/`writeFileSync` in `emit` are synchronous on the
daemon's event loop, and `emit` is called at every job/container/extension
lifecycle point.

**Proposed fix (not applied).** Persist the compaction state — e.g. compact when
`fs.statSync(EVENTS_PATH()).size > 2 × RING_CAP × avgLineBytes`, which is what the
comment at `:37-38` already describes ("compacted … when it grows past 2×") —
and compact once at startup after re-seeding. Read the tail with a bounded read
rather than the whole file.

---

### S14 — low — README's "unlimited" max-concurrent default is a hardware cap

**Where:** `README.md:7`, `:394`; `src/hardware-sizing.js:14-27,42-50`;
`src/cli.js:136-138`, `:3241-3257`.

README:7 says "Manages **unlimited concurrent agent workers**" and README:394
lists the `--max-concurrent` default as "unlimited". The code caps at
`max(1, min((totalMem − reserve) / 2 GB, cores − 1))` — **3** on an 8 GB / 4-core
box, **7** on 16 GB / 8 cores. `--max-concurrent` writes `config.maxConcurrent`
into the legacy `config.json` (`cli.js:1204-1210`) which `cli.js:134-137`
deliberately does not read (liveness **L8**); the working override is
`runtime.max_concurrent` in `config.toml` or `J41_MAX_CONCURRENT`.

The startup banner is accurate (`cli.js:3241-3257` prints the effective cap, the
hardware estimate and an over-provision warning), so an operator who reads the
console learns the truth. One who plans from the README does not, and this is the
denominator behind S10's headroom number.

**Proposed fix (not applied).** README:7 → "Manages concurrent agent workers up to
a conservative hardware-derived cap (override with `max_concurrent`)";
README:394 → default "auto (hardware estimate)" with the formula, and point the
flag column at `config.toml` / `J41_MAX_CONCURRENT` rather than the
non-functional `--max-concurrent`.

---

### S15 — low — container log lines are mirrored uncapped, and the dashboard's log file is never rotated

**Where:** `src/cli.js:8535-8544`, `src/dashboard.js:2972`,
`src/config-loader.js:22`.

The per-job `output.log` is correctly capped at 5 MB via `makeCappedLogWriter`
(`cli.js:8523`, `job-log.js:37-45`), and archives are pruned to 50
(`cli.js:8606-8609`). The *mirror* is not:

```js
writeCapped(lines + '\n');                              // capped
for (const line of lines.split('\n')) {
  if (clean) console.log(`  [${shortId}] ${clean}`);    // uncapped, forever
}
```

Once a container passes the 5 MB cap, `writeCapped` writes nothing more while
`console.log` keeps going for the life of the job. Where that goes matters:
the dashboard's "[7] Start Dispatcher" launches with

```js
stdio: ['ignore', fs.openSync('/tmp/dispatcher.log', 'a'), fs.openSync('/tmp/dispatcher.log', 'a')]
```

— append mode, one fixed path, no rotation, across every restart. `/tmp` is
tmpfs (RAM) on many distributions.

**Scale component.** Even with quiet containers, the poll loop alone emits two
unconditional lines per agent per cycle (`cli.js:6697`, `:6725`). At 100 agents
on a 100 s interval that is ~172,800 lines/day ≈ 20 MB/day, plus the per-minute
status line and the fee-tank/inbox chatter — growing linearly with fleet size,
into a file nothing ever truncates.

**Proposed fix (not applied).** Apply the same byte budget to the console mirror
(reuse `applyLogCap`'s running total and stop mirroring past the cap, with a
one-time "further output suppressed" notice), demote the per-agent poll lines to
debug level behind `logging.level`, and have the dashboard launcher rotate
`/tmp/dispatcher.log` (or write under `~/.j41/dispatcher/` with the same
`job_log_max_bytes` treatment).

---

### S16 — low — the dispute reconciler skips the response cap the poll loop applies

**Where:** `src/cli.js:5326-5329` vs `:6708-6717`; `:5314` (`_reconcileAttempts`).

`pollForJobs` caps platform job arrays at `MAX_JOBS_PER_RESPONSE` (200,
`J41_MAX_JOBS_PER_POLL`) and logs the truncation — the ddos-5 mitigation. The
reconciler running inside the same cycle does not:

```js
for (const status of ORPHANABLE_STATUSES) {
  const res = await session.client.getMyJobs({ status, role: 'seller' });
  for (const j of (res?.data || [])) if (j?.id) jobs.push(j);
}
```

`sweepDisputesForRefund` (`:5993`) is likewise uncapped. The byte-level backstop
is the SDK's 8 MB response cap (`sovagent-sdk/dist/client/index.js:105-131`),
which bounds the damage to roughly 10–20k job objects held per agent per sweep
rather than unbounded — hence low, not medium. `state._reconcileAttempts`
(`:5314`) is also never pruned; one entry per orphanable job id for the process
lifetime.

**Proposed fix (not applied).** Apply `MAX_JOBS_PER_RESPONSE` (with the same
truncation log) at `cli.js:5327` and `:5993`, and drop `_reconcileAttempts`
entries when a job leaves an orphanable status.

---

### S17 — low — the egress proxy caps neither concurrent tunnels nor idle time

**Where:** `src/egress-proxy.js:82-113`.

`_onConnect` authorises a token, resolves, re-validates against `isPrivateIp`,
then pipes. There is no per-token limit, no global limit, and no idle timeout —
`upstream` is destroyed only on `clientSocket`'s `error` event (`:112`), and an
established tunnel where neither side speaks stays open indefinitely. The host
proxy is shared by every job container.

**Trigger.** A container that opens connections in a loop (a buggy executor
retry, a leaked keep-alive pool, or a compromised worker — the posture isolation
assumes) consumes two host sockets per tunnel with no ceiling. FD exhaustion in
the dispatcher process is fleet-wide: it takes out the control socket, container
spawning, the signing channels and every `fs.openSync` on the metering paths.
Per-container `PidsLimit: 64` (`cli.js:8368`) bounds processes, not descriptors.

**Proposed fix (not applied).** Track live tunnels per token in the existing
`_allow` map, refuse past a cap (e.g. 32/job) with 503, set
`socket.setTimeout(idleMs)` on both ends with mutual destroy, and destroy a
token's live tunnels in `revoke()` rather than only blocking new ones.

---

### S18 — low — `checkFeeTanks` is the only per-agent fan-out with no stagger

**Where:** `src/cli.js:7730-7823`, vs `:6695` (poll), `:7857` (inbox), `:4184`
(activation).

Every other per-agent loop staggers deliberately, with the reason in the comment:
"Stagger API calls — 500ms between agents to avoid rate limits at scale"
(`cli.js:6694`). `checkFeeTanks` is a bare `for` loop issuing back-to-back
`getUtxos` calls. At 100 agents that is 100 requests as fast as the platform
answers.

The README's fee-tank table (README:329-334) is *consistent* with no stagger and
is honest about the resulting cycle times, and the 30-minute interval leaves
enormous headroom (README:336, "8 % of its interval") — so this is a rate-shape
concern, not a budget one. It is called out because a 429 here trips
`auth-backoff` for the affected agents (`cli.js:4826-4838`), and the loop that
goes quiet is the one whose silence caused the round-4 agent-6 incident.

**Proposed fix (not applied).** Add the same `if (i > 0) await sleep(500)` at
`cli.js:7730`; at the documented 30-minute interval even 100 agents cost 50 s of
stagger against 1,800 s of budget.

---

## Adversarial pass — shortest path from untrusted input to a scale failure

Ordered by how little the attacker needs.

1. **Anonymous HTTP → platform amplification + replay-cache flush.** In webhook
   mode with an api-endpoint agent, `POST /j41/deposit/report` needs no
   credential. Each request writes a nonce into the shared 100k cache
   (`deposit-watcher.js:64`) and issues an outbound `getIdentityKeys`
   (`:75`) — both *before* the signature check at `:89`, and with no rate limit
   on the route. Outcome: platform 429 → `auth-backoff` → the fleet stops polling
   for work; and 100k junk nonces evict every verified access-envelope nonce,
   reopening the replay window on the paid proxy path. **S3.** This is the
   shortest path in the domain: one unauthenticated POST, no identity, no funds.

2. **Any VerusID holder → permanent proxy degradation.** Repeating the signed
   discovery handshake mints an unbounded number of API keys into one file
   (`cli.js:3760` → `api-key-manager.js:62-64`), which every subsequent proxy
   request re-reads and rewrites synchronously (`recordUsage`, 
   `proxy-handler.js:515`). Rate-limited only to 10 rps *per IP*. The degradation
   is permanent — nothing prunes. **S4 + S6.**

3. **A buyer filing disputes → a permanent, growing per-5-minute tax.** Disputed
   jobs never leave the platform's list, and `sweepDisputesForRefund` fetches each
   one's dispute record every sweep, forever, *before* the already-refunded check
   (`cli.js:6004` vs `:6020`). No cap, no stagger, no reentrancy guard. Past a
   few thousand lifetime disputes the sweeps overlap permanently and the
   dispatcher DoSes its own platform session with `status: ok` on `/health`.
   **S5 + S9.**

4. **A buyer creating job requests + an LLM outage → poll-loop stall.** Job
   requests are free to create and stay `requested` while preflight fails. With no
   negative cache, each one costs a fresh 5 s probe every cycle
   (`preflight-gate.js:51`, `llm-health.js:9`), serialised inside the poll cycle:
   up to 1,000 s of stall for a single agent at the 200-job cap. **S12.**

5. **A hostile or buggy platform → memory pressure in the reconciler.** The
   ddos-5 array cap is applied in `pollForJobs` (`cli.js:6711`) and not in the two
   dispute paths (`:5327`, `:5993`). Bounded in practice by the SDK's 8 MB
   response cap, which is why this is low. **S16.**

6. **A compromised container → host FD exhaustion.** The shared egress proxy caps
   neither tunnel count nor idle time (`egress-proxy.js:82-113`), so one
   container's socket churn is a fleet-wide resource. Requires the isolation
   posture to already be breached, hence low. **S17.**

**Paths deliberately traced and found closed:**

- **Buyer chat volume → dispatcher memory.** Conversation state lives in the
  container, bounded by the token budget and the 2 GB container limit; the
  dispatcher holds only `state.active` metadata.
- **Platform job-list flooding → dispatcher memory** on the poll path — capped at
  200 per response with the truncation logged (`cli.js:6708-6717`).
- **Buyer-driven queue growth** — only *paid* jobs reach `state.queue`
  (`cli.js:6799-6805`), so growth costs the attacker money.
- **Proxy request flooding → credit over-commitment** — bearer auth, then
  per-buyer token bucket (10 rps / burst 30) and a 4-request in-flight cap, both
  applied before any upstream call (`proxy-handler.js:239-343`).
- **Slow-loris / body flooding on the webhook port** — `headersTimeout` 30 s,
  `requestTimeout` 60 s, idle 120 s, `maxConnections` 512, 1 MB streaming body cap
  with `req.destroy()` (`webhook-server.js:72-90`, `:371-374`).
- **`/health` flooding** — pure in-memory build, bound to `127.0.0.1`
  (`control.js:123`).

---

## Checked and found clean

Verified against the code and found to do what they claim, with no scale defect:

- **Hardware self-sizing.** `computeMaxAgents` / `resolveCapacity`
  (`hardware-sizing.js`) is conservative and correct: 2 GB per container matching
  `HostConfig.Memory`, `cores − 1`, host reserve = max(2 GB, 15 %), floor of 1.
  An explicit `max_concurrent` above the estimate is honoured *and* warned about
  (`cli.js:3252-3256`). Only the README misdescribes it.
- **The three reentrancy guards that exist** (`_polling`, `_inboxSweepRunning`,
  `_feeSweepRunning`) — all release on the throw path via `finally`.
- **`safeInterval`** correctly closes the Node-20 async-throw hazard
  (`cli.js:3553-3561`).
- **`seen-jobs` lifecycle** — 7-day TTL, pruned every 60 s, atomic tmp+rename
  write, corrupt files quarantined rather than silently emptied
  (`cli.js:490-539`).
- **Per-job log capping and archive pruning** — 5 MB cap with a one-time notice,
  50 archives retained, `O_NOFOLLOW` on both read and write
  (`job-log.js`, `cli.js:8588-8614`).
- **Memory headroom valve** — `hasMemoryHeadroom` gates *both* the queue drain and
  the respawn path (`cli.js:7017`, `:5036`), with a 0.5 GB margin above the
  2 GB container.
- **Resume batching** — `RESUME_POLL_BATCH = 10` with a round-robin cursor so a
  large reactivation queue does not fan out at once (`cli.js:6911-6915`).
- **Dispute reconciler caps** — 3 respawns per sweep, 3 attempts per job, both
  with explicit "deferred, not dropped" reporting (`cli.js:5222-5238`,
  `:5366-5395`).
- **Session caching and auth backoff** — 10-minute TTL, per-agent backoff with
  jitter, `auth_backoff_agents` on `/health` (`cli.js:4791-4843`,
  `auth-backoff.js`, `control.js:469-474`).
- **Proxy rate limiter and in-flight cap** — bounded buckets with idle eviction
  *and* an LRU cap, keyed post-authentication so keys are not attacker-chosen
  (`proxy-rate-limiter.js`, `proxy-inflight.js`).
- **Discovery rate limiter** — 10 rps / burst 30 per IP with a hard 10k bucket cap
  (`webhook-server.js:44-69`).
- **Nonce cache bounds** — 100k cap, 60 s sweep, and the correct
  `checkNonceAfterVerify` ordering on the v2 access path (`nonce-cache.js`,
  `cli.js:3741-3746`). Only the deposit route violates it (S3).
- **Webhook server hardening** — see the adversarial list above.
- **Per-container limits** — `PidsLimit: 64`, `Memory: 2 GB`, `CpuQuota` = 1 core,
  `OomScoreAdj: 1000`, `ReadonlyRootfs`, 64 MB tmpfs (`cli.js:8356-8384`).
- **Signing channel cost per job** — one `fs.watch` plus a 200 ms `readdir` poll,
  `unref`'d (`sign-channel-host.js:134-146`).
- **`/health` build cost** — O(agents × active) but in-memory and localhost-bound.
- **Job directory teardown** — `fs.rmSync(jobDir, {recursive:true})` on both the
  Docker and local paths (`cli.js:8676-8680`, `:8958-8962`).
- **Per-job map hygiene** — `_lastSentStatus`, `_pendingWorkspace`,
  `pendingPayment` and `_lastExtensionCheck` are all pruned at teardown, the last
  via a deliberate `jobId`-scan because it is keyed by extension id
  (`cli.js:8616-8624`, `:8697-8700`).
- **In-code awareness of thundering herds** — the 500 ms poll stagger, the 1 s
  activation stagger, the inbox stagger, the resume batch and the reconcile caps
  all exist with the reasoning written down. The gaps found here (S18, S5, S9) are
  sites where that established pattern was not applied, not places where it is
  absent from the codebase's thinking.
