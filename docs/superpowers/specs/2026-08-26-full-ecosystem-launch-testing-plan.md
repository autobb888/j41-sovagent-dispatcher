# Full-ecosystem launch-testing plan — design

**Date:** 2026-08-26, reworked 2026-08-27 for the two-dispatcher topology
**Status:** Draft, awaiting owner review
**Filed in:** dispatcher repo (hub for this work), but spans multiple repos — see Scope.
**Trigger:** owner, pre-launch: "how do we do a proper full testing experience
for everything dispatcher and junction41 have developed... need to get this
launched for testing" → reworked on the owner's instruction: "we are going to
use 2 dispatchers and the chrome plug from this computer for testing, j41 is
on another pc, plan needs to be robust af."

This is a roadmap. It decomposes into 4 tracks; each gets its own detailed
implementation plan immediately before that track runs, because plans written
now for track C/D would be stale by the time we reach them, sessions away.

---

## Scope

**In scope:** `j41-sovagent-dispatcher`, `j41-sovagent-sdk`, `j41-connect`,
`j41-jailbox`, `j41-secure-setup`, `j41-docs`.

**Out of scope** (owner instruction): `sovguard`, `j41-sovagent-mcp-server`.

**Backend (junction41.io platform):** runs on a separate PC. Every live test
exercises it as the counterparty, but nothing here reads or changes backend
source.

---

## 1. Topology

| Role | Where | What it is |
|---|---|---|
| **Backend / platform** | Separate PC | junction41.io + API. Already remote. |
| **Dispatcher A — seller** | This machine | The agent under test. Gets hired, delivers, gets paid. |
| **Dispatcher B — buyer-agent** | This machine, isolated instance | Provides the buyer *identity + wallet*. A `BuyerSession` script runs against its keys. |
| **Web frontend** | This machine, Chrome | junction41.io in the browser, driven by the Claude-in-Chrome extension. |

### 1.1 Why Dispatcher B is an identity, not a hiring engine

Verified by grepping the entire dispatcher `src/` case-insensitively for
`hire`, `BuyerSession`, `createJob`, `.hire(`, plus enumerating all 37 CLI
commands: **the dispatcher has no buyer-side hiring capability at all.** Every
"hire" in the codebase is seller-side language (an agent *being* hired). The
command set is register / accept-job / deliver / post-bounty / wallet /
refunds — seller and operator-money verbs only.

So "agent-to-agent hiring via a second dispatcher" is mechanically: a
`BuyerSession` script, run against Dispatcher B's registered agent's keys and
wallet. Dispatcher B exists to own a real, separately-registered, separately-
funded on-chain identity so the buyer is genuinely a different marketplace
actor — not to execute the purchase itself.

This also means Dispatcher B **must be running** for some scenarios (so its
agent is `active` on both status axes and its fee tank is being swept), even
though the purchase itself comes from a script.

### 1.2 The honest limitation of same-machine testing

Both dispatchers share one kernel, one Docker daemon, one filesystem, one
network namespace. That is fine for everything in Track B (the marketplace
protocol, money lifecycle, and web frontend do not care where the peer runs —
they meet at the remote backend and on-chain).

It is **not** sufficient to validate `j41-connect` / `j41-jailbox` isolation
claims. Those exist to confine a buyer-side agent, and the June 2026-06-01
audit already found their marketed "Three-Wall Isolation" diverges from the
code (Wall 1 silently falls back to plain Docker; audit logs record the
agent's *claimed* path, not the real one). A same-machine test can pass while
the actual guarantee is broken. **Track C therefore carries an explicit
caveat: its jailbox/connect findings are source-level and functional, not
isolation-proof.** Proving isolation needs a genuinely separate host, and that
is deliberately deferred, not silently dropped.

---

## 2. Two dispatchers on one machine — verified isolation recipe

Everything in this section was verified empirically on this machine today, not
inferred from docs.

### 2.1 What isolates, and how

`src/cli.js:141` derives all state from `os.homedir()`:
```js
const J41_DIR = path.join(os.homedir(), '.j41');
const DISPATCHER_DIR = path.join(J41_DIR, 'dispatcher');
```
There is **no `J41_HOME` override.** The only lever is `$HOME` itself. Node's
`os.homedir()` honours `$HOME` on POSIX — verified:
```
$ HOME=/tmp/fake-home-test node -e "console.log(require('os').homedir())"
/tmp/fake-home-test
```

Ports are separately overridable (`src/config-loader.js:188-189`):
- `J41_HEALTH_PORT` → `runtime.health_port` (default 9842)
- `J41_CONTROL_API_PORT` → `runtime.control_api_port` (default 9843)

**A third port matters and would have blocked the run.** The egress proxy
(`egress-proxy.js:15`) binds `J41_EGRESS_PROXY_PORT` (default **9847**) on the
shared `j41-isolated` docker bridge gateway (172.18.0.1) — and `start` treats
a bind failure as **FATAL** (`cli.js:5249`, `process.exit(1)`). Since both
instances resolve the *same* gateway IP, a second dispatcher without this
override cannot start at all. The source comment anticipates exactly this:

> *"daemon holds this port on the shared j41-isolated bridge, and `start`
> treats a bind failure as FATAL — without an override, a second dispatcher on
> the same host cannot start at all, which blocks fault-injection and scale
> testing."*

Confirmed bound right now by the running fleet: `172.18.0.1:9847` (PID 381346).

**Verified launch recipe for Dispatcher B:**
```bash
HOME=/home/mainn/j41-buyer \
J41_HEALTH_PORT=9852 \
J41_CONTROL_API_PORT=9853 \
J41_EGRESS_PROXY_PORT=9857 \
node /home/mainn/dispatchertest3/j41-sovagent-dispatcher/src/cli.js start
```
Add `--webhook-port 9851` **only if** running webhook mode — the webhook
server starts solely under `if (options.webhookUrl)` (`cli.js:4610`), default
port 9841. Poll mode is the default and binds nothing.

Every subsequent B-side command needs the same `HOME=` prefix, or it will
silently operate on A's fleet. **This is the single sharpest footgun in the
whole plan** — a missing `HOME=` on a `wallet send` or `deactivate` hits the
wrong fleet with no warning. Mitigation in §2.3.

### 2.2 Collision matrix

| Resource | Path / mechanism | Isolated by | Risk |
|---|---|---|---|
| Agents, keys, config.toml | `$HOME/.j41/dispatcher/` | `HOME` | ✅ auto |
| `control.sock` | `os.homedir()`+`.j41/dispatcher/control.sock` (`control.js:20`) | `HOME` | ✅ auto |
| `dispatcher.pid` | `DISPATCHER_DIR/dispatcher.pid` | `HOME` | ✅ auto |
| Jobs, queue, deposits, ledgers, locks | under `DISPATCHER_DIR` | `HOME` | ✅ auto |
| Security-init marker | `~/.j41/dispatcher-security-initialized` | `HOME` | ✅ auto |
| Health port 9842 | config / `J41_HEALTH_PORT` | **manual env** | ⚠️ must set |
| Control API port 9843 | config / `J41_CONTROL_API_PORT` | **manual env** | ⚠️ must set |
| **Egress proxy 9847** | `J41_EGRESS_PROXY_PORT`, binds shared bridge gw 172.18.0.1 | **manual env** | 🔴 **FATAL if unset** — B cannot start |
| Webhook port 9841 | `--webhook-port`; only starts in webhook mode (`cli.js:4610`) | flag | ✅ n/a in poll mode (default) |
| Docker container names | `j41-job-<jobId>`, platform-issued UUID (`cli.js:10325`) | UUID uniqueness | ✅ no collision |
| Docker images | `j41/job-agent`, `j41/gpu-jail` | shared, read-only | ✅ fine to share |
| GPU device / `j41-isolated` bridge | shared hardware + docker net | not isolated | ⚠️ only one instance may do GPU rental |

All four port questions are now **resolved and verified against source and
live socket state** — no unknowns block standing up Dispatcher B. The egress
proxy is the one that would have cost real debugging time: a fatal exit whose
cause (a port held by the *other* dispatcher on a docker bridge IP, not
localhost) is not obvious from the error.

### 2.3 Footgun mitigation — mandatory before any B-side command

Create a wrapper so no B-side command is ever typed without its `HOME`:
```bash
# /home/mainn/j41-buyer/dispb  (chmod +x)
#!/usr/bin/env bash
export HOME=/home/mainn/j41-buyer
export J41_HEALTH_PORT=9852
export J41_CONTROL_API_PORT=9853
export J41_EGRESS_PROXY_PORT=9857
exec node /home/mainn/dispatchertest3/j41-sovagent-dispatcher/src/cli.js "$@"
```
Then B-side is always `./dispb wallet show buyer-1`, never a bare
`j41-dispatcher`. Every runbook step in Track B must use this form. Any step
in the results doc showing a bare dispatcher command for a B-side action is a
**documentation defect** to fix before the run is trusted.

### 2.4 The already-running fleet — restartable, with a caveat

There is a live dispatcher on this machine: **PID 381346, `node src/cli.js
start`, running since Aug 24**, holding 127.0.0.1:9842, :9843 and
172.18.0.1:9847. It owns 13 agent directories — 9 with registered on-chain
identities (`dt3worker1-7`, `url`, `url2`) and 4 unregistered (`agent-8`,
`compute-1`, `agent-test-1`, `agent-template-test`). All are `agent` kind.

**Owner has confirmed it may be restarted freely** (open decision #4 closed).

It still makes sense to **reuse it as Dispatcher A** rather than rebuild:
it is warm, funded, registered, and its fee tanks are swept. Rebuilding costs
a full registration cycle per agent (5-20 min of block confirmations each) and
re-funding — and F2 already requires registering three *new* kinds
(compute/data/model), so there is plenty of fresh-registration coverage
without also discarding nine working identities. F1's clean-install scenario
is better served by a throwaway third `HOME`.

**The caveat that survives the owner's go-ahead:** restarting is safe, but
per §5 a graceful shutdown sets every agent `inactive` on-chain and `start`
does **not** reactivate them — recovery needs a manual `activate-all` plus a
both-axes check. So a restart is a deliberate, verified step with a known
follow-up, not a free action. Scenario L5 tests exactly this, so the first
restart is best done *as* L5 rather than incidentally.

---

## 3. Track A — Security audit refresh

**Baseline:** `audit-2026-06-01/FINAL-REPORT.md` at the workspace root — 429
agents, 5 dimensions (loss-of-funds, auth-boundary, DDoS/availability,
supply-chain, bridge/trust), two-lens adversarial verify that refuted 32 of
192 raised findings including one originally-CRITICAL claim.

**All 6 CRITICALs from that audit are verified fixed in current code** —
checked directly, not taken from the doc: `assertNotProtocolMessage` now
applied at the SDK's `_signMessage` and MCP `state.ts`; `changeAddress`/
`sourceAddress` removed outright from MCP payments (its own comments cite
"Audit 2026-06-02 C2"); MCP SSE defaults to `127.0.0.1` and fails closed
without a token off-loopback; `verus-typescript-primitives` pinned to the
exact recommended commit; secure-setup's gVisor install checks an in-package
pinned SHA-512 (comments cite "Audit C6 + H6"). This is a refresh on a real
base, not a cold start.

**Unaudited surface since June:**
- dispatcher: GPU-rental/Cat-1 compute, spend-policy consolidation,
  allowlist/sales-mode, batched-inbox writes, M4 0-conf deposit reconciler,
  at-rest WIF encryption, api-endpoint metered proxy, and the 11 CLI/TUI
  blockers fixed 2026-08-25 (`docs/testing/2026-08-25-cli-tui-newuser-audit.md`).
- sdk: canonical-v1 signing, attestation/dispute-respawn, batched-inbox,
  identity-history reconstruction.
- **`j41-connect` was never in the June audit's repo list — first pass ever.**
- jailbox, secure-setup: git history since June not yet inventoried (step 1).

**Method:** Workflow-based fan-out, same shape as June. **Requires the
owner's explicit opt-in at execution time** — it can spawn dozens of agents
and I will not start it unilaterally. Keep the two-lens adversarial verify;
it is what stopped 32 false positives, including a "CRITICAL" that would have
burned a fix cycle.

**Deliverable:** `audit-2026-08-26/` at the workspace root, mirroring June's
per-repo chunks + FINAL-REPORT.md.

**Then:** remediation branch per affected repo, CRITICAL-first, following
`docs/superpowers/specs/2026-06-22-audit-remediation-design.md` — one branch,
fix-forward, single merge + release, and flag anything needing backend
support rather than claiming a full fix.

**Estimate:** ~1 session for the audit, ~1 for triage + starting remediation.

---

## 4. Track B — Live E2E on testnet

**Why:** last live pass was 2026-08-14 (owner-confirmed). Everything since —
GPU rental, spend-policy, allowlist/sales-mode, and the 11 CLI/TUI fixes —
has only ever been checked by source review and unit tests. Those prove code
does what it claims in isolation; they cannot prove the remote backend agrees
or that confirmation timing holds. That gap has produced real outages before:
the `json-canonicalize` clean-install failure (every fresh install dead, found
in 30 seconds by one `npm i` after four source audits missed it), three
audit findings corrected by the 08-14 clean-install walk, and the CMM
key-ordering bug.

**Method:** sequential runbook, not fan-out. Real transactions, real block
waits. Each step's actual output captured before the next begins.

### 4.1 Three buyer paths

1. **Web frontend** (Chrome + Claude-in-Chrome, this machine)
2. **Agent-to-agent** — `BuyerSession` on Dispatcher B's identity
3. **Raw SDK** — `BuyerSession`

**2 and 3 are the same mechanism** (§1.1); they differ only in framing. One
script covers both. Path 1 is genuinely separate and is what the Chrome
extension is for.

**Chrome is not currently connected** — the extension is not set up in this
session. Connect via `/chrome` (claude.ai/chrome) before Track B, or path 1
falls back to the owner clicking manually while narrating results.

### 4.2 Existing buyer scripts — audit before reuse

`buyer-broker-test.js`, `buyer-pay-existing.js`, `buyer-end-session.js`,
`buyer-complete-*.js` at the workspace root use `BuyerSession` against
**hardcoded agent-5/agent-2 keys and a hardcoded service id**, and resolve the
SDK through `j41-sovagent-dispatcher/node_modules`. All of that assumes the
single-machine, single-fleet world.

Step 1 of Track B's implementation plan: read all four, determine which still
run against current dispatcher/SDK/backend, and decide reuse vs. rewrite —
**parameterised on agent-id, service-id and `HOME`**, never hardcoded again.

### 4.3 Listing kinds — the "sov-" question, answered

`src/listing-kind.js` defines **four** listing kinds, each with an intended
mainnet parent:

| Kind | Intended parent | What it is |
|---|---|---|
| `agent` | `sovagent@` | An AI you hire to do an advertised task |
| `compute` | `sovcompute@` | A GPU / SSH box buyers rent and run their own workload on |
| `data` | `sovdata@` | A dataset agents can query (you host the bytes) |
| `model` | `sovmodel@` | A specific model for sale (metered inference) |

**On VRSCTEST, DeFi is off, so all four mint as `name.agentplatform@`** and the
real kind lives in `platform.config.kind` / `keys.json` (`listing-kind.js`
header comment; `advertisedIdentity()` always appends `agentplatform@`). The
`sov*@` parents are the *mainnet* shape. So testnet coverage of all four kinds
is possible today; what it cannot prove is the parent-routing that only exists
on mainnet — flag that as a known residual, don't pretend otherwise.

**Current fleet has only `agent`-kind registrations** (`dt3worker1-7`, `url`,
`url2`). `compute-1` exists but is unregistered. **`data` and `model` listings
have never been registered or hired at all** — completely untested surface.

### 4.4 Coverage matrix — every functionality that exists

Built from three authoritative inventories: the dispatcher's **37 CLI
commands**, the **27 webhook event types** it handles (`case 'job.*'` etc. in
`cli.js`), and the platform's tool surface. Priorities:

- **P0** — launch-blocking. Money moves, or a stranger hits it in hour one.
- **P1** — should pass before wide invite; a bug here is embarrassing not fatal.
- **P2** — completeness; can trail the launch.

Buyer path: **W** = web frontend (Chrome), **S** = `BuyerSession` script
(covers both the "agent-to-agent via Dispatcher B" and "raw SDK" framings),
**—** = seller/operator-side only.

#### F — Foundation & onboarding

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| F1 | Clean install → `init` → `register` → `finalize` → `start` (agent kind), throwaway `HOME` | — | P0 | B1 profile-persistence fix; the clean-install class that caught the npm outage |
| F2 | Register **compute**, **data**, **model** listings | — | P0 | **data + model never registered, ever** |
| F3 | `quickstart` guided path; `setup --template` (all 5 templates) | — | P1 | `setup --help` previously listed 3 of 5 |
| F4 | Key lifecycle: `encrypt-keys` → `start` w/ passphrase → `change-passphrase` → `decrypt-keys` | — | P0 | B4 fix; irreversible ops |
| F5 | `recover` a timed-out registration; `set-authorities` / `check-authorities` | — | P1 | |
| F6 | `update-profile` (VDXF write), `inspect`, `status`, `providers`, `config` | — | P1 | check `pendingWrites` empty first (§5) |

#### H — Hire → deliver → pay (the core loop)

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| H1 | Agent hire → accept → chat → deliver → complete → payment | **W** | P0 | the path most real buyers take |
| H2 | Same, via `BuyerSession` from Dispatcher B | **S** | P0 | agent-to-agent framing |
| H3 | Chat: send/receive, held messages, `release`/`appeal`, communication policy | W+S | P1 | `getChatMessages ?since=` trap (§5) |
| H4 | Workspace: connect → list/read/write → done → `workspace.completed` | S | P1 | 3 webhook events |
| H5 | Files: upload / download / delete, `file.uploaded` | S | P2 | |
| H6 | **Review**: buyer submits → `review.received` → `acceptReview` → on-chain | W+S | P0 | inbox batching; trust/reputation update |
| H7 | Trust/reputation/transparency profile reflects the review | W | P1 | |
| H8 | `model`-kind listing hired (metered inference) | S | P0 | never tested |
| H9 | `data`-kind listing queried | S | P1 | never tested |

#### R — Rework, dispute, refund

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| R1 | Buyer rejects delivery (`job.delivery_rejected`) → re-deliver | W+S | P0 | |
| R2 | Dispute filed → `respond-dispute --action rejected` (defend) | S | P0 | B5 new confirm |
| R3 | Dispute → `--action rework` → `rework_accepted` → re-deliver | S | P0 | rework-cycle limit refusal path too |
| R4 | Dispute → `--action refund --refund-percent` → refunds queue → `approve` → on-chain send | S | **P0** | the money-return path; bounds per §4.6 |
| R5 | `refunds reject` / `refunds unblock` | — | P0 | B5 fix; `unblock` refuses `--yes` by design |
| R6 | Rework budget invariant: mid-job re-grant offsets cumulative usage | S | P1 | §5 hazard |
| R7 | Dispute metrics / resolver visibility | W | P2 | |

#### E — Extensions & limits

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| E1 | Extension: request → approve → **pay** | W+S | P0 | money; `requireFunderIsParty` — fund from the buyer identity's wallet |
| E2 | Extension rejected | S | P1 | |
| E3 | `limit.warning` → `limit.reached` (token budget exhaustion) | S | P1 | honest budget message |
| E4 | Free/auto extension on idle-timeout resume | — | P1 | |

#### L — Lifecycle edges & crash recovery

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| L1 | Job cancelled (`job.cancelled`) | W+S | P1 | |
| L2 | Job paused → resumed | S | P1 | paused-delivery crash was a real past bug |
| L3 | **Dispatcher restart mid-job** → `job.reconnect` → job completes | — | **P0** | never run end-to-end; `respawnReadyResumes` |
| L4 | `end_session_request` | S | P1 | |
| L5 | Restart → fleet returns → `activate-all` → both axes active | — | P0 | §5: restart deactivates fleet |

#### C — Compute / GPU rental (Cat-1)

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| C1 | `rental-setup --price <n>` → listing live at the right price | — | P0 | B2 fix; verify price echoed |
| C2 | Buyer rents → SSH credentials delivered → jail reachable | S | P0 | never live-tested |
| C3 | Lease expiry → box released, billing stops | S | P0 | money leak risk if broken |
| C4 | Prepay gating; postpay `--ack-postpay-vast-risk` refusal | — | P1 | |
| C5 | `build-image` (job-agent **and** gpu-jail), preflight failures | — | P0 | fails closed w/o docker/nvidia/StorageOpt |

#### P — api-endpoint proxy (metered LLM resale)

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| P1 | `api-setup` → service registered, models/pricing correct | — | P0 | |
| P2 | Buyer deposit → credit meter credited | S | **P0** | double-credit bugs found here before |
| P3 | Metered request through proxy → billed correctly | S | P0 | |
| P4 | `deposits list/credit/dismiss`; 0-conf reconciler (M4) | — | P0 | **M4 has never run on real data** |
| P5 | `proxy.access_revoked` | S | P1 | |
| P6 | Rate limit / circuit breaker / inflight cap | S | P2 | |

#### B — Bounties

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| B1 | `post-bounty` → `list-bounties` → buyer applies | W+S | P1 | |
| B2 | `select-bounty-claimants` → award → `bounty.awarded` | W | P1 | §5: sign over **i-addresses**, submit **application row-ids**, field is `applications` |
| B3 | Cancel bounty | W | P2 | |
| B4 | **Headless bounty award** | — | P1 | previously dashboard-only → headless operator could post but not award |

#### S — Sales gating (invite-only floodgate)

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| S1 | `sales-mode invite` + allowlisted buyer → auto-accepted | S | P0 | |
| S2 | Non-allowlisted buyer → **held**, not accepted | S | **P0** | the actual security property |
| S3 | `allowlist add` (name → resolves i-address) then `remove` → **both** entries gone | — | **P0** | B3 fix; verify with `allowlist list` |
| S4 | `sales-mode open` → floodgate, stacked jobs accepted | S | P0 | |
| S5 | `accept-job` one-shot on a stacked stranger | — | P1 | |
| S6 | Empty allowlist + invite = accept nobody | S | P1 | |

#### W — Operator money surfaces

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| W1 | `wallet list/show/sweep/send`; fee-tank drain → sweep refill | — | P0 | i-addr vs R-addr (§5) |
| W2 | Fee-tank auto-sweep fires on schedule | — | P1 | |
| W3 | Mainnet guards (verify **refusal** without being on mainnet) | — | P1 | `--yes` refused; retype-amount |
| W4 | `--json` on every command that claims it | — | P2 | |

#### V — Privacy & security

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| V1 | Canary token injected → leak attempt → outbound blocked + stripped | S | P0 | |
| V2 | Deletion attestation written + verifiable | S | P1 | |
| V3 | Privacy tiers / data policy honoured | S | P1 | |
| V4 | Prompt-injection scan on job description + tool results | S | P0 | sovguard *integration* in dispatcher (repo itself out of scope) |
| V5 | Egress proxy: allowed host passes, non-allowed **denied**, DNS-rebind re-validated | — | P0 | |
| V6 | Jail confinement | S | P1 | ⚠️ same-machine caveat (§1.2) |

#### M — Fleet & multi-instance

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| M1 | `activate-all` / `deactivate-all`; both status axes verified | — | P0 | |
| M2 | Concurrent jobs across multiple agents | S | P1 | |
| M3 | Inbox batching: several items → **one** identity tx, 0 rejections | — | P0 | CMM ordering (§5) |
| M4 | Dispatcher A and B both live, both hiring/selling, no interference | — | P0 | validates §2 isolation |
| M5 | TUI: every menu item reachable; money screens; the 11 fixed blockers live | — | P0 | |

#### N — Notifications & integration

| ID | Scenario | Path | Pri | Notes |
|---|---|---|---|---|
| N1 | Notifications / alerts / dismiss | W | P2 | |
| N2 | Webhooks: register / test / update / delete; HMAC verified | — | P1 | |
| N3 | Earnings, public stats, `ctl` read surfaces, `/health`, `/metrics` | — | P1 | |

**Totals (counted, not estimated): 67 scenarios — 30 P0, 30 P1, 7 P2.** That is realistically
3-4 sessions of live wall-clock for P0 alone, given block confirmations. This
is the honest size of "test every functionality that exists"; it is not a
one-sitting exercise, and pretending otherwise is how coverage silently
becomes a golden-path-only run.

**Suggested cut if launch pressure forces one:** P0 only, and inside P0
prioritise anything that moves money or gates access — R4, P2, P4, S2, S3,
C3, W1, E1. Those are the ones where a bug costs funds or lets the wrong
buyer in.

### 4.5 Known-untested surface (highest expected yield)

Nothing here has ever been exercised live. Expect the most findings:
- `data` and `model` listing kinds (F2, H8, H9) — never registered
- GPU rental end-to-end (C2, C3) — shipped since 08-14
- M4 0-conf deposit reconciler (P4) — explicitly recorded as never run on real data
- Restart mid-job (L3) — recorded repeatedly as never run end-to-end
- Headless bounty award (B4)
- Everything from the 2026-08-25 CLI/TUI fix batch (F1, F4, C1, S3, R5, plus M5)

### 4.6 Hard preconditions — verified blockers, found in the 2026-08-27 review

Each was checked on this machine. These gate Track B; several have no
workaround and force a scope decision.

**🔴 P-1. There is no NVIDIA GPU on this machine.** `nvidia-smi` is absent;
`docker info` lists runtimes `runsc runsc-nogso io.containerd.runc.v2 runc` —
**no `nvidia` runtime**. `rental-setup` fails closed without NVIDIA +
StorageOpt-capable storage (and storage here is `overlay2`, which per the
README typically cannot cap `disk_gb`). **The entire C family — 5 scenarios,
3 of them P0 — cannot run on this box as configured.** Options:
 - (a) Use the **`vast`** provider type instead of `home-gpu` — sourced GPU,
   no local hardware. Costs **real USD**, needs a Vast API key, and the
   platform-side `RENTAL_SECRETS_KEY` is a backend env, not ours.
 - (b) Defer the C family and launch without compute listings enabled.
 - (c) Add GPU hardware / test on a GPU box.
 **This is an owner decision (new open decision #9); the plan cannot resolve
 it.** Note gVisor (`runsc`) *is* present, so V5/V6 isolation scenarios are
 unaffected.

**🔴 P-2. Dispatcher B's buyer cannot be funded by `wallet send`.** Wallet
destinations are **fleet agent-ids only** — a raw address is refused by design,
and B is a *different fleet* (different `HOME`), so A cannot see B's agent.
Registration seeds only ~0.0033 VRSCTEST (~33 on-chain writes), nowhere near
a 0.5 VRSCTEST job price, **and there is no faucet** (§5). Funding therefore
needs a small **SDK-level `sendCurrency` script** from a funded A-side agent's
WIF to B's agent's R-address.
> ⚠️ **Do NOT copy an existing agent's `keys.json` into B's `HOME` to shortcut
> this.** The same identity live in two dispatchers means two daemons issuing
> identity writes against the same confirmed `prevOutput` — the exact
> double-spend class the batched-inbox work exists to prevent.

**🟢 P-3. Funds exist.** Fleet has real balances — `agent-2` 22.76 fee tank /
17.99 sweepable, `agent-5` 10.19 / 14.01, `agent-3` 8.99 / 14.10 (VRSCTEST).
Ample for a 0.5-per-job matrix. `agent-6` is nearly dry (0.13 / 0.08) — do not
pick it as a test seller without sweeping first.

**🟡 P-4. Health baseline is already `degraded`.** Cause identified: a stale
`lastError` on **agent-3** — `job 6f3cd336… container exited 1`. Deposits are
clean, `pendingWrites` empty, no unhealthy containers. So `status: ok` **cannot
be a pass criterion until this baseline is cleared** (a restart should clear
it — fold into L5). Capture a pre-test baseline snapshot and diff against it,
rather than asserting green.

**🟡 P-5. The seller needs a live LLM or every job is refused.** The preflight
gate declines jobs when the provider is down — correct money-safety behaviour,
but indistinguishable from "no demand" in a test. Provider is configured as
`kimi-nvidia` / `openai/gpt-oss-120b`. **Probe it as an explicit precondition
step** before any H/R/E scenario, and re-probe after any failure that looks
like silence.
> 🔑 **Security note:** the live provider API key sits in plaintext in
> `~/.j41/dispatcher/config.toml` and was surfaced in this planning session.
> Rotate it before launch and keep it out of any results doc or screenshot.

**🟡 P-6. Backend capability is assumed, not verified.** Several scenarios
need platform-side support that may not be enabled: `data`/`model` listing
hire flows (F2/H8/H9 — never exercised by anyone), the per-seller dispute
resolver, and whatever the spend-policy work expects. **Add a backend-capability
precheck as Track B step 0** (`/v1/version` feature flags + a read-only probe
per kind). A scenario failing because the backend does not implement it is a
different finding from a dispatcher bug, and conflating them wastes a cycle.

**🟡 P-7. The web path is blocked until Chrome is connected.** Every **W**-path
row is unrunnable until the extension is set up (`/chrome`). That is ~6
scenarios including H1 and H6, both P0.

### 4.7 Defect-handling loop

Track A has a remediation model; Track B had none. When a scenario fails:
1. **Classify** — dispatcher/SDK bug, backend bug, environment, or test error.
   Backend bugs are ferried, not fixed here.
2. **Record the failure in the results doc immediately**, with evidence, before
   attempting a fix. A fixed-then-unrecorded failure disappears from history.
3. **Fix on a branch**, with a regression test, following the 2026-08-25
   pattern (fix → code-review → test). Live-found bugs are the highest-value
   test cases the project gets.
4. **Re-run the failed scenario plus every scenario sharing its precondition**
   — not the whole matrix, and not only the one that failed. Record which.
5. **If the fix touches code Track A audited, flag that surface for re-audit.**

**Standing rule:** never edit the runbook's expected result to match observed
behaviour. That converts a finding into a pass, and it is the single easiest
way for this whole exercise to certify a broken system.

### 4.8 Per-scenario discipline (this is what "robust" means here)

Every scenario in the runbook must carry, written **before** it is run:
- **Preconditions** — fleet state, both status axes, funded tanks, ports up.
- **Exact commands**, with the `./dispb` wrapper for all B-side steps.
- **Expected observable result** — not "it works": the txid, the status
  transition, the balance delta, the specific log line.
- **PASS/FAIL criteria** stated in advance. Deciding after the fact what
  counted as success is how a failed run gets recorded as a pass.
- **Evidence to capture** — command output, txid, `/health` snapshot, screenshot
  for web-path steps.
- **Recovery** — what to do if it fails midway, and specifically whether money
  is left in flight.

**Checkpointing:** block confirmations are real minutes and registration is
5-20. A failure in S3 must not require re-running F1 through H2. Each scenario
declares the state it needs so it can be entered directly.

**Money safety bounds for the whole track:**
- `J41_NETWORK` verified `verustest` before *any* step. Assert it, don't assume.
- Job amounts small and fixed (the existing scripts use 0.5 VRSCTEST).
- Any refund/dispute step names, in advance, the exact expected outflow.
- No `--yes` on money verbs except where the runbook says so explicitly and
  the amount was verified in the preceding step.

**Deliverable:** dated results doc in `j41-sovagent-dispatcher/docs/testing/`
following the round-N convention — PASS/FAIL per scenario with specifics,
tracked against the §4.4 matrix IDs so partial coverage is visible rather
than implied.

**Estimate:** **3-4 sessions for P0 alone**, more with P1/P2 — wall-clock-bound
(block confirmations), not compute-bound. The earlier "1-2 sessions" estimate
was written against a 6-scenario list and is superseded by the 67-scenario
matrix.

---

## 5. Known hazards — bake into every runbook step

Recorded from prior live rounds. Treat as "verify still true", not gospel —
several cite behaviour that may have changed.

| Hazard | Consequence | Mitigation |
|---|---|---|
| **~04:00 UTC daily backend maintenance** | Seller auth dies fleet-wide, 503 `CHAIN_SYNCING`, ~50 min | Never schedule a run near 04:00 UTC |
| **Restart deactivates the fleet** | Graceful shutdown sets agents inactive; `start` does not reactivate | Manual `activate-all` after any restart; re-verify both axes |
| **Two status axes** | Hire needs platform **AND** chain active; one green surface can hide the other | Check both; `/health` alone is not proof |
| **Fee tank drain** | Payments land at i-address, fees spend only R-address → agent goes silent on-chain while holding earnings | Confirm sweep ran; `wallet sweep <id>` works at zero tank |
| **Registration funds the agent** | J41 seeds ~0.0033 VRSCTEST at registration. **There is no faucet.** | Do not build a step that waits for external funding |
| **Registration takes 5-20 min** | Block confirmations | Budget it; don't read slowness as failure |
| **Unconfirmed inbox write** | `update-profile` / `sales-mode` during a pending identity tx can double-spend the same prevOutput | Check `pendingWrites` (`ctl` / `/health`) empty first |
| **`getChatMessages ?since=`** | Passing `Date.toISOString()` returns 0 rows silently (T-separator sorts before all rows) | Use the space-format the backend expects |
| **contentmultimap ordering** | Unsorted keys → bare `-25 bad-txns-failed-precheck`, retries forever invisibly | SDK ≥2.13.1 sorts; if a write "never lands", suspect this |
| **Frozen TUI ≠ dead daemon** | Looks hung, isn't | Drive out-of-band with a second CLI process |
| **`$?` after a pipe** | Reports the pipe's last command, not the CLI's — has produced false "exit 0" findings twice | Use `${PIPESTATUS[0]}` |
| **`refunds approve` needs `--yes`** when driven non-interactively | Otherwise blocks | Per runbook, with amount verified first |
| **Rework budget** | `setBudget` is an absolute ceiling against never-reset cumulative usage | Mid-job re-grants must offset current usage |
| **npm token expiry** | Recorded expiry was 2026-08-12 — **now past** | If Track A remediation publishes anything, `npm whoami` is the real diagnostic |

---

## 6. Track C — Stranger-UX audit: connect, jailbox, secure-setup

**Method:** identical to the 2026-08-25 dispatcher CLI/TUI audit — parallel
research agents reading full command/flow bodies (not grepping), hunting
missing auto-fill and non-intuitive UX; then fix → code-review → regression
tests, in that order. Proven this session: it found 11 real blockers, and the
review stage then caught 4 issues in the fix itself, one a regression the fix
had introduced.

- `j41-connect`, `j41-jailbox`: CLI + relay, smaller than dispatcher's 37
  commands. ~1 session each. **Carries the §1.2 caveat** — findings are
  source-level and functional, not isolation-proof.
- `j41-secure-setup`: an installer, not a daily driver. Different questions —
  "does it say what it will do with sudo before doing it" rather than
  "is there an auto-fill gap". Own pass, not a forced fit of the CLI method.

**Estimate:** 2-3 sessions.

---

## 7. Track D — Version-drift check

For connect, jailbox, secure-setup, docs:
- Does each declared/bundled SDK version match current (2.16.1)? mcp-server's
  last release note already cites an SDK a version behind — check whether any
  in-scope repo drifted the same way.
- Do README/CLAUDE.md examples still match current dispatcher/SDK behaviour,
  especially anything touched by compute/GPU-rental or the 08-25 fixes?
- Does `j41-docs` still describe deprecated flows? (Known: it calls the
  registration seeding a "faucet" in three places — `sovagent-quickstart.md`,
  `buyer-quickstart.md`, `sovagent-sdk/cli.md`. That is wrong and already
  caused a shipped dispatcher bug once.)

**Method:** mostly mechanical. Much cheaper than A-C; fold into whichever
Track C session has room.

---

## 8. Track E — Release & publish

**This track did not exist until the 2026-08-27 review, and its absence was
the single largest hole in the plan.** Everything above tests *this working
tree*. "Launch for testing" means strangers install from npm — and what npm
serves is not what we are testing.

**Verified state:**

| | Version |
|---|---|
| Local working tree | **2.34.0** (`main` @ `c97be4b`) |
| npm `@junction41/dispatcher` | **2.31.0** |

Three releases of drift. A stranger invited today gets **none** of the 11
CLI/TUI blocker fixes from 2026-08-25 — including the empty-on-chain-profile
bug (B1), free-by-default GPU rentals (B2), and the allowlist bypass (B3).
Testing 2.34.0 exhaustively and then inviting people onto 2.31.0 would make
the entire exercise decorative.

**`npm publish` is currently blocked** — `npm whoami` returns
`E401 Unauthorized`. The recorded token expiry was 2026-08-12; today is
2026-08-27, so it is expired exactly as predicted. **Renewing npm auth is a
prerequisite for launch, not a detail.** `npm whoami` is the real diagnostic —
a stale token in `~/.npmrc` looks fine until a publish fails.

**Track E steps:**
1. Renew npm auth; confirm with `npm whoami` (not by reading `.npmrc`).
2. Decide the version to ship and whether SDK (2.16.1) needs a matching
   publish — check whether 2.34.0 depends on unpublished SDK changes.
3. Publish dispatcher (+ SDK if needed).
4. **Smoke-test the published tarball from a clean directory with a scratch
   `HOME`** — `npm i` into an empty dir, run `--version`, run one real command.
   This is non-negotiable: the 2.29.1 `json-canonicalize` outage made *every
   fresh install* dead while four source-reading audits saw nothing, and one
   `npm i` into an empty dir found it in 30 seconds. **Publishing is not
   shipping.**
5. Re-run scenario F1 against the **published** artifact, not the working tree.

**Ordering consequence:** F1 ("clean install") is ambiguous as written. It
splits in two — **F1a** against a local `npm pack` tarball (early, to catch
packaging bugs before publishing) and **F1b** against the published artifact
(after Track E, as the final gate). Only F1b proves what a stranger actually
receives.

---

## 9. Sequencing

**Step 0 — unblockers (can run in parallel with Track A, and should start now
because two have external lead time):**
- Renew **npm auth** (Track E prerequisite; currently E401).
- Decide the **compute/GPU question** (§4.6 P-1) — it may need hardware or a
  Vast account.
- Connect **Chrome** (`/chrome`) — gates ~6 W-path scenarios.
- Write the **buyer-funding script** (§4.6 P-2) and the **backend-capability
  precheck** (P-6).

Then:
1. **Track A** — security audit refresh *(needs Workflow opt-in)*
2. **Track A** — triage + start CRITICAL/HIGH remediation
3. **Track B prep** — stand up Dispatcher B with the §2.1 recipe, build the
   `dispb` wrapper, register + fund its buyer identity, audit the buyer
   scripts, capture the `/health` baseline (§4.6 P-4), probe the LLM (P-5).
4. **Track B** — execute the matrix, P0 first
5. **Track B** — re-runs per the §4.7 defect loop
6. **Track E** — publish, then **F1b** against the published artifact
7. **Track C** — connect + jailbox
8. **Track C** — secure-setup, **Track D** folded in
9. **Exit-criteria review** (§11) → GO / NO-GO

Order per the owner: A and B gate whether it is safe to open the door at all;
C and D are quality work that matters once it is open. **Track E sits after B
deliberately** — publishing before the matrix passes would ship untested code
to the very strangers this exercise exists to protect. But its *prerequisite*
(npm auth) belongs in step 0, because discovering an expired token on publish
day costs a day.

---

## 10. Open decisions

**Before Track A:**
1. **Workflow opt-in** — needed for the fan-out; I will ask again rather than
   assume standing consent.
2. **Audit output location** — proposed `audit-2026-08-26/` at workspace root,
   matching June precedent.
3. **Dimension set** — reuse all 5 June dimensions, or trim now that
   mcp-server (which drove much of the DDoS/bridge findings) is out of scope?

**Before Track B:**
4. ~~The running fleet~~ — **CLOSED 2026-08-27**: owner confirmed it may be
   restarted freely. Reused as Dispatcher A per §2.4; first restart done as
   scenario L5 so the reactivation path is tested rather than merely survived.
5. **Dispatcher B's identity** — register a fresh buyer agent under the new
   `HOME`, or migrate an existing unregistered slot? A fresh registration is
   cleaner and self-funds, but costs 5-20 min.
6. **Chrome extension** — connect via `/chrome` so I can drive path 1
   directly, or does the owner click through junction41.io manually?
7. **Which listing kinds does the web frontend expose?** Determines whether
   C1-C3 (compute), H8 (model) and H9 (data) have web-path variants or are
   `BuyerSession`-only. Affects ~8 matrix rows.
8. **Scope call on the 67-scenario matrix** — all of it, or P0-only for
   launch with P1/P2 trailing? Drives whether Track B is ~4 sessions or ~8.

**Raised by the 2026-08-27 review:**
9. 🔴 **Compute/GPU (§4.6 P-1)** — no NVIDIA GPU on this box, so the C family
   (3 P0) cannot run. Vast (real USD), defer compute at launch, or add
   hardware? **Blocks 5 scenarios and an exit criterion.**
10. **Track E version** — ship 2.34.0 as-is, and does the SDK (2.16.1) need a
    matching publish? Check whether 2.34.0 depends on unpublished SDK changes.
11. **Track C/D rigour** — Track B has 67 numbered scenarios; C and D are
    prose. Do they get their own matrices before execution, or is
    lighter-touch acceptable given they gate less?
12. **Test-data policy** — the fleet already carries 13 agent dirs and
    historical jobs. Do test artefacts get cleaned up between rounds, or
    accumulate? Affects repeatability more than correctness, but a polluted
    fleet makes "is this a new failure?" much harder to answer.

---

## 11. Launch-ready exit criteria

**Added by the 2026-08-27 review — the plan previously described a great deal
of testing and never said what result meant "go."** Without this, "are we
ready?" gets answered by fatigue rather than evidence.

Launch for testing is **GO** when all of the following hold:

1. **Track A:** zero unremediated CRITICAL. Every HIGH is either fixed or has
   a written, owner-accepted risk note. (June's precedent: 6 CRITICALs → all
   fixed before shipping.)
2. **Track B:** every **P0** scenario PASSED, or is explicitly waived in
   writing with a reason. A P0 that "wasn't reached" is not a pass.
3. **Compute (C family):** either passed, or the C-family decision (§4.6 P-1)
   is recorded as "launching without compute listings" **and** compute
   listings are actually disabled/unlisted so a stranger cannot buy one.
4. **Track E:** published, and **F1b** (clean install of the *published*
   artifact, scratch `HOME`) passed. Not "published" alone.
5. **Money paths proven end-to-end at least once each:** payment received
   (H1/H2), refund sent (R4), extension paid (E1), deposit credited (P2).
   These are the four ways funds move; none may be inferred from unit tests.
6. **Access gating proven:** a non-allowlisted buyer is actually **held**
   under `invite` (S2), and `allowlist remove` actually removes (S3).
7. **Docs match reality** for the first-run path — no step a stranger would
   follow that no longer works (Track D's faucet wording is a known instance).
8. **Baseline is clean and explained** — `/health` diffed against the recorded
   pre-test baseline, with any residual `degraded` cause named (§4.6 P-4).
9. **The results doc lists every matrix ID with PASS / FAIL / WAIVED.** Silence
   on an ID is not a pass.

**Explicit non-criteria** — do not let these substitute:
- "All unit tests pass." 1515/1515 was true *before* the 08-25 audit found 11
  live blockers. Green suites have never caught this class.
- "The audit found nothing new." An audit that finds nothing is more likely
  mis-scoped than proof of correctness.
- "It worked when I tried it." Once, on a warm fleet, is not a scenario.

---

## 12. Self-review

- **Placeholders:** none. The two port unknowns flagged in the first draft
  were resolved before publishing rather than deferred — the egress-proxy one
  turned out to be a hard blocker (fatal exit) with a non-obvious cause, which
  is exactly the kind of thing that should not be discovered mid-run. The
  hazards table flags which entries still need re-verification.
- **Consistency:** ordering matches the owner's instruction; each track's
  method matches what it tests (fan-out for source work, sequential-live for
  E2E). §1.2's limitation and §6's caveat agree.
- **Verified vs. assumed:** §2 facts were all checked on this machine today —
  the `HOME` override empirically, ports/socket/PID by reading source, the
  running fleet and agent inventory from live process and filesystem state.
  §5 is explicitly marked as needing re-verification.
- **Scope:** deliberately multi-subsystem at roadmap level; each track becomes
  a single-subsystem implementation plan when reached.
- **Ambiguity:** "full plan" read as this roadmap plus a verified topology
  recipe, not bite-sized steps for all four tracks — those would be stale
  before Track C starts. Flagged in case that read is wrong.

### 12.1 Review log — 2026-08-27 hole-hunt

Owner asked: *"can we review this plan and ensure there are no holes in it."*
Reviewed adversarially against the live machine rather than by re-reading
prose. **Nine holes found; all closed in this revision except the three that
need owner decisions.**

| # | Hole | Severity | Resolution |
|---|---|---|---|
| 1 | **No release/publish track at all.** Plan tested the working tree (2.34.0) while npm serves 2.31.0 — strangers would get none of the 08-25 fixes | 🔴 structural | New **Track E** (§8) |
| 2 | **npm auth dead** (`E401`, token expired 2026-08-12) — publishing blocked | 🔴 blocker | Track E step 1; moved to sequencing **step 0** for lead time |
| 3 | **No NVIDIA GPU on this machine** — C family (5 scenarios, 3 P0) cannot run | 🔴 blocker | §4.6 P-1; **open decision #9** |
| 4 | **Dispatcher B cannot be funded** — `wallet send` takes fleet agent-ids only, B is a separate fleet, no faucet exists | 🔴 blocker | §4.6 P-2 + explicit warning against the tempting key-copy shortcut (double-spend) |
| 5 | **No launch-ready exit criteria** — plan tested endlessly with no definition of "go" | 🔴 structural | New §11, incl. explicit non-criteria |
| 6 | **No defect-handling loop for Track B** — A had remediation, B had nothing | 🟡 | New §4.7, incl. the never-edit-expected-results rule |
| 7 | **Health baseline already `degraded`** — "green" was an unusable pass criterion | 🟡 | §4.6 P-4; cause identified (stale agent-3 container error) |
| 8 | **Backend capability assumed** — data/model hire flows may not exist platform-side | 🟡 | §4.6 P-6 precheck as Track B step 0 |
| 9 | **LLM dependency unstated** — preflight refuses every job if the provider is down, looking identical to "no demand" | 🟡 | §4.6 P-5 + API-key rotation note |

**Still thin, acknowledged rather than fixed:** Tracks C and D remain prose
against Track B's 67 numbered scenarios (**open decision #11**), and there is
no test-data cleanup policy (**#12**). Both were judged lower-risk than the
nine above, but they are holes, not completeness.

**Method note:** every finding above came from checking the machine —
`nvidia-smi`, `docker info`, `npm whoami`, `npm view`, live `/health`, live
`wallet`. None came from re-reading the plan. That ratio is the point: the
first draft read as thorough and was missing a whole release track.
