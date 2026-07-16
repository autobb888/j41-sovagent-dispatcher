# Worker Message Reliability — Design

**Date:** 2026-07-15
**Status:** Proposal — for review before planning
**Repo:** `j41-sovagent-dispatcher` (job-agent worker + executors)
**Origin:** E2E tester Rounds 5–6. Two dispatcher-side reliability gaps: (6.1) LLM outages are invisible — the worker
silently ships a canned fallback; (6.4) the worker only receives messages via the chat WebSocket push, so any message
that isn't pushed to the socket (API/SDK-posted messages, or a resumed session where the platform doesn't re-route)
is never seen and the agent stays silent. The platform-side causes are specced separately
(`docs/backend-reports/2026-07-15-platform-frontend-fixes-from-e2e-rounds4-6.md`, P1/P3); these are the dispatcher
defenses so the worker is robust regardless.

---

## Fix 6.1 — Make LLM outages loud (no more silent capability failure)

### Problem
`src/executors/local-llm.js:379` (and `:434`, `src/executors/mcp.js:277`) return a canned string
(`"I encountered an issue generating a response…"`) when the LLM call fails, with **no error log**. During the tester's
`kimi-k2.6` 404 window every agent shipped this string while *looking* healthy (online, chat round-tripping in ~1s) —
a silent capability outage that then fed the empty auto-delivery.

### Fix
At each fallback point, **log loudly with a distinctive, greppable marker and the real error** before returning the
fallback string:
```
console.error(`[LLM-OUTAGE] ${provider}/${model}: LLM call failed — shipping fallback. error=${err.message}`);
```
- Marker `[LLM-OUTAGE]` (worker stdout is streamed into the dispatcher log, so this is visible + alertable by ops).
- Include provider, model, and the underlying error (status/detail) so `kimi-k2.6 404` is immediately diagnosable.
- Behavior otherwise unchanged (still returns the fallback so the chat doesn't hang) — this is **observability only**,
  no delivery-path change.

### Design decisions
- Log-only (no new IPC/health-doc wiring) — the dispatcher already captures worker stdout; a marker line is the
  minimum that enables alerting, which is exactly what the tester asked for. Health-doc surfacing via stdout parsing
  is a possible follow-up, out of scope.

---

## Fix 6.4 — Worker message-poll fallback (WS-push is not the only path)

### Problem
The worker receives buyer messages **only** via the chat WebSocket push (`agent.onChatMessage`, `job-agent.js:712`).
There is no polling. So a message that the platform stores but does **not** push to the socket — API/SDK-posted
messages (`POST /v1/jobs/{id}/messages`, tester 6.4), or a resumed session where server-side routing doesn't reach
the respawned worker's socket (tester 6.2) — is never processed and the agent stays silent even though it is alive,
connected, and in the room.

### Fix
Add a **periodic poll** in the worker that fetches recent messages via `agent.client.getChatMessages(jobId)` and feeds
any it hasn't already handled through the **same** processing path as the WS handler. Shared dedup by message `id` so a
message delivered by *both* WS and poll is processed exactly once.

**Mechanics:**
1. **Extract** the WS handler body (`job-agent.js:712-757`) into `async function processBuyerMessage(msg)` — the
   `_paused` guard, `_lastActivityAt` update, file-upload detection, `messageQueue` serialization, canary check, and
   `sendChatMessage` all move in unchanged.
2. **Shared dedup set** `_processedMsgIds: Set<string>`. `processBuyerMessage` first checks
   `if (_processedMsgIds.has(msg.id)) return;` then `_processedMsgIds.add(msg.id)`. Both the WS `onChatMessage`
   callback and the poll call `processBuyerMessage`.
3. **Poll loop:** `setInterval` every `MESSAGE_POLL_MS` (default 8000). Each tick (skip if `_paused` or `sessionEnded`):
   - `const { data } = await agent.client.getChatMessages(jobId, { since: _lastPolledIso || undefined, limit: 50 });`
   - For each msg **from the buyer** (`msg.senderVerusId !== ownIdentity`) not already in `_processedMsgIds`, in
     `createdAt` order, call `processBuyerMessage({ id, jobId, senderVerusId, content, createdAt })`.
   - Advance `_lastPolledIso` to the newest `createdAt` seen. Errors are swallowed (transient) and retried next tick.
   - `.unref()` the timer; `clearInterval` on session end / delivery / timeout.
4. **Bound the dedup set** — cap `_processedMsgIds` (e.g. keep last 500 ids) so a very long session can't grow it
   unboundedly. (A job's message count is small in practice; a simple size cap on insert is enough.)

### Design decisions
- **8 s poll** — responsive enough for chat, light on the platform (one GET per active, non-paused job per 8 s). Not
  applied to paused jobs (the container is freed anyway once reactivation frees it).
- **Dedup by `id`, not content** — the WS `IncomingMessage` and `ChatMessage` both carry `id`; identical text is a
  distinct message and must not be dropped.
- **Reuse `messageQueue`** — polled and WS messages serialize through the same queue, preserving ordering and the
  one-at-a-time executor contract.
- **Sender filter** — `getChatMessages` returns the agent's own sent messages too; skip anything whose sender is this
  agent's identity so the worker never "replies to itself."
- This is a **defense/mitigation**; the correct primary fix for API-posted messages is server push (backend P3). The
  poll makes the worker work regardless.

---

## Testing
- **6.1 (unit):** a `local-llm` handleMessage whose LLM call throws → returns the fallback AND logs a line matching
  `/\[LLM-OUTAGE\]/` including the provider/model/error. (Inject a fake LLM client that throws.)
- **6.4 (unit, pure dedup):** a `shouldProcess(id, processedSet)` helper (or `processBuyerMessage`'s dedup) → the same
  `id` via WS then poll is handled once; a distinct `id` with identical content is handled twice; the set stays capped.
- **6.4 (unit, poll selection):** given a `getChatMessages` result mixing buyer + own-agent messages and some already
  in the dedup set, the poll selects exactly the new buyer messages in `createdAt` order.
- **Live (the real proof):** hire → send a message via the **API path** (`POST /v1/jobs/{id}/messages`, the path that
  the WS doesn't push) → confirm the agent now **responds** (was silent before). And a resumed session: after respawn,
  an API-posted message gets a reply.

## Global constraints
- CJS, no build step; `node --check` + `node --test`. No new runtime dependency.
- **No double-processing** — WS + poll dedup by id; exactly-once through `messageQueue`.
- **No behavior change when WS push works** — polled messages are already-seen (in the dedup set from the WS handler),
  so the poll is a near-no-op on a healthy socket; it only *adds* coverage for un-pushed messages.
- **Paused jobs:** the poll does nothing while `_paused` (consistent with the WS `_paused` guard), and stops on session
  end — no work against a freed/paused job.
- 6.1 is observability-only — the delivery path and fallback content are unchanged.

## Deferred
- Surfacing `[LLM-OUTAGE]` into the dispatcher health doc (`_agentErrors`) via stdout parsing — nice-to-have.
- Backoff/jitter on the message poll — fixed 8 s is fine for launch.
