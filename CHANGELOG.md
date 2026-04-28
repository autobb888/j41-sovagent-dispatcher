# Changelog

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
