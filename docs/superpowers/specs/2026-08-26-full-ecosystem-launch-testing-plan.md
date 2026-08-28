# Full-ecosystem launch-testing plan — design

**Date:** 2026-08-26, reworked 2026-08-27 for the two-dispatcher topology
**Status:** Draft, awaiting owner review
**Filed in:** dispatcher repo (hub for this work), but spans multiple repos — see Scope.
**Trigger:** owner, pre-launch: "how do we do a proper full testing experience
for everything dispatcher and junction41 have developed... need to get this
launched for testing" → reworked on the owner's instruction: "we are going to
use 2 dispatchers and the chrome plug from this computer for testing, j41 is
on another pc, plan needs to be robust af."

This is a roadmap. It decomposes into 6 tracks; each gets its own detailed
implementation plan immediately before that track runs, because plans written
now for track C/D would be stale by the time we reach them, sessions away.

**Tracks:** A security-audit refresh · B live E2E · C stranger-UX ·
D version-drift · E release/publish · **F GPU-hosting portability** (added
2026-08-28 when the owner set the bar at *"any human can download the
dispatcher and host their GPU"* — the current path cannot meet that, see §9).

---

## STATUS — 2026-08-27, post-publish

**Track E ran early and is essentially complete.** The owner chose to publish
before testing so the matrix runs against what strangers actually install —
which inverts §9's ordering but is defensible: the previously-published 2.31.0
carried the *known-broken* behaviour the 08-25 fixes closed, so shipping was
strictly safer than leaving it live.

Published + clean-install verified from the registry:

| package | was | now |
|---|---|---|
| `@junction41/sovagent-sdk` | 2.14.2 | **2.16.1** |
| `@junction41/dispatcher` | 2.31.0 | **2.34.1** |
| `@junction41/secure-setup` | 0.3.2 | **0.3.5** |
| `@junction41/jailbox` | 2.1.2 | **2.1.3** |

All five repos clean, 0 unpushed. Verified independently, not taken on trust.

**Four review findings closed since the plan was written:**
- ✅ **npm auth** renewed (expires ~2026-09-03 — rotate after; it was pasted in
  a transcript).
- ✅ **Supply-chain floating ref** — dispatcher now pins
  `"@junction41/sovagent-sdk": "2.16.1"` exact from the registry, replacing
  `github:…#main`. Our own lockfile had already drifted 6 commits behind main,
  so the risk was live, not theoretical. A clean npm install now reaches github
  **zero** times (the two Verus forks ship as `bundledDependencies`; the 6
  github refs remaining in our *dev* lockfile are those forks and are expected).
- ✅ **jailbox divergence reconciled** — rebased onto main, published 2.1.3;
  both checkouts now sit at `c9c33cd`. Notably, two of 2.1.3's three findings
  were **dropped as already-superseded**, and one (F3, "bwrap is not a counted
  wall") would have *regressed* main had it landed. **A stale security finding
  can become a security regression** — re-verify findings against the branch
  you are landing on, not the one they were written on.
- ✅ **`secure-setup --version`** implemented (0.3.5) — it previously printed
  nothing and fell through to the "no action" branch, which *with a product
  flag would have run a privileged setup the user never asked for*. That is a
  bigger deal than the missing flag it looked like.

**New standing release-checklist item, created by the pin:** the dispatcher no
longer picks up a new SDK on its own. **An SDK publish now requires a matching
dispatcher manifest bump + release.** That is the point of pinning, but it is a
step that will be forgotten exactly once.

**⚠️ The running fleet is stale.** PID 381346 is still on **2.34.0 /
`c97be4b`**, one release behind published, and still reports `degraded` (the
stale `agent-3` container-exited-1 error, §4.6 P-4). Restarting it onto current
code is the natural next action — and per §2.4 that restart should be performed
**as scenario L5**, so the deactivate/reactivate path gets tested rather than
merely survived.

**Still open — these gate Track B, unchanged:** GPU/compute (§4.6 P-1),
buyer funding (P-2), LLM probe (P-5), backend capability (P-6), Chrome (P-7).

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

**Revised 2026-08-28.** The owner confirmed **the host has an NVIDIA GPU** and
chose to **stand up a brand-new dispatcher and test from scratch**. That
resolves open decisions #16 and #17 and produces a materially better setup than
the original single-machine design.

| Role | Where | What it is |
|---|---|---|
| **Backend / platform** | Separate PC | junction41.io + API. Already remote. |
| **Dispatcher A — seller** | **Host (bare metal, has GPU)** | **Fresh install, registered from scratch.** The system under test: gets hired, delivers, gets paid, rents GPU. |
| **Dispatcher B — buyer** | **This VM** (existing fleet) | Provides the buyer *identity + wallet*. A `BuyerSession` script runs against its keys. Already registered and funded. |
| **Web frontend** | Host, Chrome | junction41.io in the browser, driven by the Claude-in-Chrome extension. |

### 1.0 Why this topology is strictly better

Three problems the plan had been carrying dissolve at once:

1. **The GPU blocker (§4.6 P-1) is gone.** The host has real hardware, so the
   C family (5 scenarios, 3 P0) becomes runnable on `home-gpu` — the path we
   actually ship — instead of Vast, deferral, or nothing.
2. **The same-machine isolation caveat (§1.2) is gone.** Buyer and seller are
   now genuinely different hosts, so Track C's jailbox findings can be
   isolation-relevant rather than source-level only.
3. **No WIF ever moves.** "From scratch" means the host seller **registers new
   identities**, so the key-movement hazard in §2.6 never arises. The VM keeps
   its existing funded identities and simply becomes the buyer — a role that
   does not need to be pristine, only funded and real.

It also makes **F1 a genuine test rather than a simulation**: the first-run
path gets walked on a machine that has never run this software, which is
exactly the condition under which the `json-canonicalize` outage and the
2026-08-14 audit corrections were found.

### 1.0.1 Consequences to plan for

- 🔴 **The VM fleet must be STOPPED before the host fleet is hired against**,
  or at minimum must never share identities with it. They will not share
  identities (fresh registration), so both *may* run — but the VM's 9 agents
  are still live marketplace listings that can be hired by strangers. Decide
  whether to `deactivate-all` them so test traffic is unambiguous (#18).
- 🟡 **A fresh seller starts with ~33 on-chain writes** (the 0.0033 VRSCTEST
  registration seed, §5) and **there is no faucet**. A 67-scenario matrix with
  reviews, attestations, job records and profile updates will exceed that.
  Refill comes from either earning-then-sweeping, or an SDK `sendCurrency`
  from a funded VM agent. **The funding script (§4.6 P-2) is therefore needed
  in both directions** — plan it as `fund-agent.js`, not `fund-buyer.js`.
- 🟡 **Docker images must be rebuilt on the host** (`build-image` → job-agent
  *and* gpu-jail). On a GPU host the jail image gate becomes live rather than
  skipped, so this is itself worth recording as scenario C5.
- 🟡 **The host needs the full environment**: Docker, gVisor (`runsc` — present
  in the guest, verify on host), the `j41-isolated` bridge, NVIDIA Container
  Toolkit, and **StorageOpt-capable storage** for `disk_gb` caps. Plain
  `overlay2` typically cannot cap disk, and `rental-setup` fails closed on it —
  so this may need attention even with a GPU present.
- 🟡 **Execution question (#19):** this session runs *inside the VM* and cannot
  reach the host. Driving the host needs either a Claude Code session opened
  **on the host** (simplest — the host becomes the primary session and this VM
  session becomes the buyer side), or SSH access from here.

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

### 1.2 ~~The limitation of same-machine testing~~ — RESOLVED by the host split

**Superseded 2026-08-28.** The original plan put both dispatchers on one box
and carried this caveat:

> Both dispatchers share one kernel, one Docker daemon, one filesystem, one
> network namespace… **not** sufficient to validate `j41-connect` /
> `j41-jailbox` isolation claims. Those exist to confine a buyer-side agent,
> and the June 2026-06-01 audit already found their marketed "Three-Wall
> Isolation" diverges from the code (Wall 1 silently falls back to plain
> Docker; audit logs record the agent's *claimed* path, not the real one). A
> same-machine test can pass while the actual guarantee is broken.

**With seller on the host and buyer on the VM, buyer and seller are genuinely
different machines** — different kernel, Docker daemon, filesystem and network
namespace. Track C's jailbox findings can therefore be isolation-relevant, and
the caveat in §6 is lifted.

**One honest residual:** the VM is a guest *of* the host, so they are not
independent in the way two physical machines are — a host-level compromise
sees both. That is irrelevant to every scenario here (which test confinement of
an agent, not host compromise), but it should not be described as full physical
separation in any published claim.

**Still deliberately out of scope:** proving the isolation *walls themselves*
(gVisor actually engaged vs. silently falling back, audit logs recording
realpaths). That is a security-audit question for Track A, not a functional
E2E one — the topology now permits it, but it is a different kind of test.

---

## 2. Running two dispatchers on one machine — verified isolation recipe

> **Note (2026-08-28):** the topology moved to host-seller / VM-buyer (§1), so
> A and B are no longer co-located and this recipe is not needed for that
> split. **It is retained deliberately** — it still applies to any second
> instance on either machine, and §2.1's egress-proxy finding (a fatal bind
> failure on the shared docker bridge) is the reason a second dispatcher can
> start at all. §2.4-2.6 remain live: the VM fleet's state, the test-artifact
> rule, and the VM/GPU analysis.

Everything in this section was verified empirically on the VM, not inferred
from docs.

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

### 2.5 Test-artifact isolation — nothing we build for testing enters a repo

**Owner constraint, 2026-08-27:** *"ensure anything we build is separate and
not going into the repos — this is purely for testing, our patches should not
be pushed."*

**Rule:** every executable artefact created to run these tests lives **outside
every repo**, in a dedicated testkit, and is never committed or pushed.

**Proposed location: `/home/mainn/j41-testkit/`** — a sibling of
`dispatchertest3/`, not inside it, so no repo's `git status` can ever see it.

```
/home/mainn/j41-testkit/
  bin/dispb                  # the HOME-scoped Dispatcher B wrapper (§2.3)
  bin/fund-buyer.js          # SDK sendCurrency → Dispatcher B (§4.6 P-2)
  bin/backend-precheck.js    # platform capability probe (§4.6 P-6)
  drivers/                   # BuyerSession scenario drivers
  homes/dispatcher-b/        # Dispatcher B's HOME
  homes/clean-install/       # throwaway HOME for F1a/F1b
  runs/<date>/               # per-run evidence: output, txids, health snapshots
```

**Also applies to:**
- **Temporary code patches.** If a scenario needs instrumentation (extra
  logging, a stubbed clock), it goes on a **local throwaway branch or a
  separate clone** — never on `main`, never pushed. Revert before the next
  scenario, and record in the results that instrumentation was present, since
  an instrumented run is not a clean-artifact run.
- **The loose `buyer-*.js` scripts** already at `dispatchertest3/` root. They
  are outside the repos (fine) but unmanaged. Fold them into
  `j41-testkit/drivers/` as part of Track B prep (§4.2).
- **Scratch HOMEs and installs**, which can be large — keep them out of the
  repo tree so a stray `git add -A` can never sweep them in.

**Guard:** before any commit during test execution, `git status` in the
affected repo should show **only** intended source changes. Anything under
`j41-testkit/` appearing in a repo's status means the rule has been broken.

**Open question — results docs (#15).** Prior rounds put results in
`j41-sovagent-dispatcher/docs/testing/` (many `2026-0X-XX-*-results.md`), and
this plan's Track B currently says to continue that. That is *documentation*,
not something "built", so it may be the intended exception — but it does put
test output in a repo. **Default taken:** raw evidence stays in
`j41-testkit/runs/`; a distilled results doc still goes to `docs/testing/`,
matching precedent. Say the word and both move out.

The same question applies to **this plan document**, which is already committed
to the dispatcher repo (`docs/superpowers/specs/`, matching a long-standing
convention for design docs). Kept in-repo on the same reasoning — flagging it
rather than assuming.

### 2.6 The VM question — and why it *is* the GPU blocker

**Verified 2026-08-27:** this machine is a **VirtualBox VM** —
`systemd-detect-virt` → `oracle`; DMI reports `innotek GmbH / VirtualBox`. The
only display device is a `VMware SVGA II Adapter`. Host CPU is an
**i7-12800HX** (a mobile workstation part, commonly paired with a discrete
NVIDIA GPU). Guest resources: 8 vCPU, 21 GB RAM, 80 GB free.

**This fully explains §4.6 P-1.** VirtualBox does not offer VFIO/PCI
passthrough for NVIDIA CUDA workloads. The missing GPU is not a misconfiguration
to fix inside the guest — **no amount of guest-side work will make the C family
runnable here.** The options collapse to:

| Option | Gets us | Cost / risk |
|---|---|---|
| **Move to the host** | Real GPU (if the host has one) → C1-C5 runnable on owned hardware | Migration work; must move or re-register identities |
| **Vast provider** | Compute path tested without local hardware | Real USD; needs a Vast key; tests the `vast` code path, **not** `home-gpu` |
| **Defer compute** | No work | Launch without compute listings — and they must actually be delisted, not merely untested (exit criterion §11.3) |

**✅ ANSWERED 2026-08-28: the host has an NVIDIA GPU**, and the owner chose to
**stand up a fresh dispatcher on it and test from scratch**. Decisions #16 and
#17 are closed; see §1 for the resulting topology. The "move to the host"
column below is the option taken — but as a **fresh registration, not a
migration**, so the key-movement hazard described further down never arises.
It is retained here because the hazard still applies to any *future* migration.

**If we migrate, this must be planned, not improvised:**
- **Identity/key movement is the risk.** `~/.j41/dispatcher/agents/*/keys.json`
  holds WIFs. Moving them is a secret-handling operation: copy over a trusted
  channel, verify, then **destroy the source copies** — and consider running
  `encrypt-keys` first so what moves is already encrypted at rest.
- **🔴 Never run both machines against the same identities.** Two dispatchers
  holding one identity is the same double-spend hazard as the two-HOME rule in
  §4.6 P-2, just across hosts. The VM's fleet must be **stopped and left
  stopped** before the host fleet starts.
- **Re-establish the environment:** Docker, the `j41-isolated` bridge, gVisor
  (`runsc` is present in the guest — verify on the host), the job-agent and
  gpu-jail images (`build-image`), config.toml, and provider keys.
- **The §2.1 isolation recipe still applies unchanged** on the host — two
  dispatchers there need the same `HOME` + three-port treatment.
- **Alternative that avoids key movement:** leave the VM fleet as Dispatcher A
  and stand up only the *new* pieces on the host. Requires host↔VM network
  reachability and reopens the "same machine?" question in §1.2 — but it would
  make §1.2's isolation caveat **go away**, since buyer and seller would then
  genuinely be different hosts.

**Recommendation:** decide the GPU question (#16) first, because it determines
whether migration buys anything. If the host has no NVIDIA GPU, migrating gains
little and Vast-or-defer is the real choice.

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

#### 4.5.1 ⚠️ Three families are FIRST-EVER-IN-PRODUCTION — probed live 2026-08-28

Queried the live platform directly. This is stronger than "we have not tested
it": **nobody has, including the backend.**

| Probe | Result |
|---|---|
| `/v1/services?limit=50` | 24 services, **serviceType `agent` × 24** |
| `/v1/services?serviceType=api-endpoint` | **0** |
| `/v1/services?serviceType=gpu-rental` | **0** |
| `/v1/stats` | 20 agents (18 active), all `agent` kind; indexer live at block 1209520 |
| `/v1/version` → `hosting.kinds` | all four kinds `open: true`, parent `agentplatform@` |

So the backend **accepts** all four listing kinds, but **no compute, data,
model, api-endpoint or gpu-rental listing has ever existed in production.**

**Consequences for how Track B is run:**
1. **~13 scenarios across the C, P, H8/H9 families — 8 of them P0 — will be the
   first real transactions of their type on the platform.** A failure there is
   at least as likely to be a **backend** defect as a dispatcher one.
2. **The §4.7 classify-before-fixing step becomes load-bearing.** Debugging a
   backend bug as if it were a dispatcher bug is the expensive failure mode
   here, and both sides are owned by the same person, which makes conflating
   them *easier*, not harder.
3. **Order within P0 accordingly.** Run the first-ever families **early**, not
   last, so backend fixes have runway before launch. The natural P0 order is:
   golden path (F1, H1/H2, H6) to prove the rig → then first-ever families
   (C, P, H8/H9) → then the rest.
4. Budget for backend round-trips in the schedule. These families may not make
   the launch cut, and it is better to learn that in week one.

**Useful confirmations from the same probe** — these backend features are
present, so the scenarios depending on them are viable: `agent.status-invite-v1`
(S family), `agent.platform-status-v1` (two status axes), `signing.canonical-v1`,
`proxy.forward-access` (P family), `reviews.api-session` (H6),
`tx.status-notfound-code` + `tx.confirmation-tiers-v1` (M4's strong path is
armed), `health.chain-sync-v1`, `hosting.kinds-v1`.

**Not advertised as a feature flag:** any dispute-resolver toggle. Prior notes
record it as a per-seller backend setting; confirm it is enabled for the test
seller before running R2-R4, or those will fail for configuration reasons
rather than code ones.

### 4.6 Hard preconditions — verified blockers, found in the 2026-08-27 review

Each was checked on this machine. These gate Track B; several have no
workaround and force a scope decision.

**🔴 P-1. There is no NVIDIA GPU on this machine — because it is a VM.**
`nvidia-smi` is absent; `docker info` lists runtimes `runsc runsc-nogso
io.containerd.runc.v2 runc` — **no `nvidia` runtime**; the only display device
is a `VMware SVGA II Adapter`. **Root cause identified 2026-08-27: this is a
VirtualBox guest** (§2.6), and VirtualBox has no NVIDIA passthrough. This is
**not fixable inside the guest.** `rental-setup` fails closed without NVIDIA +
StorageOpt-capable storage (storage here is `overlay2`, which per the README
typically cannot cap `disk_gb` either). **The entire C family — 5 scenarios,
3 of them P0 — cannot run on this box.** Options:
 - (a) **Move to the host** — see §2.6. Only viable if the host has an NVIDIA
   GPU (unknown, owner input needed).
 - (b) Use the **`vast`** provider type instead of `home-gpu` — sourced GPU,
   no local hardware. Costs **real USD**, needs a Vast API key, and exercises
   the `vast` code path rather than `home-gpu`. The platform-side
   `RENTAL_SECRETS_KEY` is a backend env, not ours.
 - (c) Defer the C family — and **actually delist compute listings**, not
   merely leave them untested (exit criterion §11.3).
 **Owner decision #9 / #16.** Note gVisor (`runsc`) *is* present, so V5/V6
 isolation scenarios are unaffected.

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

**🟢→🟡 P-6. Backend capability — PROBED 2026-08-28, mostly cleared.** Ran the
precheck live rather than deferring it (see §4.5.1 for full results):
- ✅ All four listing kinds are `open: true` server-side (`hosting.kinds-v1`),
  so F2/H8/H9 are not blocked by the platform refusing the kind.
- ✅ Feature flags confirm S-family (`agent.status-invite-v1`), two status axes,
  canonical-v1 signing, proxy forward-access, review sessions, and M4's strong
  `tx.status-notfound-code` path.
- ⚠️ **But zero compute / data / model / api-endpoint / gpu-rental listings have
  ever existed in production** — accepted-in-principle is not the same as
  exercised. Treat those families as first-ever (§4.5.1).
- ⏳ **Still unverified:** the per-seller dispute resolver (no feature flag;
  confirm it is enabled for the test seller before R2-R4) and whatever
  platform-side support the spend-policy work assumes.

A scenario failing because the backend does not implement it is a different
finding from a dispatcher bug, and conflating them wastes a cycle — doubly so
here, where the same person owns both sides.

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

## 6. Track C — Stranger-UX audit: jailbox, secure-setup

**Scope shrank on 2026-08-27.** `j41-connect/` and `j41-jailbox/` turned out to
be two checkouts of **one repo** publishing **one package** (`@junction41/
jailbox`); the divergence was reconciled and both now sit at `c9c33cd`. So this
track covers **two codebases, not three**. (Collapsing the duplicate checkout
is optional housekeeping — see open decision #13.)

**Method:** identical to the 2026-08-25 dispatcher CLI/TUI audit — parallel
research agents reading full command/flow bodies (not grepping), hunting
missing auto-fill and non-intuitive UX; then fix → code-review → regression
tests, in that order. Proven: it found 11 real blockers, and the review stage
then caught 4 issues in the fix itself, one a regression the fix had introduced.

- **jailbox** (`@junction41/jailbox` 2.1.3): CLI + relay + confinement, smaller
  than dispatcher's 37 commands. ~1 session. **The §1.2 caveat is lifted** —
  with buyer and seller on different machines, findings here can be
  isolation-relevant rather than source-level only. (Residual: the VM is a
  guest of the host, so this is not full physical separation — fine for
  confinement testing, not a claim to publish.)
  Worth extra attention post-reconciliation: the rebase dropped two findings
  and rewrote CLAUDE.md/README to post-merge truth, so docs-vs-code drift is
  freshly plausible here.
- **secure-setup** (0.3.5): an installer, not a daily driver. Different
  questions — "does it say what it will do with sudo before doing it" rather
  than "is there an auto-fill gap". Own pass, not a forced fit of the CLI
  method. **One finding already closed early:** `--version` printed nothing
  and fell through to the no-action branch, which with a product flag would
  have run a privileged setup unasked. That it surfaced during a routine smoke
  test suggests the rest of this surface is worth a real pass.

**Estimate:** ~2 sessions (was 2-3; one codebase fewer).

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
the single largest hole in the plan.** It has since been **executed** — the
narrative below is kept as the historical record of *why*, because the lesson
generalises to every future release.

**The problem as found (2026-08-27, now resolved):** everything else in this
plan tests *the working tree*. "Launch for testing" means strangers install
from npm — and what npm served was not what we were testing.

| | Version at review | Now |
|---|---|---|
| Local working tree | 2.34.0 (`c97be4b`) | 2.34.1 (`e627bf6`) |
| npm `@junction41/dispatcher` | **2.31.0** | **2.34.1** |

Three releases of drift. A stranger invited that morning would have got
**none** of the 11 CLI/TUI blocker fixes from 2026-08-25 — including the
empty-on-chain-profile bug (B1), free-by-default GPU rentals (B2), and the
allowlist bypass (B3). Testing 2.34.0 exhaustively and then inviting people
onto 2.31.0 would have made the entire exercise decorative.

`npm publish` was also **blocked** — `npm whoami` returned `E401
Unauthorized`, the token having expired 2026-08-12 exactly as the project's
own notes predicted. **`npm whoami` is the real diagnostic**; a stale token in
`~/.npmrc` looks fine until a publish fails. Auth has been renewed (expires
~2026-09-03 — rotate, it was pasted in a transcript).

**Track E steps — ✅ ALL DONE 2026-08-27** (see STATUS at top):
1. ✅ Renew npm auth; confirm with `npm whoami` (not by reading `.npmrc`).
2. ✅ Version decided; SDK published alongside, and the floating github ref
   replaced with an exact registry pin.
3. ✅ Published: SDK 2.16.1, dispatcher 2.34.1, secure-setup 0.3.5,
   jailbox 2.1.3.
4. ✅ **Smoke-tested from a clean directory with a scratch `HOME`** — versions
   resolve, SDK pulls in at 2.16.1, zero `codeload.github.com` in the tree,
   `--version` works on all three binaries. Non-negotiable and it earned its
   keep before: the 2.29.1 `json-canonicalize` outage made *every fresh
   install* dead while four source-reading audits saw nothing, and one `npm i`
   into an empty dir found it in 30 seconds. **Publishing is not shipping.**
5. ✅ B9 fix verified live on the published artifact (`init` → `start` names
   `register`, not `activate-all`).

**Standing item for every future release** (created by the SDK pin): an SDK
publish no longer propagates on its own — it requires a **matching dispatcher
manifest bump and release**. Add to the release checklist.

**Ordering consequence:** F1 ("clean install") splits in two — **F1a** against
a local `npm pack` tarball (to catch packaging bugs pre-publish) and **F1b**
against the published artifact. F1b was effectively executed as step 4 above,
but should be **re-run as a formal scenario** once Track B starts, because
step 4 exercised install + `--version` + one command, not the full
`init → register → finalize → start` walk F1 specifies.

---

## 9. Track F — "Any human can host their GPU" (portability)

**Added 2026-08-28 on the owner's goal statement:** *"I need this solution to
be robust enough for any human to download the dispatcher and host their GPU."*

That is a **product requirement, not a test concern**, and the current
`home-gpu` path cannot meet it. This track exists to close the gap. Migrating
to the GPU host makes these barriers testable; it does not remove any of them.

### 9.1 The barrier inventory (verified by reading the gates, 2026-08-28)

A human who downloads the dispatcher and wants to rent out their GPU must
clear **all** of the following. Two are structural.

| # | Barrier | Who it blocks | Severity vs. the goal |
|---|---|---|---|
| F-1 | **Disk cap needs overlay2 + XFS + project quota** (`home-gpu.js:216` sets `StorageOpt: {size}`) | **ext4 hosts — Ubuntu, Debian, Mint, Pop!_OS**, i.e. most Linux desktops | 🔴 **structural** |
| F-2 | **A public named TCP tunnel** with a real hostname (`ssh_hostname` may not be loopback/`0.0.0.0`/an HTTP URL) | anyone behind NAT without a domain or Cloudflare account | 🔴 **structural** |
| F-3 | `prjquota` spelling missed by the gate's `grep pquota` | correctly-configured XFS hosts | 🟡 cheap bug |
| F-4 | **btrfs / zfs rejected outright** (`if (driver !== 'overlay2') ok = false`) though both support Docker `StorageOpt` size caps | btrfs/zfs hosts that *can* cap disk | 🟡 cheap bug |
| F-5 | NVIDIA Container Toolkit required (`docker info` runtimes must match `/nvidia/i`) | AMD/Intel GPU owners | ⚪ accepted scope |
| F-6 | Hand-edited `[compute.providers.*]` TOML | — | ✅ largely solved: the TUI's `computeProviderScreen` writes it |

**F-1 and F-2 are the ones that decide whether the stated goal is met.** F-3
and F-4 are ten-line fixes that widen the audience and should just be done.

### 9.1.1 F-1 — the disk cap

Docker's `StorageOpt: {size}` works on `overlay2` **only** over XFS with
project quotas. On ext4 it is not merely unset — it is unsupported, so the
gate correctly refuses. Telling a GPU owner to reformat Docker's data-root as
XFS is a storage-admin task, not a download-and-run one.

Options, best first:

1. **Per-rental loopback volume (recommended).** Create a fixed-size file,
   `mkfs` it, mount it, bind-mount it as the jail's writable area. Caps disk on
   **any** host filesystem; no data-root migration, no storage-driver
   dependency, no Docker daemon restart. Cost: loop-device lifecycle and
   guaranteed cleanup on teardown/crash — which the rental path already has a
   home for (`shouldTeardownRental`, kind-aware stop).
2. **Automated XFS loopback for the data-root**, scripted into `secure-setup`.
   Works, but relocates *all* Docker storage and needs a daemon restart —
   invasive on a machine the user also uses for other things.
3. **Degrade with disclosure** — rent without a hard cap, monitor and kill on
   overage. **Not recommended:** a renter can fill a disk faster than a monitor
   reacts, and it silently weakens a guarantee the product sells.

### 9.1.2 F-2 — the tunnel

`README:842` is explicit: *"TCP tunnel stays your job. The dispatcher will not
run `cloudflared` for you."* For a home GPU behind NAT this is usually the
hardest step, and the product currently offers nothing — no guidance beyond a
README line, no detection, no setup help.

Note the asymmetry: the **api-endpoint** flow already auto-detects a
cloudflared tunnel (`README:801`), so the capability exists in the codebase for
the HTTP case but not the TCP/SSH case a GPU rental needs.

Options: guided setup in `rental-setup`/TUI (detect `cloudflared`, offer to
create a named TCP tunnel, verify reachability end-to-end before listing); or
at minimum a **reachability preflight** so failure surfaces at setup time
rather than after a buyer has paid.

### 9.1.3 Suggested sequencing for Track F

- **Now, cheap:** F-3 and F-4 — widen the storage gate to accept `prjquota` and
  the btrfs/zfs drivers, with tests that feed *real* mount/driver output rather
  than the current mocks (§9.2).
- **Design decision:** F-1 approach (loopback volume vs. data-root migration).
- **Then:** F-2 tunnel assistance, at least a preflight.
- **Docs, regardless:** the requirement is currently three words in a README
  table cell. Whatever the outcome, a GPU host needs a real setup page.

**Exit criterion this track adds:** a GPU owner on a **stock Ubuntu box with an
NVIDIA card** can go from `yarn global add` to a live, rentable listing without
reformatting a filesystem. Until that holds, "any human can host their GPU" is
not true, and the C-family scenarios only prove the path works on a
specially-prepared machine.

### 9.2 GPU host storage — the exact requirement, and a likely trap

Investigated 2026-08-28 because "a GPU is not sufficient" needed to be made
concrete before provisioning the host.

**What the gate actually demands** (`src/docker-host.js:15-36`,
`supportsStorageOpt`) — **both**, not either:
1. `docker info --format "{{.Driver}}"` is **exactly** `overlay2`, and
2. `mount | grep pquota` **succeeds**.

The error text says *"need overlay2 size or xfs pquota"*, which reads as
alternatives. It is not — the code requires both, and that is correct for real
Docker: `overlay2` supports `--storage-opt size=` **only** on XFS with project
quotas. Docker's own message (quoted in
`test/providers-home-gpu.test.js:243`) says as much:
*"--storage-opt is supported only for overlay over xfs with 'pquota' mount
option"*. **The wording is misleading; the behaviour is right.**

**So the host needs:**
- Docker data-root (`/var/lib/docker`, or a configured `data-root`) on an
  **XFS** filesystem
- formatted with **`ftype=1`** (default in modern `mkfs.xfs`; overlay2 refuses
  XFS without it)
- mounted with **project quota** enabled
- storage driver left as `overlay2`
- plus `nvidia` runtime and the `j41/gpu-jail` image (`build-image`)

Ubuntu hosts default to **ext4**, on which overlay2 cannot cap disk at all. If
the host root is ext4, the realistic route is a dedicated XFS volume (or an XFS
loopback file) mounted at the Docker data-root — not a driver change.

**⚠️ Likely trap — verify before trusting the gate.** `xfs(5)` lists three
spellings: **`pquota` / `prjquota` / `pqnoenforce`**. The gate greps for the
literal string `pquota`, and **`prjquota` does not contain `pquota` as a
substring** (verified: `echo prjquota | grep pquota` → no match). If the kernel
reports the mount as `prjquota` — which is the spelling most XFS/Docker guides
use, and which I believe XFS's `show_options` emits for enforcing project
quota — then a **correctly configured host is rejected** with
`HOME_GPU_NO_DISK_QUOTA`, telling the operator they lack a capability they
actually have.

**This cannot be caught by the current tests.** `test/docker-host.test.js:26`
stubs the mount check by matching on the *command string* and returns a
hand-written `'... type xfs (pquota)'`, so no test ever sees real
`/proc/mounts` output. Textbook [[feedback_untestable_paths]]: the one thing
that would fail is the one thing that is mocked.

**Settle it with one command on the host**, once XFS project quota is mounted:
```bash
mount | grep -E 'pquota|prjquota'
```
- prints `prjquota` → **the gate is broken for this host**; fix is a one-line
  regex change (`/p(rj)?quota/`) plus a test that feeds real mount output.
- prints `pquota` → gate works as written; no change needed.

Either way this is a **Track A/C finding**, not a blocker: fail-closed, so it
can only produce a false *refusal*, never an unsafe accept. But a false refusal
on a correctly built GPU host is exactly the "stranger cannot use it" class the
2026-08-25 audit existed to close.

---

## 10. Sequencing

**Step 0 — unblockers.** Three done; the rest are now mostly host setup:
- ✅ ~~Renew npm auth~~ — done 2026-08-27.
- ✅ ~~**Track E** publish~~ — done early (see STATUS).
- ✅ ~~**Compute/GPU question**~~ — closed 2026-08-28: host has a GPU, fresh
  dispatcher there (§1).
- 🔴 **Settle how the host is driven** (#19) — nothing starts until this is
  answered.
- ⏳ **Build the host** — see Step 0.5 below.
- ⏳ Connect **Chrome** on the host — gates ~6 W-path scenarios.
- ⏳ Write `fund-agent.js` (§4.6 P-2) — **needed in both directions** now, since
  a fresh seller has only its ~33-write registration seed.
- ⏳ Write the **backend-capability precheck** (P-6).
- ⏳ Decide the fate of the VM's 9 live listings (#18).

**Step 0.5 — build the host seller from scratch.** This is itself scenario
**F1b** (clean install of the published artifact) and should be *recorded as
such*, not treated as mere setup — it is the single most representative test of
what a stranger experiences.

1. Verify prerequisites **before** installing — see §9.2 for the storage
   requirement, which is the fiddly one: Docker, gVisor (`runsc`), NVIDIA
   Container Toolkit, `nvidia-smi`, and **XFS-with-project-quota** storage.
2. `yarn global add @junction41/dispatcher` (2.34.1 from the registry — **not**
   this working tree, and not a clone).
3. Walk `init` → `register` → `finalize` → `start` **capturing every prompt and
   message**. This exercises the 2026-08-25 B1 fix (profile persistence) on a
   machine that has never run the software.
4. `build-image` — job-agent **and** gpu-jail. On a GPU host the jail gate is
   live, so record this as **C5**.
5. Record the ~33-write starting fee-tank budget and watch it; top up via
   `fund-agent.js` before it blocks a scenario rather than after.
6. Capture the `/health` baseline on a genuinely clean fleet — unlike the VM's,
   this one should be `ok`, which finally makes "green" a usable criterion
   (§4.6 P-4).

Then:
1. **Track A** — security audit refresh *(needs Workflow opt-in)*
2. **Track A** — triage + start CRITICAL/HIGH remediation
3. **Track B prep** — on the **VM (buyer side)**: pick the buyer identity from
   the existing fleet, deactivate the rest (#18), fold the loose `buyer-*.js`
   into `j41-testkit/drivers/`, probe the LLM (P-5). On the **host (seller)**:
   Step 0.5 above. **Restart the VM fleet onto 2.34.1 as scenario L5**, not
   informally — it is still on 2.34.0/`c97be4b`.
   *(§2.1's two-dispatchers-one-box recipe is no longer needed for A-vs-B, but
   is retained: it still applies if a second instance is ever wanted on either
   machine, and its egress-proxy finding is the reason a second dispatcher can
   boot at all.)*
4. **Track B** — execute the matrix, P0 first
5. **Track B** — re-runs per the §4.7 defect loop
6. **Track F** — F-3/F-4 gate widening early (cheap, and they may unblock the
   host itself); F-1 design decision; F-2 tunnel assistance
7. **Track C** — jailbox
8. **Track C** — secure-setup, **Track D** folded in
9. **Re-publish** any fixes Tracks A-F produce (Track E's checklist again —
   note the SDK pin means an SDK bump now needs a dispatcher bump too)
10. **Exit-criteria review** (§12) → GO / NO-GO

**Track F can start immediately and does not need the host.** F-3 and F-4 are
source-level fixes with tests; the F-1 design decision is a design discussion.
Only *validating* them needs GPU hardware. Doing F-3/F-4 before migrating may
save a false `HOME_GPU_NO_DISK_QUOTA` on the new host.

Order per the owner: A and B gate whether it is safe to open the door at all;
C and D are quality work that matters once it is open.

**On Track E running first.** The plan originally placed it last, reasoning
that publishing before the matrix passes ships untested code to the very
strangers this exercise protects. The owner inverted it, and that was the
better call *in this specific case*: the already-published 2.31.0 carried
known-broken money and access behaviour, so leaving it live was strictly worse
than shipping tested-by-unit-tests-only 2.34.1. **The original reasoning still
holds for step 9** — fixes found by Tracks A-D and F should not be published until
they have been through the same gate everything else is.

## 11. Open decisions

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
10. ~~Track E version~~ — **CLOSED 2026-08-27.** Shipped SDK 2.16.1,
    dispatcher 2.34.1 (SDK pinned exact), secure-setup 0.3.5, jailbox 2.1.3;
    all clean-install verified. See STATUS at top.
11. **Track C/D rigour** — Track B has 67 numbered scenarios; C and D are
    prose. Do they get their own matrices before execution, or is
    lighter-touch acceptable given they gate less?
12. **Test-data policy** — the fleet already carries 13 agent dirs and
    historical jobs. Do test artefacts get cleaned up between rounds, or
    accumulate? Affects repeatability more than correctness, but a polluted
    fleet makes "is this a new failure?" much harder to answer.

**Raised by the post-publish cleanup:**
13. **Duplicate jailbox checkout** — `j41-connect/` and `j41-jailbox/` are two
    working copies of one repo, now identical at `c9c33cd`. Collapse to one,
    or keep both? Harmless today; it is exactly the shape that produced the
    divergence trap, so keeping it means the trap can recur.
14. **Restarting the stale fleet** — PID 381346 still runs 2.34.0/`c97be4b`.
    Restart it onto current code **as scenario L5** (recommended, tests the
    reactivation path), or restart it informally now and lose that coverage?

**Raised by the 2026-08-27 constraints (test isolation + VM question):**
15. **Do results docs stay in the repo?** Prior rounds put them in
    `docs/testing/`; the new "nothing test-related in the repos" rule may
    supersede that. Default taken: raw evidence in `j41-testkit/runs/`,
    distilled results still in `docs/testing/`. Same question applies to this
    plan document. See §2.5.
16. ~~Does the host have an NVIDIA GPU?~~ — **CLOSED 2026-08-28: yes.**
17. ~~Move identities or re-register?~~ — **CLOSED 2026-08-28: re-register.**
    Fresh dispatcher on the host, VM keeps its funded fleet as the buyer. No
    WIF movement; the §1.2 caveat dissolves as a bonus. See §1.

**Raised by the host-split decision:**
18. **What happens to the VM's 9 live listings during testing?** They are real
    marketplace agents a stranger could hire. `deactivate-all` them so test
    traffic is unambiguous, or leave them up? Recommendation: deactivate all
    except the one acting as buyer.
19. 🔴 **How is the host driven?** This session runs inside the VM and cannot
    reach the host. Either open a Claude Code session **on the host** (simplest
    — host becomes primary, this VM session becomes the buyer side), or set up
    SSH. **Nothing in Track B can start until this is settled.**
20. **Host storage: XFS with project quota required** — investigated in §9.2.
    A GPU is necessary but not sufficient; `overlay2` can only cap `disk_gb` on
    XFS with project quotas, so an ext4 host (Ubuntu default) needs a dedicated
    XFS volume or loopback for Docker's data-root. **Also carries a likely
    gate bug** (`pquota` vs `prjquota` grep) — settle with one command on the
    host: `mount | grep -E 'pquota|prjquota'`.

---

## 12. Launch-ready exit criteria

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
3a. **Track F, if GPU hosting is part of the launch claim:** a GPU owner on a
   **stock Ubuntu box with an NVIDIA card** reaches a live rentable listing
   without reformatting a filesystem (§9.1). If this does not hold, the honest
   position is that GPU hosting works *on a prepared machine* — say that
   plainly rather than implying "any human can host their GPU".
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

## 13. Self-review

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
