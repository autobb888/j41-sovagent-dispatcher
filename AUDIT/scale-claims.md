# scale — claims checklist

Every claim the README / CLAUDE.md makes that an operator would **act on** when
deciding how many agents to run, how much load to put on one dispatcher, or how
to tell that it is saturated. Source line refs are `README.md:N` / `CLAUDE.md`
unless stated.

Status: **VERIFIED** (code does what's claimed) · **DRIFT** (code differs — how
is stated) · **MISSING** (no implementation found) · **UNVERIFIED** (could not
determine from source alone) · **N/A** (recorded, out of scope by design).

---

## A — Concurrency & capacity

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| A1 | "Manages **unlimited concurrent agent workers**" | README:7 | **DRIFT** | The cap is a hardware estimate, not unlimited. `cli.js:136-138` computes `MAX_AGENTS` from `computeMaxAgents({os.totalmem(), os.cpus().length})` at module load; `hardware-sizing.js:14-27` returns `max(1, min((total-reserve)/2GB, cores-1))`. On 8 GB / 4 cores that is **3**. → **S14** |
| A2 | Default max concurrent = "unlimited", configurable via `--max-concurrent` | README:394 | **DRIFT** | Default is `runtime.max_concurrent: 0` (`config-loader.js:13`) → `resolveCapacity` treats 0 as "not overridden" and uses the hardware estimate (`hardware-sizing.js:42-50`). The `--max-concurrent` flag writes `config.maxConcurrent` into the legacy `config.json` (`cli.js:1204-1210`), which `cli.js:134-137` **deliberately does not read**. Already reported as liveness **L8**; recorded here because it is the documented capacity knob. |
| A3 | `J41_MAX_CONCURRENT` overrides max concurrent from config | README:423 | **VERIFIED** | `config-loader.js:106` maps it to `runtime.max_concurrent`, which is the value `resolveCapacity` honours (`cli.js:137`). |
| A4 | Owner override above the safe estimate is warned about | (code contract) | **VERIFIED** | `cli.js:3252-3256` prints the hardware estimate and an explicit OOM warning when `max_concurrent > _autoMax`. |
| A5 | Startup banner states the effective cap honestly | (code contract) | **VERIFIED** | `cli.js:3241-3257` prints registered agents, `Max concurrent: N (auto|owner override)` and the full `capacityLine`. This is the accurate surface; the README is the inaccurate one. |
| A6 | Jobs beyond capacity are queued, not dropped | README:164, 691 | **VERIFIED** | `cli.js:6819-6821` queues via `queueInsertByPriority` when `state.active.size >= MAX_AGENTS`; drained at `cli.js:7015-7033`. (Durability of that queue is liveness **L5**, not re-reported.) |
| A7 | Queue is priority-ordered (amount desc, then age) | `cli.js:6636-6640` | **VERIFIED** | `queueInsertByPriority` at `cli.js:6641-6657` implements exactly that; O(Q) linear insert, Q unbounded but only paid jobs reach it (`cli.js:6799-6805`), so growth is money-limited. |
| A8 | A spawn is refused when the host lacks memory headroom | `cli.js:5306` comment | **VERIFIED** | `hasMemoryHeadroom(os.freemem(), 2 GB, 0.5 GB margin)` gates both the queue drain (`cli.js:7017`) and the respawn path (`cli.js:5036`). |
| A9 | Per-container memory budget used for sizing matches the container limit | `hardware-sizing.js:8` | **VERIFIED** | `perContainerMemBytes = 2 GB` and `HostConfig.Memory = 2 * 1024**3` (`cli.js:8364`). `MemorySwap` is unset, so Docker's default allows 2 GB swap on top; RAM sizing is unaffected. |

## B — Poll-loop scale arithmetic

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| B1 | Poll interval = `max(60s, agents × 1s)` | README:12, 340 | **VERIFIED** | `cli.js:3955-3956`. Computed **once** at startup from `state.agents.length`. |
| B2 | 500 ms stagger between agents | README:11, 340 | **VERIFIED** | `cli.js:6694-6695` (`if (i > 0) await sleep(500)`). |
| B3 | "a cycle costs `(agents-1) × 500ms` of stagger plus **one round trip per agent**" | README:340-341 | **DRIFT** | Three more per-agent round trips and three per-active-job passes are omitted. Per agent: 2 parallel `getMyJobs` (`cli.js:6704-6707`, ≈1 RTT) **plus** `reconcileOrphanedDisputes` issuing 2 *serial* `getMyJobs` per agent with no stagger (`cli.js:5322-5329`, called at `cli.js:6904` inside the same `_polling` guard). Per active job: `getJob` (`cli.js:6846`), `getExtensions` (`cli.js:6941`), `getWorkspaceStatus` (`cli.js:6994`). → **S2** |
| B4 | "a round trip at or under 500 ms **never overruns, at any agent count**" | README:344-350 | **DRIFT** | With B3's real cost `C(N) = 0.5(N-1) + 3N·RTT` against `B(N) = max(60, N)`: at 500 ms it overruns from **N = 31**, and for **N > 60 it overruns at every latency above ~167 ms**, including the 250 ms row the table calls "flat". → **S2** |
| B5 | Overrun table (750 ms → from ~49 agents, 1 s → ~41, 1.5 s → ~31) | README:351-353 | **DRIFT** | Same cause; every threshold is ~3× too optimistic. The in-code comment at `cli.js:6680-6682` ("bites from ~30 agents at a 1.5 s round trip") is closer but still counts only one round trip per agent. |
| B6 | README:12 calls the ceiling "**measured**" | README:12 | **DRIFT** | The Scale section itself says "derived from the interval arithmetic, **not measured end to end**" (README:338-339) and "Treat these as arithmetic, not measurements" (README:358). Internal contradiction; the overview line is the wrong one. |
| B7 | When a cycle overruns the next is skipped by a reentrancy guard | README:361 | **VERIFIED** | `cli.js:6678-6689` (`_polling`), released in `finally` at `cli.js:7034-7036`. |
| B8 | Skips are reported: a `[Poll]` warning naming the count | README:363 | **VERIFIED** | `cli.js:6687` includes `${_pollSkips}` and the agent count. |
| B9 | Skips are reported: `poll_cycles_skipped` in `/health` | README:364 | **VERIFIED** | `cli.js:6686` mirrors onto `state._pollSkips`; `control.js:480` publishes it under `summary`. |
| B10 | Skipped cycles do not mark the daemon unhealthy | README:372-373 | **VERIFIED** | `control.js:445-449` — `status` degrades only on container crashes, dead-lettered inbox, or platform-inactive agents. Skips are not in that expression. |
| B11 | Platform job responses are capped so a huge response can't blow memory | `cli.js:6708-6717` | **VERIFIED (partial)** | `MAX_JOBS_PER_RESPONSE` (default 200, `J41_MAX_JOBS_PER_POLL`) applies in `pollForJobs` and truncation is logged. **Not** applied in `reconcileOrphanedDisputes` (`cli.js:5327-5328`) or `sweepDisputesForRefund` (`cli.js:5993`). Byte-level backstop is the SDK's 8 MB cap (`sovagent-sdk/dist/client/index.js:105-131`). → **S16** |

## C — Fee-tank scale

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| C1 | "Fee-tank checks scale comfortably — **measured**" | README:326 | **UNVERIFIED** | No harness, fixture or test in-repo produces the 10/100-agent × 50/500/1500 ms table (README:329-334). Read-only pass; the arithmetic it implies is consistent with the code, the provenance is not checkable. |
| C2 | "roughly one API call per agent" | README:326-327 | **VERIFIED** | `checkFeeTanks` does one `getUtxos` per agent (`cli.js:7734`); `getAgentSession` is cached for 10 min (`cli.js:4735, 4796-4799`) so it is amortised, and `broadcast` only fires on an actual sweep (`cli.js:7802-7810`). |
| C3 | Cycle times imply **no** inter-agent stagger | README:329-334 | **VERIFIED** | `cli.js:7730-7823` is a bare `for` loop — no `setTimeout`, unlike poll (`6695`), inbox (`7857`) and activation (`4184`). The table is honest about it; the asymmetry is still worth an operator note. → **S18** |
| C4 | Default interval 30 min, floor 100 writes | CLAUDE.md, README:427-428 | **VERIFIED** | `cli.js:3408-3419` resolves CLI > config/env > default; banner at `cli.js:3973` prints the effective values. (`--fee-sweep-floor 0` discarded by `\|\|` is money **M10**.) |
| C5 | Fee-tank reentrancy skip is counted and on `/health` | README:363-364 | **VERIFIED** | `cli.js:7714-7721` counts into `state._feeSweepSkips`; `control.js:481` publishes `fee_tank_cycles_skipped`. |
| C6 | Sweep runs once at startup rather than waiting a full interval | `cli.js:3975-3978` | **VERIFIED** | 15 s `setTimeout` after arming the interval. |

## D — The other periodic loops

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| D1 | Inbox sweep runs on `max(60s, agents × 1s)` with a 500 ms stagger | `cli.js:3957`, `7857` | **VERIFIED** | Same interval and same stagger as the poll loop, therefore the same per-cycle cost profile. |
| D2 | Inbox accepts are batched — one identity tx per agent per poll cycle | CLAUDE.md | **VERIFIED** | `processInboxForAgent` batches (`cli.js:7879+`); server-side type filter caps the window at 20 rows (`cli.js:7871`). |
| D3 | Inbox sweep has a reentrancy guard | `cli.js:7831-7837` | **VERIFIED** | `state._inboxSweepRunning`, released in `finally`. |
| D4 | Inbox skips are reported like poll / fee-tank skips | README:361-364 (implied by "a `[Poll]` / `[FeeTank]` warning … and … in `/health`") | **MISSING** | `cli.js:7835` is a bare `console.warn` with **no count**, no `state` mirror and no `/health` field. `control.js:475-481` publishes only `poll_cycles_skipped` and `fee_tank_cycles_skipped`. → **S8** |
| D5 | ProfileSync runs every 5 min, one identity read per agent | `cli.js:3985-4037` | **VERIFIED** | `getIdentityRaw` per agent, serial, **no stagger**, `safeInterval(…, 300000)`. |
| D6 | Periodic loops are guarded against unhandled rejection | `cli.js:3551-3561` | **VERIFIED** | `safeInterval` wraps in try/catch. It provides **no** reentrancy guard — that is per-function, and only poll/inbox/fee-tank have one. → **S9** |
| D7 | Dispute refund sweep runs every 5 min | `cli.js:4052` | **VERIFIED** | `safeInterval(sweepDisputesForRefund, 5 min)`, plus a boot sweep at `cli.js:4067`. |
| D8 | Dispute refund sweep is cheap / bounded | (no claim; audited because it is the largest per-cycle cost found) | **DRIFT vs. reality** | `cli.js:5987-6009`: per agent, one `getMyJobs({status:'disputed'})` **plus one `getDispute()` per returned job**, serial, uncapped, unstaggered, and re-run for jobs already in the refunded ledger (the ledger short-circuit at `cli.js:6020` happens *after* the fetch). Cost grows monotonically with lifetime dispute count. → **S5** |
| D9 | Dispute reconciler caps respawns per sweep and per job, and reports deferrals | `cli.js:5222-5238`, `5366-5395` | **VERIFIED** | `MAX_RECONCILE_RESPAWNS_PER_SWEEP = 3`, `MAX_RECONCILE_ATTEMPTS_PER_JOB = 3`, deferrals logged, never silently truncated. (Lifetime-vs-consecutive counting is liveness **L14**.) |
| D10 | Resume polling is batched so "100 queued jobs don't hammer the platform" | `cli.js:6911-6915` | **VERIFIED** | `RESUME_POLL_BATCH = 10` with a round-robin cursor (`state._resumeCursor`). |
| D11 | Session cache: sessions reused 10 min before re-auth | `cli.js:4734-4735` | **VERIFIED** | `SESSION_TTL_MS` checked at `cli.js:4796-4799`. Because sessions are minted during a 500 ms-staggered sweep, their expiries are staggered too — no synchronised re-auth burst. |
| D12 | Auth backoff prevents re-auth storms during a platform outage | README:20, `cli.js:4801-4815` | **VERIFIED** | `auth-backoff.js` gate + `summary.auth_backoff_agents` on `/health` (`control.js:469-474`). |
| D13 | Startup activation staggers 1 s per agent | `cli.js:4183-4184` | **VERIFIED** | …and by default also writes one on-chain identity tx per agent (`_toggleOnChain` default true, `cli.js:4179`, `4194`), so startup wall-clock and fee-tank drain both scale linearly with fleet size. |
| D14 | Startup activation cannot collide with the inbox writer | (implied by CLAUDE.md "Never write two identity txs for the same VerusID back-to-back") | **DRIFT** | The poll/inbox timers are armed at `cli.js:3961-3964`, **before** crash recovery (`4077`), the initial `await pollForJobs` (`4080`) and the activation loop (`4181-4211`). At fleet sizes where that prelude exceeds one inbox interval, the inbox sweep broadcasts for the same agent the activation loop is activating. Neither path consults the other's gate. → **S7** |

## E — Per-container resource limits

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| E1 | `PidsLimit: 64` — fork-bomb protection | README:510, 799 | **VERIFIED** | `cli.js:8368`. |
| E2 | `StorageOpt: { size: '1G' }` — max disk | README:800 | **VERIFIED (conditional)** | `cli.js:8379` applies it only when `supportsStorageOpt()`; silently dropped on most storage drivers. Already isolation **I7**. |
| E3 | `OomScoreAdj: 1000` — first to die under memory pressure | README:801 | **VERIFIED** | `cli.js:8380`. |
| E4 | 2 GB / 1 core per container | `cli.js:8364-8365` | **VERIFIED** | `Memory: 2 GiB`, `CpuQuota: 100000` (= 1 core at the default 100 ms period), matching `hardware-sizing.js` `coreReserve: 1`. |
| E5 | Per-job `output.log` is capped | `config-loader.js:22` | **VERIFIED** | 5 MB default via `makeCappedLogWriter` (`cli.js:8191-8203`, `job-log.js:37-45`), one-time truncation notice emitted. |
| E6 | Archived job logs are pruned | `config-loader.js:23` | **VERIFIED** | `job_log_max_retained: 50`, enforced by `selectLogsToPrune` at `cli.js:8606-8609`. Bounded at ~250 MB. |
| E7 | The same cap applies to the dispatcher's own log | (no claim) | **MISSING** | The container mirror at `cli.js:8540-8543` `console.log`s every line **uncapped**, and the dashboard launcher appends stdout+stderr to unrotated `/tmp/dispatcher.log` (`dashboard.js:2972`). → **S15** |
| E8 | Signing channel per job is cheap | (no claim) | **VERIFIED** | One `fs.watch` + a 200 ms `readdir` poll per active job (`sign-channel-host.js:54,134-146`), timer `unref`'d. At the hardware cap this is a few hundred syscalls/sec. |

## F — Observability of capacity

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| F1 | `ctl resources` shows CPU, RAM, per-job memory usage and capacity headroom | README:174, 663 | **DRIFT** | `control.js:542-591`. (a) `capacity.maxSlots = state.agents.length` — the *registered fleet*, not the enforced `MAX_AGENTS`; (b) `jobs[]` is built only from `active.pid`, which Docker-mode entries never carry (`cli.js:8446-8467` sets no `pid`; only the local path does, `cli.js:8874`), so "per-job memory usage" is always empty in the default runtime. → **S10** |
| F2 | `/metrics` exposes agent/job/queue counters | README:717 | **VERIFIED** | `control.js:99-117` — `j41_agents_total`, `j41_jobs_active`, `j41_jobs_queue`, `j41_agents_available`, `j41_jobs_seen_total`. Note it exposes no skip counters and no capacity denominator. |
| F3 | `/health` summary is the canonical "anything wrong" watch | README:713-717 | **VERIFIED** | `control.js:459-485`; `containers_unhealthy`, `fee_tanks_empty`, `auth_backoff_agents`, both skip counters. |
| F4 | `GET /v1/status` reports queue depth | README:691 | **VERIFIED** | `control.js:157-174` (`queue: state.queue.length`). Same `active`/`agents` shape as `/health`; also reports no capacity denominator. |
| F5 | `/health` is cheap enough to be polled by a monitor room | README:711-712 | **VERIFIED** | `buildHealthDocument` is pure in-memory. It is O(agents × active) — `control.js:392` materialises `[...state.active.entries()]` inside the per-agent `map` — but at the hardware cap that is a few thousand iterations per request, and the server is bound to `127.0.0.1` (`control.js:123`). Not a finding. |
| F6 | `ctl earnings` / `GET /v1/earnings` "hits the platform" | README:695 | **VERIFIED** | 2N serial calls against a 5 s client deadline — already liveness **L11**, not re-reported. |

## G — Data growth (disk and memory)

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| G1 | `seen-jobs` is pruned | `cli.js:523-539` | **VERIFIED** | 7-day TTL, pruned every 60 s from the status-report timer (`cli.js:4055-4058`), persisted atomically (`cli.js:507-521`). |
| G2 | Events are a **file-backed ring buffer** whose `seq` survives restart | README:698-700, CLAUDE.md | **DRIFT** | The *in-memory* ring is capped at 1000 (`control-api.js:113`), and `seq` does survive (`control-api.js:92-104`). The **file** is capped only by an in-run counter: `appendsSinceCompaction` is a fresh local starting at 0 on every process start (`control-api.js:106`), so a dispatcher that restarts before accumulating 1000 appends **never compacts**, and `events.jsonl` grows without bound while `readFileSync` reads the whole file at every start. → **S13** |
| G3 | `_lastSentStatus` / `_pendingWorkspace` / `_lastExtensionCheck` are bounded | `cli.js:3387-3389`, `8616-8624` | **VERIFIED** | All pruned at teardown (`cli.js:8697-8700`, `8980-8983`); `pruneExtensionChecks` scans by `jobId` because the map is keyed by `ext.id`. |
| G4 | `pendingPayment` is bounded | (no claim) | **DRIFT (minor)** | Deleted on payment (`cli.js:6810`) and at teardown (`cli.js:8700`), but a job that is requested and **never paid** never reaches teardown, so its entry persists for the process lifetime. Entries are tiny (a boolean plus a reference to an existing `agentInfo`) and creation costs the buyer a job request, so this is a slow, money-limited leak. Recorded, not reported. |
| G5 | `_reconcileAttempts` is bounded | `cli.js:5314` | **DRIFT (minor)** | Never pruned; one entry per orphanable job id for the process lifetime. Bounded by the platform's dispute count, so small. → folded into **S16** |
| G6 | Nonce cache is bounded and only populated after verification | `nonce-cache.js:10-17, 79-98` | **DRIFT** | The 100 k cap and sweep are real (`nonce-cache.js:25,32-39,58-61`) and the v2 access path correctly uses `checkNonceAfterVerify` (`cli.js:3741-3746`). But `deposit-watcher.js:64` calls `checkAndRecordNonce` **before** the signature check at `:70-92`, on the unauthenticated `/j41/deposit/report` route — precisely the ordering the module's own doc-comment forbids, against the same shared singleton. → **S3** |
| G7 | Proxy rate-limit buckets are bounded | `proxy-rate-limiter.js:10-13` | **VERIFIED** | Idle eviction at 5 min plus a 10 k LRU cap (`:22-38, 62-66`), and it runs *after* bearer-key auth (`proxy-handler.js:239-291`), so bucket keys are not attacker-chosen. |
| G8 | Discovery rate-limit buckets are bounded | `webhook-server.js:44-69` | **VERIFIED** | Hard 10 k cap with insertion-order eviction. (Eviction is oldest-inserted rather than least-recently-used, so a rotating-IP flood can evict a long-lived legitimate client; bounded and cosmetic, recorded not reported.) |
| G9 | Per-agent API keys are bounded | (no claim) | **MISSING** | `mintApiKey` appends one record per successful discovery request (`cli.js:3760`, `api-key-manager.js:62-64`) and **nothing ever prunes revoked or expired records**. `_keyCache` (`api-key-manager.js:26`) has no cap and is repopulated with every key in the file on each `saveKeys`. → **S4** |
| G10 | Credit meters are bounded | (no claim) | **VERIFIED (weak)** | `credit-meters.json` is keyed by buyer VerusID (`credit-meter.js:38-49`); entries are never pruned but creation requires a signed access envelope, so growth is identity-limited. |
| G11 | Buyer/job files under `jobs/<id>/` are removed at teardown | `cli.js:8676-8680`, `8958-8962` | **VERIFIED** | `fs.rmSync(jobDir, {recursive:true})` unless retention keeps the log. |

## H — Remedies for exceeding capacity

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| H1 | "Raise the interval" | README:367 | **MISSING** | There is no interval knob. `pollInterval`/`reviewInterval` are computed inline at `cli.js:3955-3957` from the agent count; no CLI flag, no `config.toml` key, no entry in `ENV_OVERRIDES` (`config-loader.js:103-160`). The only lever is registering fewer agents. → **S1** |
| H2 | "run a second dispatcher against a different subset of agents" | README:368 | **DRIFT — destructive** | `start` SIGTERMs the PID in `~/.j41/dispatcher/dispatcher.pid`, waits up to **10 minutes** for it to die, and `process.exit(1)`s if it does not (`cli.js:3162-3210`). The PID file, `control.sock` (`control.js:20`) and `DISPATCHER_DIR` are fixed paths with no override. → **S1** |
| H3 | The three port env vars make a second instance possible | README:369-370 | **VERIFIED as ports, MISSING as remedy** | `J41_HEALTH_PORT` / `J41_CONTROL_API_PORT` exist (`config-loader.js:142-143`) and `J41_EGRESS_PROXY_PORT` exists (`egress-proxy.js:15-19`), but freeing the ports does not get past H2's PID handoff. → **S1** |
| H4 | "The reliable signal is the skip counter" | README:358-359, 366 | **VERIFIED** | True for poll and fee-tank (B9/C5). Not true for the inbox loop (D4). |

## I — Extension admission control

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| I1 | Extensions auto-approved by default | README:396 | **VERIFIED** | `cli.js:6598-6601` — only `extensionAutoApprove === false` disables. |
| I2 | Reject if load avg > 80 % of cores | README:397 | **VERIFIED** | `cli.js:6603, 6608-6610` — `loadAvg1m < cpuCount * (maxCpuPct/100)`. |
| I3 | Reject if free RAM below 512 MB | README:398 | **VERIFIED** | `cli.js:6604, 6611-6612`. |
| I4 | Those are the *only* rejection conditions | README:396-398 (by omission) | **DRIFT** | `cli.js:6606-6614` also requires `state.queue.length === 0` **and** `state.active.size < MAX_AGENTS`. An extension consumes no new slot — the job already holds one — so a fully-utilised dispatcher rejects every paid extension, and does so more often the busier it is. Neither condition is documented. → **S11** |

## J — Unauthenticated / high-volume surfaces

| # | Claim | Source | Status | Evidence |
|---|---|---|---|---|
| J1 | Webhook server is slow-loris hardened with a connection cap | `webhook-server.js:106-115` | **VERIFIED** | `headersTimeout` 30 s, `requestTimeout` 60 s, idle 120 s, `maxConnections` 512 (`:371-374`). |
| J2 | Request bodies are size-capped | `config-loader.js:65` | **VERIFIED** | 1 MB, enforced streaming with `req.destroy()` (`webhook-server.js:72-90`). |
| J3 | `/j41/discovery/request-access` is rate-limited "before the outbound `getIdentityKeys` call to prevent amplification DoS" | `webhook-server.js:133-141` | **VERIFIED** | 10 rps / burst 30 per source IP. |
| J4 | The same protection covers the other unauthenticated outbound-triggering route | (implied by J3's rationale) | **MISSING** | `/j41/deposit/report` (`webhook-server.js:158-196`) has **no** rate limit, and its handler reaches `client.getIdentityKeys()` (`deposit-watcher.js:75`) before any signature check. → **S3** |
| J5 | Proxy requests are auth-gated before any expensive work | `proxy-handler.js:236-343` | **VERIFIED** | bearer prefix → `findKeyOwner` → model pricing → rate limit → circuit breaker → per-buyer in-flight cap (default 4). Ordering is correct. |
| J6 | `findKeyOwner` is O(1) | `api-key-manager.js:82-84` | **DRIFT** | True on a cache hit; a **miss** does `readdirSync(AGENTS_DIR)` plus a synchronous read+parse of every agent's `api-keys.json` (`:97-106`), on the unauthenticated path. Already keys **K9**; the scale magnitude (O(agents × keys) sync I/O per junk bearer token) is noted under **S6**. |
| J7 | Proxy metering is a cheap in-memory reservation | README:651 (by implication) | **DRIFT** | Every completed request performs 4 synchronous whole-file reads and 3 synchronous whole-file writes (`reserveCredit`+`adjustCredit` on `credit-meters.json`, `recordUsage` on `api-keys.json`, `checkAndFlagLow` re-read) on the daemon's single event loop. → **S6** |

---

## Roll-up

77 claims — **48 VERIFIED** · **19 DRIFT** (A1, A2, B3, B4, B5, B6, D8, D14, E2, F1, G2, G4, G5, G6, H2, I4, J6, J7, plus C3 recorded as verified-but-asymmetric) · **6 MISSING** (D4, E7, G9, H1, H3-as-remedy, J4) · **1 UNVERIFIED** (C1, the "measured" fee-tank table — no harness in repo) · **3 recorded-not-reported** (G4, G8, G10).

Two VERIFIED entries are qualified in place: **B11** (the ddos-5 response cap is real, but applied at one of three call sites) and **F5** (`/health` is O(agents × active) but localhost-bound and cheap at the enforced cap).
