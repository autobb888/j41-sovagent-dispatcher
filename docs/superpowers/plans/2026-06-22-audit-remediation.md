# Security Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every dispatcher-side finding from the 2026-06-22 security/runtime audit, CRITICAL-first, on one branch for a single 2.4.0 release.

**Architecture:** Relocate job logs out of the container-shared `jobDir` to a host-only `_live/` dir (closes the CRITICAL symlink vector at the root) + `O_NOFOLLOW`/`lstat` defense-in-depth; then harden the teardown state machine, payment paths, refund durability, container config, input-trust scanning, and webhook/network surfaces. Pure logic is unit-tested; `cli.js`/server plumbing is `node --check` + smoke.

**Tech Stack:** Node.js CJS (no build step), `node:test`/`node:assert/strict`, dockerode, `@iarna/toml`.

**Spec:** `docs/superpowers/specs/2026-06-22-audit-remediation-design.md`
**Backend deps (mitigate + flag, don't claim fixed):** `docs/backend-requests-2026-06-22.md`

---

## File Structure

- `src/job-log.js` — extend (pure): add `liveLogPath`/`archiveLogPath` resolvers, keep retention/cap pure.
- `src/cli.js` — most edits (log paths, teardown, payment retry, container config, refund, job.id validation).
- `src/control.js` — `ctl history` reader lstat-guard + `_live` lookup.
- `src/token-budget.js` — fallback budget cap by payment.
- `src/webhook-server.js` — webhook nonce, revoke enumeration, discovery rate-limit, /health version.
- `src/proxy-handler.js` — IPv6 loopback, DNS-pin, streaming credit header.
- `src/sovguard-context.js` — scanner-absent warn.
- `src/executors/{local-llm,mcp,webhook,a2a,langgraph,langserve}.js` — scan coverage + buyer-chat default.
- `src/job-agent.js` — rework scan + canary strip.
- `src/sign-attestation.js` — broker-aware.
- New test files: `test/security-helpers.test.js` (job.id, ipv6, budget cap, refund/terminal predicates, log-path resolvers).

**Convention for `cli.js`/server edits:** these files are large with heavy import side effects, so they are NOT unit-tested — verify with `node --check` + the smoke checks named in each task, matching the project's established pattern. Each implementer must read the current code at the cited anchor and apply the change via exact-string match; if an anchor doesn't match, report NEEDS_CONTEXT rather than guessing.

---

## Task W1: Log relocation + symlink guards (CRITICAL — C1, M7)

**Files:** `src/cli.js` (`startJobContainer`, `startJobLocal`, `archiveJobLog`, `logs` command, `ensureDirs`), `src/control.js` (history reader), `src/job-log.js`, `test/security-helpers.test.js`.

**Goal:** Active logs live in host-only `JOBS_DIR/_live/<jobId>.log` (never bind-mounted); archives in `JOBS_DIR/_logs/<jobId>.log`; `jobDir` holds no logs; all log opens use `O_NOFOLLOW`; all readers of container-influenced files (`buyer.txt`, logs) `lstat`-refuse symlinks.

- [ ] **Step 1: Failing tests for the pure path resolvers** — in `test/security-helpers.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { liveLogPath, archiveLogPath } = require('../src/job-log.js');

test('liveLogPath builds JOBS_DIR/_live/<id>.log', () => {
  assert.equal(liveLogPath('/j/jobs', 'abc'), '/j/jobs/_live/abc.log');
});
test('archiveLogPath builds JOBS_DIR/_logs/<id>.log', () => {
  assert.equal(archiveLogPath('/j/jobs', 'abc'), '/j/jobs/_logs/abc.log');
});
```

- [ ] **Step 2: Run → fail** (`liveLogPath` undefined). `node --test test/security-helpers.test.js`.

- [ ] **Step 3: Add resolvers to `src/job-log.js`** (pure, alongside existing exports):

```js
const path = require('path');
function liveLogPath(jobsDir, jobId) { return path.join(jobsDir, '_live', `${jobId}.log`); }
function archiveLogPath(jobsDir, jobId) { return path.join(jobsDir, '_logs', `${jobId}.log`); }
// add to module.exports: liveLogPath, archiveLogPath
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Rewire the write paths in `cli.js`.** In BOTH `startJobContainer`'s log-stream block and `startJobLocal`: write to `liveLogPath(JOBS_DIR, job.id)` instead of `path.join(jobDir, 'output.log')`; `mkdirSync(path.join(JOBS_DIR,'_live'), {recursive:true, mode:0o700})` first; open the stream with `fs.createWriteStream(p, { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, mode: 0o600 })`. Keep the existing `fileStream.on('error', ()=>{})` (a pre-planted symlink makes the open ELOOP → error → swallowed, no write). Store `active._logPath = p` for teardown.

- [ ] **Step 6: Rewire `archiveJobLog`** to read from `_live` and write to `_logs`, NOFOLLOW, then delete the `_live` file:

```js
function archiveJobLog(jobsDir, jobId, exitInfo) {
  try {
    const live = liveLogPath(jobsDir, jobId);
    let fd;
    try { fd = fs.openSync(live, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (e) { if (e.code === 'ELOOP') console.error(`[Logs] refusing symlinked log for ${jobId}`); return; }
    try {
      const retention = resolveLogRetention(cfg);
      if (shouldArchiveLog(retention, exitInfo)) {
        const archiveDir = path.join(jobsDir, '_logs');
        fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
        const data = fs.readFileSync(fd);
        fs.writeFileSync(archiveLogPath(jobsDir, jobId), data, { mode: 0o600 });
        const entries = fs.readdirSync(archiveDir).filter(f => f.endsWith('.log'))
          .map(f => ({ id: f.slice(0,-4), mtimeMs: fs.statSync(path.join(archiveDir,f)).mtimeMs }));
        for (const id of selectLogsToPrune(entries, cfg.runtime.job_log_max_retained))
          fs.rmSync(path.join(archiveDir, `${id}.log`), { force: true });
      }
    } finally { fs.closeSync(fd); }
    fs.rmSync(live, { force: true });
  } catch (e) { console.error(`[Logs] archive failed for ${jobId}: ${e.message}`); }
}
```
Update both teardown call sites to `archiveJobLog(JOBS_DIR, jobId, {...})` (drop the old `jobDir` arg). Remove the now-dead `output.log` path from `jobDir`.

- [ ] **Step 7: Rewire the `logs` command** to enumerate `_live/*.log` (active) + `_logs/*.log` (archived) and resolve a prefix to `_live` first then `_logs` (no more `JOBS_DIR/<id>/output.log`). `lstat`-guard each read: `if (fs.lstatSync(p).isSymbolicLink()) continue;`. The `buyer.txt` read in the lister must `lstat`-guard too: `const bs = fs.existsSync(bf) && !fs.lstatSync(bf).isSymbolicLink(); const buyer = bs ? fs.readFileSync(bf,'utf-8').trim() : '?';`.

- [ ] **Step 8: `control.js` history reader** — same `_live`/`_logs` lookup + `lstat`-guard before `readFileSync`.

- [ ] **Step 9: Startup sweep** — in `ensureDirs` (or dispatcher start), `mkdirSync(_live,{recursive,mode:0o700})` and remove stale `_live/*.log` whose job isn't active (best-effort).

- [ ] **Step 10: Verify** — `node --check src/cli.js src/control.js src/job-log.js`; `node --test test/*.test.js` (205 + new); smoke: create `_live/x.log` as a symlink to a secret file, call the archive path indirectly via a unit/manual harness, confirm it is NOT followed (ELOOP refused).

- [ ] **Step 11: Commit** — `git commit -m "fix(security): relocate job logs out of container mount + NOFOLLOW/lstat guards (C1,M7)"`.

---

## Task W2: Teardown / lifecycle robustness (HIGH — H2, H3, H4, M2, M6)

**Files:** `src/cli.js` (`startJobContainer`, `stopJobContainer`, `startJobLocal`, `stopJobLocal`, the monitor `cleanupCompletedJobs`).

One task — all edits overlap the same functions.

- [ ] **Step 1: H3 re-entrancy guard** — as the FIRST statement after the `if (!active) return;` in BOTH `stopJobContainer` and `stopJobLocal`: `if (active._stopping) return; active._stopping = true;`.

- [ ] **Step 2: H4 rmSync guard** — wrap each `fs.rmSync(jobDir, { recursive: true })` in `try { … } catch (e) { console.error(\`[Cleanup] rm ${jobId}: ${e.message}\`); }`.

- [ ] **Step 3: M6 persist** — in `stopJobContainer`, after `state.active.delete(jobId)`, add `persistActiveJobs(state.active);` (mirror `stopJobLocal`).

- [ ] **Step 4: H2 start-failure cleanup** — in `startJobContainer`'s outer `catch (e)` (the one that re-pools the agent), before/after the push add: if `signerHost` set → `await signerHost.destroy().catch(()=>{})`; if `signerTeardown` set → `await signerTeardown().catch(()=>{})`; if `tmpKeysPath` set → `fs.rmSync(path.join(os.tmpdir(), \`j41-keys-${job.id}\`), { recursive:true, force:true })`. Also wrap the `saveSeenJobs(state.seen)` call (~`:5663`) in try/catch so a throw there doesn't skip the agent-removal/`state.active` bookkeeping.

- [ ] **Step 5: M2 exitCode stamp** — in the monitor's Docker branch, after `const exitCode = info.State.ExitCode;`, set `if (active) active._exitCode = info.State.ExitCode;` BEFORE any `stopJobContainer` call, so archival classifies crash logs correctly without relying on the async `container.wait().then`.

- [ ] **Step 6: Verify** — `node --check src/cli.js`; `node --test test/*.test.js` (unchanged count). Smoke reasoning: a second teardown call returns immediately (guard); a start failure leaves no `/tmp/j41-keys-*` and no live signer.

- [ ] **Step 7: Commit** — `git commit -m "fix(runtime): teardown re-entrancy guard, start-failure cleanup, rmSync guard, exit-code stamp, persist (H2,H3,H4,M2,M6)"`.

---

## Task W3: Payment state-machine (HIGH — H1, M8, M3)

**Files:** `src/cli.js` (retry path ~6153/6186, `!job.payment` ~4540), `src/token-budget.js`, `test/security-helpers.test.js`.

- [ ] **Step 1: H1** — in BOTH retry branches, after `job = await agent.client.getJob(jobId)`, add: `if (TERMINAL_STATUSES.includes(job.status)) { console.log(\`✅ Job ${jobId} already ${job.status} — not retrying\`); await stopJob…(state, jobId); continue; }` (reuse the existing `TERMINAL_STATUSES` constant; use `stopJobLocal`/`stopJobContainer` per branch).

- [ ] **Step 2: M8** — change the `isPaid` computation so the implicit-trust `!job.payment` clause requires an explicit opt-in env flag (default off) — `const allowNoPayment = process.env.J41_ALLOW_UNPRICED_JOBS === '1'; const isPaid = (job.payment && <existing paid checks>) || (allowNoPayment && !job.payment);` — and `console.warn` loudly when the no-payment branch admits a job.

- [ ] **Step 3: Failing test for budget fallback cap** — in `test/security-helpers.test.js`:

```js
const { initialTokenBudget } = require('../src/token-budget.js');
test('fallback budget is capped for tiny payments on rate outage', () => {
  // no rate available → fallback path; a near-zero payment must not get the full 50k
  const tiny = initialTokenBudget({ amountVrsc: 0.0001, rate: null });
  const big  = initialTokenBudget({ amountVrsc: 100, rate: null });
  assert.ok(tiny < big, 'tiny payment must receive fewer fallback tokens than a large one');
});
```
(Adjust the call signature to the real `initialTokenBudget` API after reading `token-budget.js`; the assertion — tiny < big on the no-rate path — is the contract.)

- [ ] **Step 4: M3 implement** — in `token-budget.js`, on the no-rate fallback branch, scale the fallback by `amountVrsc` against a configured floor (`cfg.proxy` or a constant `FALLBACK_MIN_VRSC = 0.01`): grant full `DEFAULT_FALLBACK_TOKEN_BUDGET` only at/above the floor; below it, scale proportionally (still ≥ `MIN_TOKEN_BUDGET`). Never unlimited.

- [ ] **Step 5: Verify** — `node --test test/security-helpers.test.js` (pass) + full suite; `node --check src/cli.js src/token-budget.js`.

- [ ] **Step 6: Commit** — `git commit -m "fix(payment): terminal-status check on retry, gate unpriced jobs, cap fallback budget (H1,M8,M3)"`.

---

## Task W4: Refund durability (HIGH/MEDIUM — M4 + crash-recovery double-refund)

**Files:** `src/cli.js` (`handleCrashRecovery` ~4255-4366), new pure predicate, `test/security-helpers.test.js`.

- [ ] **Step 1: Failing test for the refund-selection predicate** — extract the "should this orphan be refunded" decision as a pure function `shouldRefundOrphan(job, finishedStatuses)` and test: delivered/completed/cancelled/resolved → false; in_progress/accepted → true.

```js
const { shouldRefundOrphan } = require('../src/refund.js');
test('shouldRefundOrphan skips terminal states', () => {
  for (const s of ['delivered','completed','cancelled','resolved','resolved_rejected'])
    assert.equal(shouldRefundOrphan({ status: s }, undefined), false);
  assert.equal(shouldRefundOrphan({ status: 'in_progress' }, undefined), true);
});
```

- [ ] **Step 2: Create `src/refund.js`** (pure): `shouldRefundOrphan(job, finishedStatuses = ['completed','resolved','resolved_rejected','cancelled','delivered'])` → `!finishedStatuses.includes(job.status)`. Export it; have `handleCrashRecovery` use it.

- [ ] **Step 3: Durable pending-refunds** — persist `~/.j41/dispatcher/pending-refunds.json`. In `handleCrashRecovery`: write the recovery set to the file BEFORE sending any refund; process each orphan, on success remove it from the file, on send-failure leave it for retry; do NOT wipe the whole ledger unconditionally (replace `persistActiveJobs(new Map())` with writing back the unprocessed remainder). Add a startup retry that drains `pending-refunds.json`.

- [ ] **Step 4: Verify** — `node --test` (new predicate) + full suite; `node --check src/cli.js src/refund.js`.

- [ ] **Step 5: Commit** — `git commit -m "fix(refund): durable pending-refunds + crash-safe recovery, tested predicate (M4)"`.

---

## Task W5: Container hardening (HIGH/MEDIUM — H5, M1, M10, jobDir 0o700, job.id)

**Files:** `src/cli.js` (seccomp ~5308, CapDrop ~5615/5624, network ~5331, jobDir chmod ~5443, `startJobContainer` top), `test/security-helpers.test.js`.

- [ ] **Step 1: Failing test for `isValidJobId`** — in `test/security-helpers.test.js`:

```js
const { isValidJobId } = require('../src/job-id.js');
test('isValidJobId accepts hex/uuid-ish, rejects traversal', () => {
  assert.equal(isValidJobId('abc123_DEF-456'), true);
  assert.equal(isValidJobId('../../tmp/evil'), false);
  assert.equal(isValidJobId(''), false);
  assert.equal(isValidJobId('a'.repeat(65)), false);
  assert.equal(isValidJobId('x'), false); // too short (<8)
});
```

- [ ] **Step 2: Create `src/job-id.js`** (pure): `isValidJobId(id){ return typeof id==='string' && /^[A-Za-z0-9_-]{8,64}$/.test(id); }`. In `startJobContainer`/`startJobLocal`, at the top, `if (!isValidJobId(job.id)) { console.error(\`Refusing job with invalid id\`); return; }` before building `jobDir`/`containerName`.

- [ ] **Step 3: H5 seccomp both paths** — change the seccomp resolution to check `/etc/j41/seccomp-agent.json` AND `~/.j41/seccomp-agent.json` (first that exists wins). If neither exists, `console.warn('[security] seccomp profile not found — container runs without syscall filtering')` (counts toward the security check).

- [ ] **Step 4: M1 CapDrop** — ensure bwrap mode keeps `SYS_ADMIN` only: after the spread, force `opts.HostConfig.CapDrop` to the explicit drop-list `['CHOWN','DAC_OVERRIDE','FOWNER','FSETID','KILL','MKNOD','NET_BIND_SERVICE','NET_RAW','SETGID','SETUID','SETFCAP','SETPCAP','SYS_CHROOT','AUDIT_WRITE']` when `CapAdd` includes `SYS_ADMIN` (instead of `CapDrop: []`).

- [ ] **Step 5: M10 network + apparmor** — if `getDispatcherNetworkMode()` would fall back to `bridge` because `j41-isolated` is absent, attempt to create it (best-effort `docker network create --internal j41-isolated`) or `console.warn` that egress is unrestricted; warn if the AppArmor profile is missing.

- [ ] **Step 6: jobDir 0o700** — change `chmodSync(jobDir, 0o755)` to `0o700` (container runs as dispatcher UID, so bind-mount access is unaffected). Update the comment.

- [ ] **Step 7: Verify** — `node --test` (isValidJobId) + full suite; `node --check src/cli.js src/job-id.js`.

- [ ] **Step 8: Commit** — `git commit -m "fix(container): seccomp both-paths warn, scoped CapDrop, isolated-net, jobDir 0700, job-id validation (H5,M1,M10)"`.

---

## Task W6: Input-trust scanning (MEDIUM)

**Files:** `src/executors/{local-llm,mcp,webhook,a2a,langgraph,langserve}.js`, `src/job-agent.js` (rework ~1383/1411), `src/sovguard-context.js`.

- [ ] **Step 1: Scan `job.buyer`** — in `local-llm.js` and `mcp.js`, before interpolating `Buyer: ${job.buyer}` into the system prompt, run it through `scanUntrusted(job.buyer, 'job_description')`.

- [ ] **Step 2: Buyer-chat default-on** — change the chat-scan guard from `J41_SCAN_BUYER_CHAT === '1'` to `J41_SCAN_BUYER_CHAT !== '0'` in `local-llm.js` and `mcp.js`. Update the comment to reflect default-on/opt-out.

- [ ] **Step 3: M9 rework** — in `job-agent.js`, scan `dispute.reason` via `scanUntrusted(dispute.reason, 'other_agent')` before assigning `reworkContext`; and strip the canary from `reworkResult.content` before the rework `deliverJob` (mirror the main path's `split(CANARY_TOKEN).join('[redacted]')`).

- [ ] **Step 4: Scanner-absent warn** — in `sovguard-context.js`, when the scanner module resolves to null at import, `console.warn('[sovguard] scanner unavailable — inputs will pass through unscanned')` once at startup.

- [ ] **Step 5: Four executors** — in `webhook.js`, `a2a.js`, `langgraph.js`, `langserve.js`, import `scanUntrusted` and apply it to `job.description` in `init()` and to the `message` param in `handleMessage()`.

- [ ] **Step 6: Verify** — `node --check` all six executors + `job-agent.js` + `sovguard-context.js`; full suite. Confirm `source:'user'` is never passed for untrusted text (no muzzling).

- [ ] **Step 7: Commit** — `git commit -m "fix(input-trust): scan job.buyer + rework reason, default-on buyer-chat scan, canary-strip rework, scanner-absent warn, cover 4 executors"`.

---

## Task W7: Webhook / network hardening (MEDIUM/LOW)

**Files:** `src/webhook-server.js`, `src/proxy-handler.js`, `test/security-helpers.test.js`.

- [ ] **Step 1: Failing test for IPv6 loopback** — `test/security-helpers.test.js`:

```js
const { isPrivateIp } = require('../src/proxy-handler.js'); // export it if not already
for (const ip of ['::1','0:0:0:0:0:0:0:1','0::1','::ffff:7f00:1','127.0.0.1','169.254.169.254','10.0.0.1'])
  test(`isPrivateIp blocks ${ip}`, () => assert.equal(isPrivateIp(ip), true));
test('isPrivateIp allows a public IP', () => assert.equal(isPrivateIp('1.1.1.1'), false));
```
(If `isPrivateIp` isn't exported, add it to `module.exports`.)

- [ ] **Step 2: Extend `isPrivateIp`** to catch `0:0:0:0:0:0:0:1`, `0::1`, and hex-dotted `::ffff:7f00:1`-style loopback (normalize/parse rather than literal compare). Make the test pass.

- [ ] **Step 3: DNS-pin** — pass a `lookup` option to the upstream `http.request` that returns the already-validated IP, eliminating the rebind TOCTOU.

- [ ] **Step 4: M5 webhook nonce** — on `/webhook/:agentId`, if the request carries an event id (header `x-j41-event-id` or body `nonce`), check + record it in the existing nonce cache and reject replays; if absent, proceed as today (the platform-side id is request #3a). Comment the residual window.

- [ ] **Step 5: revoke enumeration** — return a uniform `403` for both unknown-seller and bad-signature on the revoke route (no 404 oracle).

- [ ] **Step 6: discovery rate-limit** — add a per-IP token bucket on `/j41/discovery/request-access` before the handler.

- [ ] **Step 7: /health version** — drop the `version` field from the public `/health` response (keep `agents`/`proxy`).

- [ ] **Step 8: Verify** — `node --test` (isPrivateIp) + full suite; `node --check src/webhook-server.js src/proxy-handler.js`.

- [ ] **Step 9: Commit** — `git commit -m "fix(network): IPv6 loopback SSRF, DNS-pin, webhook nonce, revoke enum, discovery rate-limit, hide version (M5 + lows)"`.

---

## Task W8: Misc cleanup (LOW)

**Files:** `src/cli.js` (`_lastExtensionCheck`), `src/sign-attestation.js`, `src/proxy-handler.js` (streaming header).

- [ ] **Step 1: `_lastExtensionCheck` bound** — key it by `jobId` (a per-job flag) instead of `ext.id`, OR prune all of a job's entries at teardown; confirm it no longer grows unbounded.

- [ ] **Step 2: `sign-attestation.js` broker-aware** — if `process.env.J41_SIGNING_BROKER !== '0'`, assert `!fs.existsSync(KEYS_FILE)` and route signing through the sign-channel client (mirror `job-agent.js`), instead of unconditionally reading `/app/keys.json`.

- [ ] **Step 3: streaming credit header** — emit `X-J41-Credit-Remaining` on the SSE/streaming proxy path too (parity with non-streaming).

- [ ] **Step 4: Verify** — `node --check src/cli.js src/sign-attestation.js src/proxy-handler.js`; full suite.

- [ ] **Step 5: Commit** — `git commit -m "chore(security): bound _lastExtensionCheck, broker-aware sign-attestation, streaming credit header"`.

---

## Task W9: Release prep

- [ ] **Step 1:** Bump `package.json` version `2.3.0 → 2.4.0`.
- [ ] **Step 2:** Update `project_dispatcher_readiness_0621` memory: audit done, findings closed, platform deps outstanding.
- [ ] **Step 3:** Full suite + `node --check src/*.js src/executors/*.js` green.
- [ ] **Step 4: Final whole-branch review** (dispatch reviewer over `main..HEAD`), then `superpowers:finishing-a-development-branch` (merge to main) → push → `npm publish` 2.4.0.

---

## Notes for implementers
- `cfg`, `fs`, `path`, `os`, `state`, `JOBS_DIR`, `TERMINAL_STATUSES`, `persistActiveJobs`, `scanUntrusted` are already in scope in their respective files — confirm before use.
- Do NOT touch the HTTP control API surface (`control-api.js`).
- Every teardown/log/refund path stays best-effort: a thrown error must never block job cleanup, delivery, or agent-return.
- For the three platform-dependent items, ship the guard and leave a `// BACKEND-DEP:` comment referencing `docs/backend-requests-2026-06-22.md`.
