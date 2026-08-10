# isolation — audit report

**Date:** 2026-08-10 · **Scope:** container/runtime isolation, network egress,
sandbox↔host channels, the mainnet escape-hatch gate, canary/prompt-injection
plumbing. Read-only pass; no code was changed and no tests were run.

**Counts:** crit 0 · high 2 · med 5 · low 5 · **total 12**

Claims checklist: `AUDIT/isolation-claims.md` (72 claims across 9 groups) —
50 VERIFIED · 18 DRIFT · 3 MISSING · 1 UNVERIFIED.

---

## Findings

| ID | Sev | Summary | Anchor |
|---|---|---|---|
| I1 | high | Platform-supplied download filename is unvalidated → arbitrary write inside the container, reaching the host signing channel and the IPC file | `src/job-agent.js:1250` |
| I2 | high | Job-file writes on respawn follow symlinks a previous container planted → arbitrary host-file overwrite with buyer-authored content | `src/cli.js:8256` |
| I3 | med | Wall 3 (bubblewrap) is never applied — `detectIsolation()` is async and un-awaited; and the config it would return is unusable | `src/cli.js:8123` |
| I4 | med | The startup security gate silently discards every `warn`, and a missing egress firewall is graded `warn` | `src/cli.js:3486` |
| I5 | med | Mainnet gate reads `process.env` only, so `allow_local_upstream` / `skip_status_check` set in `config.toml` bypass it | `src/mainnet-guard.js:29` |
| I6 | med | Pausing a job tears down the container but leaks its egress token and its host-side signing channel | `src/cli.js:5015` |
| I7 | med | No cap on buyer file uploads written into the host-bind-mounted job dir; documented `StorageOpt: 1G` doesn't cover it and is often silently dropped | `src/job-agent.js:1247` |
| I8 | low | Container→job-agent IPC file is unauthenticated and lives in container-writable tmpfs | `src/job-agent.js:790` |
| I9 | low | Canary stripping on the deliverable is literal while detection is evasion-resistant; the deliverable is never leak-checked | `src/job-agent.js:854` |
| I10 | low | Docker-mode workspace connect bypasses the on-chain `workspace.capability` gate | `src/job-agent.js:1287` |
| I11 | low | `secure-setup` is optional + ESM, loaded by a silent `require`/`catch`; below Node 20.19 the whole security layer vanishes without a word | `src/cli.js:106` |
| I12 | low | No guard against running the dispatcher as root — the job container inherits `User: 0:0` | `src/cli.js:8414` |

---

### I1 — high — Unvalidated download filename gives a platform response a write primitive inside the sandbox

**Where:** `src/job-agent.js:1250` (and the job-start copy at `src/job-agent.js:1060`).
Sink: `node_modules/@junction41/sovagent-sdk/dist/agent.js:692`.
Source: `node_modules/@junction41/sovagent-sdk/dist/client/index.js:1003-1006`.

**Path.** `downloadNewFiles()` calls `agent.downloadFileTo(job.id, f.id, filesDir)`
with `filesDir = /app/job/files`. The SDK derives the filename from the
`Content-Disposition` header of the platform's file-download response with
`disposition.match(/filename="([^"]+)"/)` — any character except `"` is accepted,
including `/` and `..` — then does `path.join(dir, result.filename)` and
`fs.writeFileSync`. `path.join` collapses the traversal; nothing on either side
checks that the result is still under `filesDir`.

`/app/job` and `/app/sign` are the only writable mounts (rootfs is read-only),
plus the `/tmp` tmpfs. So a filename of `../../sign/req/a1b2c3d4e5f6.json`,
`../../../tmp/ipc-msg.jsonl`, or `../deletion-attestation.json` all land.

**Concrete bad outcomes, each without any code execution in the container:**

1. **Forged signing request.** `/app/sign/req` is the host-side broker's watch
   directory (`src/sign-channel-host.js:97,134`). Its filename filter is
   `^[a-f0-9-]{8,80}\.json$` (`:49`) — trivially satisfied. `_handle`
   (`:281`) then accepts `method:"executeOnChain", params:{kind:"jobCompletionUpdate"}`,
   which builds and **broadcasts an identity-update transaction** with
   attacker-chosen job-record/review content (`src/broker-executors.js:236-252`,
   registered at `:264-266`), spending the agent's fee tank. `method:"signMessage"`
   also reaches a generic signing oracle, bounded only by
   `assertNotProtocolMessage` and a byte cap (`src/sign-broker.js:143-171`).
2. **IPC injection.** A line written to `/tmp/ipc-msg.jsonl` is consumed
   unauthenticated (`src/job-agent.js:791-808`). `{"type":"budget_increased",
   "data":{"additionalTokens":100000000}}` calls `_executor.increaseBudget()`
   (`:715-728`) → the token-budget ceiling the whole of WP-D4 exists to enforce
   is lifted, and the operator pays for the LLM calls.
   `{"type":"shutdown"}` or `{"type":"ttl_expired"}` (`:745-763`) force
   immediate delivery of partial work.
3. **Host-visible artefact tampering** — `/app/job` is the host's
   `~/.j41/dispatcher/jobs/<jobId>/`, so `deletion-attestation.json` and the
   other artefacts the host later reads can be planted.

**Trigger condition.** Any job where a file is attached (`downloadNewFiles` runs
on job start and on every `📎 Uploaded file:` chat notification,
`src/job-agent.js:1133-1136`) and the platform's download response carries an
attacker-chosen `Content-Disposition` filename.

**Hinge — UNVERIFIED (backend):** whether a *buyer* controls the stored
filename that the platform echoes back. If yes this is buyer-reachable and I
would rate it critical. If the backend sanitises, the reachable adversary is a
compromised or MITM'd platform — which the codebase already treats as in scope
(`src/cli.js:8246-8253` caps `job.description` for exactly that reason). Needs a
backend-side check.

**Proposed fix (not applied).** In `downloadNewFiles`, stop trusting the SDK's
returned path: pass a sanitised name and verify containment —
`const safe = path.basename(String(f.filename || 'download'))` and, after the
call, `if (!path.resolve(localPath).startsWith(path.resolve(filesDir) + path.sep))
{ fs.rmSync(localPath, {force:true}); throw … }`. The durable fix belongs in the
SDK: `path.basename()` the `Content-Disposition` filename in
`client/index.js:1004` before it ever reaches `path.join`. Independently, move
the IPC file off a container-writable path (see I8).

---

### I2 — high — Respawn writes follow symlinks planted by the previous container

**Where:** `src/cli.js:8256-8263` (`description.txt`, `buyer.txt`, `amount.txt`,
`currency.txt`, `canary.token`), reached a second time for the same `jobDir` via
`src/cli.js:5044` (`respawnReadyResumes` → `startJob` → `startJobContainer`).

**Path.** `jobDir` (`~/.j41/dispatcher/jobs/<jobId>`) is bind-mounted **rw** at
`/app/job` (`src/cli.js:8359`) and the container runs as the dispatcher's own
uid (`src/cli.js:8414`), so `fs.protected_symlinks` offers nothing. When a job
is paused, `moveJobToReactivationQueue` (`src/cli.js:4994-5024`) stops and
removes the container but **leaves `jobDir` in place** — only the completion
path deletes it (`src/cli.js:8678-8681`). On resume, `startJobContainer` runs
again against the surviving directory and calls `fs.mkdirSync(recursive)` then
`fs.writeFileSync(path.join(jobDir,'description.txt'), desc)` — a plain write
that **follows a symlink**.

So a container that plants `description.txt → /home/<op>/.ssh/authorized_keys`
(or `~/.j41/dispatcher/config.toml`, or `agents/agent-1/keys.json`) before it is
paused gets that host path overwritten, on resume, with `job.description` —
up to 1 MB of buyer-authored text. This is a container→host write that bypasses
all three walls, because the host performs the write.

**Trigger condition.** (a) arbitrary file creation inside the container — the
threat the three-wall design and the mandatory signing broker explicitly assume
(`src/cli.js:8278-8288`), and also reachable via I1; plus (b) a pause/resume,
dispute respawn (`src/cli.js:5073`), or rework cycle on the same job id.

**Asymmetry that makes this clearly a bug rather than a design choice:** the
*read* side already defends against exactly this — `readJobFileNoFollow`
(`src/cli.js:8209-8214`) opens with `O_NOFOLLOW` and is used at `:4582`,
`:4646`, `:4674`, `:4704`. The write side has no counterpart.

**Proposed fix (not applied).** Add the mirror helper and use it for all five
writes: `fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT |
fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600)`. Belt-and-braces:
`fs.unlinkSync` each of the five names before writing (unlink does not follow),
and `fs.lstatSync(jobDir)` to confirm the directory itself is a real directory.

---

### I3 — med — The bubblewrap wall is never applied

**Where:** `src/cli.js:8113-8155`.

`getDispatcherBwrapConfig()` is synchronous and does
`const isolation = secureSetup.detectIsolation();` at `src/cli.js:8123`.
`detectIsolation` is declared `export async function`
(`node_modules/@junction41/secure-setup/lib/detect-isolation.js:170`), so
`isolation` is a Promise, `isolation.mode` is `undefined`, and the
`=== 'bwrap'` test at `:8124` is never true. The function always returns `{}`.
`src/dashboard.js:917` awaits the same call correctly, which is what makes this
read as a slip rather than a decision.

**Consequence.** On any Linux host where gVisor is not Docker's default runtime
— the documented "VPS fallback" case — the container has Docker-level isolation
only, while `quickCheck` reports `mode: 'bwrap', score: 8` and the README
promises a third wall.

**Second-order:** simply adding `await` would not work. The returned
`Entrypoint` is a **host** path
(`require.resolve('@junction41/secure-setup')…/scripts/entrypoint-agent.sh`,
`src/cli.js:8125-8128`) that is never bind-mounted into the image — `Binds` is
only jobDir, `/app/sign` and `SOUL.md` (`:8357-8362`) — so the container would
fail to start. And the script itself does `--unshare-net`
(`secure-setup/scripts/entrypoint-agent.sh:12`), which would cut the egress path
the job-agent needs, and `--ro-bind /app /app`, which would make the rw signing
channel read-only.

**Trigger condition.** Every Docker-mode job on a non-gVisor Linux host.

**Proposed fix (not applied).** Either (a) drop the branch and change the README
to say Docker-only is the non-gVisor posture, or (b) make it real: `await` the
detection (make the helper async), bind-mount the entrypoint script into the
container, and change the script to keep the network namespace and bind `/app`
rw. Do not do (b) partially — the current shape fails closed only by accident.

---

### I4 — med — The startup security gate throws away every `warn`, including "no egress firewall"

**Where:** `src/cli.js:3475-3502`.

`quickCheck` returns per-check `pass|fail|warn|skip`. The dispatcher blocks on
`checkResult.passed`, which is `checks.every(c => c.status !== 'fail')`
(`secure-setup/lib/quick-check.js:331`), and prints only the `fail` entries
(`src/cli.js:3486`). On success it prints `Security: ${score}/10 (${mode})`.

Two checks that matter are graded `warn`, not `fail`:

- **`iptables-rules`** (`quick-check.js:282-292`) — absence of the
  `J41_AGENT_OUT` chain, i.e. **the entire documented Network Lockdown**, is a
  warning. Worse, the probe is `sudo iptables -L J41_AGENT_OUT -n`
  (`quick-check.js:44-50`), which also fails when the daemon has no
  passwordless sudo — so it is unreliable in both directions.
- **`apparmor-profile`** (`quick-check.js:117-127`).

And `score` is computed purely from runtime + seccomp
(`detect-isolation.js:132-154`) — network posture does not enter it.

**Consequence.** A dispatcher whose containers have completely unrestricted
outbound network (the `j41-isolated` bridge is deliberately *not* `--internal`,
`setup-network.js:230-238`) starts normally and tells the operator
`Security: 10/10 (gvisor)`. Note the containers do get `Dns:['0.0.0.0']`
(`src/cli.js:8375`), so exfiltration would be to literal IPs — a speed bump, not
a control.

**Trigger condition.** First-run `secureSetup.setup()` failed or timed out
(`src/cli.js:3455-3458` — 10 s race, non-fatal catch), which is the common case
because the iptables rules need `sudo` (`setup-network.js:54`).

**Proposed fix (not applied).** Print `warn` entries at startup rather than
discarding them, and in `src/cli.js` treat `iptables-rules !== 'pass'` as
blocking when `RUNTIME === 'docker'` on Linux (with an explicit
`--allow-unfirewalled` style opt-out for non-Linux/dev). Optionally verify the
chain directly from `cli.js` rather than through a `sudo` probe, e.g. by
checking that a canary container cannot reach a non-allowlisted host.

---

### I5 — med — The mainnet gate only inspects `process.env`

**Where:** `src/mainnet-guard.js:22-52`, called from `src/cli.js:3122-3136`.

`findMainnetSecurityViolations(process.env, …)` tests raw env strings. Two of
the flags it names are also first-class `config.toml` keys:

| Flag | TOML key | Default | Consumer |
|---|---|---|---|
| `J41_ALLOW_LOCAL_UPSTREAM` | `runtime.allow_local_upstream` (`config-loader.js:17`, override `:110`) | false | `cli.js:4142` → `egress-proxy.js:101`; `proxy-handler.js:187` |
| `J41_SKIP_STATUS_CHECK` | `runtime.skip_status_check` (`config-loader.js:16`, override `:109`) | false | `cli.js:3271` |

An operator who writes

```toml
[runtime]
allow_local_upstream = true
```

into `~/.j41/dispatcher/config.toml` gets the effect (the egress proxy stops
rejecting upstreams that resolve to private/link-local addresses — including
`169.254.169.254`, the cloud metadata endpoint the guard at
`egress-proxy.js:94-104` was written for) **and** a clean mainnet start.

**Trigger condition.** Mainnet (`platform.network = 'verus'`) plus a TOML-set
value. Requires operator misconfiguration, not attacker action — but the README
states the gate as an unconditional refusal, so an operator will reasonably
believe the gate covers it.

**Proposed fix (not applied).** Change the signature to
`findMainnetSecurityViolations(env, cfg, opts)` and test the **effective**
values (`cfg.runtime.allow_local_upstream === true`,
`cfg.runtime.skip_status_check === true`) alongside the env forms, naming the
source in the message so the operator knows which file to edit. `mainnet-guard`
stays pure — the caller already has `cfg` in scope at `src/cli.js:3122`.

---

### I6 — med — Pausing a job leaks its egress token and its host signing channel

**Where:** `src/cli.js:4994-5024` (`moveJobToReactivationQueue`), contrast
`src/cli.js:8644-8660` (`stopJobContainer`).

The completion path tears down three per-job resources: `_signerHost.destroy()`
(stops the `req/` watcher and removes the channel dir), `_signerTeardown()`
(closes the cached `J41Agent`), and `egressProxy.revoke(_egressToken)`. The
pause path does **none** of them — it enqueues, deletes the entry from
`state.active` (`:5011`), and stops/removes the container (`:5015-5017`).

**Consequences, all concrete:**

- The per-job egress credential stays registered in `EgressProxyHost._allow`
  (`src/egress-proxy.js:55,59`) for the dispatcher's lifetime, long after the
  container that held it is gone. Anything that reaches the gateway IP on
  `:9847` and knows that token can still use the tunnel to the job's allowlisted
  hosts. The map also grows without bound across pauses.
- `SignChannelHost` keeps watching `/tmp/j41-sign-<jobId>` with the agent WIF in
  its closure (`src/cli.js:8300-8331`) after the container is destroyed — a live
  signing oracle with no consumer. This compounds K3 from `AUDIT/keys.md`
  (predictable, reusable channel path).
- On respawn, `startJobContainer` derives the **same** deterministic channel dir
  (`src/cli.js:8291`) and starts a second `SignChannelHost` on it. Two watchers
  now race on the same `req/` directory, both able to answer.

**Trigger condition.** Any idle-timeout pause — the normal path after
`IDLE_TIMEOUT_MS` (default 8 min), via `job_idle` →
`moveJobToReactivationQueue`. Not adversarial; it happens on ordinary jobs.

**Proposed fix (not applied).** Factor the three teardown steps out of
`stopJobContainer` into a `releaseJobResources(state, info)` helper and call it
from `moveJobToReactivationQueue` after the container stop, before
`state.active.delete`. The respawn already re-creates all three.

---

### I7 — med — Buyer file uploads are uncapped and land in the host bind mount

**Where:** `src/job-agent.js:1237-1255`.

`downloadNewFiles()` iterates every new file and downloads it with no per-file
size check, no per-job total, and no file-count limit — `f.sizeBytes` is used
only to format a log line (`:1251`). The SDK buffers the whole body
(`sdk/dist/agent.js:693`, `Buffer.from(await response.arrayBuffer())`). The
destination `/app/job/files` is the host's `~/.j41/dispatcher/jobs/<jobId>/files`
via the rw bind at `src/cli.js:8359`.

**Two documented controls do not apply:**

- `StorageOpt: { size: '1G' }` bounds the container's *writable layer*, not bind
  mounts — and it is applied only when `supportsStorageOpt()` finds overlay2 +
  pquota (`src/cli.js:8379`, `:8170-8187`), and is dropped **silently** on every
  other host. The `/tmp` tmpfs is separately capped at 64 MB (`:8367`).
- The 1 MB `job.description` cap that exists precisely against this class of
  abuse (`src/cli.js:8246-8253`, "a compromised/MITM'd platform could otherwise
  ship a 100 GB description and exhaust the operator's disk") has no counterpart
  on the upload path.

**Trigger condition.** A buyer attaches large or numerous files to a job; each
`📎 Uploaded file:` chat notification re-triggers the download
(`src/job-agent.js:1133-1136`). Outcome: operator disk exhaustion (which takes
the whole fleet down, including the queue/ledger writes), or container OOM
against the 2 GB limit.

**Proposed fix (not applied).** Add `J41_JOB_FILE_MAX_BYTES` (per file) and
`J41_JOB_FILES_MAX_BYTES` (per job) mirroring
`J41_JOB_DESCRIPTION_MAX_BYTES`; skip-and-log files over the cap before
downloading, using the `f.sizeBytes` already in hand, and stop once the job
total is reached. Separately, log a warning when `StorageOpt` is dropped so
"max disk 1G" is not silently untrue.

---

### I8 — low — The container→job-agent IPC file is unauthenticated

**Where:** `src/job-agent.js:789-808`; producer `src/cli.js:4972-4988`.

The dispatcher delivers control messages by `docker exec … sh -c 'cat >>
/tmp/ipc-msg.jsonl'`. The job-agent polls that path every 2 s, parses each line,
and dispatches on `msg.type` with no authentication, no ordering check and no
provenance check. The file is in the container's own writable tmpfs, so **any**
in-container writer is indistinguishable from the dispatcher. Reachable
message types include `budget_increased` (lifts the token ceiling),
`shutdown` / `ttl_expired` (force delivery), `reconnect`, and `workspace_ready`.

This is the amplifier for I1 and for any in-container code execution. On its own
it is low, because it needs a writer inside the container.

**Proposed fix (not applied).** The clean fix is to stop using a
container-writable path: bind a host-owned FIFO or a second read-only directory
that only the host can write. A cheaper mitigation is an HMAC over each message
using a per-job secret — but note the secret would have to reach the container
via env, where in-container code can also read it, so this only raises the bar
against a partially-constrained writer (e.g. the I1 file-planting primitive,
which cannot read env).

---

### I9 — low — Canary stripping on the deliverable is literal; the deliverable is never leak-checked

**Where:** `src/job-agent.js:853-860`, contrast `:339-348` and `:1150-1157`.

Outbound *chat* runs through `checkCanaryLeak`, which uses the SDK's
evasion-resistant `checkForCanaryLeak` (zero-width stripping, NFKC, case-fold),
and blocks the message. The *deliverable* takes a different path: a literal
`result.content.split(CANARY_TOKEN).join('[redacted]')`, with no leak check at
all.

**Trigger condition.** A prompt-injected model that emits the canary with a
zero-width joiner or NFKC-equivalent characters inside it — exactly the evasion
the SDK helper exists to defeat. The literal `split` finds nothing, so the
canary is delivered to the buyer verbatim, the leak counter never increments,
and nothing is logged. The tripwire is silently absent on one of its two
documented surfaces.

**Proposed fix (not applied).** Run `checkCanaryLeak(result.content)` before
delivery; on a hit, redact via the same normalisation the SDK check uses (or
refuse to deliver and raise), then recompute `result.hash` — the existing
recompute at `:857` is already correct and must stay.

---

### I10 — low — Docker-mode workspace connect bypasses the on-chain capability gate

**Where:** `src/job-agent.js:1274-1302` and `:1394-1408`, contrast
`src/cli.js:5438-5454`.

`checkWorkspaceCapability` enforces the README's "agents without on-chain
`workspace.capability` are blocked" — but it only guards the host's
`workspace_ready` IPC. In Docker mode the container has its own poller that
calls `agent.client.getWorkspaceStatus(job.id)` every 15 s and, on
`active|pending`, calls `connectWorkspace` directly. `connectWorkspace`'s only
gate is `process.env.JAILBOX_ENABLED !== '1'` (`:1405`). The buildContainerEnv
comment at `src/cli.js:7985-7989` states this bypass explicitly, so it is known;
what is not stated is that the on-chain policy is therefore unenforced in the
production runtime.

**Trigger condition.** An operator sets `JAILBOX_ENABLED=1` /
`[jailbox] enabled = true`. Inert on defaults — jailbox is parked
(`src/config-loader.js:86`), which is why this is low rather than medium.

**Proposed fix (not applied).** Resolve the capability decision at container
launch and forward it as env (e.g. `J41_WORKSPACE_ALLOWED=1`, set only when
`checkWorkspaceCapability` passes), and have `connectWorkspace` require both
that and `JAILBOX_ENABLED`. Same dual-read pattern already used for
`JAILBOX_ENABLED` itself.

---

### I11 — low — The security layer is an optional ESM dependency loaded by a silent `require`

**Where:** `src/cli.js:106-111`; `package.json:46` (`optionalDependencies`) and
`engines: { node: ">=20.0.0" }`;
`node_modules/@junction41/secure-setup/package.json` (`"type": "module"`).

```js
let secureSetup;
try { secureSetup = require('@junction41/secure-setup'); } catch { /* silent */ }
```

Two independent ways this becomes `undefined`:

1. It is an **optional** dependency — `npm install --omit=optional`, a registry
   hiccup, or a global install where the optional resolve failed all leave it
   absent.
2. It is **ESM-only**. `require()` of an ESM package throws `ERR_REQUIRE_ESM` on
   every Node below 20.19 (and 21.x, and 22.0–22.11); `require(esm)` only became
   available in 20.19 / 22.12. `engines` permits `>=20.0.0`, so Node 20.18 —
   an LTS line many operators are still on — is a supported version on which
   this throws. Verified working on the Node in this environment (v20.20.1,
   above the boundary); the boundary itself is Node's documented behaviour.

When it is `undefined`: the first-run setup prints an install hint
(`src/cli.js:3465-3469`) only if the marker file is absent, the bwrap branch
returns `{}` (`:8120`), and — the important one — the entire quick-check gate at
`:3475-3502` is skipped **with no output at all**. The gate whose failure text
reads "SECURITY CHECK FAILED — dispatcher will not start" simply does not run.
Containers still get cap-drop / read-only rootfs / seccomp-from-disk, so this is
a partial, not total, loss; hence low.

**Proposed fix (not applied).** Log the caught error rather than swallowing it
(`catch (e) { console.warn('[security] secure-setup unavailable: ' + e.message) }`);
raise `engines.node` to `>=20.19.0`; and in Docker runtime treat a missing
`secureSetup` as fatal unless `--dev-unsafe`, matching how a failing quick-check
is treated.

---

### I12 — low — No guard against running the dispatcher as root

**Where:** `src/cli.js:8414`.

`User: \`${process.getuid()}:${process.getgid()}\`` is correct and deliberate —
it is what keeps bind-mounted files owned by the operator. But if the dispatcher
itself is started under `sudo` (plausible: the security-setup failure message at
`src/cli.js:3462` tells operators to re-run *something* with sudo), every job
container runs as uid 0. `CapDrop: ALL` + `no-new-privileges` + read-only rootfs
keep that mostly toothless, but root-in-container removes DAC checks on the
bind-mounted `jobDir` and `/app/sign`, and pairs badly with I2.

**Trigger condition.** `sudo j41-dispatcher start`.

**Proposed fix (not applied).** In the `start` action, refuse (or warn on every
30 s tick, as local mode does) when `process.getuid() === 0` and
`RUNTIME === 'docker'`; point at the fact that only `secure-setup` needs root,
and only once.

---

## Adversarial pass — shortest path from untrusted input to a bad outcome

Ranked by how little the attacker needs.

1. **Platform/buyer → filesystem write inside the sandbox → host-side signing
   broker.** One HTTP response header (`Content-Disposition: filename="…"`) on a
   file the job downloads. No code execution, no injection, no LLM cooperation.
   Lands in `/app/sign/req/`, which the host watches and acts on. This is **I1**
   and it is the shortest path in the domain.
2. **Same primitive → `/tmp/ipc-msg.jsonl` → unlimited token budget.** Same
   single step, different target; converts a header into operator-funded LLM
   spend (**I1** + **I8**).
3. **Compromised container → host file overwrite.** Plant a symlink at
   `/app/job/description.txt`, wait for the idle-timeout pause and the resume,
   and the host writes buyer-authored text over an arbitrary path as the
   operator user (**I2**). Two steps, but the second is a routine lifecycle
   event, not something the attacker must induce.
4. **Buyer → operator disk exhaustion.** Attach files. No cap anywhere
   (**I7**).
5. **Injected model → canary evasion in the deliverable.** The tripwire that is
   supposed to reveal (1)–(3) is defeated by zero-width padding on the delivery
   path (**I9**).

**Paths I looked for and did not find:**

- **Command injection into the Docker control plane.** Every Docker invocation
  uses `execFileSync` with an argv array (`src/cli.js:4980`, `:8340`) or the
  dockerode JSON API; env is passed as an array, never through a shell. Job ids
  are regex-validated before they reach a path or container name
  (`src/job-id.js:2`, enforced at `src/cli.js:8232`, `:8716`).
- **Docker socket exposure.** `Binds` contains exactly three entries; the socket
  is not among them.
- **Container→container.** ICC is disabled on `j41-isolated`
  (`secure-setup/lib/setup-network.js:235`), and each job's egress token
  authorises only its own host set.
- **DNS-rebind SSRF through the egress proxy.** Closed at
  `src/egress-proxy.js:91-104`: the resolved literal is re-checked against
  `isPrivateIp` and is the exact address handed to `net.connect`, so there is no
  TOCTOU window.
- **Chat transport escaping the proxy.** I expected socket.io to bypass undici's
  global dispatcher (it does) and therefore to break under `Dns:['0.0.0.0']` —
  but the SDK tunnels it explicitly through the same proxy
  (`sdk/dist/net/egress-agent.js:67-110`, wired at `sdk/dist/chat/client.js:102`).
  Clean.
- **A WIF reachable from the container.** Confirmed absent again from this
  angle: broker is mandatory and fails closed (`src/cli.js:8283-8288`).

---

## Checked and found clean

Traced to code, behaves as documented, no finding:

- `CapDrop: ALL`, `ReadonlyRootfs`, `PidsLimit: 64`, `OomScoreAdj: 1000`,
  `no-new-privileges`, `Memory: 2G`, `CpuQuota: 1 core`, tmpfs `/tmp`
  `noexec,nosuid,size=64m` — all present and unconditional (`src/cli.js:8356-8384`).
- The `CapDrop` restoration after the bwrap spread (`src/cli.js:8385-8389`) is
  correct: it re-drops everything except `SYS_ADMIN` rather than leaving
  `CapDrop: []`.
- Seccomp is passed as **content**, not a path, and is JSON-validated before
  being handed to the daemon (`src/cli.js:8067-8077`) — the failure mode
  documented in the comment is genuinely closed. System profile preferred over
  user profile.
- `getDispatcherNetworkMode()` refuses to auto-create `j41-isolated`
  (`src/cli.js:8099-8110`), with an accurate comment about why a
  dispatcher-created `--internal` network would silently break every job.
- Egress proxy: per-job random 32-byte token, `407` on missing/unknown token,
  `403` on a host outside the job's set, `502` on a private-resolving upstream,
  default-deny `allowLocalUpstream: false` (`src/egress-proxy.js:45-113`).
  Bind failure is fatal (`src/cli.js:4144-4149`).
- `deriveAllowedHosts` (`src/egress-proxy.js:22-43`) handles the WHATWG URL
  parser's bracketed and hex-normalised IPv6 loopback forms, not just `127.`.
- The allowlist is derived from the **merged** effective env, so per-agent
  `executorUrl`/`mcpUrl` overrides are included (`src/cli.js:8393-8403`).
- Egress token revoked on the completion and failure paths
  (`src/cli.js:8578`, `:8658-8660`).
- Container env: host paths (`J41_KEYS_FILE`, `J41_SOUL_FILE`, `J41_JOB_DIR`)
  are stripped before the env array is built (`src/cli.js:8418-8420`); provider
  keys come from `cfg.provider_keys`, never the dispatcher's own environment
  (`src/cli.js:7924-7938`).
- Local mode: explicit env whitelist with no `...process.env`
  (`src/cli.js:8749-8757`); blocked without `--dev-unsafe`; 30 s repeating
  warning.
- Mainnet gate is sticky — `J41_NETWORK` cannot downgrade a mainnet config file
  (`src/mainnet-guard.js:63-65`), and the guard is pure/never-throws as
  documented.
- Canary: mandatory, 32 random bytes per job, written `0600`, injected into the
  prompt, registered with SovGuard, evasion-resistant check on the chat path,
  hash recomputed after any strip (`src/cli.js:8262`, `src/job-agent.js:492-496`,
  `:543-580`, `:853-860`, `:1150-1157`).
- SovGuard `scanUntrusted` is wired in **all six** executors for job
  description, buyer field and inbound messages, plus tool results in the two
  tool-looping executors — broader than CLAUDE.md claims.
- `job.description` is length-capped before being written to disk on the Docker
  path (`src/cli.js:8246-8256`), and `sanitizeInput` strips control characters
  and truncates on the container side (`src/job-agent.js:351-356`, `:511-518`).
- Host reads of container-writable files use `O_NOFOLLOW`
  (`src/cli.js:8209-8214`) at every JSON/log read site.
- Job-id validation gates both container and local start paths.
- Health (`:9842`) and control API (`:9843`) both bind `127.0.0.1`; the webhook
  server (`0.0.0.0`) starts only in webhook mode, which is opt-in.
- `_lastSentStatus` is cleared on every (re)spawn so a fresh container is not
  starved of a status transition (`src/cli.js:8444`, `:8868`).
- Deployed seccomp/AppArmor profiles are world-readable `0644` in a `0711`
  directory (`secure-setup/lib/deploy-profiles.js:112-135`), so the non-root
  dispatcher can actually read them — the obvious "profile deployed but
  unreadable → silent Docker-default seccomp" trap is not present.

---

## Explicitly not covered

See the state-file entry for the full list and reasoning.
</content>
</invoke>
