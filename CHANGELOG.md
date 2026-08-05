# Changelog

## Unreleased

## 2.10.0

**`wallet` — the manual money surface.** 2.9.0 made agents refill their own fee
tanks automatically, but an operator who saw `FEE TANK EMPTY and nothing to
sweep` still had no CLI path: no balance view anywhere (not in `inspect`,
`status`, `/health` or the TUI), no way to force a sweep, no way to fund an agent
that has never earned. Those operations were being done with hand-written
scripts. Now:

```
j41-dispatcher wallet                            # fleet tank table
j41-dispatcher wallet show <agent-id>            # addresses + per-UTXO detail
j41-dispatcher wallet sweep <agent-id>|--all     # force an i-to-R sweep
j41-dispatcher wallet send <from> <to> <amount>  # R-to-R between fleet agents
```

- `send` moves funds **between fleet agents only** — the destination is an
  agent-id resolved to that agent's own R-address. Raw addresses are refused: a
  typo'd destination on an irreversible transaction is the one mistake that
  actually loses money.
- Guards: reserve floor (a send may not leave the source under 100 writes
  without `--allow-drain`), self-send refusal, integer-only amount parsing, and
  a per-agent pending stamp that blocks a second spend until the first confirms
  (the platform serves the last *confirmed* UTXO view, so rebuilding from it
  double-spends). On mainnet, `send` refuses `--yes` and requires the amount to
  be retyped.
- Fee tanks now appear in `/health` per agent (`feeTank`) and on the TUI's
  Earnings screen. An empty tank does **not** degrade global `status` — an agent
  mid-onboarding legitimately has one.
- `null` vs `0` is preserved end to end: an agent that was never queried reports
  `—`/`null`, never `0`. Treating "we didn't look" as "the tank is empty" is how
  a second unnecessary transfer gets sent.

**Security fix — sweep destinations no longer trust the platform.** The sweep
took its destination as `u.address || keys.address`, *preferring* the platform's
`getUtxos()` response over local key material. Because `summarizeUtxos` decides
what is sweepable by comparing against that value, a wrong address reclassifies
every UTXO — R-address and i-address alike — as sweepable, the executor's
address-class guard passes (nothing matches), and the entire balance is signed
away to it. The daemon's auto-sweep broadcasts unattended every 30 minutes. The
benign variant is equally bad: an i-address returned here makes every sweep run
backwards, draining the fee tank and recreating the outage the sweep prevents.

Destinations are now derived from the WIF (`wifToAddress`) — the key that
actually signs — with the platform's value accepted only as corroboration and
any disagreement a hard refusal. Applied to the manual sweep, the daemon
auto-sweep, the send source, and the read path. This mirrors the SDK's existing
rule for identity updates, which already refuses a doctored API response.

**Other fixes from the same audit:** a per-agent lock so two concurrent CLI
invocations cannot both pass the stamp gate and double-spend; amounts capped at
2^50 satoshis, below the range where the SDK's `sats -> VRSC -> Math.round`
handoff is lossy (65,782 of the top 200,000 values under `MAX_SAFE_INTEGER` come
back off by 1-4 satoshis); `--all` and failed dry-run builds no longer exit 0;
`wallet show` resolves a pending stamp instead of reporting a confirmed tx as
pending; the TUI reuses the shared money formatter instead of a local one that
rendered `null` as `0.00000000`.

**Docs.** README's front page was a two-month-old security changelog instructing
new users to set four environment variables — one of which no longer exists, and
one of which (`J41_DISABLE_BWRAP=1`) the mainnet gate refuses to start with. That
block is gone; a fresh install requires no `J41_*` variables at all. Also
corrected: runtime default (`docker`, not `local`), 25 LLM presets (not 22), 26
VDXF keys (not 25, and `service.dispute` never existed), `IDLE_TIMEOUT_MS`
(480000, not 600000).

771 tests.

## 2.9.0

**Agents fund their own fees.** Job payments credit an agent's **i-address**;
identity-update fees are payable only from its **R-address**, so the R-address
only ever drained — at 0.0001/write — and nothing refilled it. An agent that ran
dry went silent on-chain (no reviews, attestations or job records) while still
holding unswept earnings. Observed live on agent-6, which dead-lettered three
valid inbox items for it.

- **`src/fee-tank.js` (new) — i→R sweep, on by default.** Checks every 30 min and
  sweeps when an agent can afford fewer than `floor_writes` (default 100) writes.
  **Self-funding by construction**: it pays its own fee out of the inputs it
  spends, so it works at a zero R-balance — which is exactly when it is needed.
  Refuses R-address inputs. Runs in both poll and webhook mode, with a startup
  pass so a dispatcher restarted *because* an agent ran dry does not stay dry for
  another half hour. Flags `--no-fee-sweep`, `--fee-sweep-floor <writes>`,
  `--fee-sweep-interval <minutes>`; `[fee_sweep]` in `config.toml`; env
  `J41_FEE_SWEEP`, `J41_FEE_SWEEP_FLOOR`, `J41_FEE_SWEEP_INTERVAL_MS`. See
  README → "Wallets & Fee Tank".
- **The `_MS` suffix on the interval env var is load-bearing.** The CLI flag takes
  **minutes**; the config/env value takes **milliseconds**. An unsuffixed name
  invited `=30` meaning 30 minutes, which would have landed as 30 ms and clamped
  to a 1-minute cadence — 30× the fleet-wide `getUtxos`/auth traffic.
- **`J41_FEE_SWEEP=true` silently disabled the sweep.** The `bool1` override kind
  is `raw === '1'`. Default-ON safety features now use a word-tolerant `bool`.
- **A dry fee tank no longer dead-letters valid work.** The SDK throws it as a
  bare `Error` — no code, no statusCode — so `inbox-deadletter.js` classified it
  `hard` and burned the per-item dead-letter budget. It is now `transient`, with
  `isFundingFailure()` giving the operator the address and the remedy instead of
  a generic batch-failure line. The legacy non-batched inbox path exempted only
  `contention`, so it reproduced the incident verbatim wherever
  `acceptInboxBatch` is unavailable; it now exempts everything but `hard`.
- **Fee alerts retract.** Two different prefixes described one condition and
  nothing cleared `_agentErrors` but a successful activation. Unified, cleared on
  tank recovery and on batch success, prefix-scoped so it cannot erase another
  subsystem's error. Funding failures now also reach the control-API event ring.

An agent that has **never earned** cannot self-fund — it logs `FEE TANK EMPTY and
nothing to sweep — fund <R-addr> externally` and needs a one-time operator
transfer to its R-address.

## 2.8.2

**Container teardown is now observable.** Requires the rebuilt `j41/job-agent` image.

- **Canary release logs its outcome.** It returned a bare boolean and logged nothing, so a
  teardown could not be told to have released the SovGuard canary or failed to. All three
  teardown paths now log, and the four outcomes are distinguishable — critically, a platform
  outage reads as `lookup failed: <err>` rather than `no registration found`, which would have
  sent an operator hunting a registration bug during an outage.
- **A skipped release is stated.** The release sits inside the same `try` as the attestation,
  so an attestation throw skipped it wordlessly — on the path most likely to be broken.
- **Startup build stamp** — `Build: job-agent 2.3.0 | SDK 2.14.1`. Establishing which code ran
  in a given container previously required a docker-events dig, because the old and new
  teardown paths emit an identical success string.

## 2.8.1

**All agents now load their on-chain dispute policy.** Requires
`@junction41/sovagent-sdk@2.14.1`.

5 of 9 agents logged `no dispute policy on-chain — disputes will log only` even
though the flat `agent.disputePolicy` key was present and well-formed on every
one of them. The SDK misdetected any pre-2026-03-28 identity as legacy-format —
the legacy parent key never disappears from the aggregated `getMyIdentity` view —
and the legacy decoder does not know the flat keys. Their `displayName` was
dropped the same way.

This gated dispute handling on the OLDEST, most-used agents, and it is a
prerequisite for `DISPUTE_RESOLVER_ENABLED`: an agent without a loaded policy
degrades to log-only.

## 2.8.0

**Round-4 prep: three job-container defects fixed.** Requires
`@junction41/sovagent-sdk@2.14.0`.

- **Deletion attestations are produced on SIGTERM and timeout again.** Both
  shutdown handlers used the older `getDeletionAttestationMessage()` →
  `signMessage("J41-DELETE-…")` flow, which the signing broker CORRECTLY refuses.
  Only the normal-completion path had been migrated, so **every abnormally
  terminated job silently produced no privacy proof** for `private`/`sovereign`
  tiers — swallowed by a bare catch. All three paths now share one implementation.

- **A transient startup response no longer kills the container permanently.**
  `getJob` is retried (5 attempts, 3s base), with the completeness check *inside*
  the retried call — the observed failure was a resolved response with missing
  fields, which never throws. Five containers died this way, each stranding a
  paid job; both clusters landed inside `CHAIN_SYNCING` windows.

- **SovGuard canary registrations are released on teardown.** Nothing ever called
  `deleteCanary`, and the cap is 5 per agent, so **every agent past its 5th job
  ever ran with SovGuard-side leak detection silently off** (one slot was still
  held from 2026-03-15). Release happens *after* the attestation — the SIGTERM
  grace period can be 5s and `deleteCanary` can hang for 30s, and the privacy
  proof matters more. Abandoned slots (older than 25h) are purged so registration
  can recover on agents already at the cap; a canary belonging to a **concurrent**
  job is never touched. Registration failure now says leak detection is DISABLED
  for that job rather than a bland "non-fatal".

- New `src/job-agent-teardown.js` with explicit dependencies, so container
  teardown is behaviourally testable instead of regex-asserted.

**Known, unchanged:** idle-pause/respawn churn (deferred — bounded, needs a
container/host shared-state design). Note it interacts with the attestation fix:
each respawn now submits its own deletion attestation, truthful per container
instance, so a job may produce several.

## 2.7.3

**Two failures that reported success while the real outcome was silent.**

- **`TX_REJECTED` is no longer classified as chain contention unconditionally.**
  Contention never counts toward the dead-letter budget and never escalates, so a
  permanently malformed transaction retried every cycle forever — no dead letter,
  no health signal, nothing in the event ring. This is what hid the contentmultimap
  key-ordering bug (`-25 bad-txns-failed-precheck`) while every new-key write on
  every agent failed. The classifier now reads the daemon's reason from
  `error.detail`: spent-inputs/mempool-conflict stay contention, malformed-tx
  reasons become hard failures that dead-letter loudly, and a named-but-unknown
  reason defaults to hard. A rejection with no detail (older platform) keeps the
  previous behaviour. Requires `@junction41/sovagent-sdk@2.13.1`.

- **`ctl shutdown` could announce success and keep running.** It logged
  `✅ No active jobs. Shutting down.` and then polled for 27 more cycles with
  `/health` still answering 200. A startup race: the shutdown handler's state was
  declared after the control server that triggers it, so a shutdown arriving during
  startup hit a TDZ and became an unhandled rejection. A "restart" that leaves the
  old process alive means two dispatchers writing identity transactions against the
  same `prevOutput` — the exact double-spend class 2.7.0 exists to prevent.
  Shutdown now always terminates: state declared first, a startup gate that exits
  immediately rather than half-draining, every cleanup step guarded, and a 30s
  watchdog.

- **New log line `✅ Startup complete — graceful shutdown enabled.`** `Ready agents: N`
  appears *before* the on-chain activation pass and is not a safe-to-stop marker.
  Scripted restarts should wait for the new line.

## 2.7.2

**Requires `@junction41/sovagent-sdk@2.13.1`** — 2.7.1 pinned 2.13.0, which did NOT
contain the contentmultimap key-ordering fix. On a daemon that enforces canonical
key order, 2.7.1 cannot write any VDXF key an identity does not already have:
`update-profile` fails, and so does the first `review.record` / `review.attestation`
/ `job.record` write to a fresh agent. Upgrade.

- `update-profile` gains `--dispute-policy <json|default>`. Validated before
  broadcast (enum values, ranges, integer cycles) — a malformed policy on-chain is
  worse than none, since the dispatcher loads it and acts on it, whereas an absent
  one degrades to log-only. `default` writes the same policy `setup` does.
- All 9 test agents now carry an on-chain dispute policy; previously every one
  logged `no dispute policy on-chain — disputes will log only`, because adding the
  key was impossible.

## 2.7.1

**`update-profile` was completely broken; fixed.** Requires
`@junction41/sovagent-sdk@2.13.0`.

The SDK's `removeAndRewriteVdxfFields()` used a two-transaction flow —
`contentmultimapremove` (action 3), wait a block, then write. As of 2026-08-04
the remove transaction is rejected by the network (`400 TX_REJECTED`, daemon
`-25 bad-txns-failed-precheck`), so no profile update could complete on any
agent. It is now a single transaction.

**If you installed 2.7.0 from npm, `update-profile` does not work** — it pinned
SDK 2.12.0, which still contains the broken path. Upgrade.

- `update-profile` no longer prints "Remove TX" or "Blocks waited" (neither
  exists now), and no longer waits up to 20 minutes for an intermediate block.
- `--dry-run` resolves field names with the same `resolveVdxfFieldRef` the real
  run uses, so it now predicts the real outcome — including the error on an
  unknown or ambiguous field name.
- Verified live: agent-3 `b7d49d25`, agent-7 `9e890c6d` (a profile field and
  `review.record` written together in ONE transaction), agent-4 `4294bfc8` via
  the CLI. No contentmultimap key, current-state review, or history entry was
  lost in any of them.

**Not gated:** `update-profile` does not route through the inbox pending-write
confirmation gate. Do not run it while the dispatcher has an unconfirmed
identity write for the same agent — check `/health` `pendingWrites` is empty
first.

## 2.7.0

**Inbox writes are now batched — one identity transaction per agent per poll
cycle.** Requires `@junction41/sovagent-sdk@2.12.0`.

The old loop accepted inbox items one at a time, writing N transactions to the
same VerusID back-to-back. The first spends the identity `prevOutput` and sits in
the mempool, but the platform API keeps serving the last *confirmed* `prevOutput`
— so every transaction after it is built spending an already-spent output and the
daemon rejects it as a double-spend. Live-observed on 3 of 3 agents: an
attestation landed, the review that followed milliseconds later was rejected five
times and dead-lettered, and its on-chain reputation data never arrived. The
platform's confirmed view was measured stale for **over five minutes**, past the
confirming block's own timestamp — so no block-time estimate is safe as a retry
horizon.

- **Batching** via the SDK's `acceptInboxBatch`, with per-item failure handling:
  a poisoned item is rejected alone while healthy items still write.
- **Pending-write gate** — never build a second identity transaction while the
  previous one is unconfirmed. Releases on observing `prevOutput` become our
  txid, or on chain height passing the transaction's `expiryHeight`; a 4h
  wall-clock backstop covers a concurrent writer confirming on top of ours.
- **Failure classification** — chain contention no longer consumes the terminal
  dead-letter budget. Burning five attempts on a self-resolving condition is
  exactly how the three reviews were quarantined.
- **Bounded escalation** — batch-level failures are not attributable to one item
  so they are uncounted, but *uncounted must not mean unbounded*: five
  consecutive same-composition **hard** failures start counting items
  individually. Contention and transient/environmental faults never escalate, so
  an unfunded wallet cannot quarantine an inbox.
- **Structured `/health` inbox block** (`deadLettered`, `retrying`, `ackFailed`,
  `pendingWrites`) plus `ctl inbox` and `ctl inbox-redrive [--item <id>]`.
  `status` becomes `degraded` while anything is dead-lettered — **note for
  monitoring: anything alerting on `status != ok` will now fire on dead
  letters.** Redrive clears quarantine without a restart. The previous surface
  was a single per-agent `lastError` string that lost every failure but the
  newest.
- **Reentrancy guard** on the inbox sweep — `safeInterval` is a plain
  `setInterval`, so a sweep slower than the 60s floor would overlap the next one
  and race the gate.

Skew-safe: running against an SDK without `acceptInboxBatch` falls back to the
per-item path, still with contention classification — strictly better than 2.6.0
even mis-paired.


## 2.6.0

**Operators must upgrade to 2.6.0 before Junction41 enables its dispute
resolver.** Earlier versions have no `queueDisputedJobForRespawn`, so a
torn-down agent never respawns to answer a dispute — under the resolver that
reads as silence and results in an auto-default and a hire suspension.

- **SDK dep bumped to `@junction41/sovagent-sdk@2.11.0` — required, not
  optional.** The worker-attach ACK path calls `confirmWorkerAttached()` and
  `reportWorkerAttachFailed()`, which first ship in SDK 2.11.0. On any 2.10.x
  SDK those methods are `undefined`, the ACK never reaches the platform, and
  `jobs.worker_attached_at` stays `NULL` for every job — which in turn keeps
  dispute-refund eligibility permanently ungated. Pin 2.11.0 or newer.

- **sovcompute credit-low notify (edge-triggered).** The proxy now fires a
  one-time, **signed** `POST /v1/webhooks/dispatcher/credit-low` to J41 the
  moment a buyer's prepaid balance crosses **below** the threshold after a
  request (edge-triggered — debounced so a buyer parked under the line doesn't
  re-notify every call). Threshold is `[proxy] credit_low_threshold_vrsc`
  (`J41_PROXY_CREDIT_LOW_THRESHOLD`); `null` falls back to
  `suggested_topup_vrsc`. Body is RFC-8785 canonicalized and seller-signed,
  matching the deposit-confirmed signing pattern. Best-effort / non-fatal — a
  notify failure never blocks the proxy response.

- **fix: `notifyJ41DepositConfirmed` deposit-confirmed notifies had never
  fired.** The json-canonicalize import was `const canonicalize =
  require('json-canonicalize')` — but the module exports `{ canonicalize }` (an
  object, not a callable). Calling `canonicalize(payload)` threw "canonicalize
  is not a function", which the surrounding best-effort `try/catch` swallowed
  silently — so **every deposit-confirmed J41 notify had been a no-op**. Now
  `const { canonicalize } = require('json-canonicalize')`. Both the
  deposit-confirmed notify and the new credit-low notify produce correct
  canonical signed bodies and actually reach J41.

- **jailbox parked (default-off).** The "agent works inside the buyer's
  environment" sandbox (legacy `workspace.*`, aka jailbox) is parked in favour
  of deliver-and-review and now defaults **OFF** behind the new
  `jailbox.enabled` config flag (`JAILBOX_ENABLED=1` to re-enable). The
  dispatcher refuses to start a jailbox session — clear `[JAILBOX]` log, no
  `workspace_ready` forwarded — gated at the single dispatcher choke point
  (`checkWorkspaceCapability`) and the single in-container funnel
  (`connectWorkspace`, flag forwarded via `buildContainerEnv`). **Not deleted,
  re-enablable, and the hash-chained signed audit-log / attestation machinery is
  retained intact** as proof-of-process. See `JAILBOX_PARKED.md` and docs spec
  `2026-06-12-vdxf-v2-schema-design` §3b. When the flag is on, behaviour is
  unchanged.

## 2.2.0 — 2026-06-02 security audit

This release closes 6 highs + ~15 mediums/lows from the 2026-06-02 cross-repo security audit. Behavioral changes operators should know about:

**Per-job WIF temp copy is now cleaned up + mode 0600** (H1). Previously `/tmp/j41-keys-<jobId>/keys.json` was created mode 0644 and never removed — operators ended up with an accumulating stash of plaintext WIFs. `stopJobContainer` now `rm -rf`s the dir on every stop path (success + failure), and the mode is tightened (container runs as the dispatcher UID — 0644 was historical).

**`sign-channel-host` validates container-supplied response ids** (H2). The container sets `req.id` and it's used in the response file path; the previous code allowed arbitrary host-side file writes via `../../../tmp/pwned` style ids. Now matched against `[a-f0-9-]{1,80}`.

**`broker-executors.jobCompletionUpdate` shape-validates the container blob** (H6). Container-supplied `jobRecord` must only contain a known allow-listed set of keys (jobHash/timestamp/completedAt/amount/currency/buyer/seller/status/reviewerSignature); unexpected keys throw. `reviewRecord` and `workspaceAttestation` type-checked.

**`@junction41/secure-setup` pinned to exact `0.3.0`** (H5). The previous `>=0.1.0` would auto-resolve any future malicious release.

**Bumped SDK to 2.5.0** with its own breaking changes (see that package's README).

**Family 3 normalizer at two sites** (M-auth-2/3): `deposit-watcher.js` `senderVerusId` vs `buyerVerusId` and `cli.js` API-access revoke `buyerVerusId` now `trim+lowercase+strip-trailing-@` before comparing. Catches `'buyer.agentplatform@'` vs `'buyer.agentplatform'` mismatches that the backend's `4b1f334` Family 3 fix flagged.

**Deposit-watcher refuses signature-only credit by default** (M-funds-1). When the platform's `verifyPayment` response omits `senderVerified`, we no longer credit on signature auth alone — an attacker who observed a public funding tx could otherwise self-credit. Override with `J41_DEPOSIT_ALLOW_AUTH_ONLY=1` while the platform side updates.

**New ingest caps**: `J41_CTL_MAX_BUFFER_BYTES=64KB` (control socket), `J41_SIGN_REQ_MAX_BYTES=256KB` (broker req), `J41_JOB_DESCRIPTION_MAX_BYTES=1MB`, `J41_MAX_JOBS_PER_POLL=200`.

*Historical note:* this release documented temporary compatibility env vars for the platform transition. They are obsolete: `J41_REQUIRE_PLATFORM_SIGNER` no longer exists in any package, and the remaining flags are legacy security opt-outs documented (and discouraged) in README → Security → Legacy opt-outs.

## 2.1.15 — 2026-05-26

**Broker file-channel transport — opt-in.** The new `J41_SIGNING_BROKER=1` env var routes all in-container signing through a file-IPC channel to a host-side `SignChannelHost`, keeping the agent WIF on the dispatcher host and out of the job-agent container's filesystem entirely. Default remains off; the legacy `keys.json` bind mount is still the only behaviour you get without the flag. Cuts the in-container blast radius — a fully-compromised job-agent cannot exfiltrate the WIF or forge identity-bearing signatures for other jobs (broker rebuilds canonical accept/deliver/dispute message bytes from authoritative platform state and refuses container-supplied protocol-formatted text).

End-to-end testnet validation pass closed 8/8 runbook gates (see `docs/BROKER-DOCKER-VALIDATION.md`). Five backend bug families surfaced and were fixed in flight during validation; the dispatcher-side fixes in this release:

- **`User: <uid>:<gid>` at the top level of `createContainer`** (was nested under `HostConfig` where the Docker engine silently ignores it — container was falling through to the Dockerfile's `USER j41-agent` and EACCESing on bind-mounted job files).
- **Poll loop merges `status:in_progress` jobs** (default `getMyJobs({role:'seller'})` excludes them server-side, so jobs paid in another session became invisible).
- **Post-delivery IPC routes through `_postDeliveryHandler` in Docker mode** (`process.on('message')` never fires under Docker — file-poller messages were sitting in `ipcQueue` unprocessed; container couldn't observe `job.completed`).
- **`performCleanup` uses `attestDeletion` via `signAttestationWith`** (JCS-canonicalized bytes, not `J41-DELETE-...|...` protocol-formatted — the broker's `assertNotProtocolMessage` signing-oracle guard correctly refused the old raw-`signMessage` call).
- **Container's on-chain identity-update step deferred to the host Inbox processor in broker mode** (was double-broadcasting the same `job.record` VDXF; host's `acceptJobRecord` is the canonical writer in broker mode).
- **`deletion-attestation.json` written before submit attempt** (so the on-disk artifact survives a platform-side validation failure unrelated to signing).
- **Operator env-var gates**: `J41_NO_STATUS_TOGGLE=1` skips startup activate-all + shutdown deactivate-all loops (don't ping-pong agent platform state across restarts; don't fire an on-chain identity-update tx for every managed agent at boot). `J41_DISABLE_BWRAP=1` skips the bubblewrap entrypoint wrapper (the bwrap `--ro-bind /app /app` re-mount can obscure bind-mounted job-dir permissions during debugging).
- **SDK dep bumped to `@junction41/sovagent-sdk@2.4.0`** (RemoteSigner hook is the container-side counterpart of the broker transport).

Cutover sequence remains as documented in the runbook — this release ships broker as opt-in only. Default-on flip lands once a release cycle of opt-in soak shows no broker-related errors.

## 2.1.14 — 2026-04-28

**Resilience patch.** Two fixes addressing economic-griefing vectors that bite at scale:

1. **Per-buyer rate limit at the proxy.** Token bucket keyed by `buyerVerusId`. Defaults: 10 RPS per buyer, 30-burst. Configurable via `[proxy]` keys `rate_limit_rps`, `rate_limit_burst`, `rate_limit_max_buckets` (default 10k LRU cap on distinct buyers tracked). Idle buckets evicted after 5 min, LRU-evicted at the cap. Returns HTTP 429 with `Retry-After` header. Prevents a buyer with valid auth from saturating the upstream + draining their own credit on errors.

2. **Circuit breaker on proxy → upstream.** `upstream-health.js` was already polling `/models` every 60s but the proxy never gated on the result. Now: after `circuit_threshold = 3` consecutive failed probes, `circuitOpenedAt` timestamp is set and the proxy returns 503 immediately for `circuit_open_ms = 30s` instead of forwarding to a dead upstream. After the open window expires, traffic flows through (half-open via real requests). On any successful probe, `circuitOpenedAt` resets to null and the circuit closes.

The `circuitOpenedAt` mechanic was a fix from plan review — the original draft used `lastCheck` (set every poll), which would have left the circuit permanently open. Now the timestamp is sticky from threshold-cross to next successful probe.

Pure additive — no breaking API/wire changes. Operators with default config get the protections automatically. 50 unit tests passing (was 40).

## 2.1.13 — 2026-04-28

**Security patch — required for mainnet.** Two fixes:

1. **Revoke webhook now requires HMAC signature.** Previously the `/j41/api-access/revoke` endpoint (introduced in 2.1.12) accepted unauthenticated POSTs — anyone with a dispatcher's public URL could revoke any seller's API keys for any known buyer. The endpoint now requires `x-webhook-signature: sha256=<hex>` header with the body HMAC-signed using the **seller's per-agent webhook secret** (same secret already used for `/webhook/:agentId` events since 2.0.x). Missing signature → 401. Wrong signature → 403. Unknown seller → 404. Backend coordination required (see below).
2. **Nonce replay protection on v2 access envelopes.** Dispatcher now tracks recently-seen nonces (in-memory, 11-min TTL = max envelope window + 1 min grace, 100k LRU cap). Replayed envelopes within their expiry window throw `v2 envelope rejected: replay` and the proxy refuses to mint a duplicate API key.

**Backend rollout order** (REQUIRED — do not invert):
1. Backend ships HMAC-signing on `DELETE /v1/me/api-access/:grantId` revoke fan-out FIRST (one-line change — the per-agent webhook secrets are already stored from `POST /v1/me/webhooks` registrations).
2. Then ship dispatcher 2.1.13. If dispatcher ships first, revoke calls return 401 until backend catches up — bad operationally but not a security regression.

40 unit tests passing (was 32; +4 nonce-cache, +4 revoke-webhook).

## 2.1.12 — 2026-04-27

**Revoke webhook endpoint** — closes the half-shipped revoke flow that the platform's `/api-access` dashboard now exposes. New endpoint:

```
POST /j41/api-access/revoke
Content-Type: application/json

{
  "sellerVerusId": "i...",
  "buyerVerusId":  "i...",   // optional; if set, revokes ALL active keys this buyer holds for this seller
  "apiKey":        "sk-..."  // optional; if set, revokes that exact key
}

→ 200 { "revoked": <number>, "buyerVerusId"?: "i..." }
```

Wired to `api-key-manager.revokeApiKey()` so the proxy refuses further requests with the revoked key. The platform's `DELETE /v1/me/api-access/:grantId` is the natural caller — when a buyer hits "Revoke" on the dashboard, J41 deletes its grant metadata and posts here to invalidate the key locally.

If neither `buyerVerusId` nor `apiKey` is provided, returns 400. If the seller isn't on this dispatcher, returns `{ revoked: 0, reason: 'seller-not-found' }` (200).

## 2.1.11 — 2026-04-26

**Root-cause fix for agent identity file permissions** (continues from 2.1.10).

The 2.1.10 audit on a real operator's machine surfaced 11/11 agent dirs at 0775 and 2/11 `keys.json` files at 0664 — world-readable. 2.1.10 fixed the `mkdirSync(agentDir, ...)` call sites to pass `mode: 0o700`, but a deeper investigation showed the underlying issue had **four layers**:

1. **The dispatcher relied on the operator's `umask`** for files written without explicit mode. On Ubuntu's user-private-groups default (`umask 0002`), files default to 0664 and dirs to 0775 — world-readable. A different operator with `umask 0027` would have gotten 0750/0640. **Non-deterministic across deployments** — that's the real defect.
2. `mkdirSync(agentDir, ...)` calls without explicit mode (fixed in 2.1.10).
3. `writeFileSync(keys.json, ...)` writes that relied on a follow-up `chmodSync(0o600)`. The brief window between write and chmod was racy. One write (the registration-timeout path at cli.js:2673) had no chmod at all.
4. Files created by older dispatcher versions persist with whatever mode they were created at — chmod patches don't apply retroactively.

**2.1.11 fixes (defense in depth):**

- `process.umask(0o077)` at the very top of `cli.js` so the entire process produces 0700 dirs and 0600 files by default. Even if a future code path forgets `{ mode: 0o600 }`, it still gets a safe default.
- All 12 `writeFileSync(keys.json, ...)` call sites now pass `{ mode: 0o600 }` atomically. Eliminates the write-then-chmod race window.
- The defense-in-depth sweep in `ensureDirs()` (added in 2.1.10) continues to handle case 4 — re-locks any pre-existing bad-mode files on every CLI invocation.

After upgrading and running any `j41-dispatcher <subcommand>`, all existing agent files self-heal. New agents are created with strict modes regardless of operator umask.

## 2.1.10 — 2026-04-26

**Permission hardening for agent identity files.** A real-world audit on a host with 11 agents found:

- All `~/.j41/dispatcher/agents/<id>/` directories were created at mode 0775 (group-writable, world-readable). The dispatcher's `mkdirSync(agentDir, ...)` calls weren't passing an explicit `mode`, so the OS umask applied (typically 022). Three call sites patched to pass `mode: 0o700`.
- Two agents had `keys.json` at mode 0664 (world-readable) — likely from older dispatcher versions or upgrade paths that bypassed the chmod step.

Two fixes:

1. All three `fs.mkdirSync(agentDir, ...)` sites now pass `mode: 0o700` explicitly.
2. New defense-in-depth sweep in `ensureDirs()` (called on every CLI invocation) re-locks existing agent dirs to 0700 and any present sensitive files (`keys.json`, `agent-config.json`, `finalize-state.json`, `vdxf-update.*`) to 0600. Idempotent and silent — corrects past mistakes without operator action.

Real-world impact on a single-user host is limited (parent dir `~/.j41/dispatcher/` is 0700, blocking external listing), but on multi-user systems this was a meaningful exposure. After upgrading, just running any `j41-dispatcher` command (including `--version`) will trigger the sweep.

## 2.1.9 — 2026-04-26

- **Dashboard banner now shows version** (`J41 Dispatcher v2.1.9 — Setup & Management`). Operators can confirm what they're running at a glance without dropping to a shell.
- **Fixed `browse-bounties` crash** — `cli.js:6152` had the same `agents[0].id` bug pattern fixed in 3 other sites in 2.1.8. With the multi-agent loop fixes that shipped in 2.1.8, this was the last instance.

## 2.1.8 — 2026-04-26

Two bug fixes caught by live operator testing:

- **Fixed `setup` / `register` crashing on hosts with multiple registered agents.** Three duplicate-name check loops treated `listRegisteredAgents()` results as objects with an `.id` property, but the function returns plain string IDs. With ≥1 other registered agent, `loadAgentKeys(undefined)` would throw `TypeError: Cannot read properties of undefined (reading 'includes')` from the path-traversal validation. Patched all 3 sites (cli.js:1279, 1652, 2618).
- **Fixed `j41-dispatcher --version` always printing `2.0.0`.** Hardcoded string at `cli.js:995`; now reads from `package.json.version` so the flag actually reports the installed version.

## 2.1.7 — 2026-04-25

Security patch round — closed 3 protobufjs criticals (via dockerode 4→5 + yarn resolutions), 1 socket.io-parser high, and several moderates across the workspace. Verus-fork bitgo chain has 1 known unfixable high (documented).

## 2.1.6 — 2026-04-25

Hardcoded values pass: 10 magic numbers across the dispatcher are now configurable via `~/.j41/dispatcher/config.toml` and per-key environment variable overrides. No new features; this is a "make the knobs reachable" release.

### ⚠️ Breaking behavior change

**Implicit `maxConcurrent: 9` default removed.** Operators who never explicitly set `maxConcurrent` were silently capped at 9 concurrent jobs by a hardcoded default in `src/config.js`. After 2.1.6, the default is **unlimited** (`max_concurrent = 0`).

To preserve the previous behavior, add to `~/.j41/dispatcher/config.toml`:

```toml
[runtime]
max_concurrent = 9
```

Or to your existing `~/.j41/dispatcher/config.json`:

```json
{ "maxConcurrent": 9 }
```

**Why:** the historical `9` was arbitrary and conflicted with the new TOML schema. Surfacing it as an explicit operator decision is correct, even if upgrade migration is mildly painful.

### Behavior change (non-breaking, worth noting)

**Job-timeout warning now scales with timeout length.** Previously fired exactly 5 minutes before timeout regardless of job length. Now fires at 90% of timeout, never less than 1 minute before.

| Job timeout | Old warning | New warning |
|---|---|---|
| 60 min | 5 min before | 6 min before |
| 20 min | 5 min before | 2 min before |
| ≤11 min | 5 min before (could fire before job started!) | 1 min before (floor) |

The old behavior was buggy for short jobs — it could fire the warning before the job had a chance to do anything. The new formula always leaves at least 1 minute of warning.

### Configuration migration

For operators who were using `J41_EXECUTOR_TIMEOUT` to indirectly control proxy upstream timeout (because no proxy-specific knob existed), switch to the new dedicated env var:

```diff
- J41_EXECUTOR_TIMEOUT=300000
+ J41_PROXY_UPSTREAM_TIMEOUT=300000
```

`J41_EXECUTOR_TIMEOUT` continues to work but only affects the executor (n8n / langgraph / a2a / etc.), not the API proxy.

### New configuration keys

Schema additions to `~/.j41/dispatcher/config.toml`:

```toml
[proxy]
upstream_timeout_ms = 60000     # raise to 300000 for long local-LLM queries
estimated_input_tokens = 4000   # fallback when token counter unavailable
estimated_output_tokens = 2000  # fallback when no max_tokens in request body
suggested_topup_vrsc = 10       # X-J41-Credit-SuggestedTopup header default

[deposit]
poll_interval_ms = 60000        # how often to scan for new VRSC deposits

[health]
poll_interval_ms = 60000        # how often upstream-health pings each upstream

[webhook]
max_body_bytes = 1048576        # 1 MiB inbound body cap

[retry]
rate_limit_backoff_multiplier = 3   # multiplier on baseDelayMs for HTTP 429
```

All of these accept matching `J41_*` environment variable overrides:

| Env var | TOML key |
|---|---|
| `J41_PROXY_UPSTREAM_TIMEOUT` | `proxy.upstream_timeout_ms` |
| `J41_PROXY_ESTIMATED_INPUT` | `proxy.estimated_input_tokens` |
| `J41_PROXY_ESTIMATED_OUTPUT` | `proxy.estimated_output_tokens` |
| `J41_PROXY_SUGGESTED_TOPUP` | `proxy.suggested_topup_vrsc` |
| `J41_DEPOSIT_POLL_INTERVAL` | `deposit.poll_interval_ms` |
| `J41_HEALTH_POLL_INTERVAL` | `health.poll_interval_ms` |
| `J41_WEBHOOK_MAX_BODY` | `webhook.max_body_bytes` |
| `J41_RATE_LIMIT_BACKOFF_MULTIPLIER` | `retry.rate_limit_backoff_multiplier` |

### Internal

- `src/proxy-handler.js` now does a single `loadDispatcherConfig()` per request instead of three.
- `checkUpstreamHostSafe(hostname, cfg)` signature changed to take cfg (was internal to the file; no external callers).
- 31 unit tests passing (was 30 in 2.1.5; added one for the extended schema).

## 2.1.5 — 2026-04-25

- Migrated dispatcher config from `.env` (loaded into `process.env`) to `~/.j41/dispatcher/config.toml` (mode 0600, atomic writes, file-locked, 1s TTL cache). Provider API keys now never enter the dispatcher's own `process.env` and are forwarded to job containers explicitly via `docker run -e`.
- Auto-migration of existing `.env` files at install dir to `config.toml` on first start, with `# MIGRATED` banner on the legacy file.
- Removed install-dir `.env` auto-loader from `cli.js` (was the security regression vector that defeated the migration's intent if left in).
- Both container-launch paths (`startJobContainer`, `startJobLocal`) source provider keys from `cfg.provider_keys` instead of `process.env`-spread.
- `gitignore` now lists `config.toml` as belt-and-suspenders.

## 2.1.4 — 2026-04-25

- Full local fail-closed v2 canonical envelope verification at `/j41/discovery/request-access` (no trust-J41-forwarded fallthrough).
- Removed `J41_SKIP_SIG_VERIFY` env-var bypass entirely.
- `[CHAT-DEBUG]` log gated behind `J41_DEBUG_CHAT=1`, content-bytes logging removed (privacy fix).
- Dashboard Status & Health screen rewritten with backend feature-flag check + per-agent api-endpoint summary.

---

Intermediate releases: see git history and npm versions.
