# Audit state

Running log of soft-launch audit passes. One entry per domain per pass.
Later passes should read this first and skip anything already marked done.

---

## money — 2026-08-10 — DONE

Artifacts: `AUDIT/money.md` (findings + clean list), `AUDIT/money-claims.md`
(claims checklist, 70 claims across 6 groups).

**Counts by severity:** crit 0 · high 1 · med 4 · low 5 · total 10

| Sev | Finding |
|---|---|
| high | M1 — proxy streaming settle bills the full worst-case reservation on an upstream HTTP error |
| med | M2 — proxy non-streaming settle falls back to the flat estimate when `usage` is absent |
| med | M3 — documented financial rate limits + outage suspension are dead code (no callers) |
| med | M4 — sub-2-VRSC deposits credited at 0 confirmations, never reconciled |
| med | M5 — seller-agreed refund silently dropped when `refund_percent` is absent/out of range |
| low | M6 — `respond-dispute --refund-percent` not range-checked |
| low | M7 — operator-set `vrsc_usd_rate` re-stamped per container, so `rate_max_age_ms` never fires |
| low | M8 — daemon fee-sweep and CLI wallet pending stamps are mutually invisible |
| low | M9 — `wallet sweep` skips the per-agent spend lock that `wallet send` takes |
| low | M10 — `--fee-sweep-floor 0` silently discarded by the `\|\|` precedence chain |

**Claims checklist outcome:** 62 VERIFIED · 6 DRIFT (A5, B18, B19, C14, D3, E10)
· 2 MISSING (C4, C5) · 0 UNVERIFIED remaining in scope. Two of the VERIFIED
entries are qualified in place: C13 (verified, but reachable hole → M5) and E6
(verified as written, but the tier itself is the risk → M4).

**Files read in full:** `src/wallet.js`, `src/fee-tank.js`, `src/token-budget.js`,
`src/refund.js`, `src/refund-target.js`, `src/dispute-sweep.js`,
`src/deposit-watcher.js`, `src/deposit-credit.js`, `src/credit-meter.js`,
`src/bounty-award.js`, `src/sign-broker.js`, `src/webhook-server.js`;
`src/proxy-handler.js` (metering paths), `src/control.js` (read models),
`src/control-api.js` (auth), `src/cli.js` (allowlist/rate-limit block 140-330,
refund machinery 5500-6600, fee tank 7700-7830, container env 7985-8016,
respond-dispute 9110-9210, wallet CLI 9790-10800), `src/mainnet-guard.js`,
`src/config-loader.js` (money-relevant defaults + `ENV_OVERRIDES`).

### Deliberately NOT covered, and why

- **Inbox / on-chain identity-write machinery** (`inbox-deadletter.js`,
  `inbox-job-record.js`, `processInboxForAgent`, the batched-write contention
  logic). Money-adjacent — a dry fee tank surfaces there, and `TX_REJECTED`
  classification decides whether a write retries forever — but the write path
  itself moves no value. Belongs to an on-chain/inbox domain pass.
- **Key custody and at-rest encryption** (`keystore.js`, `keys-file.js`,
  `keys-migrate.js`, `sign-channel-*.js`, the passphrase paths). The WIF is the
  ultimate money control, but this is the security/keys domain; the money pass
  only verified that the container never receives a WIF and that the broker
  default-denies payment signing.
- **Container/network isolation, SovGuard, canary tokens.** Prompt-injection is
  the attack, but the money-relevant question — "can an injected container move
  funds?" — was answered inside this pass (it cannot; see adversarial item 5).
  The isolation posture itself is the security domain.
- **Platform-side behaviour.** Several findings bottom out in what
  `api.junction41.io` does with a value we send (M6's out-of-range
  `refundPercent`, `post-bounty`'s unvalidated `parseFloat(--amount)`). Marked
  as such rather than guessed at; needs a backend-side check.
- **`post-bounty` / `list-bounties` / service pricing input validation.**
  `parseFloat(options.amount)` at `cli.js:9676` and the service-price
  `parseFloat` calls at `cli.js:732, 874, 966, 974` are unvalidated, but every
  one of them submits a decimal to the platform rather than converting to
  satoshis locally, so the platform is the validator. Noted, not reported —
  tracing the outcome requires the backend.
- **Dashboard TUI money screens** beyond `buildEarningsRow` (which is extracted
  into `wallet.js` and was checked). `dashboard.js` cannot be imported under
  `node --test`; its remaining money surfaces are presentation over the same
  read models already verified here.
- **Running any code.** Read-only pass per the audit rules — no tests executed,
  no `node --check`, no live API calls. Every finding is traced statically to a
  file:line and a reachable call path.

---

## keys — 2026-08-10 — DONE

Artifacts: `AUDIT/keys.md` (findings + adversarial pass + clean list),
`AUDIT/keys-claims.md` (claims checklist, 43 claims across 4 groups).

**Counts by severity:** crit 1 · high 1 · med 2 · low 5 · total 9

| Sev | Finding |
|---|---|
| crit | K1 — dashboard "Retry Registration" irrecoverably destroys an encrypted agent's WIF |
| high | K2 — `init` skips the unlock guard, writing new WIFs plaintext onto an encrypted pool |
| med | K3 — predictable `/tmp/j41-sign-<jobId>` reused if pre-existing; swallowed chmod → local signing oracle |
| med | K4 — `O_NOFOLLOW` guards the request file but not `req/`/`resp/`; container can symlink them |
| low | K5 — documented passphrase precedence is backwards (credential wins, not env var) |
| low | K6 — `allowLocked: true` is a no-op on plaintext keys.json (the reason K1 is latent) |
| low | K7 — `viewAgentProfile` reads without the secret then uses `keys.wif` |
| low | K8 — `api-keys.json` chmod-after-write, and absent from the 0600 repair sweep |
| low | K9 — bearer API keys compared with `===` on an unauthenticated path; O(agents) disk scan per miss |

**Claims checklist outcome:** 37 VERIFIED · 6 DRIFT (A6, A7, C11, C13, D5, and
the `allowLocked` contract under K6) · 0 MISSING · 0 UNVERIFIED.

**Shape of the domain:** the signing side is genuinely solid — broker mandatory
on every network, default-deny throughout, WIF provably absent from the
container. Every custody finding above only fires **after** an operator runs
`encrypt-keys`; on a default plaintext install K1, K2 and K7 are all inert.
Opting into the security feature is what exposes you, which is worth calling out
in the soft-launch notes if `encrypt-keys` is going to be recommended.

**Files read in full:** `src/keystore.js`, `src/keys-file.js`,
`src/keys-migrate.js`, `src/keygen.js`, `src/sign-broker.js`,
`src/sign-channel-host.js`, `src/sign-channel-client.js`, `src/job-signer.js`,
`src/broker-executors.js`, `src/api-key-manager.js`, `src/mainnet-guard.js`,
`src/job-id.js`; `src/cli.js` (permission sweep + unlock guard 383-470, init
1351-1408, register 1411-1500, setup 2735-2880, api-setup 3000-3070, start
mainnet gate + unlock 3113-3160, encrypt/decrypt/change-passphrase 4412-4502,
container env 7905-8016, docker job launch + broker wiring 8255-8435, local job
launch 8705-8860, interactive shell key paths 9435-9615); `src/dashboard.js`
(agent detail 267-360, retryRegisterScreen 1934-2050, saveAgentConfig
1695-1700, security menu 2100-2120); `src/job-agent.js` (broker guard 455-540,
attestation 1620-1720); `src/sign-attestation.js`; `src/proxy-handler.js` (auth
path 230-270); `src/control-api.js` (token 34-75); `README.md` (44, 175-200,
300-320, 375-400, 425-455, 720-790); `test/cli-encryption-guard.test.js`,
`test/keys-file-read.test.js`, `test/keys-file-encrypted.test.js`.

### Deliberately NOT covered, and why

- **The SDK's own key handling** (`keypairFromWIF`, `signMessage`,
  `buildIdentityUpdateTx`, `assertNotProtocolMessage`). `src/keygen.js` is a
  25-line passthrough; entropy source, WIF encoding and signature construction
  live in `@junction41/sovagent-sdk`, outside this repo.
- **Whether `encrypt-keys` is reachable from the dashboard Security menu.**
  `dashboard.js:2105` offers the item; only the `change-passphrase` handler
  (`:2116-2117`) was traced. `dashboard.js` can't be imported under
  `node --test` and the pass is read-only. Low stakes — the CLI is the
  documented entry point.
- **Container isolation posture** (gVisor / seccomp / AppArmor / bwrap, egress
  proxy, SovGuard, canary). K4 assumes a compromised container and asks only
  what it can do *to the signing channel*; whether it can get there is the
  isolation domain.
- **Platform-side trust.** The broker's root of trust for amount/buyer/jobHash
  is `getJob()` against `api.junction41.io`, and the witness verification in
  `broker-executors.js` bottoms out in platform signatures. Needs a backend
  check, not a guess.
- **Money paths already covered by the money pass** — `fee-tank.js`,
  `wallet.js`, `refund*.js`. This pass only re-touched them where a key or a
  signature was the subject.
- **Running any code.** Read-only per the audit rules — no tests executed, no
  `node --check`, no live calls. Note K1 destroys a private key if reproduced;
  any reproduction needs a throwaway `~/.j41/dispatcher`.

---

## isolation — 2026-08-10 — DONE

Artifacts: `AUDIT/isolation.md` (findings + adversarial pass + clean list),
`AUDIT/isolation-claims.md` (claims checklist, 68 claims across 9 groups).

**Counts by severity:** crit 0 · high 2 · med 5 · low 5 · total 12

| Sev | Finding |
|---|---|
| high | I1 — unvalidated platform download filename → arbitrary write in the sandbox, reaching the host signing channel and the IPC file |
| high | I2 — job-file writes on respawn follow symlinks a prior container planted → host file overwrite with buyer-authored content |
| med | I3 — bwrap wall never applied (`detectIsolation()` async, un-awaited); the config it would return is unusable anyway |
| med | I4 — startup security gate discards every `warn`; a missing egress firewall is a `warn`, and `score` ignores network posture |
| med | I5 — mainnet gate reads `process.env` only, so `allow_local_upstream` / `skip_status_check` in `config.toml` bypass it |
| med | I6 — pausing a job leaks its egress token and its host-side signing channel (and a respawn opens a second host on the same dir) |
| med | I7 — buyer file uploads uncapped into the host bind mount; `StorageOpt: 1G` doesn't cover it and is silently dropped on most hosts |
| low | I8 — container→job-agent IPC file is unauthenticated and lives in container-writable tmpfs |
| low | I9 — canary strip on the deliverable is literal while detection is evasion-resistant; deliverable never leak-checked |
| low | I10 — Docker-mode workspace connect bypasses the on-chain `workspace.capability` gate (inert while jailbox is parked) |
| low | I11 — `secure-setup` is optional + ESM behind a silent `require`/`catch`; below Node 20.19 the whole security gate vanishes wordlessly |
| low | I12 — no guard against running the dispatcher as root; the container inherits `User: 0:0` |

**Claims checklist outcome:** 72 claims — 50 VERIFIED · 18 DRIFT (A2, A3, A4,
A6, B7, C2, C3, C12, D6, E1, E5, F1, F3, F5, G5, H4, I-a, I-b) · 3 MISSING
(C4, C5, C6) · 1 UNVERIFIED (D4, "local mode cannot register agents for public
jobs" — no dispatcher-side enforcement found; if real it is platform-side).
Two VERIFIED entries are qualified in place: A8 (true on completion, false on
pause → I2/I6) and I-g (reads are `O_NOFOLLOW`, writes are not → I2).

**Shape of the domain.** The *per-container* posture is genuinely strong and
unconditional — cap-drop, read-only rootfs, pids limit, tmpfs, seccomp-by-content,
non-root, no docker socket, no WIF. Where it weakens is at the seams:
(a) the three-wall story is two walls in practice (I3); (b) whether the network
wall exists at all is decided by a check that only warns (I4); and (c) the two
host↔container channels that had to stay writable — the bind-mounted job dir and
the signing channel — are the reachable ones (I1, I2, I6). Both high findings
are write-primitive bugs on those seams, and both have a matching read-side
defence already in the codebase (`readJobFileNoFollow`, the `req/` filename
regex) that was simply never mirrored on the write side.

**Files read in full:** `src/egress-proxy.js`, `src/egress-proxy-client.js`,
`src/container-entry.sh`, `src/mainnet-guard.js`, `Dockerfile.job-agent`,
`package.docker.json`; `src/cli.js` (security helpers + container launch
8040-8500, local launch 8700-8890, teardown 8580-8710, pause/respawn 4972-5100,
start/mainnet gate/first-run/quick-check 3105-3250 + 3420-3510, egress proxy
wiring 4125-4155, webhook/proxy gating 3560-3880, container env 7907-8050,
workspace capability gate 5425-5455); `src/job-agent.js` (module head 1-70,
canary 330-350 + 490-500 + 840-880, IPC 690-810, chat 1100-1180, file download
1040-1070 + 1237-1260, workspace poller/connect 1261-1310 + 1392-1470 +
1556-1620, cleanup 2320-2350); `src/sign-channel-host.js` (intake + `_handle`
40-360); `src/broker-executors.js` (registered kinds 230-276);
`src/sign-broker.js` (`signGenericMessage`); `src/config-loader.js` (defaults +
`ENV_OVERRIDES` 1-200); `src/webhook-server.js` (bind + routes 100-260);
`src/control.js` / `src/control-api.js` (bind addresses only); all six
`src/executors/*.js` (scan wiring only). Dependency code read for claim
verification: `@junction41/secure-setup` (`lib/index.js`, `lib/quick-check.js`,
`lib/detect-isolation.js`, `lib/setup-network.js`, `lib/deploy-profiles.js`,
`scripts/entrypoint-agent.sh`) and `@junction41/sovagent-sdk`
(`dist/agent.js` download path, `dist/client/index.js:979-1013`,
`dist/net/egress-agent.js`, `dist/chat/client.js`).

### Deliberately NOT covered, and why

- **The seccomp and AppArmor profile *contents*.** `secure-setup/profiles/
  seccomp-agent.json` and `apparmor-agent` were not reviewed syscall by syscall;
  this pass verified only that they are found, validated as JSON, and handed to
  the daemon in the form it expects. The README's "~80 syscalls, blocks
  ptrace/mount/reboot/keyctl/bpf" is therefore VERIFIED as wiring, not as
  content.
- **gVisor / bubblewrap / Docker themselves.** No escape research against runsc
  or runc. The pass asks only which walls the dispatcher actually configures.
- **`@junction41/secure-setup` as a package.** Read where a dispatcher claim
  bottoms out in it (I3, I4, C2–C6, F1–F5), but not audited as its own
  codebase — its `setup()`, `selfTest()`, gVisor/bwrap installers and profile
  integrity checks deserve a pass of their own, and it is a separate repo.
- **The SDK as a codebase.** Read the two functions that terminate finding I1
  (`downloadFileTo`, `downloadFile`) and the egress/chat transport used to
  clear a suspected proxy bypass. `assertNotProtocolMessage`,
  `checkForCanaryLeak`'s normalisation and the workspace client's own path
  validation were taken as given.
- **Whether a buyer controls the stored upload filename.** The hinge on I1's
  severity. It is a backend question and is marked UNVERIFIED in place rather
  than guessed.
- **Key custody and the signing-channel internals** — `AUDIT/keys.md` (K3, K4
  cover the `/tmp/j41-sign-<jobId>` directory itself). This pass only asked what
  can *reach* that channel from outside, and found I1 and I6.
- **Money flows** — `AUDIT/money.md`. Touched only where an isolation defect
  ends in a financial outcome (I1's on-chain write and budget lift, I7's disk).
- **The api-endpoint proxy's own request handling** (`proxy-handler.js` metering,
  envelope verification, rate limiting) — covered by the money pass; this pass
  used it only for `isPrivateIp` and the `allow_local_upstream` read.
- **Dashboard security screens** beyond confirming `dashboard.js:917` awaits
  `detectIsolation` (the contrast that makes I3 a slip). `dashboard.js` cannot be
  imported under `node --test`.
- **Jailbox/workspace behaviour in depth.** Parked by default
  (`config-loader.js:86`); H3/H4/I10 record the state of its gates without
  auditing the feature.
- **Running any code.** Read-only per the audit rules. Two exceptions, both
  non-mutating and both load-bearing for a finding: `node -v`, and a
  `require('@junction41/secure-setup')` probe that establishes I11's boundary is
  *not* crossed on this host (v20.20.1). No tests, no `node --check`, no docker
  commands, no network calls.

---

## trust-boundary — 2026-08-10 — DONE

Artifacts: `AUDIT/trust-boundary.md` (findings + adversarial pass + clean list),
`AUDIT/trust-boundary-claims.md` (claims checklist, 77 claims across 9 groups).

**Domain as scoped:** what the dispatcher accepts from a producer it does not
control, and what it does with it. Producers: the buyer (chat, job description,
uploaded files), the platform API (job records, inbox items, service metadata,
webhooks), the LLM (completions + tool calls), the operator's external executor
backend (n8n / CrewAI / A2A / LangGraph / LangServe), an MCP server, and
anonymous HTTP callers on the webhook/proxy port.

**Counts by severity:** crit 0 · high 0 · med 7 · low 4 · total 11

| Sev | Finding |
|---|---|
| med | T1 — respawn/reconnect seeds platform chat history into LLM context, bypassing the buyer-chat scan |
| med | T2 — `review.received` webhook writes N back-to-back identity txs, outside the batch and outside the pending-write gate |
| med | T3 — webhook events never bound to the agent whose secret authenticated them |
| med | T4 — webhook executor lets its backend supply the delivery hash independently of the content |
| med | T5 — proxy sends the seller's upstream credential to a URL taken from the platform's service record |
| med | T6 — TUI-configured upstream API key written as `upstreamAuth`, read as `apiEndpointAuth` — never sent |
| med | T7 — legacy body-only webhook HMAC still accepted on the event route; the anti-downgrade guard is wired only to `revoke` |
| low | T8 — `J41_SCAN_BUYER_CHAT` never forwarded to the container; documented opt-out and its mainnet-gate entry are both inert |
| low | T9 — WS chat handler accepts any sender in the room; the poll path filters by buyer |
| low | T10 — `buyer/amount/currency.txt` written unbounded; only `description.txt` got the ddos-4 length cap |
| low | T11 — workspace path guard assumes `args.path` is a string; a non-string throws out of the local-llm tool loop |

**Claims checklist outcome:** 77 claims — 58 VERIFIED · 9 DRIFT (A5, C5, D14,
D15, F7, F10, G3, H5, I6) · 5 MISSING (A6, A14, C13, G8, plus H4/I2 deferred to
prior passes) · 0 UNVERIFIED · 3 recorded N/A-by-design (A15, F6, I5). Two
VERIFIED entries are qualified in place: C8 (nonce cache is correct for access
envelopes, weak for webhook event ids → T7) and E3 (0600 is true for a token the
dispatcher created, not re-checked for a pre-existing one).

**Shape of the domain.** The *designed* boundaries are strong and, in two cases,
better than documented: the signing broker is a genuinely constrained signer,
the `job_record` inbox gate cross-checks platform bytes against an independently
fetched witness, the SDK's per-type VDXF allowlist caps what any inbox item can
write, both proxy envelope versions verify locally and fail closed, and the
proxy's SSRF handling (IPv6 hex `::ffff:` forms, DNS pin) is unusually careful.
Where it weakens is at **re-entry and asymmetry**, not at first contact:

- Text that is scanned on the way in is *not* re-scanned when the same text
  comes back from the platform's store on respawn (T1).
- A write path that is correctly batched and gated in the poller is neither
  batched nor gated in the webhook handler (T2).
- A downgrade defence that the code itself articulates is wired to one route of
  two (T7).
- A sender filter that the poll path applies is absent on the WebSocket path
  (T9), and a per-agent secret's scope is discarded by the event handler (T3).

Four of the seven mediums are a control that exists somewhere in the codebase
and was simply not applied at the second site — which is what makes them
cheap to fix and easy to miss.

**Files read in full:** `src/sovguard-context.js`, `src/nonce-cache.js`,
`src/sign-broker.js`, `src/inbox-job-record.js`, `src/message-poll.js`,
`src/message-dedup.js`, `src/mainnet-guard.js`, `src/control-api.js`,
`src/webhook-server.js`, `src/proxy-handler.js`, `src/executors/local-llm.js`,
`src/executors/webhook.js`, `src/job-id.js`;
`src/executors/mcp.js` (60-250), `src/executors/{a2a,langserve,langgraph}.js`
(scan + finalize wiring); `src/job-agent.js` (canary + sanitizeInput 330-360,
job-file read 510-525, delivery 836-900, chat loop + poll 1020-1235, workspace
handler 1556-1618, rework 2030-2145); `src/cli.js` (webhook mode + proxy context
3563-3880, capability fetch 4855-4939, webhook event handler 7053-7436, inbox
dispatch + batch 7438-7615, container env 7907-8050, docker launch 8232-8440,
local launch 8700-8800, teardown 8668-8968); `src/dashboard.js` (API endpoint
setup 2795-2895); `src/control.js` (health bind only); `README.md` (1-60,
227-400, 600-850); `docs/sovguard-context-integration.md` (full);
`test/{sovguard-context,respawn-context-reload}.test.js`. Dependency code read
for claim verification: `@junction41/sovagent-sdk` — `dist/inbox/vdxf-gate.js`
(full), `dist/crypto/envelope.js` (`verifyAccessRequest`),
`dist/chat/client.js` (connect + message dispatch), `dist/agent.js` (inbox
accept methods).

### Deliberately NOT covered, and why

- **The SovGuard scanner's detection quality.** `scanContext`'s regex/indirect/
  perplexity layers and its strip-vs-quarantine fallback live in the SDK. This
  pass verified where it is called, with what source label, and what happens
  when it fails — not what it catches. A5/A8/A11 are VERIFIED as wiring, not as
  coverage. Adversarial-corpus testing is its own pass.
- **`checkForCanaryLeak`'s normalisation.** Same reason. The strip-vs-detect
  asymmetry on the deliverable is already isolation **I9**.
- **Platform-side behaviour.** Three findings bottom out in what
  `api.junction41.io` does or permits: T9 (can anyone but the buyer emit into a
  job room?), T5 (can a service record be tampered short of full compromise?),
  and T2's review re-emit frequency. Marked platform-dependent in place rather
  than guessed at; each needs a backend check.
- **Money consequences.** T6 ends in a billing behaviour `AUDIT/money.md`
  already reports (M1/M2); this pass names the new trigger and does not
  re-derive the metering analysis. Platform-supplied budget numbers
  (`data?.estimatedTokens`, `cli.js:7398`) stay money-domain.
- **Key custody and the signing channel internals** — `AUDIT/keys.md`. This pass
  asked only what the broker *refuses*, never how the channel or the keystore is
  protected (K3/K4/K9 stand).
- **Container and network isolation** — `AUDIT/isolation.md`. The three walls,
  the egress proxy, the bind mounts, and the download-filename write primitive
  (I1/I2) belong there; T1-T11 assume that posture as-is. Isolation **I5** (the
  mainnet gate reads `process.env` only) is cited under H4 and not re-reported.
- **`update-profile`'s ungated identity write.** Documented in CLAUDE.md (F8)
  and operator-initiated, so not reachable from untrusted input. T2 is the
  automatic, undocumented instance of the same hazard.
- **MCP tool-description poisoning.** `mcp.js:68-80` feeds `tools/list` output
  into the LLM's tool schema unscanned, but the MCP server is operator-
  configured and inside the trust boundary. Recorded as A15, not reported.
- **Dashboard screens** beyond the `[18] API Endpoint Setup` write path that T6
  required. `dashboard.js` cannot be imported under `node --test`.
- **Running any code.** Read-only per the audit rules — no tests, no
  `node --check`, no docker commands, no network calls. Every finding traces
  statically to a file:line and a reachable call path. The one claim that looks
  dynamic (T8: `J41_SCAN_BUYER_CHAT` cannot reach the container) rests on
  exhaustive reading of both env-construction sites, `cli.js:8418-8427` (Docker)
  and `cli.js:8750-8760` (local), which are explicit allowlists with no
  `process.env` spread.

---

## liveness — 2026-08-10 — DONE

Artifacts: `AUDIT/liveness.md` (findings + adversarial pass + clean list),
`AUDIT/liveness-claims.md` (claims checklist, 44 claims across 7 groups).

**Domain as scoped:** does the dispatcher keep making progress, and does it stop
cleanly. Loops that must keep turning (poll, inbox, fee-tank, cleanup), work that
must not stall (a job, a paused session, an open dispute, a queued job),
processes that must start and stop (PID handoff, drain, watchdogs), and the
signals an operator watches to know any of it is true (`/health`, `ctl`, skip
counters).

**Counts by severity:** crit 0 · high 3 · med 8 · low 6 · total 17

| Sev | Finding |
|---|---|
| high | L1 — shutdown's 30s stall watchdog is shorter than one agent's worst-case deactivation, and the restore-marker is written only after the loop → forced exit strands the fleet inactive |
| high | L2 — Docker-mode container crash is indistinguishable from a clean exit (`AutoRemove` + 10s inspect poller): no retry, no abandoned-job refund, no `container.died`, and `containers_unhealthy` can never fire |
| high | L3 — the dispatcher's job timeout kills a worker holding an open dispute; the reconciler burns its 3 respawns in ~3h and abandons the job until restart |
| med | L4 — any `container.inspect()` error is treated as "container gone" → a dockerd restart reaps every in-flight job, no refund, 7-day `seen` lockout |
| med | L5 — jobs queued at capacity are marked `seen` (persisted) but `state.queue` is memory-only → a restart drops them for 7 days |
| med | L6 — the queue drain pops an arbitrary available agent and ignores `assignedAgent` (written twice, read nowhere) |
| med | L7 — shutdown's on-chain deactivate writes outside the inbox batch and the pending-write gate, and swallows the rejection |
| med | L8 — `config --max-concurrent` writes a key nothing reads; `config --show` prints it back |
| med | L9 — README's "waits up to 30s … then SIGTERM -> SIGKILL" vs a real 120-min drain with no kill escalation → systemd `TimeoutStopSec` orphans containers |
| med | L10 — `/health` and the `ctl` socket bind only after an unbounded startup sequence |
| med | L11 — `ctl earnings` is 2N serial platform calls against a hard 5s client deadline |
| low | L12 — README's "New instance auto-kills previous" is really SIGTERM + 10-min wait + refuse |
| low | L13 — Docker IPC file is read-then-unlinked non-atomically; a message in that window is dropped unacked |
| low | L14 — `_reconcileAttempts` counts lifetime respawns, never consecutive failures |
| low | L15 — `state.available` accumulates duplicates when one agent runs two jobs |
| low | L16 — `sendCommand`'s 5s timeout is never cleared → every `ctl` call lingers ~5s |
| low | L17 — pause-TTL expiry drops the queue entry; the documented auto-deliver has no sender and no worker |

**Claims checklist outcome:** 44 claims — 28 VERIFIED · 11 DRIFT (A1, A3, A8, B2,
B5, D1, D3, D8, E4, F2, G3, G10 — B2 counted once as DRIFT+MISSING) · 1 MISSING
(B2's auto-deliver half) · 2 UNVERIFIED (A9; the B6 service-field ranges, both
platform-side or cosmetic). Two VERIFIED entries are qualified in place: A7/E5
(the drain is implemented as documented, but the deactivate loop it depends on
can be cut short → L1) and G4 (the reconcile cap works exactly as written, and
that is what strands a long dispute → L14).

**Shape of the domain.** The *loop* layer is genuinely strong and better than
documented: three reentrancy guards that release on the throw path, skip counters
wired to `/health` and tested, `safeInterval` closing the Node-20 async-throw
hazard, deadlines on every outbound call, a fail-open auth backoff with jitter,
bounded dead-lettering with a deliberate liveness backstop, and atomic writes on
every state file. Nothing found spins forever or leaks a timer.

Where it weakens is at **the boundaries of a lifecycle** — the moments a job or a
process changes hands:

- **Container exit is not observed.** `AutoRemove` plus a 10 s `inspect()` poller
  means the dispatcher learns *that* a container is gone, never *why* (L2), and
  cannot tell "gone" from "I cannot reach the daemon" (L4). Both branches end in
  the same silent teardown, and the exit code needed to separate them is already
  sitting on the active entry from `container.wait()`.
- **Two clocks, one of them unaware.** The container-side dispute hold was fixed;
  the dispatcher-side timer that also kills the container was not (L3). Same
  shape as the round-8 bug the code documents as fixed.
- **Budgets sized against the wrong worst case.** The shutdown stall watchdog
  allows 30 s per step against an SDK single-request worst case of ~93 s (L1).
- **Durability asymmetry.** `seen` is persisted, `queue` is not (L5); the restore
  marker is persisted after the loop, not during it (L1). In both cases the
  durable half records that work was taken and the volatile half records how to
  finish it.

Four of the five worst findings are one control that already exists somewhere in
the codebase, not applied at the second site — the same pattern the
trust-boundary pass reported.

**Files read in full:** `src/auth-backoff.js`, `src/inbox-deadletter.js`,
`src/preflight-gate.js`, `src/llm-health.js`, `src/reactivation-poll.js`,
`src/hardware-sizing.js`, `src/config.js`;
`src/cli.js` (allowlist sweep 262-337, capacity resolution 125-145, seen-jobs
persistence 505-540, `config` command 1180-1270, `start` action 3100-4410 in
full — mainnet gate, PID handoff, capability load, mode selection, all timer
wiring, control plane, activation loop, `gracefulShutdown`; `getAgentSession` +
rate poller 4733-4843, `sendToJobAgent` 4972-4988, pause/respawn 4990-5124,
dispute reconciler 5215-5423, crash recovery 6398-6545, `refundAbandonedJob`
6547-6570, `pollForJobs` 6659-7037, webhook event handler 7270-7320, fee tank
7700-7828, inbox sweep 7830-7860, container launch + timers 8345-8582,
`stopJobContainer` 8626-8700, local launch + `stopJobLocal` 8780-8980,
`cleanupCompletedJobs` 9004-9107, `ctl` client 9209-9265);
`src/control.js` (health bind + retry 100-146, read models 157-200,
`buildHealthDocument` 387-487, `buildEarnings`, `sendCommand` 656-706);
`src/control-api.js` (event ring 35-128);
`src/job-agent.js` (dispute-hold declaration 145-205, IPC handler + file poller
740-830, post-delivery entry 895-925, message/workspace/idle/budget timers
1185-1384, SIGTERM handler 1620-1663, soft + hard timeout 1665-1763,
`waitForPostDelivery` 1920-2030);
`src/webhook-server.js` (hardening + routes 95-380);
`src/config-loader.js` (runtime defaults). Dependency code read for claim
verification: `@junction41/sovagent-sdk/dist/client/index.js:10-193` (timeout,
`maxRetries`, retry ladder, response caps) — the numbers L1 and L11 rest on.

### Deliberately NOT covered, and why

- **Whether the work is correct, safe, or paid for.** This pass asks only whether
  it *progresses*. L2/L4 end in an unpaid buyer and L7 in an on-chain
  inconsistency; the ledger machinery behind both was verified by
  `AUDIT/money.md` and is not re-derived here.
- **The platform's own liveness.** Four findings bottom out in backend behaviour:
  L17 (does the platform really auto-cancel/refund an expired pause?), L3's
  dispute-deadline semantics, L2's post-abandonment job state, and whether
  `refreshAgent` is synchronous enough for the shutdown deactivate to matter.
  Marked platform-dependent in place rather than guessed at.
- **Docker/dockerd itself.** L2 and L4 assume documented `AutoRemove` semantics
  (remove-on-exit) and that `inspect()` surfaces daemon-unreachable as a throw.
  Neither was exercised — the pass is read-only — but both are the documented
  contract and the code's own 404-discrimination at `cli.js:8637-8641` shows the
  authors expect exactly that error shape.
- **`dashboard.js` liveness surfaces.** The TUI's dispatcher start/stop screens
  (`:2960-3060`) spawn and SIGTERM the daemon; they were read only far enough to
  confirm they do not add a second PID-file writer. `dashboard.js` cannot be
  imported under `node --test`, and every screen is presentation over read models
  already verified here.
- **`deposit-watcher.js`, `dispute-sweep.js`, `credit-meter.js`,
  `proxy-handler.js` timers.** Confirmed `unref()`'d and non-blocking; their
  *contents* are money-domain and were audited there.
- **Executor-level stalls** (`executors/*.js`). Verified that every outbound call
  carries an `AbortController` deadline; the retry/streaming behaviour inside a
  single LLM turn is money-domain (M1/M2) and was not re-walked.
- **Load testing / measurement.** README's scale table is arithmetic and says so;
  this pass verified the arithmetic's inputs (stagger, interval, guard) and did
  not attempt to measure a cycle. The reliable signal is the skip counter, which
  is verified wired.
- **Two-dispatcher operation.** README:367-370 suggests running a second instance
  on free ports; C7 records that the PID file is a single fixed path that would
  SIGTERM the sibling. Not reported as a finding — the rest of the design treats
  concurrent dispatchers as the thing to prevent, so the README suggestion and
  the PID logic disagree and the PID logic is the safer one. Worth a doc fix.
- **Running any code.** Read-only per the audit rules — no tests executed, no
  `node --check`, no docker commands, no network calls. Every finding traces
  statically to a `file:line` and a reachable call path. The two that read as
  quantitative (L1's 93 s, L11's 5 s budget) are computed from constants read in
  the SDK source (`client/index.js:22-23,80,187-189`), not measured.

---

## scale — 2026-08-10 — DONE

Artifacts: `AUDIT/scale.md` (findings + adversarial pass + clean list),
`AUDIT/scale-claims.md` (claims checklist, 77 claims across 10 groups).

**Domain as scoped:** what happens as things get bigger — more registered agents,
more concurrent jobs, more proxy traffic, more accumulated history. Three
questions: does the documented capacity arithmetic match the code's real
per-cycle cost; does anything grow without bound in memory or on disk; and when
the box is saturated, does the operator find out and is there a working way out.

**Counts by severity:** crit 0 · high 5 · med 7 · low 6 · total 18

| Sev | Finding |
|---|---|
| high | S1 — both documented remedies for a saturated poll loop are unusable: there is no interval knob, and "run a second dispatcher" SIGTERMs the running one and then refuses to start |
| high | S2 — the poll cycle costs ~3× the README's arithmetic; above 60 agents it overruns at every latency above ~167 ms, so "≤500 ms never overruns at any agent count" is false |
| high | S3 — `/j41/deposit/report` burns the shared nonce cache and fires an outbound platform call *before* the signature check, unrate-limited; the neighbouring route has both defences |
| high | S4 — `api-keys.json` and `_keyCache` grow one record per discovery request forever; every proxy request then re-reads and rewrites the whole file |
| high | S5 — `sweepDisputesForRefund` re-fetches every historical dispute every 5 min (uncapped, unstaggered, unguarded, and *before* the already-refunded check), so sweeps pile up and the cost only ever grows |
| med | S6 — proxy hot path does 4 sync whole-file reads + 3 whole-file writes per request on the same event loop that runs the job fleet |
| med | S7 — startup activation runs after the inbox timer is armed; at fleet scale both broadcast identity txs for the same agent |
| med | S8 — the inbox sweep's skipped cycles are uncounted and absent from `/health`, unlike poll and fee-tank |
| med | S9 — ProfileSync / `cleanupCompletedJobs` / dispute-sweep have no reentrancy guard; `safeInterval` only catches throws |
| med | S10 — `ctl resources` reports the registered-agent count as the slot cap, and its per-job memory list is always empty in Docker mode |
| med | S11 — extensions are rejected whenever the pool is full or the queue is non-empty — undocumented, and an extension consumes no slot |
| med | S12 — the preflight LLM probe caches success but not failure, so an LLM outage stalls the poll cycle by 5 s per pending job request |
| low | S13 — `events.jsonl` compaction counter resets on restart; a frequently-restarted dispatcher never compacts and reads the whole file at boot |
| low | S14 — README's "unlimited" max-concurrent default is really a hardware cap (3 on 8 GB / 4 cores) |
| low | S15 — container log lines mirrored to dispatcher stdout uncapped; the dashboard launcher appends to unrotated `/tmp/dispatcher.log` |
| low | S16 — the dispute reconciler skips the response cap the poll loop applies; `_reconcileAttempts` never pruned |
| low | S17 — the egress proxy caps neither concurrent CONNECT tunnels nor idle time |
| low | S18 — `checkFeeTanks` is the only per-agent fan-out with no inter-agent stagger |

**Claims checklist outcome:** 77 claims — 48 VERIFIED · 19 DRIFT (A1, A2, B3, B4,
B5, B6, C3, D8, D14, E2, F1, G2, G4, G5, G6, H2, I4, J6, J7) · 6 MISSING (D4, E7,
G9, H1, H3-as-remedy, J4) · 1 UNVERIFIED (C1 — the "measured" fee-tank table has
no harness in the repo) · 3 recorded-not-reported (G4, G8, G10). Two VERIFIED
entries are qualified in place: B11 (the ddos-5 response cap is real but applied
at one of three sites) and F5 (`/health` is O(agents × active), but in-memory and
localhost-bound).

**Shape of the domain.** The *primitives* are good and better than the docs: the
hardware self-sizing is genuinely conservative and warns when overridden, the
memory-headroom valve guards every spawn path, per-container limits are
unconditional, the seen-jobs map has a TTL and an atomic write, the proxy's
per-buyer bucket + in-flight cap are correctly ordered after auth, and every
stagger/batch/cap in the codebase has its reasoning written down next to it.

Three things break, and they are different in kind from the earlier passes:

- **The published arithmetic is wrong, not just imprecise.** README:340-356 counts
  one round trip per agent where the cycle makes three, and omits the three
  per-active-job passes entirely (S2). Every threshold in the operator's capacity
  table is ~3× optimistic, and the `N > 60` regime — where the budget grows by 1 s
  per agent and the cost by ~1.5 s — is exactly backwards from what the table says.
- **The way out doesn't exist.** The Scale section's only guidance is "raise the
  interval or run a second dispatcher" (S1). There is no interval knob anywhere in
  the config surface, and the second-dispatcher path SIGTERMs the live one, waits
  10 minutes, then exits 1 — the operator who follows the docs takes their own
  fleet down. This is the one finding where the documentation instructs a
  destructive action.
- **Costs that only ever grow.** S5 (every historical dispute re-fetched every
  5 min, forever, before the already-refunded check), S4 (a key record per
  discovery handshake, never pruned, re-parsed and rewritten on every proxy
  request) and S13 (an events file that only compacts if the process lives long
  enough). None has a steady state; each is strictly worse tomorrow.

Four findings are again *a control that exists somewhere in the codebase, not
applied at the second site* — the pattern the trust-boundary and liveness passes
both reported. S3 is the sharpest instance: `nonce-cache.js:81-88` writes down the
exact attack, `checkNonceAfterVerify` exists for it, `webhook-server.js:133-134`
rate-limits the neighbouring route "to prevent amplification DoS" — and the
deposit route has neither. Also S8 (skip counter on two of three loops), S16
(response cap on one of three call sites), S18 (stagger on three of four loops).

**Files read in full:** `src/hardware-sizing.js`, `src/preflight-gate.js`,
`src/llm-health.js`, `src/nonce-cache.js`, `src/proxy-rate-limiter.js`,
`src/credit-meter.js`, `src/api-key-manager.js`, `src/control-api.js`,
`src/egress-proxy.js`, `src/job-log.js`;
`src/cli.js` (capacity resolution 118-145, seen-jobs 490-539, `config` command
1204-1273, PID handoff 3160-3215, startup banner 3238-3262, `safeInterval` +
mode selection 3547-3572, discovery/access handler 3690-3780, timer wiring
3951-4058, activation loop 4160-4212, session cache + rate poller 4733-4843,
capacity guard 5027-5040, dispute reconciler 5215-5423, dispute refund sweep
5977-6021, extension admission 6590-6633, queue insert 6636-6657, `pollForJobs`
6659-7037 in full, fee tank 7702-7827, inbox sweep 7829-7880, capped log writer
8191-8214, container limits 8355-8390, container launch + log stream 8440-8582,
`archiveJobLog` 8584-8624, `cleanupCompletedJobs` 9004-9107);
`src/control.js` (health/metrics server 90-146, read models 157-215,
`buildHealthDocument` 387-487, `ctl resources` 542-591);
`src/webhook-server.js` (body cap + discovery limiter 39-90, routes 105-230,
server tuning 371-376); `src/proxy-handler.js` (request path 230-350, settle
paths 495-580); `src/deposit-watcher.js` (`verifyDepositReport` 51-95,
`reportDeposit` 185-265); `src/config-loader.js` (DEFAULTS + `ENV_OVERRIDES`
1-160); `src/sign-channel-host.js` (poll timer 48-160);
`src/executors/local-llm.js` (agent loop 250-300);
`README.md` (1-30, 160-180, 296-450, 640-730, 790-830). Dependency code read for
claim verification: `@junction41/sovagent-sdk/dist/client/index.js:1-200`
(timeout, `maxRetries`, retry ladder, 8 MB response cap) — the numbers S2, S9 and
S16 rest on.

### Deliberately NOT covered, and why

- **Load testing or measurement of any kind.** Read-only per the audit rules. Every
  quantitative statement (S2's overrun thresholds, S5's cycle-time table, S15's
  20 MB/day) is computed from constants read in source — interval formulas,
  stagger sleeps, the SDK's 30 s timeout and 3-attempt ladder — and is labelled as
  arithmetic. C1 (the README's "measured" fee-tank table) is marked UNVERIFIED
  rather than guessed at: no harness or fixture in the repo produces it.
- **Whether the work is correct, safe, or paid for.** This pass asks only how it
  behaves as N grows. S3 and S4 have security consequences (replay-window erosion,
  unauthenticated amplification) that a security-domain pass should re-examine
  from its own angle; S5 and S12 end in unearned revenue that `AUDIT/money.md`
  already owns the ledger for.
- **Platform-side behaviour.** Four findings bottom out in what
  `api.junction41.io` does: S3 (does it rate-limit `getIdentityKeys` per caller?),
  S4 (does the platform dedup discovery handshakes?), S5 (does
  `getMyJobs({status:'disputed'})` ever stop returning old jobs?), and S2's real
  p50/p99 round trip, which is the entire input to the arithmetic. Marked
  platform-dependent in place.
- **Docker/dockerd and the container runtime.** S9's `cleanupCompletedJobs` race
  assumes documented `AutoRemove` semantics and that `inspect()` on a
  live-but-exited container succeeds within the window; neither was exercised.
  Liveness **L2**/**L4** own the container-exit observability question.
- **Findings already reported by earlier passes, not re-derived here:** liveness
  **L5** (queue is memory-only), **L8** (`--max-concurrent` writes a dead key —
  recorded as claim A2), **L11** (`ctl earnings` is 2N serial calls), **L14**
  (`_reconcileAttempts` counts lifetime not consecutive), **L2**/**L4**
  (container-exit blindness); keys **K9** (`findKeyOwner`'s O(agents) disk scan —
  its scale magnitude is folded into S6); isolation **I7** (`StorageOpt` silently
  dropped). Each is cited where a scale claim touches it.
- **`dashboard.js` beyond two call sites.** `:2972` (the `/tmp/dispatcher.log`
  launcher, load-bearing for S15) and `:737`. The TUI's Live Jobs auto-refresh and
  its per-screen platform calls are presentation over read models already verified
  here, and `dashboard.js` cannot be imported under `node --test`.
- **Per-container internals** (`job-agent.js` conversation growth, executor retry
  shapes). Bounded by the token budget and the 2 GB / 1-core container limits, both
  verified; the *contents* are money- and trust-boundary-domain.
- **The SDK as a codebase.** Read `client/index.js`'s request path because S2's and
  S9's worst cases are its constants. Nothing else.
- **Multi-host / horizontal scaling as a design question.** S1 reports that the
  documented single-host multi-instance path does not work; whether the platform
  and the fee-tank/inbox invariants would tolerate a genuinely sharded fleet is a
  design question, not an audit finding.

---

## docs-truth — 2026-08-10 — DONE

Artifacts: `AUDIT/docs-truth.md` (findings + adversarial pass + clean list),
`AUDIT/docs-truth-claims.md` (claims checklist, 118 claims across 11 groups).

**Domain as scoped:** does the documentation tell the truth about the code? The
unit is a *claim an operator would act on* — a default, a threshold, a
guarantee, a "refuses to", a path, a command, a config key, a menu item. Sources:
`README.md` (883 lines, in full), `CLAUDE.md` (222 lines, in full),
`docs/config.toml.example`, `package.json` as published metadata, and the
operator-facing instruction strings the code itself prints.

**Counts by severity:** crit 0 · high 1 · med 5 · low 11 · total 17

| Sev | Finding |
|---|---|
| high | D1 — the documented install cannot produce a runnable dispatcher: `package.json` `files` omits `scripts/`, `Dockerfile.job-agent` and `package.docker.json`, so the README's mandatory image build is impossible and `createContainer` has no image |
| med | D2 — `provider_keys.anthropic\|google\|xai` are unreachable (lookup is by preset name); the `.env` migration routes keys straight into them, and the fleet then declines every job as "LLM down" |
| med | D3 — Workspace/jailbox is documented as a live default feature (Overview bullet, full section, shipped `workspace-reviewer` template) while all three entry points refuse by default |
| med | D4 — the parked-jailbox refusal tells the operator to set `JAILBOX_ENABLED=true`; both readers require the literal `'1'`, so the printed remedy is a no-op |
| med | D5 — `extension.approved\|rejected` and `dispute.filed\|resolved` reach `/v1/events` only through `WEBHOOK_EVENT_MAP`, whose sole caller is the webhook route; in poll mode (the default) they can never fire, and 14 emitted types are absent from the published vocabulary |
| med | D6 — `refunds` is undocumented and README:21 says crash recovery "handles refunds" when it queues them for a manual approval command no operator doc names |
| low | D7 — "Dispatcher Settings" points at a TUI screen that is unreachable dead code, and at `config.toml` for six settings that live in an undocumented `config.json` |
| low | D8 — `ctl inbox` / `ctl inbox-redrive` (the on-chain-write recovery path) are undocumented in README; CLAUDE.md instructs the use of one of them |
| low | D9 — the TUI names 24 of the documented 26 VDXF keys; a landed `review.attestation` renders as an unlabelled raw i-address |
| low | D10 — `docs/config.toml.example` ("the full format") omits 13 keys incl. the whole proxy rate-limit/circuit block, suggests a non-existent `claude` preset, and advertises two config-file escape hatches the mainnet gate cannot see |
| low | D11 — README:19 says the financial allowlist adds **seller** addresses on **creation**; the code adds the **buyer** address on **accept**, as README:818 correctly states |
| low | D12 — documented Docker IPC path `/tmp/ipc-msg.json`; the file is `/tmp/ipc-msg.jsonl` |
| low | D13 — the Testing section documents three unshipped scripts with stale counts and never mentions the 105-file `node --test` suite |
| low | D14 — CLAUDE.md puts `financial-allowlist.json` / `network-allowlist.json` under `~/.j41/dispatcher/`; real path is `~/.j41/`, and the second file is not written at all |
| low | D15 — CLAUDE.md file-map line counts stale by 13% (`cli.js`) and 65% (`dashboard.js`) |
| low | D16 — npm package description says 22 providers / 12 executor frameworks; code has 25 presets and 6 executors |
| low | D17 — `IDLE_TIMEOUT_MS` is documented as an ops override of a `config.toml` value; it is in neither `DEFAULTS` nor `ENV_OVERRIDES`, and neither runtime forwards it (same shape as trust-boundary T8) |

**Claims checklist outcome:** 118 claims — 74 VERIFIED · 30 DRIFT · 8 MISSING ·
3 UNVERIFIED (H15 an external docs URL; G5/J19 both *(prior)*) · 3
recorded-not-reported (A9 the SDK symlink wording, C7 custom templates written
into the installed package, H12 the undocumented `/j41/api-access/revoke`
route). 22 rows are marked *(prior)* and cite the earlier pass that owns them.

**Shape of the domain.** The docs are accurate where the numbers are: all 25 LLM
presets and all 19 provider-table rows check out field by field, the 26-key VDXF
table matches the SDK exactly, every default and range in the three settings
tables is right, the whole control-plane and health surface is right including
the dotted-path compatibility promise, and the mainnet gate's 13-entry list is
right. Nothing in the documentation instructs the operator to weaken a security
control; where the security prose is wrong it describes an *older, weaker*
design than the one that shipped (isolation C2/C3/C4) — stale in the safe
direction.

Where it fails is a different axis from the earlier passes. Those found *a
control applied at one site and not the second*. This one finds **the docs
describing a system one or two releases back**:

- A feature was parked and the README was not told (D3), so it still sells
  workspace/connect — with a built-in template for it.
- A packaging list was tightened and the quick start was not told (D1), so the
  documented install can no longer build the image it insists on.
- A config table was keyed by preset name and the example file was not told
  (D2), so three provider slots and the `.env` migration that fills them point
  nowhere.
- An event vocabulary was published from the webhook-mode implementation and
  never re-checked against poll mode (D5).

The second theme is **omission around failure**: the two commands an operator
needs when something has gone wrong — `refunds approve` (D6) and
`ctl inbox-redrive` (D8) — are the two the README does not mention, and D6's
gap is actively contradicted by a feature bullet claiming crash recovery
"handles refunds".

D4 is the sharpest single item: the remedy is printed by the code, at the moment
of failure, and does not work.

**Files read in full:** `README.md`, `CLAUDE.md`, `docs/config.toml.example`,
`package.json`, `package.docker.json`-adjacent `scripts/build-image.sh`,
`src/executors/index.js`, `src/preflight-gate.js`, `src/llm-health.js`,
`JAILBOX_PARKED.md`; `src/cli.js` (entry point 10950-10958, `config` command
1174-1277, `init` 1352-1362, capacity + paths 112-190, service-lifecycle flags
880-920, `ctl` 9211-9250, dead `mainMenu`/`showSystemSettings` 9350-9645,
`post-bounty` 9650-9690, `refunds` 10803-10830, crash-recovery refund queue
6520-6545, extension admission 6590-6635, webhook event map + handler
7035-7260, `buildContainerEnv` 7905-8015, container launch env filter
8390-8430, local launch env 8700-8790, workspace capability gate 5425-5455,
`respond-dispute` 9110-9130); `src/dashboard.js` (VDXF maps 24-50 + 363-395 +
546-575, main menu 187-235, agent detail 313-340, template picker + custom
builder 968-1155, `saveAgentConfig` 1695-1700, provider-key write 2170-2220);
`src/config-loader.js` (DEFAULTS + `ENV_OVERRIDES` + `applyEnvOverrides` 1-200,
`.env` migration + `PROVIDER_KEY_ENV_MAP` 340-400); `src/config.js`;
`src/control-api.js` (routes + ring buffer 120-215); `src/control.js` (action
switch 490-640, health fields 90-170 + 455-470); `src/webhook-server.js`
(routes 110-270); `src/executors/local-llm.js` (`LLM_PRESETS` +
`resolveLLMConfig` 14-70, Kimi parsing 455-470); `src/job-agent.js` (idle
constant 52, canary 25-70 + 335-350 + 490-550, IPC file 690-800, jailbox gate
1392-1410); `scripts/install.sh`, `setup.sh`, `scripts/test-*.{js,py}`
(check-count only). Dependency code read for claim verification:
`@junction41/sovagent-sdk` — `dist/onboarding/vdxf.js:77-127` (the 26-key
table), `dist/inbox/vdxf-gate.js:44-56` (per-type allowlists),
`dist/client/index.js:274,610,836,1402` (the four response shapes),
`dist/agent.js:2208-2289` (UTXO chaining); `@junction41/secure-setup` —
`lib/setup-allowlist.js` (full), `lib/setup-network.js:230-266`,
`bin/j41-secure-setup.js:85-100`.

### Deliberately NOT covered, and why

- **`docs/` beyond `config.toml.example`.** ~60 documents — testing briefs,
  backend correspondence, superpowers specs and plans. They are dated working
  records, not operator instructions; auditing a 2026-07-30 test brief against
  today's code produces drift that is *correct*. Only the three documents
  README/CLAUDE.md actively point an operator at were checked.
  `docs/RELEASE-READINESS.md` is the one worth a later look — it makes
  present-tense launch-readiness claims — but auditing a self-assessment against
  six completed domain passes is a different exercise from auditing docs against
  code, and it should be done *after* this pass's findings are triaged.
- **`--help` text as a systematic surface.** ~32 commands and ~150 options.
  Checked only where a README claim touched them; D8 turned up one case where
  `--help` is *more* accurate than the README, which suggests the sweep is worth
  doing on its own.
- **The CHANGELOG** (1659 lines). Verified only that its top version matches
  `package.json:3`. Historical entries have the same category problem as old
  test briefs.
- **Claims already owned by a prior pass.** 22 checklist rows are marked
  *(prior)* and cite: money M1/M3/M7/M10; keys K5, D3; isolation
  C2/C3/C4/C5/C6, I5/I7/I9/I10/I11, D4; trust-boundary T8 (its shape is reused
  by D17); liveness L1/L2/L8/L9/L10/L12/L17; scale S1/S2/S8/S11/S14, C1. Status
  restated, analysis not re-derived.
- **Platform-side claims.** Three bottom out in backend behaviour and are marked
  as such rather than guessed: the external `docs.junction41.io` link
  (README:653), the "backend's 10-min auto-deliver" the 8-minute idle timeout is
  sized against (README:424), and the platform-side pause-TTL auto-deliver
  (README:235, already liveness L17).
- **Prose quality, structure, tone, or completeness as documentation.** Only
  falsifiable claims are in scope. "The README needs a troubleshooting section"
  is not a finding.
- **Running any code.** Read-only per the audit rules — no tests, no
  `node --check`, no docker commands, no network calls, no `npm pack`. D1 rests
  on npm's documented `files` allowlist semantics read against
  `scripts/build-image.sh`'s own `cp` list; an `npm pack --dry-run` is the one
  cheap confirmation worth running before acting on it. Every quantitative
  statement (25 presets, 26 VDXF keys, 24 TUI keys, 105 test files, 220
  `promptWithEsc` sites, 13 missing config keys, the three check counts, the two
  line counts) is a count of source, reproducible with `grep`/`wc`.

---

## first-run — 2026-08-10 — DONE

Artifacts: `AUDIT/first-run.md` (findings + adversarial pass + clean list),
`AUDIT/first-run-claims.md` (claims checklist, 61 claims across 6 groups).

**Domain as scoped:** the path a brand-new operator walks between `install` and
their first completed job — install, `quickstart`, `init`, `register`,
`finalize`, `setup`, templates, first-run security setup, first `start`, first
job spawn. The unit is a claim an operator would act on, plus every place the
first-run path *detects* a problem and then reports success anyway.

**Counts by severity:** crit 0 · high 4 · med 3 · low 5 · total 12
(plus X1, a confirmed out-of-domain bug reported anyway)

| Sev | Finding |
|---|---|
| high | F1 — a fresh agent has no UTXOs, so `publishVdxf` returns early; the SDK marks that `vdxf_published` → `ready`, `setup` prints "Setup Complete", and `finalize` (which never clears state) can never retry. Bare `finalize <id>` separately publishes an EMPTY contentmultimap and reports a txid |
| high | F2 — `ollama`/`lmstudio`/`vllm`/keyless-`custom` resolve `apiKey=''`, so `local-llm` falls through to `generateTemplateResponse` and delivers canned filler as the paid work product; preflight passes because the *endpoint* is healthy. The TUI labels these "(no key needed)"; `mcp.js:54` refuses loudly on the same condition |
| high | F3 — `quickstart` discards the API key it collects, prints `export OPENAI_API_KEY=` (never read; `J41_LLM_API_KEY` is the real one), offers a non-existent `claude` preset, and creates no agent despite its own `--help` |
| high | F7 — both installers default to `runtime=local` with no Docker (and `curl \| bash` takes it silently), then print the start command; the `--dev-unsafe` block lives in `startJobLocal`, so every job is accepted and paid for before being refused |
| med | F4 — `secureSetup.setup()`'s `{success:false}` returns are discarded; `✓ Security setup complete` is unconditional, and is immediately followed by `SECURITY CHECK FAILED`. `dashboard.js:2127` checks the same value correctly |
| med | F5 — 10 s budget for an operation that installs gVisor and writes root-only `/etc/j41`; the abandoned promise keeps mutating the host while `quickCheck` reads it. README's "No manual configuration needed" cannot hold on Linux without root |
| med | F6 — `markup`, `network.capabilities`, `session` limits and `workspace` are prompted for by the Custom Template Builder, saved into `config.json`, and then dropped by `setup`'s template merge; `setup` exposes no flag for any of them |
| low | F8 — README:38's "hang mid-registration" is wrong (the image is referenced only at `cli.js:8408`), and there is no image or daemon preflight anywhere |
| low | F9 — the dashboard Start button's 2.5 s liveness window is shorter than the first-run security setup's own 10 s timeout, so the first start always reports success |
| low | F10 — `init -n <non-numeric>` → `✅ NaN agents initialized`, nothing created |
| low | F11 — `install.sh` clones the git worktree into `~/.j41/dispatcher`, the runtime data dir, and pins `J41_VERSION="2.0.0"` against a `2.19.0` package |
| low | F12 — `quickstart` persists the runtime string unvalidated; anything but exactly `local` means docker |
| — | X1 *(out of domain)* — `cli.js:7380` calls `startJob(state, agentInfo, fullJob)`; signature is `(state, job, agentInfo)`. On `bounty.awarded` the job is accepted, signed and allowlisted, then never starts: `agent-1`…`agent-9` fail `isValidJobId`'s 8-char floor and early-return; `agent-10`+ pass and throw on `job.buyerVerusId === undefined`. The other three call sites are correct |

**Claims checklist outcome:** 61 claims — 32 VERIFIED · 26 DRIFT · 3 MISSING ·
0 UNVERIFIED, plus 5 items recorded-not-reported. 9 rows are marked *(prior)* and cite
docs-truth D1/D2/D3/D14 + C7, isolation C1/C2-C6/I5/I7/I9/I10/I11, liveness
(PID file), trust-boundary (canary), scale S15.

**Shape of the domain.** Every earlier pass found a control applied at one site
and not its twin. This one finds a single repeated defect with a different
shape: **the first-run path detects the problem correctly and then reports
success.**

- No funds → detected, warned about, and recorded as `vdxf_published` (F1).
- No model → detected by the key check, and answered with canned filler that is
  then delivered and hashed as the work product (F2).
- Security setup aborted → `{success:false}` returned, discarded, `✓` printed,
  `SECURITY CHECK FAILED` printed eight lines later (F4).
- No Docker → detected by the installer, persisted as a runtime that accepts
  money and cannot deliver (F7).

In each case a correct detection exists *and is thrown away at the call site*.
F4 is the purest instance: the identical library return value is consumed
correctly in `dashboard.js:2127` and dropped in `cli.js:3459`.

The second theme is **collected-then-discarded input**: quickstart's API key
(F3) and the Custom Template Builder's markup / capabilities / session /
workspace answers (F6). Both are documented as the primary configuration
surface; both write the operator's answers somewhere that the consuming path
never reads.

F1 is the one to fix first. It is unconditional — every first agent hits it —
it is silent, it produces an agent whose on-chain identity is empty, and the
documented recovery (`finalize` again) is a guaranteed no-op because the failed
run marked the state `ready`. The two-line fix is `throw` instead of `return`
at `cli.js:1107`.

F2 is the one with a buyer on the other side of it.

**Files read in full:** `README.md` (first-run sections), `setup.sh`,
`scripts/install.sh`, `scripts/build-image.sh`, `src/config.js`,
`src/config-loader.js`, `src/preflight-gate.js`, `src/llm-health.js`,
`src/job-id.js`, all five `templates/*/config.json`. `src/cli.js` — secure-setup
require 105-111, paths 113-117, allowlist 147-200, `ensureDirs` 382-410,
`buildFullProfile` 559-619, `buildServiceFromOptions` 849-880,
`createFinalizeHooks` 1012-1140, `getActiveJobs` 1142-1172, `quickstart`
1278-1348, `init` 1351-1408, `register` 1411-1589, `finalize` 1592-1673,
`recover` 1676-1690, `setup` 2715-2963, `start` 3109-3260 + 3420-3520,
`loadAgentCapabilities` 4850-4925, poll accept 6752-6766, bounty webhook
7351-7389, `buildContainerEnv` 7920-7975, `reportSpawnAttachFailed` 8219-8228,
`startJobContainer` 8231-8260 + 8395-8435 + 8540-8582, network mode 8099-8111,
`startJobLocal` 8715-8740, `startJob` 8994-9001, entry point 10950-10958.
`src/dashboard.js` — `mainMenu` 187-239, agent list 241-246,
`createCustomTemplate` 968-1110, `addAgentScreen` 1111-1212,
`configureLLMProvider` 1848-1932, `securityScreen` 2072-2165, `main` + Start
button 2948-2997. `src/executors/local-llm.js` 14-74 + 115-137 + 205-256 +
503-525, `src/executors/mcp.js` 48-60. Dependency code read for verification:
`@junction41/sovagent-sdk` — `dist/agent.js:426-535` (onboard handshake),
`dist/onboarding/finalize.js:258-345` (stage machine),
`dist/onboarding/vdxf.js:368-441` (`buildAgentContentMultimap`);
`@junction41/secure-setup` — `lib/index.js:68-92` (root requirement) +
`103-122` (`isInitialized`) + `132-290` (`setup`), `lib/quick-check.js:1-140`,
`lib/deploy-profiles.js:77-122`.

### Deliberately NOT covered, and why

- **`recover <agent-id>`'s full body** (`cli.js:1676-1878`). Read only its
  entry guards. It is the *second* thing a first-run operator touches, and only
  after a registration timeout — a path this pass could not reach without a
  live platform. Worth its own look alongside `inbox-deadletter.js`.
- **`interactiveProfileSetup` / `interactiveOnboarding`** (`cli.js:~700-1010`).
  Read only where a claim touched them (markup at 767/787, workspace at
  756-758, the assembled profile at 836-839). The 26-field interactive
  walkthrough is a large surface whose failure mode is a bad prompt, not a bad
  state; the headless/template path is what the README recommends and what the
  TUI actually spawns, so that is where the pass went.
- **`api-setup` and the API-endpoint proxy first run** (`cli.js:3002-3100`).
  Menu item [18], a distinct product (selling GPU/compute) with its own deposit
  and pricing machinery. Not on the path to a first *job*.
- **`encrypt-keys` as a first-run step.** README:440 calls at-rest encryption
  opt-in and the keys pass owns it (K1/K2/K7). The unlock prompt's interaction
  with a dashboard-spawned dispatcher is already handled and documented at
  `dashboard.js:2976-2996`.
- **Anything requiring execution.** Read-only per the audit rules: no
  `npm pack --dry-run`, no `node --check`, no `docker build`, no network calls,
  no running of `quickstart`/`setup`/`start`. F1's "zero UTXOs on a fresh
  keypair" and F2's "empty apiKey reaches the container" are both traced
  statically through the assignment chain; each is one `console.log` away from
  runtime confirmation if wanted.
- **The seccomp/AppArmor profile contents and `secure-setup` as a package.**
  Same boundary the isolation pass drew (I11 and its notes). This pass read only
  the four entry points a first `start` calls — `setup`, `quickCheck`,
  `isInitialized`, `deployProfiles` — to establish what the README's seven-step
  claim actually resolves to.
- **X1's blast radius.** Confirmed the argument order, the signature, and the
  two `isValidJobId` outcomes. Did *not* trace whether the accepted-then-unstarted
  bounty job is later refunded, reconciled or dead-lettered — that is liveness /
  money territory and should be picked up there.
- **Style, prose and UX opinion.** "Setup should print the funding address" is a
  fix proposal attached to F1, not a standalone finding. Nothing in this file is
  reported on taste.

---

## mass-onboarding — 2026-09-04 — DONE

Artifacts: `AUDIT/mass-onboarding.md` (findings + plan threat model + clean
list), `AUDIT/mass-onboarding-claims.md` (70 claims across 11 groups).

**Counts by severity:** crit 0 · high 2 · med 5 · low 2 · total 9

| Sev | Finding |
|---|---|
| high | MO1 — shipped `install.sh` clones 404 `github.com/junction41/…` into the runtime data dir and falls through to a `vlatest` tarball that is not a release |
| high | MO2 — Docker EACCES is collapsed into "no Docker" / "image not built" / "switch to local"; installer still silently writes `runtime=local`; `config --runtime local` has no warning |
| med | MO3 — `secure-setup` labels every non-Linux distro `macos`; win32 takes the Docker Desktop VM branch |
| med | MO4 — TUI Start/logs hardcode `/tmp/dispatcher.log` + `tail -f` (Windows throw, `/tmp` precreate race) |
| med | MO5 — CLI never refuses Node < 20; Ubuntu apt Node 18 loses the security gate silently (pairs I11) |
| med | MO6 — no clock preflight; 65 min skew kills signed login as "challenge expired" |
| med | MO9 — `install.sh` pipes unsigned nvm/NodeSource/get.docker.com to bash with no checksums; `usermod docker` without root-equivalent disclosure |
| low | MO7 — TUI header "N registered" counts every local `keys.json` |
| low | MO8 — `build-image` is `spawn('bash', [script])` |

**Claims checklist outcome:** 70 claims — 28 VERIFIED · 24 DRIFT · 14 MISSING
· 4 UNVERIFIED. 11 rows are *(prior)* and cite first-run F4/F5/F7/F8/F9/F11/F12,
isolation I4/I11/I12, docs-truth D1 (fixed), scale S15.

**Shape of the domain.** Current `main` already has the two *runtime* gates
the 2026-08-10 first-run pass demanded: `start` refuse-before-accept on
`runtime=local` without `--dev-unsafe`, and refuse-without-job-image. Dashboard
Start cannot pass `--dev-unsafe`. `HOME_GPU_NO_DISK_QUOTA` is still fail-closed
(including Docker 29 `overlayfs`). Those are checked-clean and must not regress.

What is still broken is the **door**, which is the thing the proposed
installer-first plan is about to put in front of every stock user:

- `scripts/install.sh` now *ships* in the npm tarball (D1's `files` fix) and
  still cannot install (404 clone, `J41_VERSION=latest` is not a GitHub tag,
  silent `runtime=local` on `curl | bash`, `init -n 9` as next step, unsigned
  nvm/NodeSource/get.docker.com pipes).
- Docker permission errors are not a distinct state, so the printed remedies
  *create* the F7 config the start-gate then correctly refuses — a brick, not
  a paid-job bug.
- There is no `doctor`, no `install.ps1`, no Node version gate, no clock
  check, and win32 is handled as macOS.

The documented `yarn global add @junction41/dispatcher` path still works for
an operator who already has Node ≥ 20 and Docker group membership. The live
trap is unscoped `j41-dispatcher@2.0.0`. Plan alias is the safety net, not a
substitute for a working installer.

**Plan MUST-FIX-BEFORE-SHIP (installer/doctor/TUI), condensed:** rewrite
`install.sh` (npm user-prefix, no data-dir clone, no silent local, checksums,
refuse root, ENOENT vs EACCES); CLI Node ≥ 20 gate; npm alias of unscoped
name; `src/doctor.js` shared with TUI (no secrets, no local-as-prod, clock
vs API Date); `build-image` in Node; TUI log under `~/.j41/dispatcher/`;
win32 ≠ macos; macOS ≤ 13 fail closed; honour `setup()` `{success:false}`
(F4) and stop the 10 s mutate-after-timeout (F5); GPU quota script
Linux-only with typed consent, do not relax `HOME_GPU_NO_DISK_QUOTA`.

**Files read in full:** `scripts/install.sh`, `setup.sh`, `scripts/build-image.sh`
(head + docker check), `package.json`, `src/config.js`, `src/docker-host.js`,
`src/mainnet-guard.js`, `src/cli.js` (runtime/getActiveJobs 123-131 + 1240-1270,
config 1278-1300, quickstart 1391-1514, init 1517-1583, inspect local 3221-3242,
setup funding 3601-3609, build-image 4066-4166, start gate + image/jail
preflight + first-run security 4170-4817, startJobContainer docker 10608-10614,
startJobLocal gate 11138-11154), `src/dashboard.js` (getAgents 84-96, header
265-298, resolveDispatcherLogPath 865-878, status registered split 954-958,
Start/logs 3898-4000), `j41-secure-setup/lib/detect-platform.js`,
`lib/index.js` (setup + marker 68-296), `lib/quick-check.js`; README Install /
Quick Start / Runtime Modes / Local Mode / First-Run Security / Friend boot
Storage; CLAUDE.md Quick Reference + data dirs. SDK clock:
`sovagent-sdk/dist/agent.js:349-356`, `dist/crypto/canonical.js:28,149-153`,
`dist/webhook/verify.js:49-57`. Prior: `AUDIT/first-run.md` F1–F12,
`AUDIT/state.md` first-run + docs-truth D1.

### Deliberately NOT covered, and why

- **Re-opening F1–F12 as new findings.** Procedure. F7 start-gate and F8 image
  preflight are fixed; F7 installer half, F4, F5, F9, F10, F11, F12 are cited
  as prior and still load-bearing for the plan.
- **Money / keys / isolation / trust-boundary / liveness / scale internals**
  except where an onboarding surface is the trigger (MO4 vs S15, MO5 vs I11,
  MO2 vs F7).
- **`recover`, 26-field interactive onboarding, Cat-2 `api-setup`.** Not the
  stock labour first-run.
- **npm publish tokens, 2FA, provenance.** Out of scope (operator note).
- **Windows named-pipe ACL matrix and ExecutionPolicy.** No `install.ps1` to
  read; claims J2–J3 MISSING/UNVERIFIED.
- **Platform-side window on `J41-ACCEPT` timestamps.** Verifier is
  `api.junction41.io`.
- **Unscoped `2.0.0` tarball internals.** Live that it installs; not this tree.
- **Running any code.** Read-only. No `npm pack`, no `node --check`, no docker,
  no network. GitHub 404 of `junction41/j41-sovagent-dispatcher` is the live
  test already recorded plus the URL mismatch with `package.json` `repository`;
  not re-fetched.

---

## onboarding-2-leftovers — 2026-09-04 — DONE

Artifacts: `AUDIT/onboarding-2-leftovers.md`, `AUDIT/onboarding-2-leftovers-claims.md`.
Spec: `docs/superpowers/specs/2026-09-04-onboarding-2-leftovers-design.md`.

**Counts by severity:** crit 0 · high 0 · med 1 · low 1 · total 2

Follow-up same day: **O2-1 and O2-2 fixed in tree** (postinstall + TUI + empty-dir/dangling-symlink replace). secure-setup 0.3.0 still hardcodes paths; we satisfy them at install time.

| Sev | Finding |
|---|---|
| med | O2-1 — canary symlink is start-only — **FIXED** (scoped + alias postinstall, TUI securityScreen) |
| low | O2-2 — empty dest dir blocks symlink — **FIXED** (rmdir empty / unlink dangling, then symlink) |

**Claims:** 16 VERIFIED · 0 DRIFT · 0 MISSING. A5 qualified: LOW does not degrade; EMPTY lastError after startupComplete still does (pre-existing). E1 qualified: container smoke used `J41_SKIP_NPM=1`.

**Files read:** `src/fee-tank.js` (planFeeSweep), `src/doctor.js` (loadFeeTankRows, runDoctor), `src/cli.js` (start attach, checkFeeTanks LOW, hire fail, banner), `src/dispatcher-log.js`, `src/job-agent-path.js`, `src/control.js` (health lastError), `src/dashboard.js` (doctorScreen omit feeTankRows), `scripts/install.sh`, `test/install-container-smoke.test.js`, `node_modules/@junction41/secure-setup/lib/self-test.js` getDispatcherPaths.

### Deliberately NOT covered

- Publishing 2.37.1 / alias bump.
- Patching and publishing `@junction41/secure-setup`.
- Bare-metal stock Ubuntu VM (docker `ubuntu:24.04` used).
- `inspect` “No services registered”.
- Pre-existing `test/sign-channel-precreate.test.js` “replaced host slot” failure (untouched this pass; fails in isolation on this host).
- Re-litigating 2.37 Wave 0–2 (alias, installer rewrite, doctor existence).
