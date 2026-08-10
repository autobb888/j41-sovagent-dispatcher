# Audit — trust-boundary (2026-08-10)

Read-only pass. Domain: **what the dispatcher accepts from a producer it does
not control, and what it does with it.** Producers in scope: the buyer (chat,
job description, uploaded files), the platform API (job records, inbox items,
service metadata, webhooks), the LLM (completions + tool calls), the operator's
external executor backend (n8n / CrewAI / A2A / LangGraph / LangServe), an MCP
server, and anonymous HTTP callers on the webhook/proxy port.

Claims checklist: `AUDIT/trust-boundary-claims.md` (77 claims, 9 groups).

Prior passes (`money`, `keys`, `isolation`) are not re-litigated; where a
boundary defect was already reported there it is cited, not restated.

---

## Findings

| # | Sev | Finding | Where |
|---|---|---|---|
| T1 | med | Respawn/reconnect seeds platform chat history straight into LLM context, bypassing the buyer-chat scan | `src/executors/local-llm.js:151-168` |
| T2 | med | `review.received` webhook accepts N reviews with N back-to-back identity txs, outside the batch and outside the pending-write gate | `src/cli.js:7127-7148` |
| T3 | med | Webhook events are never bound to the agent whose secret authenticated them — one agent's secret controls every job on the dispatcher | `src/cli.js:7053-7069` |
| T4 | med | The webhook executor lets an external backend supply the delivery hash independently of the delivered content | `src/executors/webhook.js:113-118` |
| T5 | med | The proxy sends the seller's upstream credential to a URL taken from the platform's service record, with no local cross-check | `src/cli.js:3655` |
| T6 | med | TUI-configured upstream API key is written under one name and read under another — it is never sent | `src/dashboard.js:2838` |
| T7 | med | Legacy body-only webhook HMAC is still accepted on the event route; the anti-downgrade guard exists but is only wired to `revoke` | `src/webhook-server.js:323` |
| T8 | low | `J41_SCAN_BUYER_CHAT` never reaches the code that reads it — the documented opt-out and its mainnet-gate entry are both inert | `src/cli.js:8418-8427` |
| T9 | low | The WebSocket chat handler accepts messages from any sender in the room; the poll path filters by buyer | `src/job-agent.js:1170` |
| T10 | low | `buyer.txt` / `amount.txt` / `currency.txt` are written unbounded; only `description.txt` got the length cap | `src/cli.js:8256-8259` |
| T11 | low | Workspace path guard assumes `args.path` is a string; a non-string tool argument throws out of the tool loop | `src/job-agent.js:1574` |

crit 0 · high 0 · med 7 · low 4 · **total 11**

---

### T1 — med — Respawn seeds platform chat history into the LLM context unscanned

**Where:** `src/executors/local-llm.js:151-168` (`seedConversationLog`), reached
via `:174-187` (`_seedHistoryFromPlatform`) from `init()` at `:113-117`.

**Code path.** Three call sites reach `init(..., {isReconnect: true})`:

1. `src/job-agent.js:1096-1097` — `const isReconnect = job.status === 'in_progress'`,
   i.e. every worker respawned onto an already-running job (idle-pause →
   resume, container crash → restart, dispatcher bounce → crash recovery).
2. `src/job-agent.js:2114-2116` — the dispute **rework** path, which init's the
   executor explicitly before generating the rework.
3. `src/cli.js` respawn/reactivation paths that re-launch a paused job.

On that path `_seedHistoryFromPlatform` calls
`agent.client.getChatMessages(jobId, {limit: 100})` and hands the rows to
`seedConversationLog`, which pushes `m.content` verbatim:

```js
this.conversationLog.push({ role: isAgent ? 'assistant' : 'user', content: m.content });
```

There is no `scanUntrusted` call anywhere in `seedConversationLog` or
`_seedHistoryFromPlatform`. The same text, when it arrives live, *is* scanned —
`handleMessage` at `:198-200` runs it through `scanUntrusted(message,
'other_agent')` (HOLE 3). The re-entry path skips that.

**Trigger.** A buyer sends an injection payload. It is scanned and stripped on
arrival, so the live session is protected. The buyer then goes quiet for
`IDLE_TIMEOUT_MS` (the session pauses and the container is torn down), or files
a dispute that the seller accepts as rework. On respawn the *unstripped
original* is fetched from the platform's message store and seeded into
`conversationLog` as a `user` turn, then sent to the model as part of every
subsequent `callLLM` / `callLLMWithTools` request. A pause-and-resume is a
documented, ordinary lifecycle step (README:234-235), not an unusual state.

Note the SDK's `scanContext` treats source `'user'` as trusted and never
muzzles it (`sovguard-context.js:11`, `test/sovguard-context.test.js:22-25`), so
even a later scan of the assembled log would not help — the scan has to happen
at seed time with an untrusted source label.

**Blast radius.** Everything HOLE 3 was added to prevent: instruction override,
exfiltration attempts through workspace tools, canary probing. The canary block
(`job-agent.js:1150-1153`) and the broker's constrained-signer policy
(`sign-broker.js:53-103`) still hold, so this is context poisoning, not key or
fund compromise.

**Only `local-llm` seeds.** `mcp.js:104-110` sends an amnesia notice instead and
is unaffected; the other four executors do not reload history at all.

**Proposed fix (not applied).** Scan inside `seedConversationLog` for rows the
agent did not author:

```js
const isAgent = (agentId && m.senderVerusId === agentId) || (agentName && m.senderVerusId === agentName);
const content = isAgent ? m.content : await scanUntrusted(m.content, 'other_agent');
```

which makes the method async — `_seedHistoryFromPlatform` already awaits it.
Match the `J41_SCAN_BUYER_CHAT` gate used at `:198` so the two paths stay
symmetrical (see T8 — that gate is currently inert either way).

---

### T2 — med — `review.received` writes N back-to-back identity transactions

**Where:** `src/cli.js:7127-7148`.

```js
case 'review.received': {
  const inbox = await agent.client.getInbox('pending', 10);
  const reviews = (inbox.data || []).filter(i => i.type === 'review' || i.rating != null);
  for (const review of reviews) {
    await agent.acceptReview(review.id);   // ← one identity tx each, no gate
```

**What this violates.** CLAUDE.md §Key Patterns states the invariant plainly:

> Inbox accepts are BATCHED — one identity transaction per agent per poll cycle
> (`processInboxForAgent`). **Never write two identity txs for the same VerusID
> back-to-back**: the platform serves the last *confirmed* `prevOutput`, so the
> second double-spends.

`processInboxForAgent` (`cli.js:7496`) implements exactly that: a pending-write
gate at `:7515-7543` that defers the whole cycle while the previous identity tx
is unconfirmed, a single batched accept, and `state._inboxLastWrite` bookkeeping.
The `review.received` handler participates in none of it — it neither consults
`state._inboxLastWrite` nor records into it.

**Trigger, two independent ways.**

1. *Within the handler.* Two or more pending `review` items when the webhook
   fires (a burst of completed jobs, or one review re-emitted — the SDK's own
   `jobHashAlreadyOnChain` comment at `inbox/vdxf-gate.js:132-142` says the
   platform's `POST /v1/reviews` "can mint a fresh inbox item for a review that
   was already written"). The loop broadcasts tx 1, then immediately builds tx 2
   from the still-last-confirmed `prevOutput`. Tx 2 double-spends and is
   rejected.
2. *Against the poller.* Even for a single review, the write is invisible to
   `processInboxForAgent`. The next inbox cycle (within ~60 s) sees an empty
   `state._inboxLastWrite` for that agent, skips the defer, and builds its batch
   from the same stale `prevOutput`.

**Why it stays invisible.** The rejection surfaces as `TX_REJECTED`, which
`inbox-deadletter.js` classifies as **contention** — never counted, never
dead-lettered, retried forever. CLAUDE.md §VDXF Update calls out this exact
silent-retry behaviour. The operator sees reviews that "never land on chain"
with no error escalation, while each attempt still burns the 0.0001 VRSC fee
against the R-address tank.

**Reachability.** Webhook mode only (`options.webhookUrl` set, `cli.js:3572`) —
which is also the mode required for the API-endpoint proxy (`cli.js:3566-3567`),
so it is not an exotic configuration. Poll mode reaches reviews only through the
gated `processInboxForAgent`.

**Proposed fix (not applied).** Delete the direct-accept loop. Have
`review.received` do what a push notification should do — mark the agent's inbox
dirty and let the next `processInboxForAgent` cycle handle it under the existing
gate. If a lower-latency path is wanted, route through `processInboxForAgent`
with the single item so the gate and `_inboxLastWrite` bookkeeping still apply.

---

### T3 — med — Webhook events are never bound to the authenticating agent

**Where:** `src/cli.js:7053-7069`.

```js
async function handleWebhookEvent(state, agentId, payload) {
  const agentInfo = state.agents.find(a => a.id === agentId);   // from the URL path
  if (!agentInfo) { ... return; }
  const { event, data } = payload;
  const jobId = data?.jobId || payload.jobId;                    // from the body
  // …no check that jobId belongs to agentInfo…
```

`agentId` comes from `/webhook/:agentId` and *is* authenticated — the HMAC is
verified against that agent's secret only (`webhook-server.js:322-327`). But
`jobId` comes from the signed body and is used directly against global
dispatcher state. Concretely:

- `job.cancelled` (`:7151-7168`) → `stopJobContainer(state, jobId)` for **any**
  active job.
- `job.disputed` / `job.dispute.filed` (`:7176-7184`) → `queueDisputedJobForRespawn`.
- `job.dispute.resolved` / `.rework_accepted` (`:7191-7208`) → `sendToJobAgent`
  into another agent's live container.
- `job.paused` (`:7318-7338`) → tears the job down into the reactivation queue.
- `job.delivered` (`:7340-7349`) / `job.end_session_request` (`:7269-7276`) →
  forces another agent's worker to finalize and deliver early.
- `job.reconnect` (`:7287-7300`) → `state.seen.delete(jobId)`, which makes an
  already-processed job eligible to be picked up again.

**Trigger.** Any party who learns one agent's webhook secret — a leaked
`webhook-config.json` (mode 0600, but it is one file among nine on a shared
host), a compromised tunnel/reverse proxy in front of the public webhook URL, or
a stale secret from a decommissioned agent that was never rotated — gains
lifecycle control over every job the dispatcher is running, not just that
agent's. The per-agent-path design at `webhook-server.js:5` exists precisely to
scope a secret to one agent; the event handler then discards that scoping.

Combined with **T7** (legacy signatures accepted, replayable) the precondition
weakens further: a captured `job.cancelled` for agent-1 can be replayed later,
and its payload jobId need not be agent-1's job.

**Not a path-traversal risk.** Every `path.join(JOBS_DIR, jobId)` reached from
these handlers requires the job to already be in `state.active`, and entry to
`state.active` is gated by `isValidJobId` (`cli.js:8232`, `:8716`). The impact
is availability and lifecycle, not filesystem.

**Proposed fix (not applied).** After resolving `jobId`, require the job to
belong to the authenticated agent before acting on it:

```js
const owned = state.active.get(jobId);
if (jobId && owned && owned.agentInfo?.id !== agentInfo.id) {
  console.error(`[Webhook] ${agentInfo.id} sent an event for ${jobId} owned by ${owned.agentInfo?.id} — refusing`);
  return;
}
```

For the accept-side events (`job.requested`, `job.started`, `bounty.awarded`),
which have no local job yet, the equivalent check is that the platform's
`getJob(jobId)` names this agent as the assignee — `fullJob` is already fetched
at `:7077` and `:7106`.

---

### T4 — med — The webhook executor lets its backend choose the delivery hash

**Where:** `src/executors/webhook.js:113-118`, consumed at `src/job-agent.js:863-867`.

```js
// webhook.js finalize()
const content = response?.deliverable || response?.content || <local fallback>;
const hash    = response?.hash        || crypto.createHash('sha256').update(content).digest('hex');
return { content, hash };
```

```js
// job-agent.js
let deliverHash = result.hash;                       // taken as-is
const brokered = await signer.signDeliver({ jobId: job.id, jobHash: fullJob.jobHash, deliveryHash: deliverHash });
await agent.client.deliverJob(job.id, deliverHash, brokered.signature, brokered.timestamp, result.content.substring(0, 200));
```

`hash` and `content` come from the same backend response but are never checked
against each other. The broker deliberately does not close this: its comment at
`sign-broker.js:79-81` says the deliveryHash "is a SHA-256 commitment to the
delivered content — not a fund-bearing field", and it validates format only
(`HEX64`, `:83-85`). So the agent's key signs, and the platform records, a
commitment that need not commit to anything that was delivered.

**Trigger.** Any deployment using `J41_EXECUTOR=webhook` — which is also where
the framework aliases `crewai`, `autogen`, `dify`, `flowise`, `haystack` and
`n8n` route (CLAUDE.md §Executor Types), i.e. a large share of the non-LLM
integrations. A backend that returns `{content: "...", hash: "<64 hex>"}` where
the hash is stale, from a different response, or simply wrong produces a
delivery whose integrity proof is void. It needs no malice — an n8n workflow
that computes the hash before a post-processing step is enough. The failure is
silent: the format check passes, the signature is valid, the platform accepts it,
and the mismatch only surfaces if a buyer ever recomputes.

**Contrast.** The other four executors compute the hash locally and cannot drift
(`langserve.js:83`, `langgraph.js:106`, `a2a.js:133`, `local-llm.js:254`), and
`job-agent.js:853-859` goes out of its way to *recompute* the hash after the
canary strip precisely because "a wrong hash is a broken integrity claim, not a
cosmetic mismatch". The webhook executor is the one place that reintroduces the
condition that comment describes.

**Proposed fix (not applied).** Drop `response?.hash` from the preference chain
in `webhook.js:115` and always hash locally. If a backend-supplied hash must
stay supported for compatibility, verify it and refuse on mismatch:

```js
const local = crypto.createHash('sha256').update(content).digest('hex');
if (response?.hash && response.hash.toLowerCase() !== local) {
  throw new Error(`webhook executor returned hash ${response.hash} that does not match its own content (${local})`);
}
return { content, hash: local };
```

Belt-and-braces: `job-agent.js:863` could assert `result.hash === sha256(result.content)`
for every executor before calling `signDeliver`.

---

### T5 — med — The platform chooses where the seller's upstream credential is sent

**Where:** `src/cli.js:3654-3662` (proxy config assembly), `src/cli.js:4912-4915`
(precedence), `src/proxy-handler.js:443` (use).

```js
// cli.js:3653-3661
const upstreamAuth = apiSvc.upstreamAuth || localCfg.apiEndpointAuth || '';
agentConfigs.set(a.id, {
  endpointUrl: apiSvc.endpointUrl,     // ← platform's value, no local cross-check
  …
  upstreamAuth,
});
```

`apiSvc` comes from `client.getAgentServices()` (`cli.js:4861-4862`) — a platform
API response. The operator's locally configured URL is consulted only as a
*fallback* when the platform omits one:

```js
// cli.js:4915
if (!svc.endpointUrl) svc.endpointUrl = agentConfigEndpoint || onChainEndpoint;
```

so when the platform supplies a value it always wins over both
`agent-config.json` and the agent's own on-chain `networkEndpoints`. That value
then becomes the destination for every proxied request, carrying the seller's
real upstream credential:

```js
// proxy-handler.js:438-444
const proxyReq = transport.request(upstreamUrl.href, {
  headers: { …, ...(config.upstreamAuth ? { 'Authorization': config.upstreamAuth } : {}) },
```

**Trigger.** A platform-side compromise, a database-level tamper of the service
row, or a TLS-terminating intermediary that can rewrite the `getAgentServices`
response. On the next `start` (or capability refresh) the dispatcher adopts the
new `endpointUrl`; the first buyer request then ships the seller's OpenAI /
OpenRouter / vLLM bearer token to the attacker's host and returns whatever it
answers as the seller's inference output.

**What does hold.** The SSRF checks still apply — `checkUpstreamHostSafe`
(`proxy-handler.js:186-210`) blocks private/loopback/link-local destinations and
pins DNS — so the redirect must be to a routable public host. And README:634's
claim that J41 never *sees* the key is accurate (D13): `upstreamAuth` is never
uploaded (`dashboard.js:2846-2859` omits it). The gap is narrower but real: the
platform does not hold the key, it holds the pointer to where the key goes.

**Proposed fix (not applied).** Treat the local config as authoritative for the
destination and the platform record as advisory. Either pin to
`localCfg.apiEndpointUrl` when it is set, or keep preferring the platform value
but refuse when the two disagree:

```js
const platformUrl = apiSvc.endpointUrl;
const localUrl = localCfg.apiEndpointUrl || localCfg.endpointUrl || '';
if (localUrl && platformUrl && new URL(localUrl).origin !== new URL(platformUrl).origin) {
  console.error(`[API Proxy] ${a.id}: platform endpointUrl ${platformUrl} disagrees with local ${localUrl} — refusing to start the proxy for this agent`);
  continue;
}
```

A same-origin check is the useful granularity: it permits path changes without
permitting a host change.

---

### T6 — med — TUI-configured upstream API key is written under one name, read under another

**Where:** `src/dashboard.js:2806-2840` (write) vs `src/cli.js:3653` (read).

```js
// dashboard.js — [18] API Endpoint Setup, Step 8
if (authKey) upstreamAuth = `Bearer ${authKey}`;
…
if (upstreamAuth) agentConfig.upstreamAuth = upstreamAuth;   // key: "upstreamAuth"
saveAgentConfig(agentId, agentConfig);
console.log('  ✓ Agent config saved (upstream URL + auth)');
```

```js
// cli.js:3653
const upstreamAuth = apiSvc.upstreamAuth || localCfg.apiEndpointAuth || '';
//                                                    ^^^^^^^^^^^^^^^ never written by the TUI
```

The scripted path writes the other name — `cli.js:3048` sets
`config.apiEndpointAuth` from `--upstream-auth` — so the CLI flow works and the
TUI flow does not. `apiSvc.upstreamAuth` cannot cover the gap either: the key is
deliberately never registered with the platform (`dashboard.js:2846-2859`, and
D13 depends on that staying true), so it is always absent from the service
record.

**Trigger.** An operator who follows README:636 ("Set up via TUI:
`dashboard` → `[18] API Endpoint Setup`"), answers "yes" to *"Does your LLM
server require an API key?"*, and types the key. The TUI prints
`✓ Agent config saved (upstream URL + auth)` and the key lands on disk — but
`config.upstreamAuth` is falsy at `cli.js:3653`, so `proxy-handler.js:443` omits
the `Authorization` header entirely and every buyer request reaches the upstream
unauthenticated.

**Consequence.** The upstream answers 401. The non-streaming settle path
(`proxy-handler.js:550-580`) does not branch on `proxyRes.statusCode` — it parses
the body, finds no `usage`, falls back to the flat estimates at `:554-561`, and
calls `adjustCredit`. The buyer is billed for a 401. (The billing-on-error
mechanism itself is `AUDIT/money.md` **M2**; what is new here is a configuration
path that makes it fire on *every* request rather than on a rare upstream fault.)
For a streaming request the fallback at `:507-509` settles at the full worst-case
reservation — money **M1**.

**Proposed fix (not applied).** Accept both names at the read site, which fixes
existing installs without a migration:

```js
const upstreamAuth = apiSvc.upstreamAuth || localCfg.apiEndpointAuth || localCfg.upstreamAuth || '';
```

and align `dashboard.js:2838` on `apiEndpointAuth` to match `cli.js:3048` going
forward. Separately worth doing: skip metering when `proxyRes.statusCode >= 400`
and no `usage` is present, so an auth misconfiguration cannot bill a buyer.

---

### T7 — med — Legacy body-only webhook HMAC is still accepted on the event route

**Where:** `src/webhook-server.js:23-34` (the helper), `:323` (the event route),
`:230-231` (the one route that is protected).

The helper documents the threat and provides the control:

```js
// requireTimestamped: refuse the legacy body-only HMAC so an on-path attacker
// can't strip the timestamped header to force a replayable downgrade.
if (opts.requireTimestamped) return false;
return verifyWebhookSignature(rawBody, headers['x-webhook-signature'] || '', secret);
```

`/j41/api-access/revoke` passes it (default-on, disabled only by
`J41_ALLOW_LEGACY_REVOKE=1`). The main event route does not:

```js
// webhook-server.js:323
if (!verifyInboundWebhook(rawBody, req.headers, config.secret)) {   // no opts
```

**Trigger.** An on-path observer of the public webhook URL — a
tunnel/reverse-proxy operator, a logging sidecar, anything that sees the request
— captures one signed `POST /webhook/agent-1`, strips
`X-Webhook-Signature-Timestamped` and `X-Webhook-Timestamp`, and replays the
body with only `X-Webhook-Signature`. The 5-minute freshness window is bypassed
because the legacy HMAC covers the body alone.

**What is left standing.** The nonce cache at `:339-355`. It is real defence but
it is not a substitute:

- It fires only if the payload carries `id` / `nonce` / `eventId`, or the sender
  supplies an `x-j41-event-id` **header** — which an attacker replaying the body
  simply omits. The code itself notes "If no event id is present, proceed as
  before but note the open window" (`:342`).
- It is process-local with an 11-minute default TTL for entries with no
  `expiresAt` (`nonce-cache.js:19`, `:66-68`). A webhook event id has no
  `expiresAt`, so a replay 12 minutes later, or any replay after a dispatcher
  restart, is accepted. `nonce-cache.js:15-18` argues restart-clearing is safe
  because "an attacker can only replay within the envelope's expiresAt" — true
  for access envelopes, false for these events, which have no expiry once the
  timestamped signature is stripped.

Chained with **T3** (no agent↔job binding), a single captured event replays into
lifecycle control over an arbitrary job: `job.cancelled` and `job.paused` both
tear down a running container, `job.delivered` forces an early finalize.

**Proposed fix (not applied).** Pass the same flag the revoke route already
passes, under the same rollout escape hatch:

```js
const requireTimestamped = process.env.J41_ALLOW_LEGACY_WEBHOOK !== '1';
if (!verifyInboundWebhook(rawBody, req.headers, config.secret, { requireTimestamped })) { … }
```

and add the new variable to `mainnet-guard.js` alongside
`J41_ALLOW_LEGACY_REVOKE`. If the platform's dual-sign rollout is not complete,
the interim step is to require an event id (reject when `eventId` is null) so the
nonce cache always engages.

---

### T8 — low — `J41_SCAN_BUYER_CHAT` cannot reach the code that reads it

**Where:** read at `src/executors/local-llm.js:198`, `mcp.js:121`,
`webhook.js:73`, `a2a.js:91`, `langserve.js:58` — all of which execute **inside
the job container**. Never written at `src/cli.js:7927` (`buildContainerEnv`),
never appended to the container `Env` array (`cli.js:8418-8427`), and absent from
the local-mode whitelist (`cli.js:8750-8753`, an explicit 10-entry list with no
`...process.env` spread).

**Consequence, both directions.**

- The documented opt-out does not exist. README:759, `docs/sovguard-context-integration.md:63-70`
  and five in-code comments all tell operators to set `J41_SCAN_BUYER_CHAT=0`.
  Setting it on the dispatcher changes nothing in either runtime; the guard
  `process.env.J41_SCAN_BUYER_CHAT !== '0'` is always true in the container, so
  scanning is unconditionally on.
- The mainnet-gate entry (`mainnet-guard.js:44`) refuses to start on a variable
  that has no effect. It is the only one of the 13 gated flags where that is
  true — the other twelve are read either on the host (`J41_WITNESS_VERIFY` →
  `broker-executors.js:82`, `J41_ALLOW_LOCAL_UPSTREAM` → `proxy-handler.js:187`,
  `J41_ALLOW_LEGACY_REVOKE` → `webhook-server.js:230`) or by SDK code that runs
  where the variable is set.

The default is the safe one, so this is not an exploitable hole — it is a
documented control that does not exist, in a domain where an operator reading the
mainnet gate is entitled to conclude the opposite.

**Secondary drift.** `docs/sovguard-context-integration.md:63` states buyer-chat
scanning is "gated behind `J41_SCAN_BUYER_CHAT=1` (default off)". The code is
`!== '0'`, i.e. default **on**, and README:759 agrees with the code. The doc is
stale and inverted; an operator trusting it believes an active defence is off.

**Proposed fix (not applied).** Forward it explicitly, the same way
`J41_DISPUTE_HOLD_MAX_MS` is (`cli.js:7955-7958` — "setting it on the dispatcher
alone did nothing, and the knob silently had no effect", the identical bug class,
already fixed once):

```js
...(process.env.J41_SCAN_BUYER_CHAT !== undefined
  ? { J41_SCAN_BUYER_CHAT: String(process.env.J41_SCAN_BUYER_CHAT) }
  : {}),
```

and correct `docs/sovguard-context-integration.md:63-70` to say default-on.

---

### T9 — low — WebSocket chat accepts messages from any sender in the room

**Where:** `src/job-agent.js:1170`.

```js
agent.onChatMessage((jobId, msg) => { if (jobId !== job.id) return; processBuyerMessage(msg); });
```

The filter is on `jobId` only. The SDK dispatches every `message` socket event
for that room to the handler with no sender check
(`node_modules/@junction41/sovagent-sdk/dist/chat/client.js:148-160`), so
whatever `senderVerusId` carries, the content goes to `executor.handleMessage`
and drives an LLM turn, a workspace tool call, and an outbound reply.

The poll fallback on the very same job does filter, deliberately and with a
comment saying why:

```js
// message-poll.js:2-5 — "keep ONLY messages the buyer sent (positive match —
// never the agent's own, so no self-reply loop)"
return messages.filter(m => m && m.senderVerusId === buyerVerusId)…
```

and `_buyerVerusId` is already resolved in scope at `job-agent.js:1175`, three
lines after the WS handler is registered.

**Trigger.** Anyone other than the buyer who can emit into the job room —
a platform-side arbiter or support account during a dispute, an operator tool,
or a second identity the platform admits. Whether that set is non-empty is a
**platform-side** question this pass cannot answer from the dispatcher
repository, which is why this is rated low rather than medium. What is certain
from the code is that the dispatcher applies no check of its own on the WS path
while applying one on the poll path, and that the asymmetry is silent.

Self-echo is the one case that is provably not happening: if the server echoed
the agent's own `sendChatMessage` back into the room, the agent would answer
itself in an unbounded loop, so the server evidently does not.

**Proposed fix (not applied).** Mirror the poll filter, and log rather than
silently drop so an unexpected participant is visible:

```js
agent.onChatMessage((jobId, msg) => {
  if (jobId !== job.id) return;
  if (_buyerVerusId && msg.senderVerusId && msg.senderVerusId !== _buyerVerusId) {
    console.warn(`[CHAT] ignoring message from non-buyer ${msg.senderVerusId} on job ${job.id}`);
    return;
  }
  processBuyerMessage(msg);
});
```

This needs `_buyerVerusId` hoisted above the handler registration (currently
resolved at `:1175`), or the check deferred into `processBuyerMessage`.

---

### T10 — low — The job-description length cap does not cover the sibling files

**Where:** `src/cli.js:8245-8259`.

```js
// Audit 2026-06-02 M-DISPATCHER-ddos-4: cap platform-supplied job.description
// length before writing to disk. A compromised/MITM'd platform could otherwise
// ship a 100 GB description and exhaust the operator's disk.
const MAX_DESCRIPTION_BYTES = Number(process.env.J41_JOB_DESCRIPTION_MAX_BYTES || 1024 * 1024);
const desc = typeof job.description === 'string' ? job.description : '';
if (desc.length > MAX_DESCRIPTION_BYTES) throw new Error(…);

fs.writeFileSync(path.join(jobDir, 'description.txt'), desc);
fs.writeFileSync(path.join(jobDir, 'buyer.txt'), job.buyerVerusId);   // uncapped
fs.writeFileSync(path.join(jobDir, 'amount.txt'), String(job.amount)); // uncapped
fs.writeFileSync(path.join(jobDir, 'currency.txt'), job.currency);     // uncapped
```

Same threat model the existing mitigation was written for, same `getJob`
response, three fields the mitigation does not reach. `startJobLocal`
(`cli.js:8737-8740`) has no cap on any of the four.

`sanitizeInput` in the container truncates all four to 10 000 chars when they are
read back (`job-agent.js:351-356`, `:514-517`), so the LLM context is protected —
the exposure is the host's disk between write and cleanup, plus a type error if
`job.buyerVerusId` is not a string (`writeFileSync` throws, the job start fails).

Low because it requires a compromised or MITM'd platform response, and the same
attacker has more direct options. Listed because the mitigation is documented as
covering "platform-supplied job data" and covers one field of four.

**Proposed fix (not applied).** Factor a small helper and apply it to all four
fields in both `startJobContainer` and `startJobLocal`:

```js
const capped = (v, name, max = 64 * 1024) => {
  const s = typeof v === 'string' ? v : String(v ?? '');
  if (s.length > max) throw new Error(`job.${name} exceeds ${max} bytes (${s.length}); refusing to write`);
  return s;
};
```

with the existing 1 MB budget for `description` and something small (64 KB) for
the other three.

---

### T11 — low — Workspace path guard assumes the model returned a string

**Where:** `src/job-agent.js:1573-1578`.

```js
if (args.path) {
  if (args.path.startsWith('/') || args.path.split(/[\\/]/).includes('..')) {
    return `Workspace error: invalid path "${args.path}" — …`;
  }
}
```

`args` is `JSON.parse(toolCall.function.arguments)` (`local-llm.js:312-316`) —
model output. A model that emits `{"path": 42}` or `{"path": ["a","b"]}` reaches
`args.path.startsWith`, which is `undefined` on a number and throws
`TypeError: args.path.startsWith is not a function`. The check sits **before**
the `try` at `:1580`, so it propagates.

In `local-llm.js` the handler call at `:323` is not wrapped:

```js
const toolResult = await this.workspaceHandler(toolName, args);
```

so the throw unwinds `_agentLoop` → `handleMessage` → the `try` in
`processBuyerMessage` (`job-agent.js:1162-1165`), and the buyer gets "I
experienced an issue processing your message. Please try again." — losing the
whole turn, including any tool results already gathered in that round. `mcp.js`
is unaffected: its handler call is inside a `try` at `:212-224` and degrades to
`Error: …` fed back to the model.

Not a bypass — a non-string `path` never reaches the workspace client, and the
SDK validates again — so this is robustness at a trust boundary, not a hole.

**Proposed fix (not applied).** Type-check first, and return the same
model-readable error the other invalid-path cases return:

```js
if (args.path !== undefined) {
  if (typeof args.path !== 'string') {
    return `Workspace error: path must be a string (got ${typeof args.path})`;
  }
  if (args.path.startsWith('/') || args.path.split(/[\\/]/).includes('..')) { … }
}
```

Independently, wrap the `workspaceHandler` call in `local-llm.js:323` the way
`mcp.js:212-224` already does, so no handler defect can cost a whole turn.

---

## Adversarial pass — shortest path from untrusted input to a bad outcome

Traced concretely; each ends in code, not speculation.

**1. Buyer → LLM context, via the pause/resume seam (shortest real path).**
Buyer posts an injection → scanned and stripped on arrival
(`local-llm.js:198`) → buyer goes quiet for `IDLE_TIMEOUT_MS` → session pauses,
container dies → buyer resumes → new worker inits with `isReconnect: true`
(`job-agent.js:1096`) → `_seedHistoryFromPlatform` fetches the **original,
unstripped** text and seeds it as a `user` turn (`local-llm.js:164`) → every
subsequent LLM request carries it. **Three steps, all ordinary lifecycle.** This
is T1 and it is the shortest path in the domain.

**2. Platform (or a webhook-secret holder) → another agent's job.** One agent's
webhook secret → `POST /webhook/agent-1` with `{event:'job.cancelled',
data:{jobId:<agent-7's job>}}` → `handleWebhookEvent` resolves `agentInfo` from
the path, `jobId` from the body, checks nothing (`cli.js:7053-7069`) →
`stopJobContainer` kills agent-7's live job (`:7151-7168`). With T7 the secret is
not even needed for a *repeat*: a single captured signed event replays
indefinitely once the timestamped header is stripped.

**3. Platform → the agent's on-chain identity, via review re-emit.** Platform
emits `review.received` while ≥2 reviews are pending → the handler loops
`acceptReview` (`cli.js:7133-7135`) → two identity txs back-to-back on the same
VerusID → the second double-spends the `prevOutput` → `TX_REJECTED` → classified
`contention` by `inbox-deadletter.js` → retried forever, never escalated, fee
burned each cycle. That is T2, and it is the failure CLAUDE.md documents as
"observed live on 3/3 agents".

**4. Operator's executor backend → a void integrity proof.** An n8n workflow
returns `{content, hash}` where the hash is stale → `webhook.js:115` prefers it →
`job-agent.js:863` signs it → the platform records a delivery commitment that
does not commit to the delivery. Format check passes, signature is valid, nothing
warns. That is T4.

**5. Platform → the seller's upstream API key.** A tampered `getAgentServices`
response changes `endpointUrl` → `cli.js:3655` adopts it (local config is only a
fallback, `:4915`) → the first buyer request ships
`Authorization: <seller's upstream key>` to the new host
(`proxy-handler.js:443`). SSRF checks force a public destination but do not
constrain *which*. That is T5.

**Paths that were traced and do NOT reach a bad outcome:**

- **Container → host signing.** A fully injected container gets a signature only
  for its own job's legitimate action at the authoritative amount:
  `buildBrokeredMessage` rebuilds every security-bearing field from the platform
  job record and default-denies unknown types (`sign-broker.js:53-103`);
  `signGenericMessage` refuses protocol-shaped strings and caps at 4 KB
  (`:143-172`). No path from buyer text to an identity update or a payment.
- **Platform → arbitrary VDXF key on the agent's identity.** The SDK's per-type
  allowlist (`inbox/vdxf-gate.js:44-52`) admits `review.record` only for a
  review, `review.attestation` only for an attestation, and `job.*` only for a
  job record — gated per item *before* any batch merge, so a key cannot ride in
  under another item's type. `job_record` additionally cross-checks the inbox
  bytes against an independently fetched, signature-verified witness
  (`inbox-job-record.js:174-199`). T2 abuses the *timing* of these writes, not
  their content.
- **Anonymous HTTP → a minted API key.** Both envelope versions verify locally
  and fail closed (`cli.js:3733-3735`, `:3752-3755`), the nonce cache is touched
  only after verification (`nonce-cache.js:95-98`), v1 enforces a 300 s freshness
  window before any network I/O (SDK `envelope.js:298-303`), and discovery is
  rate-limited per source IP before the outbound identity lookup
  (`webhook-server.js:135-141`). No bypass flag exists on either path.
- **Buyer → SSRF via the proxy.** Path is re-based onto the configured endpoint
  and the hostname must match (`proxy-handler.js:377-397`); private/loopback/
  link-local are blocked in v4, v6, and both `::ffff:` encodings
  (`:118-174`); the validated IP is pinned into `http.request`'s `lookup` so DNS
  rebinding cannot win the TOCTOU (`:427-446`).
- **Buyer → filesystem via jobId.** `isValidJobId` (`job-id.js:2`) gates both
  spawn paths; every later `path.join(JOBS_DIR, jobId)` is reached only for an id
  already in `state.active`, so the `fs.rmSync(jobDir, {recursive:true})` at
  `cli.js:8676` and `:8958` cannot be steered.
- **Buyer → workspace traversal.** Leading `/` and `..` segments on either
  separator are rejected (`job-agent.js:1574-1577`) and the SDK validates again.
  T11 is a type-robustness defect on this check, not a bypass.
- **Anonymous localhost → the control API.** Bearer required on every `/v1/*`
  route before dispatch, compared in constant time including the length-mismatch
  branch (`control-api.js:63-76`, `:172-175`); non-GET is 405 (`:166-168`); bound
  to 127.0.0.1 (`:206`). `/health` and `/metrics` are unauthenticated but also
  127.0.0.1-bound (`control.js:123`), which README:711 understates rather than
  overstates.

---

## Checked and found clean

Read in this domain and found to do what they claim:

- **`src/sovguard-context.js`** — full file. Source-trust passthrough, single
  warn on scanner unavailability, fail-open documented and implemented at both
  the missing-module and the throw path, notify on every non-allow action.
- **`src/nonce-cache.js`** — full file. Verify-before-record ordering is an
  explicit, testable gate (`checkNonceAfterVerify`); the `Math.max` fallback bug
  called out at `:62-65` really is fixed; LRU eviction bounded; sweep unref'd.
  (Its restart/TTL reasoning is sound for access envelopes and is what T7 leans
  on being insufficient for webhook event ids.)
- **`src/sign-broker.js`** — full file. Constrained signer, not an oracle:
  authoritative-field reconstruction, jobId binding, default-deny switch,
  4 KB generic cap, protocol-shape refusal.
- **`src/inbox-job-record.js`** — full file. The strongest boundary in the
  repo: network allowlist, both inbox encodings decoded, >1-entry refusal,
  independent witness fetch, JCS-datahash cross-check of record *and* witness,
  409-only transient classification.
- **`src/message-poll.js`**, **`src/message-dedup.js`** — full files. Positive
  buyer match, bounded exactly-once dedup.
- **`src/mainnet-guard.js`** — full file. All 13 README entries present and
  matching; stickiness correct. (Its env-only read is isolation **I5**; its one
  no-op entry is T8.)
- **`src/control-api.js`** — full file. Auth before dispatch, constant-time
  compare, read-only v1, 0600 token, restart-monotonic event ring.
- **`src/proxy-handler.js`** — SSRF and auth paths. IPv6 normalisation is
  unusually careful (dotted *and* hex `::ffff:` forms); DNS pin closes the
  rebind window; response headers pass an allowlist; unpriced models rejected
  before any upstream call.
- **`src/webhook-server.js`** — routing, body caps, slow-loris timeouts,
  discovery rate limiter, uniform-403 enumeration defence, agent-id path
  validation. (Its one unwired guard is T7.)
- **`src/executors/{mcp,a2a,langserve,langgraph}.js`** — scan wiring at all
  three holes; local hash computation in `finalize`; bounded tool loops;
  `JSON.parse` failure on tool arguments degrades to `{}`.
- **`src/job-id.js`**, **`src/job-agent.js`** `sanitizeInput` — tight regex;
  control-char strip plus 10 000-char cap applied to buyer messages and all four
  job files.
- **SDK `inbox/vdxf-gate.js`** — read in full to terminate F4/F5. Null-prototype
  additions map, per-item type gating before merge, explicit refusal to
  synthesize a review or attestation, unknown type throws rather than defaulting
  open.
- **SDK `crypto/envelope.js`** `verifyAccessRequest` — read to confirm the v1
  replay hook runs after signature verification and that freshness is checked
  before any network I/O.
- **SDK `chat/client.js`** — read to establish that the WS dispatch does no
  sender filtering (T9) and that inbound Socket.IO payloads are capped at 1 MB.

---

## Deliberately NOT covered, and why

- **The SovGuard scanner itself.** `scanContext`'s regex/indirect/perplexity
  layers, its strip-vs-quarantine fallback, and its evasion resistance live in
  `@junction41/sovagent-sdk/dist/safety/context.js`. This pass verified *where*
  it is called, with *what* source label, and what happens when it fails —
  not what it detects. A5/A8/A11 are verified as wiring, not as coverage.
  Detection quality deserves its own pass with adversarial corpora.
- **`checkForCanaryLeak`'s normalisation.** Same reason; the README's
  "evasion-resistant (zero-width strip, NFKC)" is taken from the SDK's own
  docstring. Canary *strip*-vs-*detect* asymmetry on the deliverable is
  already isolation **I9**.
- **Platform-side behaviour.** Three findings bottom out in what
  `api.junction41.io` does or permits: T9 (can anyone but the buyer emit into a
  job room?), T5 (can a service record be tampered short of full compromise?),
  and T2's re-emit frequency. Marked as platform-dependent in place rather than
  guessed at; each needs a backend check.
- **Money consequences of trust-boundary defects.** T6 ends in a billing
  behaviour that `AUDIT/money.md` already reports (M1/M2); this pass names the
  new trigger and does not re-derive the metering analysis. Budget/extension
  numbers arriving from the platform (`data?.estimatedTokens`, `cli.js:7398`)
  are money-domain.
- **Key custody and the signing channel's internals** — `AUDIT/keys.md`. This
  pass asked only what the broker *refuses*, not how the channel is protected
  (K3/K4) or how keys are stored.
- **Container and network isolation** — `AUDIT/isolation.md`. The three walls,
  the egress proxy, the bind mounts, and the download-filename write primitive
  (I1/I2) are that pass's. T1–T11 all assume the isolation posture as-is.
- **`update-profile`'s ungated identity write.** CLAUDE.md documents it
  (F8) and it is operator-initiated, not reached from untrusted input. T2 is the
  automatic, undocumented instance of the same hazard and is what this pass
  reports.
- **MCP tool-description poisoning.** `mcp.js:68-80` puts `tools/list` output
  into the LLM's tool schema unscanned, but the MCP server is operator-
  configured and inside the trust boundary. Recorded as A15, not reported.
- **Dashboard screens** beyond the `[18] API Endpoint Setup` write path that T6
  needed. `dashboard.js` cannot be imported under `node --test` and the pass is
  read-only.
- **Running any code.** No tests executed, no `node --check`, no docker
  commands, no network calls. Every finding is traced statically to a file:line
  and a reachable call path. The one dynamic-looking claim — that
  `J41_SCAN_BUYER_CHAT` cannot reach the container — is established by
  exhaustive reading of the two env-construction sites (`cli.js:8418-8427` for
  Docker, `cli.js:8750-8760` for local), both of which are explicit allowlists
  with no `process.env` spread.
