# trust-boundary — claims checklist

Every claim the README, CLAUDE.md, or an in-repo doc makes that an operator
would *act on* in this domain: a default, a guarantee, a "refuses to", a
threshold, a "never". Each is marked VERIFIED / DRIFT / MISSING / UNVERIFIED
against the implementing code.

Domain definition used for this pass: **what the dispatcher accepts from a
producer it does not control, and what it does with it.** The producers are
the buyer (chat, job description, uploaded files), the platform API (job
records, inbox items, service metadata, webhooks), the LLM (completions and
tool calls), the operator's external executor backend (n8n / CrewAI / A2A /
LangGraph), an MCP server, and anonymous HTTP callers on the proxy port.

Findings referenced as **T1..T11** are in `AUDIT/trust-boundary.md`.

---

## A. SovGuard context scanning (prompt injection)

| # | Claim | Source | Verdict |
|---|---|---|---|
| A1 | `scanUntrusted(text, source)` wraps the vendored `scanContext` from `@junction41/sovagent-sdk` | CLAUDE.md file map | **VERIFIED** — `sovguard-context.js:22` |
| A2 | HOLE 1 — `job.description` is scanned before it enters the system prompt | sovguard doc §What changed | **VERIFIED** — `local-llm.js:94`, `mcp.js:83`, `webhook.js:36`, `a2a.js:44`, `langserve.js:35`, `langgraph.js:37`. All six executors, not just the two the doc names. |
| A3 | HOLE 2 — tool results are scanned before re-entering `messages` | sovguard doc | **VERIFIED** — `local-llm.js:325-327` (`workspace_file` / `mcp_result` source chosen by tool-name prefix), `mcp.js:226-231` |
| A4 | HOLE 3 — inbound buyer chat is scanned | sovguard doc §Gotchas | **VERIFIED** as code — `local-llm.js:198`, `mcp.js:121`, `webhook.js:73`, `a2a.js:91`, `langserve.js:58` |
| A5 | Buyer-chat scanning is **default OFF**, gated behind `J41_SCAN_BUYER_CHAT=1` | `docs/sovguard-context-integration.md:63` | **DRIFT** — the guard is `!== '0'`, i.e. default **ON**. The doc is stale and inverted; README's mainnet-gate entry (`=0` is a violation) is the accurate one. → **T8** |
| A6 | Operators can opt out with `J41_SCAN_BUYER_CHAT=0` | README:759, sovguard doc, 5 code comments | **MISSING** — the variable is never forwarded into the job container (`buildContainerEnv` `cli.js:7927`, container `Env` array `cli.js:8418-8427`) and is not in the local-mode whitelist (`cli.js:8750-8753`). The knob cannot reach the code that reads it in either runtime. → **T8** |
| A7 | Trusted `user` input is NEVER muzzled | sovguard doc, `sovguard-context.js:11` | **VERIFIED** — source string is passed straight through to the SDK; `test/sovguard-context.test.js:22-25` pins it |
| A8 | Default policy is `strip`, falling back to `quarantine`; a flagged payload never silently passes | sovguard doc §Behavior | **VERIFIED** at the dispatcher seam — `sovguard-context.js:54` defaults `policy='strip'`. The strip/quarantine fallback itself is SDK-internal, not re-verified here. |
| A9 | Fails **OPEN** on scanner error/unavailability — deliberate | sovguard doc, `sovguard-context.js:12-14` | **VERIFIED** — `sovguard-context.js:52` (no scanner → return text), `:61-64` (throw → return text). Warns once on module-load failure (`:28`). |
| A10 | Every non-allow action logs a notification | sovguard doc | **VERIFIED** — `sovguard-context.js:57-59` |
| A11 | Detection is model-less (regex + indirect + perplexity); "don't over-expect" | sovguard doc §Detection scope | **VERIFIED** as a documented limitation; the SDK scanner's contents were not audited |
| A12 | `job.buyer` is platform-supplied metadata and is treated as untrusted | code comment, all executors | **VERIFIED** — scanned as `job_description` in all six executors |
| A13 | `dispute.reason` is scanned before it reaches the executor on the rework path | `job-agent.js:2083-2085` | **VERIFIED** |
| A14 | Prior conversation history reloaded on respawn is scanned | *(implied by A4 — no explicit claim)* | **MISSING** — `seedConversationLog` (`local-llm.js:151-168`) pushes platform-served message content into `conversationLog` with no scan; reached via `init({isReconnect:true})` → `_seedHistoryFromPlatform` (`:174-187`). → **T1** |
| A15 | MCP tool *descriptions* fetched from the server are treated as untrusted | *(no claim)* | **N/A** — `mcp.js:68-80` puts `tools/list` output straight into the tool schema. Operator-configured server, so inside the trust boundary; recorded, not reported. |

## B. Canary tokens

| # | Claim | Source | Verdict |
|---|---|---|---|
| B1 | Every job automatically gets a canary token; checking is always enabled | README:833 | **VERIFIED** — unconditional `randomBytes(32)` at `cli.js:8261` (docker) and `cli.js:8743` (local); `J41_CANARY_TOKEN` always in `buildContainerEnv` (`cli.js:7949`) |
| B2 | The token is injected into the SOUL.md prompt as an HTML comment | CLAUDE.md | **VERIFIED** — `job-agent.js:492-494` |
| B3 | Uses the SDK's evasion-resistant `checkForCanaryLeak` (zero-width strip, NFKC) | CLAUDE.md, README | **VERIFIED** — `job-agent.js:337-347` |
| B4 | Outbound messages containing the canary are blocked | CLAUDE.md | **VERIFIED** — `job-agent.js:1150-1153` (chat), `:1856-1859` (rework reply) |
| B5 | The canary is stripped from delivery content | CLAUDE.md | **VERIFIED**, and the hash is correctly recomputed after the strip — `job-agent.js:853-859`, `:2123-2129` |
| B6 | Registers with SovGuard via `client.registerCanary()` | CLAUDE.md | **VERIFIED** — `job-agent.js:543-579` |
| B7 | The deliverable is leak-*checked* (not just stripped) | *(no claim; noted by isolation pass I9)* | **Out of scope** — already reported as isolation I9 |

## C. Inbound webhook authentication

| # | Claim | Source | Verdict |
|---|---|---|---|
| C1 | Each agent gets a unique webhook path for O(1) secret lookup | `webhook-server.js:5` | **VERIFIED** — `:275-286`, `:322-323` |
| C2 | Agent id in the path is validated (no traversal) | `webhook-server.js:277` | **VERIFIED** — `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` plus an explicit `..` check |
| C3 | HMAC signature is required; missing → 401 | code | **VERIFIED** — `webhook-server.js:313-319` |
| C4 | The timestamped signature (5-min window) is *preferred* for replay protection, with a legacy body-only fallback | `webhook-server.js:13-22` | **VERIFIED** as written — `:24-33` |
| C5 | `requireTimestamped` refuses the legacy HMAC "so an on-path attacker can't strip the timestamped header to force a replayable downgrade" | `webhook-server.js:29-31` | **DRIFT** — the option is passed **only** on `/j41/api-access/revoke` (`:230-231`). The main event route calls `verifyInboundWebhook(rawBody, req.headers, config.secret)` with no opts (`:323`), so the documented downgrade is accepted there. → **T7** |
| C6 | `J41_ALLOW_LEGACY_REVOKE=1` is the only escape hatch for replayable revokes, and is refused on mainnet | README:755, 774 | **VERIFIED** — `webhook-server.js:230`, `mainnet-guard.js:31` |
| C7 | Webhook replay nonce: `payload.id` / `nonce` / `eventId` / `x-j41-event-id`, duplicates → 409 | `webhook-server.js:339-355` | **VERIFIED**, and correctly ordered **after** signature verification |
| C8 | Nonce cache is process-local and that is acceptable | `nonce-cache.js:15-18` | **VERIFIED** for *access envelopes* (self-expiring). **Qualified** for webhooks: an event id has no `expiresAt`, so it gets the 11-min default TTL and does not survive restart — see T7. |
| C9 | The nonce cache is never populated before signature verification | `nonce-cache.js:79-97` | **VERIFIED** on both paths — v2 `cli.js:3741-3746`, v1 `cli.js:3751-3754` via the SDK's post-verify `isReplay` hook (`envelope.js:346-348`) |
| C10 | Body size is capped (`webhook.max_body_bytes`) | code | **VERIFIED** — `webhook-server.js:39`, enforced on both readers (`:78-79`, `:296`) |
| C11 | Slow-loris hardening: headers/request/idle timeouts + max connections | `webhook-server.js:106-116` | **VERIFIED** — `:371-374` |
| C12 | Uniform 403 on revoke so sellers can't be enumerated | `webhook-server.js:224-226` | **VERIFIED** — `:231-235` |
| C13 | An authenticated webhook may only act on **its own agent's** jobs | *(no explicit claim; implied by per-agent secrets)* | **MISSING** — `handleWebhookEvent` (`cli.js:7053-7069`) resolves `agentInfo` from the URL but takes `jobId` from the payload and never checks the two are related. → **T3** |

## D. API-endpoint proxy — inbound authentication

| # | Claim | Source | Verdict |
|---|---|---|---|
| D1 | "Verification is fully local and fail-closed. No bypass env var exists in the codebase." | README:649 | **VERIFIED** — v2 `cli.js:3733-3735`, v1 `:3752-3755`; both `throw` on failure. `grep` finds no bypass flag on either path. |
| D2 | v2 resolves primary R-addresses via the public identity-keys endpoint and enforces `minimumSignatures` | README:649 | **VERIFIED** at the dispatcher seam (`cli.js:3734` → SDK `verifyCanonicalSignatures`); the threshold logic itself is SDK-internal |
| D3 | v1 pipe-format envelopes are verified with `bitcoinjs-message` | README:649 | **VERIFIED** — SDK `envelope.js:337-346`, plus a 300 s freshness window checked before any network I/O (`:298-303`) |
| D4 | `/j41/discovery/request-access` is rate-limited per source IP (10 rps, burst 30) before the outbound identity lookup | `webhook-server.js:41-46` | **VERIFIED** — `:48-68`, `:135-141`; bounded at 10k entries |
| D5 | Deposit reports MUST be signed by the buyer; unsigned → 401 | `webhook-server.js:169-175` | **VERIFIED** |
| D6 | Verification failures map to distinct HTTP codes; platform trust-anchor failures return 502 | `webhook-server.js:177-187` | **VERIFIED** |
| D7 | Models not in the seller's `modelPricing` are rejected with 400 | README:651 | **VERIFIED** — `proxy-handler.js:277-285` |
| D8 | Proxy bearer keys must start with `sk-` and resolve to an owner | code | **VERIFIED** — `proxy-handler.js:237-251`. (String-compare weakness already reported as keys K9.) |
| D9 | SSRF: the request path may not resolve to a host other than the configured endpoint | `proxy-handler.js:389` | **VERIFIED** — `:390-397` |
| D10 | SSRF: private/loopback/link-local IPs are blocked unless `J41_ALLOW_LOCAL_UPSTREAM=1` | README:838, code | **VERIFIED** — `proxy-handler.js:118-210`; IPv4, IPv6, `::ffff:` dotted **and** hex forms all covered |
| D11 | DNS-rebind TOCTOU is closed by pinning the validated IP into `http.request`'s `lookup` | `proxy-handler.js:427-432` | **VERIFIED** — `:433-446` |
| D12 | Upstream response headers are forwarded through an allowlist | code | **VERIFIED** — `proxy-handler.js:212-227` |
| D13 | "J41 brokers discovery + access **without ever seeing your upstream API key**" | README:634 | **VERIFIED** — `upstreamAuth` is never included in `registerService` (`dashboard.js:2846-2859`) nor in any platform call. It stays in `agent-config.json` (0600). |
| D14 | The upstream URL the seller configured is the URL the proxy talks to | README:636-638 (implied by the setup flow) | **DRIFT** — `cli.js:3655` takes `endpointUrl` from the **platform** service record; the local `apiEndpointUrl` is only a fallback when the platform omits it (`cli.js:4915`). The seller's `Authorization` header goes wherever that value points. → **T5** |
| D15 | The TUI's "API Endpoint Setup" configures the upstream API key the proxy uses | README:636, `dashboard.js:2806-2812` | **DRIFT** — written as `agentConfig.upstreamAuth` (`dashboard.js:2838`), read as `localCfg.apiEndpointAuth` (`cli.js:3653`). The key is never sent. → **T6** |
| D16 | Per-buyer rate limit + in-flight concurrency cap + circuit breaker gate every request | code | **VERIFIED** — `proxy-handler.js:287-343` |

## E. Control plane

| # | Claim | Source | Verdict |
|---|---|---|---|
| E1 | **Every** `/v1/*` endpoint requires a bearer token, even from localhost | README:679 | **VERIFIED** — `control-api.js:172-175`, checked before every route |
| E2 | Token auto-created at `~/.j41/dispatcher/control.token`, mode 0600 | README:681 | **VERIFIED** — `control-api.js:49-60` (write mode + explicit chmod) |
| E3 | Same-user access trivial, other-user impossible | README:682 | **VERIFIED** given E2. Note `ensureToken` reuses an existing file without re-checking its mode — a pre-existing world-readable token is not repaired. |
| E4 | Constant-time bearer comparison | `control-api.js:62` | **VERIFIED** — `:63-76`; the length-mismatch branch still runs a `timingSafeEqual` |
| E5 | v1 is read-only; writes land later | README:705-707 | **VERIFIED** — `control-api.js:166-168` rejects every non-GET with 405 |
| E6 | `/health` on :9842 stays open and unauthenticated | README:711 | **VERIFIED**, and **bound to 127.0.0.1** (`control.js:123`) — it is not network-exposed despite the wording |
| E7 | Control API binds 127.0.0.1 | README:674 | **VERIFIED** — `control-api.js:206` |
| E8 | Event ring survives restart with a monotonic `seq` | README:698 | **VERIFIED** — `control-api.js:91-104` re-seeds from disk; corrupt lines skipped |

## F. Trusting the platform's own responses

| # | Claim | Source | Verdict |
|---|---|---|---|
| F1 | Before `acceptJobRecord` writes on-chain, the inbox bytes are confirmed to equal the cryptographically-verified platform-witnessed record | `inbox-job-record.js:5-16` | **VERIFIED** — `verifyInboxJobRecord` (`:222-283`): network allowlist, decode, independent `getJobWitness`, `verifyWitness`, `decideWitnessWrite`, then a JCS-datahash cross-check of both the bare record and the witness |
| F2 | The gate is fail-closed; only a 409 / `NOT_WITNESSABLE` is treated as transient | `inbox-job-record.js:265-272` | **VERIFIED** — broad string matching is deliberately excluded |
| F3 | `J41_WITNESS_VERIFY=off` is a verustest-only break-glass and never enables on an unknown network | `broker-executors.js:79-82` | **VERIFIED** — `:82` requires `network === 'verustest'`; `mainnet-guard.js:32` blocks it on mainnet |
| F4 | A compromised platform inbox cannot hand back an arbitrary VDXF key | SDK `inbox/vdxf-gate.js:8-12` | **VERIFIED** — per-type allowlists (`review` → `review.record` only; `attestation` → `review.attestation` only; `job_record` → `job.*`), gated per item before any batch merge; unknown type throws |
| F5 | `review` / `attestation` inbox items are never synthesized locally | SDK vdxf-gate | **VERIFIED** — `vdxf-gate.js:120-123` throws instead |
| F6 | The *content* of a `review.record` is verified before it is written on-chain | *(no claim — asymmetry with F1)* | **N/A by design** — the platform is the review authority and the key is allowlisted, so the blast radius is one known key. Recorded in the clean list, not reported. |
| F7 | Inbox accepts are BATCHED — one identity tx per agent per poll cycle; never two back-to-back for the same VerusID | CLAUDE.md §Key Patterns | **DRIFT** — true for `processInboxForAgent` (`cli.js:7496-7586`, with the pending-write gate at `:7515-7543`), but the `review.received` webhook handler (`cli.js:7127-7148`) loops `await agent.acceptReview(...)` over up to 10 pending items outside both the batch and the gate. → **T2** |
| F8 | `update-profile` is NOT gated by the pending-write confirmation gate — check `ctl inbox` first | CLAUDE.md §VDXF Update | **VERIFIED** as a documented hazard; T2 is the same hazard on an *un*documented, automatic path |
| F9 | `J41_TRUST_PLATFORM_RESOLUTION=1` is legacy; default is local verification | README:775 | **VERIFIED** — SDK `agent.js:2113-2118` defaults to local; `mainnet-guard.js:49` blocks the opt-out |
| F10 | Platform-supplied `job.description` is length-capped before being written to disk (1 MB) | `cli.js:8245-8251` | **VERIFIED** for `description.txt`. **Partial** — `buyer.txt`, `amount.txt`, `currency.txt` are written unbounded at `:8256-8259`. → **T10** |
| F11 | `job.id` is validated before it becomes a filesystem path | `cli.js:8232`, `:8716` | **VERIFIED** — `isValidJobId` (`job-id.js:2`) gates both spawn paths; every later `path.join(JOBS_DIR, jobId)` is reached only for an id already in `state.active` |
| F12 | Platform message history is sorted defensively oldest-first because the backend's ORDER BY is undocumented | `local-llm.js:145-148` | **VERIFIED** — `:154-155` |

## G. Executor / LLM output boundary

| # | Claim | Source | Verdict |
|---|---|---|---|
| G1 | The broker is a constrained signer, not an oracle: it never trusts container-supplied amounts, identities, or raw bytes | `sign-broker.js:3-18` | **VERIFIED** — `buildBrokeredMessage` (`:53-103`) takes every security-bearing field from the authoritative job; default-deny on unknown types (`:97-101`) |
| G2 | `deliveryHash` must be a 64-char hex SHA-256 | `sign-broker.js:79-85` | **VERIFIED** — format only. The broker explicitly does **not** bind it to content (`:79-81`). |
| G3 | The delivery hash commits to the delivered content | implied by "signed proof", `job-agent.js:846-852` | **DRIFT for the webhook executor** — `webhook.js:115` accepts `response?.hash` from the external backend in preference to a locally computed one, and `job-agent.js:863` signs `result.hash` as-is. The other four executors all compute the hash locally. → **T4** |
| G4 | Buyer input is sanitized (control chars stripped, length-capped) before reaching the executor | `job-agent.js:351-356` | **VERIFIED** — 10 000-char cap, `[\x00-\x1F\x7F]` stripped; applied at `:1130` and to every job file at `:514-517` |
| G5 | `handleMessage` calls are serialized so concurrent buyer messages can't interleave | `job-agent.js:1023` | **VERIFIED** — `:1143-1166` |
| G6 | Chat messages are deduplicated exactly-once across the WS and poll paths | `job-agent.js:1102-1106` | **VERIFIED** — `markIfNew` (`message-dedup.js:3-9`), bounded at 500 |
| G7 | The poll fallback keeps only messages the buyer sent, never the agent's own | `message-poll.js:2-5` | **VERIFIED** — `selectBuyerMessages` positive-matches `senderVerusId` |
| G8 | The WebSocket path applies the same sender filter | *(no claim — asymmetry with G7)* | **MISSING** — `job-agent.js:1170` forwards every `message` event for the job id; the SDK dispatches without filtering (`chat/client.js:148-160`). → **T9** |
| G9 | Tool-call loops are bounded | code | **VERIFIED** — `MAX_TOOL_ROUNDS` 10 and `MAX_TOTAL_CALLS` 15 (`local-llm.js:68`, `:274`, `:279`); budget re-checked before every round (`:283`) |
| G10 | Malformed tool-call arguments degrade safely | code | **VERIFIED** — `JSON.parse` failure → `args = {}` (`local-llm.js:312-316`, `mcp.js:204-208`) |
| G11 | Kimi inline tool-call markup is parsed into proper `tool_calls` | CLAUDE.md, README:25 | **VERIFIED** — `local-llm.js:461-468`, `:482-497`; the markup is stripped from the content afterwards |

## H. Mainnet gate over trust-boundary knobs

| # | Claim | Source | Verdict |
|---|---|---|---|
| H1 | 13 named env/flag escape hatches are refused on mainnet | README:748-762 | **VERIFIED** — all 13 present and matching in `mainnet-guard.js:26-50` |
| H2 | The mainnet check is sticky; `J41_NETWORK` cannot downgrade a mainnet config file | README:766 | **VERIFIED** — `resolveIsMainnet` (`mainnet-guard.js:63-65`) ORs file and effective network |
| H3 | `J41_PLATFORM_SIGNER` is deliberately absent because the SDK already enforces it | README:764 | **VERIFIED** as stated rationale (`mainnet-guard.js:6-11`); the SDK-side enforcement was not re-verified |
| H4 | The gate reads the same configuration the daemon runs on | *(implied)* | **DRIFT** — env-only read; already reported as isolation **I5**. Not re-reported. |
| H5 | Gate entries actually control the behaviour they name | *(implied)* | **DRIFT for one entry** — `J41_SCAN_BUYER_CHAT` is read only inside the container and is never forwarded there, so the gate guards a variable that has no effect either way. → **T8** |

## I. Workspace / file boundary

| # | Claim | Source | Verdict |
|---|---|---|---|
| I1 | All workspace file paths are validated to prevent traversal (`..`, absolute) | README:627, 839 | **VERIFIED** — `job-agent.js:1573-1578`, rejecting a leading `/` and any `..` segment on either separator; the SDK validates again |
| I2 | Agents without on-chain `workspace.capability` are blocked from workspace connections | README:840 | **VERIFIED** for the dispatcher-mediated path (`cli.js:7230-7233`). Docker-mode self-connect bypass already reported as isolation **I10**. |
| I3 | Files blocked by SovGuard are remembered and not retried | code | **VERIFIED** — `_blockedFiles` (`job-agent.js:1560`, `:1568-1571`, `:1586-1590`) |
| I4 | Local mode whitelists only necessary env vars | README:837 | **VERIFIED** — explicit 10-entry whitelist, no `...process.env` spread (`cli.js:8752-8760`) |
| I5 | Executor URLs are validated against private IP ranges | README:838 | **VERIFIED** for the proxy upstream (D10). The *executor* URL (`J41_EXECUTOR_URL`) is operator-supplied config and is constrained by the egress allowlist rather than an IP check — recorded, not reported. |
| I6 | Path validation is total over the tool-call argument | *(implied by I1)* | **DRIFT (minor)** — `job-agent.js:1574` assumes `args.path` is a string; a non-string from the model throws before the `try`. → **T11** |

---

## Totals

**77 claims** — 58 VERIFIED · 9 DRIFT (A5, C5, D14, D15, F7, F10, G3, H5, I6)
· 5 MISSING (A6, A14, C13, G8, plus H4/I2 deferred to prior passes) · 0 UNVERIFIED
· 3 recorded as N/A-by-design (A15, F6, I5).

Two VERIFIED entries are qualified in place: **C8** (correct for access
envelopes, weak for webhook event ids) and **E3** (true for a token the
dispatcher created, not re-checked for a pre-existing one).
