# isolation — claims checklist

**72 claims — 50 VERIFIED · 18 DRIFT · 3 MISSING · 1 UNVERIFIED.**

Every claim the README / CLAUDE.md makes that an operator would act on in the
isolation domain: a default, a guarantee, a "refuses to", a threshold, a wall.

Status: **VERIFIED** (code does what's claimed) · **DRIFT** (code differs — how)
· **MISSING** (no implementation found) · **UNVERIFIED** (could not determine).

Source refs are `README.md:<line>` unless noted.

---

## A. Runtime modes & the three walls (README 8, 503–528, 732–744)

| # | Claim | Status | Evidence |
|---|---|---|---|
| A1 | Docker is the default runtime; each job runs in an ephemeral container | VERIFIED | `cli.js:8231 startJobContainer`, `AutoRemove: !keep_containers` `cli.js:8363`; `config-loader.js` runtime default + `cli.js:8715 startJobLocal` is the other branch |
| A2 | "Three concentric walls": gVisor (or macOS VM) → Docker → bubblewrap | DRIFT | Walls 1–2 real. **Wall 3 is never applied**: `cli.js:8123` calls the *async* `secureSetup.detectIsolation()` without `await`, so `isolation.mode` is `undefined` and the `=== 'bwrap'` branch at `cli.js:8124` can never be taken. See finding **I3** |
| A3 | gVisor runtime used "if KVM available" | DRIFT (narrower) | `cli.js:8382` sets `Runtime:'runsc'` only when `isGvisorAvailable()` (`cli.js:8157`) finds runsc is Docker's **DefaultRuntime**. gVisor installed-but-not-default → no gVisor, and no warning from the dispatcher |
| A4 | Bubblewrap is the "VPS fallback — minimal fs view, no network" | DRIFT | The fallback is unreachable (A2). If it were reached it would not work: the `Entrypoint` is a **host** path (`cli.js:8125-8128`, `require.resolve('@junction41/secure-setup')…/scripts/entrypoint-agent.sh`) that is never bind-mounted into the image (`cli.js:8357-8362` binds only jobDir, sign channel, SOUL.md), and the script itself does `--unshare-net` (`secure-setup/scripts/entrypoint-agent.sh:12`) and `--ro-bind /app /app`, which would cut both egress and the rw signing channel |
| A5 | Security score 10/10 gVisor · 8/10 bwrap · 4/10 Docker-only | VERIFIED (as arithmetic) | `secure-setup/lib/detect-isolation.js:132-154`. Note the score is derived **only** from runtime+seccomp — network/iptables/AppArmor do not affect it (see **I4**) |
| A6 | The best isolation is auto-detected on first `start`; "no manual configuration needed" | DRIFT | `cli.js:3444-3472` runs `secureSetup.setup('dispatcher')` behind a 10 s `Promise.race` and treats **every** failure as non-fatal; the real setup needs `sudo` for `/etc/j41` and iptables (`secure-setup/lib/index.js:76-90`, `setup-network.js:54`). The README's own Quick Start does not mention sudo |
| A7 | Local mode is dev-only and requires `--dev-unsafe` | VERIFIED | `cli.js:8717-8732` throws without `state._devUnsafe`; flag defined `cli.js:3113` |
| A8 | Worker is "isolated and stateless — once the job finishes the process exits and its data is cleaned up" | VERIFIED (with caveat) | `cli.js:8676-8681` removes jobDir on completion. **Caveat:** a *paused* job keeps its jobDir, signing channel and egress token (see **I2**, **I6**) |

## B. Container hardening (README 509–513, 791–802)

| # | Claim | Status | Evidence |
|---|---|---|---|
| B1 | `CapDrop: ['ALL']` — zero capabilities | VERIFIED | `cli.js:8369`. The bwrap override that would wipe it (`cli.js:8145`) is patched back at `cli.js:8387-8389` and is unreachable anyway (A2) |
| B2 | `ReadonlyRootfs: true` | VERIFIED | `cli.js:8366` |
| B3 | tmpfs `/tmp` with `noexec,nosuid` | VERIFIED | `cli.js:8367` — `rw,noexec,nosuid,size=64m` |
| B4 | `PidsLimit: 64` — fork-bomb protection | VERIFIED | `cli.js:8368`. Note each host→container IPC message spends a pid via `docker exec` (`cli.js:4980-4983`) |
| B5 | Custom seccomp profile, ~80 syscalls, blocks ptrace/mount/reboot/keyctl/bpf | VERIFIED (wiring) | `cli.js:8054-8080` reads `/etc/j41/seccomp-agent.json` then `~/.j41/…`, validates JSON, passes **content** to `SecurityOpt`. Profile contents themselves are `secure-setup/profiles/seccomp-agent.json` (not audited here). Absence degrades to Docker default with a `console.warn` only (`cli.js:8079`) |
| B6 | AppArmor confinement (Linux) | VERIFIED (best-effort) | `cli.js:8082-8094`; absent profile → `console.warn`, container still starts. `quickCheck` grades AppArmor `warn`, never `fail` (`quick-check.js:117-127`) |
| B7 | `StorageOpt: { size: '1G' }` — max disk | DRIFT | `cli.js:8379` applies it only when `supportsStorageOpt()` (`cli.js:8170-8187`: overlay2 **and** `mount \| grep pquota`) — silently omitted otherwise, no warning. It would also never bound the writable surface that matters: `/app/job` is a host bind mount. See **I7** |
| B8 | `OomScoreAdj: 1000` — first to die | VERIFIED | `cli.js:8380` |
| B9 | `no-new-privileges` | VERIFIED | `cli.js:8055` |
| B10 | Container runs as host UID (no root-owned files) | VERIFIED (literally) | `cli.js:8414` `User: ${process.getuid()}:${process.getgid()}` at top level, with the correct comment about `HostConfig.User` being ignored. **No guard against the dispatcher itself running as root** → container gets uid 0. See **I12** |
| B11 | Memory 2 GB / 1 CPU per job | VERIFIED | `cli.js:8364-8365` |
| B12 | Host key material never enters the container | VERIFIED | Binds are jobDir, `/app/sign`, `SOUL.md:ro` only (`cli.js:8357-8362`); broker mandatory (`cli.js:8283-8288`). No docker socket bind. (Custody itself: `AUDIT/keys.md`) |
| B13 | Image is pre-baked `j41/job-agent:latest` | VERIFIED | `cli.js:8408`. Tag, not digest — no pin |

## C. Network lockdown & egress (README 24, 804–811, 640–651)

| # | Claim | Status | Evidence |
|---|---|---|---|
| C1 | Containers run on the `j41-isolated` Docker network | VERIFIED (with fallback) | `cli.js:8378` → `getDispatcherNetworkMode()` `cli.js:8099-8111`; falls back to `bridge` with a warning when the network is absent |
| C2 | "Internal bridge with ICC disabled" | DRIFT (deliberate) | ICC **is** disabled (`secure-setup/lib/setup-network.js:235`). The bridge is deliberately **not** `--internal` — `setup-network.js:230-238` and `quick-check.js:186-215` both *require* it to be egress-capable, because egress is restricted by iptables, not air-gapping. The README sentence describes the superseded design |
| C3 | "iptables allowlist: only `api.junction41.io` + configured LLM provider endpoints" | DRIFT | The firewall is a **default-deny**: `ESTABLISHED,RELATED` accept, everything else DROP on `br-j41iso`, plus `INPUT` accept for `gateway:9847` only (`setup-network.js:100-110`). The per-host allowlist lives in the host egress proxy (`egress-proxy.js:22-43`, `cli.js:8403-8404`), derived per job from `J41_API_URL`/`J41_LLM_BASE_URL`/`J41_EXECUTOR_URL`/`J41_MCP_URL`. Stronger than documented, but not what is documented |
| C4 | "DNS pinned and re-resolved every 5 minutes" | MISSING | `resolveAndPinDNS()` still exists but its own docstring says it no longer resolves DNS (`setup-network.js:260-265`), and **nothing in this repo calls it** (`grep resolveAndPinDNS src/` → no hits). Containers get `Dns:['0.0.0.0']` (`cli.js:8375`) and do no DNS at all; the proxy resolves |
| C5 | "Configure allowed endpoints in `~/.j41/network-allowlist.json`" | MISSING | `setup-network.js:251-252`: "`~/.j41/network-allowlist.json` is no longer written here; the proxy manages per-job domain allowlists independently." No reader of that file exists in `src/` |
| C6 | First-run creates `~/.j41/network-allowlist.json` (README 786) | MISSING | Same as C5 |
| C7 | Egress proxy is the sandbox's sole outbound path | VERIFIED (by construction) | `cli.js:4136-4150` binds the proxy on the bridge gateway; `cli.js:8425-8426` injects `J41_EGRESS_PROXY`/`J41_EGRESS_TOKEN`; container installs it before the SDK require (`job-agent.js:9-12`, `egress-proxy-client.js`); socket.io is tunnelled too via the SDK's `getEgressSocketAgent()` (`sdk/dist/net/egress-agent.js:93-110`, used at `sdk/dist/chat/client.js:102`) |
| C8 | Proxy is per-job token-gated | VERIFIED | `egress-proxy.js:75-90`; token is 32 random bytes per job (`cli.js:8392`), revoked on completion (`cli.js:8578`, `8658-8660`). **Not** revoked on pause — see **I6** |
| C9 | Proxy re-validates the *resolved* address and fails closed on private IPs | VERIFIED | `egress-proxy.js:91-104`, sharing `isPrivateIp` with `proxy-handler.js:118` |
| C10 | Proxy bind failure is fatal ("jobs would have no egress path") | VERIFIED | `cli.js:4144-4149` `process.exit(1)` |
| C11 | Health `:9842` open but local-only; control API `:9843` token-gated | VERIFIED | `control.js:123` and `control-api.js:206` both bind `127.0.0.1` |
| C12 | API-endpoint proxy routes are exposed "when at least one api-endpoint agent is registered" | DRIFT | All `/j41/*` routes live in the webhook server (`webhook-server.js:117-260`), which is only started inside the `if (options.webhookUrl)` branch (`cli.js:3572`, `3876-3879`). In default poll mode they are not served at all. (Drifts *toward* less exposure) |

## D. Local mode (README 524–527, 822–829)

| # | Claim | Status | Evidence |
|---|---|---|---|
| D1 | Blocked by default; needs `--dev-unsafe` | VERIFIED | `cli.js:8717-8732` |
| D2 | Warns every 30 seconds while active | VERIFIED | `cli.js:3232-3239` |
| D3 | Security score 0/10 / zero isolation | VERIFIED (descriptive) | `cli.js:8774-8778` plain `spawn('node', …)` |
| D4 | "Cannot register agents for public jobs on the platform" | UNVERIFIED | No dispatcher-side enforcement found — `register`/`finalize` do not consult `RUNTIME`. If this is enforced it is platform-side. Not traced |
| D5 | Env isolation: local mode whitelists only necessary env vars | VERIFIED | `cli.js:8749-8757` explicit `WHITELISTED_ENV`, no `...process.env` |
| D6 | (implicit) local mode gets the same input caps as Docker | DRIFT | `cli.js:8737` writes `job.description` with neither the 1 MB cap nor the `typeof` guard applied on the Docker path (`cli.js:8249-8256`). Dev-only surface; noted, not filed |

## E. Mainnet gate & escape hatches (README 746–775)

| # | Claim | Status | Evidence |
|---|---|---|---|
| E1 | On mainnet the dispatcher refuses to start if any listed flag is set | DRIFT | `cli.js:3122-3136` → `mainnet-guard.js:22-52`. The gate inspects **`process.env` only**. `J41_ALLOW_LOCAL_UPSTREAM` and `J41_SKIP_STATUS_CHECK` are also `config.toml` keys (`config-loader.js:17,16` + `ENV_OVERRIDES:109-110`) read as `cfg.runtime.*` (`cli.js:4142`, `cli.js:3271`), so a TOML-set value bypasses the gate. See **I5** |
| E2 | `J41_SIGNING_BROKER=0` refused on mainnet | VERIFIED | `mainnet-guard.js:26`; independently fatal on every network at `cli.js:8283-8288` |
| E3 | `--dev-unsafe` refused on mainnet | VERIFIED | `mainnet-guard.js:27`, fed from parsed options (`cli.js:3123`) |
| E4 | `J41_DISABLE_BWRAP=1` refused on mainnet | VERIFIED (moot) | `mainnet-guard.js:28`; the flag it guards (`cli.js:8118`) short-circuits a branch that is already dead (A2) |
| E5 | `J41_ALLOW_LOCAL_UPSTREAM=1` refused on mainnet | DRIFT | env form yes (`mainnet-guard.js:29`); TOML form not — see E1 |
| E6 | `J41_SCAN_BUYER_CHAT=0` refused on mainnet | VERIFIED | `mainnet-guard.js:44`; env-only knob, read in all six executors |
| E7 | Mainnet detection is sticky — `J41_NETWORK` cannot downgrade | VERIFIED | `mainnet-guard.js:63-65` |
| E8 | "No bypass env var exists in the codebase" (local verification) | VERIFIED for the proxy verify path | not re-audited here; money/keys passes cover it |

## F. First-run security setup & self-test (README 777–789, 843–848)

| # | Claim | Status | Evidence |
|---|---|---|---|
| F1 | First start auto-detects platform, installs gVisor/bwrap, deploys profiles, creates the network, runs a self-test | DRIFT | `cli.js:3444-3472` calls `secureSetup.setup('dispatcher')` — but with a 10 s timeout and a non-fatal catch; and the "self-test" (`selfTest`) is **never** called by the dispatcher, only `quickCheck` |
| F2 | Subsequent starts skip setup and run a quick-check | VERIFIED | `cli.js:3445` marker check + `cli.js:3475-3502`. (The dispatcher's marker test is `fs.existsSync` only; `secure-setup`'s own `isInitialized` additionally validates JSON + 90-day age — the dispatcher does not use it) |
| F3 | A failing quick-check stops the dispatcher | DRIFT | `cli.js:3481-3495` blocks only on `status === 'fail'`. `warn` results are **neither printed nor blocking**, and the missing egress firewall is graded `warn` (`quick-check.js:282-292`). See **I4** |
| F4 | `~/.j41/financial-allowlist.json` created deny-all on first run | VERIFIED | `secure-setup/lib/setup-allowlist.js`; `quick-check.js:165-172` fails if absent. (Behaviour audited in `AUDIT/money.md`) |
| F5 | secure-setup is required for the security features | DRIFT | It is an **optionalDependency** (`package.json:46`) loaded by a bare `require` inside an empty `catch` (`cli.js:106-111`). It is ESM-only (`"type":"module"`); `require()` of ESM throws on Node < 20.19 while `engines` allows `>=20.0.0`. On such a host every security check silently disappears. See **I11** |

## G. Canary tokens & prompt-injection (README 831–833; CLAUDE.md "Canary Token System", "sovguard-context")

| # | Claim | Status | Evidence |
|---|---|---|---|
| G1 | Every job gets a canary via `J41_CANARY_TOKEN`; always enabled | VERIFIED | `cli.js:8262` (32 random bytes) → `buildContainerEnv` `cli.js:7949`; local path `cli.js:8743` |
| G2 | Injected into the SOUL.md prompt as an HTML comment | VERIFIED | `job-agent.js:492-496` |
| G3 | Uses the SDK's evasion-resistant `checkForCanaryLeak` | VERIFIED | `job-agent.js:337-348` |
| G4 | Blocks outbound **messages** containing the canary | VERIFIED | `job-agent.js:1150-1157` |
| G5 | Strips the canary from **delivery** content | DRIFT | `job-agent.js:853-860` uses a literal `split(TOKEN).join('[redacted]')`, and the deliverable is never run through the evasion-resistant check. An obfuscated canary is neither redacted nor detected. See **I9** |
| G6 | Registers the canary with SovGuard | VERIFIED | `job-agent.js:543-580`; registration failure is a warn, local check still runs |
| G7 | SovGuard scans job descriptions + buyer messages + tool results | VERIFIED (broader than documented) | All six executors scan `job.description`/`job.buyer` and (default-on) inbound messages; tool results scanned in `local-llm.js:327` and `mcp.js:228`. CLAUDE.md names only local-llm + mcp |
| G8 | `J41_SCAN_BUYER_CHAT=0` is the only opt-out and is default-on | VERIFIED | `!== '0'` guard in all six executors |

## H. "Existing protections" (README 835–841)

| # | Claim | Status | Evidence |
|---|---|---|---|
| H1 | Env isolation in local mode | VERIFIED | = D5 |
| H2 | SSRF protection: executor URLs validated against private IP ranges | VERIFIED (at the egress layer) | Enforced when the container dials out: `egress-proxy.js:36-38` drops loopback from the allowlist and `:101` rejects any host resolving private, unless `allow_local_upstream`. The api-endpoint proxy has its own check (`proxy-handler.js:187-200`) |
| H3 | Path traversal: workspace file ops reject `..` and absolute paths | VERIFIED (with gaps) | `job-agent.js:1574-1578` rejects a leading `/` and any `..` segment across `/` or `\`. Does not cover `C:\`/UNC forms, and a non-string `args.path` throws outside the surrounding `try`. Parked feature (see H4) |
| H4 | VDXF policy: agents without on-chain `workspace.capability` are blocked | DRIFT | Host gate exists (`cli.js:5438-5454`) but in **Docker mode** the container reaches workspace connect through its own poller (`job-agent.js:1284-1291`) and `connectWorkspace` checks only `JAILBOX_ENABLED` (`job-agent.js:1405`). Inert today: jailbox is parked by default (`config-loader.js:86`). See **I10** |
| H5 | Temp keys file 0600 | VERIFIED | Covered in `AUDIT/keys.md`; no keys file is created in broker mode at all |

## I. Job/container lifecycle & IPC (README 24, 583–587, 719–728)

| # | Claim | Status | Evidence |
|---|---|---|---|
| I-a | Docker IPC is file-based at `/tmp/ipc-msg.json` | DRIFT (cosmetic) | Path is `/tmp/ipc-msg.jsonl` (`job-agent.js:790`), written by `docker exec … cat >> …` (`cli.js:4980-4983`) |
| I-b | (implicit) that channel carries dispatcher authority | DRIFT | The file lives in the container's own writable tmpfs and messages are unauthenticated — any in-container write is accepted (`job-agent.js:791-808`). See **I8** |
| I-c | Container stays alive through the review window; killed only on completed/dispute-resolved | VERIFIED | `job-agent.js` post-delivery wait + `cli.js` completion paths |
| I-d | Graceful shutdown delivers work then tears containers down | VERIFIED | `cli.js:4340-4390` shutdown path stops the egress proxy and drains |
| I-e | Job description is capped before being written to disk | VERIFIED (Docker path) | `cli.js:8249-8253`, 1 MB default. **No equivalent cap on buyer file uploads** — see **I7** |
| I-f | Job ids are validated before any path/container name is built | VERIFIED | `job-id.js:2` `^[A-Za-z0-9_-]{8,64}$`, enforced at `cli.js:8232` and `cli.js:8716` |
| I-g | Host reads of container-writable files refuse symlinks | PARTIAL | Reads use `readJobFileNoFollow` (`cli.js:8209-8214`, used at `:4582`, `:4646`, `:4674`, `:4704`). **Writes do not** — see **I2**. `fs.existsSync` at `cli.js:4538` follows links (existence oracle only) |
</content>
</invoke>
