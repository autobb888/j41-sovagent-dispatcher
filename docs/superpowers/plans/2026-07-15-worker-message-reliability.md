# Worker Message Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** (6.1) make LLM outages loud+greppable; (6.4) add a worker message-poll fallback so API/SDK-posted and
resumed-session messages reach the (alive) worker even when the chat WebSocket doesn't push them.

**Architecture:** Extract the WS message handler into a reusable `processBuyerMessage(msg)` with shared id-based dedup;
feed both the WS callback and a new `getChatMessages` poll through it. Add loud logging at the LLM fallback points.
Pure helpers unit-tested; the poll/handler wiring verified live.

**Tech Stack:** CJS, no build step. `node --check src/*.js src/executors/*.js`, `node --test test/*.js`. No new deps.

## Global Constraints
- No new runtime dependency.
- **Exactly-once:** WS + poll dedup by `msg.id` through the existing `messageQueue`. No double-processing, no
  self-reply (skip messages whose sender is this agent's identity).
- **No behavior change on a healthy socket:** polled messages are already in the dedup set from the WS handler → poll
  is a near-no-op.
- **Paused/ended jobs:** poll does nothing while `_paused`; stops on session end/delivery/timeout; timer `.unref()`.
- 6.1 is observability-only — fallback content + delivery path unchanged.
- `job-agent.js` runs INSIDE the container; its stdout is streamed to the dispatcher log (so a log marker is the
  alerting surface).

---

### Task 1: 6.1 — loud LLM-outage logging

**Files:**
- Modify: `src/executors/local-llm.js` (~379 and ~434), `src/executors/mcp.js` (~277).
- Test: `test/llm-outage-log.test.js` (new).

**Interfaces:**
- No signature change. At each catch that returns the canned fallback, emit
  `console.error(`[LLM-OUTAGE] ${provider}/${model}: LLM call failed — shipping fallback. error=${err.message}`)`
  first. `provider`/`model` come from the executor's resolved config in scope (use what's available; if only model is
  in scope, log the model + error).

- [ ] **Step 1: Write the failing test** — `test/llm-outage-log.test.js`: construct the `local-llm` executor with a
  fake LLM call that throws (mirror how other executor tests inject the HTTP/LLM call — inspect `test/` for the
  pattern; if the LLM call isn't injectable, add a minimal seam or drive `handleMessage` with a base URL that fails
  fast). Capture `console.error` (monkeypatch) and assert: the returned content is the fallback string AND a captured
  line matches `/\[LLM-OUTAGE\]/` and contains the error text.
- [ ] **Step 2: Run → fail** (`node --test test/llm-outage-log.test.js`).
- [ ] **Step 3: Implement** — add the `console.error('[LLM-OUTAGE] …')` line before each of the three fallback
  `return`s. Keep the returned fallback string unchanged.
- [ ] **Step 4: Run → pass**; `node --check src/executors/local-llm.js src/executors/mcp.js`.
- [ ] **Step 5: Full suite** `node --test test/*.js` green.
- [ ] **Step 6: Commit** — `feat(worker): loud [LLM-OUTAGE] logging at LLM fallback points`.

---

### Task 2: 6.4a — extract `processBuyerMessage` + shared id dedup (behavior-preserving)

**Files:**
- Modify: `src/job-agent.js` — extract the `agent.onChatMessage(...)` body (~712-757) into
  `async function processBuyerMessage(msg)`; the WS callback becomes `agent.onChatMessage((jobId, msg) => { if (jobId
  !== job.id) return; processBuyerMessage(msg); })`. Add module/closure-scope `const _processedMsgIds = new Set()`.
- Add: `src/message-dedup.js` (new, pure) + test.
- Test: `test/message-dedup.test.js` (new).

**Interfaces:**
- Produces: `markIfNew(set, id, cap = 500): boolean` — returns `true` and adds `id` if not present (and evicts oldest
  when over `cap`); returns `false` if `id` already present. Pure.
- `processBuyerMessage(msg)`: first line `if (!markIfNew(_processedMsgIds, msg.id)) return;` then the existing handler
  body (paused guard, `_lastActivityAt`, file-upload detection, `messageQueue` serialize, canary, `sendChatMessage`).

- [ ] **Step 1: Write failing test** — `test/message-dedup.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { markIfNew } = require('../src/message-dedup.js');
test('markIfNew is true once per id, false on repeat', () => {
  const s = new Set();
  assert.strictEqual(markIfNew(s, 'a'), true);
  assert.strictEqual(markIfNew(s, 'a'), false);
  assert.strictEqual(markIfNew(s, 'b'), true);
});
test('markIfNew evicts oldest beyond cap (bounded)', () => {
  const s = new Set();
  for (let i = 0; i < 5; i++) markIfNew(s, 'id' + i, 3);
  assert.ok(s.size <= 3, 'set stays capped');
  assert.strictEqual(markIfNew(s, 'id4', 3), false, 'recent id still deduped');
});
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `src/message-dedup.js`:**
```js
'use strict';
// Exactly-once dedup for chat message ids shared by the WS handler and the poll
// fallback. Bounded: evicts oldest (insertion order) beyond `cap`.
function markIfNew(set, id, cap = 500) {
  if (set.has(id)) return false;
  set.add(id);
  if (set.size > cap) { const oldest = set.values().next().value; set.delete(oldest); }
  return true;
}
module.exports = { markIfNew };
```
- [ ] **Step 4: Extract `processBuyerMessage` in job-agent.js** — move the WS handler body verbatim into the function;
  add `const _processedMsgIds = new Set()` in scope; first line of `processBuyerMessage` is
  `if (!markIfNew(_processedMsgIds, msg.id)) return;`. Rewire `agent.onChatMessage` to call it. `require` `markIfNew`
  at the top. Behavior-preserving — the WS path must behave exactly as before for a first-seen id.
- [ ] **Step 5: Run** `node --check src/job-agent.js` + full suite green (no existing test should break).
- [ ] **Step 6: Commit** — `refactor(worker): extract processBuyerMessage + shared id dedup`.

---

### Task 3: 6.4b — message-poll fallback loop

**Files:**
- Add: `src/message-poll.js` (new, pure selector) + test.
- Modify: `src/job-agent.js` — add the poll loop after the WS handler is wired; stop it on session end/timeout.
- Test: `test/message-poll.test.js` (new).

**Interfaces:**
- Consumes: `markIfNew` (Task 2), `agent.client.getChatMessages`, `processBuyerMessage`.
- Produces: `selectBuyerMessages(messages, buyerVerusId): msg[]` — filters `getChatMessages().data` to messages whose
  `senderVerusId === buyerVerusId` (POSITIVE match on the buyer — avoids a self-reply loop; identity/i-address format
  makes a negative "not own identity" filter unsafe), sorted by `createdAt` ascending. (Dedup happens in
  `processBuyerMessage` via `markIfNew`, so this helper is sender-filter + sort only — pure and testable.)
- `buyerVerusId` source: `job.buyerVerusId` / `fullJob.buyerVerusId` (the job carries it — see `job-agent.js:286`
  which validates `buyerVerusId`). Confirm the in-scope variable and use it.

- [ ] **Step 1: Write failing test** — `test/message-poll.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { selectBuyerMessages } = require('../src/message-poll.js');
const BUYER = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';
test('keeps only buyer messages, oldest-first', () => {
  const msgs = [
    { id: 'm2', senderVerusId: BUYER,     content: 'second',   createdAt: '2026-07-15T00:00:02Z' },
    { id: 'a1', senderVerusId: 'iAgentX', content: 'my reply', createdAt: '2026-07-15T00:00:01Z' },
    { id: 'm1', senderVerusId: BUYER,     content: 'first',    createdAt: '2026-07-15T00:00:00Z' },
  ];
  const out = selectBuyerMessages(msgs, BUYER);
  assert.deepStrictEqual(out.map(m => m.id), ['m1', 'm2']); // agent's own dropped, sorted asc
});
test('empty / missing input is safe', () => {
  assert.deepStrictEqual(selectBuyerMessages([], BUYER), []);
  assert.deepStrictEqual(selectBuyerMessages(undefined, BUYER), []);
});
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `src/message-poll.js`:**
```js
'use strict';
// Pure selector for the worker message-poll fallback: keep ONLY messages the
// buyer sent (positive match — never the agent's own, so no self-reply loop),
// oldest-first. Exactly-once dedup is handled downstream by markIfNew inside
// processBuyerMessage.
function selectBuyerMessages(messages, buyerVerusId) {
  if (!Array.isArray(messages) || !buyerVerusId) return [];
  return messages
    .filter(m => m && m.senderVerusId === buyerVerusId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}
module.exports = { selectBuyerMessages };
```
- [ ] **Step 4: Wire the poll loop in job-agent.js** (after the `onChatMessage` wiring):
```js
const { selectBuyerMessages } = require('./message-poll.js');
const MESSAGE_POLL_MS = 8000;
const _buyerVerusId = fullJob.buyerVerusId || job.buyerVerusId || null; // positive sender match
const _msgPoll = setInterval(async () => {
  if (_paused || sessionEnded || !_buyerVerusId) return;
  try {
    const res = await agent.client.getChatMessages(job.id, { limit: 50 });
    const msgs = res?.data || res || [];
    for (const m of selectBuyerMessages(msgs, _buyerVerusId)) {
      // processBuyerMessage dedups by id (markIfNew) → WS-delivered ones are skipped.
      await processBuyerMessage({ id: m.id, jobId: job.id, senderVerusId: m.senderVerusId, content: m.content, createdAt: m.createdAt });
    }
  } catch { /* transient — retry next tick */ }
}, MESSAGE_POLL_MS);
_msgPoll.unref();
```
  Confirm the in-scope variable holding the buyer's VerusID (`fullJob.buyerVerusId` — `job-agent.js:284-286` fetches
  `fullJob` and validates `buyerVerusId`; use whichever is in scope at the wiring site). Stop the poll on every session
  exit path — grep the `sessionEndResolve(...)` call sites (`end-session-request`, `ttl-expired`,
  `dispatcher-shutdown`, `session-ended`) and the timeout/delivery path, and add `clearInterval(_msgPoll)` at each (or
  clear it once in the single finalize/cleanup block if there is one). The reviewer must confirm no exit path leaks the
  timer.
- [ ] **Step 5: Run** `node --check src/job-agent.js src/message-poll.js` + full suite green.
- [ ] **Step 6: Commit** — `feat(worker): getChatMessages poll fallback for un-pushed messages`.

---

## Post-build
Whole-branch review (opus). Then **live E2E**: hire → post a message via the **API path** (`POST /v1/jobs/{id}/messages`,
the one the WS doesn't push) → confirm the agent now **responds** (was silent); and a resumed session gets a reply to
an API-posted message. Then rebuild the job-agent image (worker code changed → **image rebuild required** this time)
and relaunch, and push.
