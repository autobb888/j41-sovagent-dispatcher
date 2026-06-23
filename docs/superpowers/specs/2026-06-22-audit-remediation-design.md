# Security Audit Remediation — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Components:** `@junction41/dispatcher` (`src/cli.js`, `src/control.js`, `src/job-log.js`, `src/token-budget.js`, `src/webhook-server.js`, `src/proxy-handler.js`, `src/sovguard-context.js`, `src/sign-attestation.js`, `src/executors/*`, `src/job-agent.js`) + `@junction41/sovagent-sdk` (minor)
**Source audit:** 6-dimension parallel audit, 2026-06-22 (dispatcher 2.3.0 + sdk 2.9.0)

## Problem

The security/runtime audit found one CRITICAL (introduced by the just-merged
log-persistence feature), a cluster of HIGHs in the job-teardown state machine
and payment paths, and many MEDIUM/LOW hardening gaps. `main` is unpushed and
unreleased, so we fix-forward before any push or npm release.

## Goals / non-goals

- Fix every audit finding that is fixable dispatcher-side, CRITICAL-first.
- Single branch `security/audit-remediation-0622`; one merge + push + npm
  release (**2.4.0**) at the end.
- Three findings need platform support (documented in
  `docs/backend-requests-2026-06-22.md`); ship the dispatcher-side mitigation and
  flag the residual dependency — do NOT claim a full fix.
- Non-goal: refactoring beyond what each fix needs; changing the broker
  mechanism, the HTTP control API surface, or executor framework support.

## Cross-cutting architecture decision: log storage relocation (C1)

**Today:** both run-paths write `output.log` *inside* `jobDir`
(`JOBS_DIR/<jobId>/`), which is bind-mounted into the container at `/app/job`
and writable by the container (it runs as the dispatcher UID). A malicious
container replaces `output.log` with a symlink; the host's append-write and the
teardown `copyFileSync` follow it → arbitrary host-file read (WIF/config) into
the archive, or host-file write via the live append.

**New layout:**
- **Active logs → `JOBS_DIR/_live/<jobId>.log`** — host-only directory, **never
  bind-mounted**, mode `0o700`. Both Docker and local paths write here. The
  container has no access, so it cannot plant a symlink on the log path.
- **Archived logs → `JOBS_DIR/_logs/<jobId>.log`** — unchanged location/policy.
  Teardown copies `_live/<id>.log → _logs/<id>.log` (when retention says keep),
  then deletes `_live/<id>.log`.
- **`jobDir` no longer contains `output.log`** — only the container workspace
  (`description.txt`, `buyer.txt`, attestation artifacts).
- **Defense-in-depth (kept even though `_live` is host-only):**
  - open the write stream with `O_NOFOLLOW` (`fs.constants.O_WRONLY | O_CREAT |
    O_APPEND | O_NOFOLLOW`); on failure the stream errors out (already swallowed).
  - in `archiveJobLog`, open the source with `O_RDONLY | O_NOFOLLOW` and copy via
    the fd (not `copyFileSync` by path); skip + warn on `ELOOP`/symlink.
  - the `logs` reader, `ctl history` (`control.js`), and the `buyer.txt` reader
    (`logs` listing) `lstat`-guard their target and refuse symlinks (closes M7,
    the `buyer.txt`→host-file print).
  - startup sweep: remove stale `_live/*.log` left by a crash (their jobs are no
    longer active).
- **`logs` command:** lists `_live/*.log` (active) + `_logs/*.log` (archived);
  prefix-resolves to `_live` first, then `_logs`. `job-log.js` stays pure.

This is W1 and lands first.

## Work-groups

Each group is a coherent unit touching related code; sequenced CRITICAL→LOW.
Groups that touch the same functions are a single task to avoid edit conflicts.

### W1 — Log relocation + symlink guards (CRITICAL) — C1, M7
As above. Files: `src/cli.js` (write paths in `startJobContainer`/`startJobLocal`,
`archiveJobLog`, the `logs` command, `ensureDirs`/startup sweep), `src/control.js`
(`ctl history` reader), `src/job-log.js` (helper for `_live`/`_logs` path
resolution if useful — keep pure). Tests: pure path-resolution + a symlink-guard
unit (lstat refusal); smoke: a symlinked `_live` entry is not followed by archive.

### W2 — Teardown / lifecycle robustness (HIGH) — H2, H3, H4, M2, M6
One task (all in `startJobContainer`/`stopJobContainer`/`startJobLocal`/
`stopJobLocal`/the monitor):
- **H3 re-entrancy:** set `active._stopping = true` as the first mutation in both
  stop functions; `return` if already set.
- **H2 start-failure cleanup:** in `startJobContainer`'s outer `catch` (and a
  `finally` where appropriate), tear down `signerHost.destroy()`,
  `signerTeardown()`, and `rm` the `tmpKeysDir`; same for `saveSeenJobs` throw.
- **H4 rmSync guard:** wrap `fs.rmSync(jobDir, …)` in try/catch in both stop
  functions (log + continue).
- **M2 exitCode stamp:** in the monitor, set `active._exitCode = info.State.ExitCode`
  (Docker) before calling `stopJobContainer`, so crash logs classify correctly
  for archival (don't rely on the async `container.wait().then`).
- **M6 persist:** add `persistActiveJobs(state.active)` after `state.active.delete`
  in `stopJobContainer` (mirror `stopJobLocal`).
Tests: extract a pure `isTerminalTeardown`/guard predicate where feasible; else
`node --check` + smoke (double-teardown does not double-push the agent).

### W3 — Payment state-machine (HIGH) — H1, M8, M3
- **H1:** in the retry-after-nonzero-exit path (`cli.js` ~6153/6186), after the
  `getJob` re-fetch, `if (TERMINAL_STATUSES.includes(job.status)) { stop…;
  continue; }` (reuse the existing constant).
- **M8:** gate the `!job.payment` implicit-trust clause behind an explicit
  opt-in flag (default off) and/or `job.status === 'accepted'`; log when it fires.
- **M3:** in `token-budget.js`, on the no-rate fallback, cap by payment — only
  grant the full fallback above a configured minimum `amountVrsc`; scale down or
  refuse below it.
Tests: `token-budget` unit for the fallback cap; pure predicate for the terminal
check; `node --check` for the cli.js wiring.

### W4 — Refund durability (HIGH/MEDIUM) — M4 + crash-recovery double-refund
- Persist a durable `pending-refunds.json`; on send failure append + retry on
  startup/background (mirror the deposit poller); only clear an orphan once its
  refund tx confirms. Clear/marker BEFORE sending to avoid double-refund on a
  recovery crash; process per-job, writing back the remainder on partial failure.
Tests: extract the terminal-status/pending-refund selection as pure functions +
unit tests (this also finally covers `handleCrashRecovery`'s predicate).

### W5 — Container hardening (HIGH/MEDIUM) — H5, M1, M10, jobDir 0o700, job.id
- **H5 seccomp:** check BOTH `/etc/j41/seccomp-agent.json` and
  `~/.j41/seccomp-agent.json`; warn loudly (counts toward the security check) if
  neither exists.
- **M1 CapDrop:** compute the final `CapDrop` keeping only `SYS_ADMIN` for bwrap
  mode instead of `CapDrop: []` (drop the rest explicitly).
- **M10:** create the `j41-isolated` network if absent (or warn) instead of
  silently falling back to `bridge`; warn on missing AppArmor profile.
- **jobDir 0o700:** the container runs as the dispatcher UID, so `0o700` works
  (no need for `0o755`); switch it.
- **job.id validation:** validate `job.id` against `^[a-zA-Z0-9_-]{8,64}$` before
  building `jobDir`/`containerName`; refuse malformed (path-traversal guard).
Tests: pure `isValidJobId` unit; `node --check` + the security-check output for
the warn paths.

### W6 — Input-trust (MEDIUM) — scan job.buyer, buyer-chat default, M9, scanner-warn, 4 executors
- Scan `job.buyer` through `scanUntrusted(..., 'job_description')` before it
  enters the system prompt (`local-llm.js`, `mcp.js`).
- Flip buyer-chat scanning to **default-on, opt-out** (`J41_SCAN_BUYER_CHAT !==
  '0'`), in `local-llm.js`/`mcp.js`.
- **M9:** scan `dispute.reason` before it enters the rework context, and strip
  the canary from rework delivery content (mirror the main path).
- Add a startup warn when the SovGuard scanner module is unavailable
  (`sovguard-context.js`).
- Add `scanUntrusted` on `job.description` + `handleMessage` input to the four
  currently-unscanned executors (`webhook`, `a2a`, `langgraph`, `langserve`).
Tests: scanner-wrapper behaviour is SDK-tested; here `node --check` + targeted
asserts where pure; confirm no muzzling of `source: 'user'`.

### W7 — Webhook / network (MEDIUM/LOW) — M5 + network LOWs
- **M5:** dedupe `/webhook/:agentId` events via the nonce cache **once the
  platform supplies an event id** (request #3a); until then, document the window.
  Implement the dispatcher-side nonce check guarded on the presence of the id.
- **IPv6 loopback:** extend `isPrivateIp()` to catch `0:0:0:0:0:0:0:1`, `0::1`,
  and hex-dotted `::ffff:7f00:1` forms.
- **DNS-pin:** pass a `lookup` to `http.request` that pins the pre-validated IP
  (collapse the rebind TOCTOU).
- **revoke enumeration:** return a uniform `403` for unknown-seller and
  bad-signature on the revoke route.
- **discovery rate-limit:** per-IP token bucket on `/j41/discovery/request-access`.
- **/health:** drop the exact `version` field.
Tests: `isPrivateIp` unit (the new IPv6 cases); `node --check` for server wiring.

### W8 — Misc cleanup (LOW) — leaks + small hardening
- `_lastExtensionCheck`: key by `jobId` (or prune at teardown) so it's bounded.
- `sign-attestation.js`: broker-mode aware (route through the channel) or assert
  `!exists(keys.json)` in broker mode.
- streaming proxy: emit `X-J41-Credit-Remaining` on the SSE path too.
Tests: `node --check`; pure where applicable.

## Platform-dependent (mitigate + flag, do not claim fixed)
Deposit on-chain-amount clamp, `jobCompletionUpdate` value reconstruction, and
generic-sign replay freshness — see `docs/backend-requests-2026-06-22.md`. Ship
the dispatcher-side guard that's possible; flag the residual dependency in code
comments and the readiness memory.

## Error handling
Every new fs/teardown path stays best-effort/try-caught and must never block job
cleanup, delivery, or agent-return (the same discipline the audit confirmed for
the log feature). Fail-closed on security decisions (job.id validation, budget
fallback, symlink refusal); fail-open only where explicitly safe (scanner-absent
passes text through but now WARNS).

## Testing strategy
- Pure logic → `node --test` units: `_live`/`_logs` path resolution, symlink-guard
  predicate, `isValidJobId`, token-budget fallback cap, refund/terminal-status
  predicate, `isPrivateIp` IPv6 cases.
- `cli.js`/server plumbing → `node --check` + targeted smoke: symlinked `_live`
  not followed; delivered-then-crashed job not re-run; double-teardown doesn't
  double-pool the agent; `logs` lists `_live`+`_logs`.
- Full suite green at each task; final whole-branch review before merge.

## Success criteria
- C1 closed: container cannot influence any host-read/written log path; verified
  by a symlink smoke test.
- All HIGHs fixed; MEDIUM/LOW fixed except the three flagged platform-dependent
  items (mitigated + documented).
- Full suite green; new units cover every extracted pure function; whole-branch
  review passes; no change to the HTTP control API surface.
- One release: dispatcher **2.4.0** (+ SDK patch if W8 touches it), merged +
  pushed + published, after the audit findings are closed.
