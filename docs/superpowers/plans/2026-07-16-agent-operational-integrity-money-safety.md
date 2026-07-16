# Agent Operational Integrity — Money-Safety Core (A + D + C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never accept a job the agent can't perform (LLM down), and when we've been paid for nothing, get the money back to the buyer under owner approval — with a bulletproof, verified refund destination.

**Architecture:** All logic runs in the long-running dispatcher (`src/cli.js`), which holds authenticated `J41Agent` instances per agent (`getAgentSession`, cli.js:4303) able to call `sendCurrency`/`respondToDispute`/`submitRefundTxid`/`acceptJob` directly. New pure modules (`llm-health`, `refund-target`, `dispute-sweep`) are unit-tested in isolation; cli.js wires them into the accept loop, the periodic `safeInterval` machinery, the existing `pending-refunds.json` ledger, and new `refunds` CLI commands.

**Tech Stack:** Node CJS (no build step), `node --test`, `@junction41/sovagent-sdk` (yarn-linked at `../j41-sovagent-sdk`), Commander.js, global `fetch`.

**Reference spec:** `docs/superpowers/specs/2026-07-16-agent-operational-integrity-money-safety-design.md` (read the "Refund-target resolution & verification" and per-Pillar sections; this plan implements them).

## Global Constraints

- CJS, plain `.js`. Validate every changed file with `node --check`. Tests: `node --test test/<file>.js`.
- **Outbound refund SENDS are the only owner-gated action.** Dispute `respondToDispute` is auto (not gated). No on-chain deactivation in this plan (Pillar B deferred).
- **Refund destination is verified by `resolveRefundTarget` or it is NOT sent.** For dispute refunds, `dispute.raised_by === address` is mandatory. Unverified → `needs_review`, never sent. Approve re-verifies at send time.
- **No double-send:** send txid persisted before `submitRefundTxid`; `markJobRefunded`/`loadRefundedJobs` de-dup gates every send; daemon drain sends only `status:'approved'`.
- **Fail closed:** probe error/timeout ⇒ LLM down ⇒ don't accept. Missing/unverified buyer address ⇒ don't send.
- Reuse existing primitives: `pending-refunds.json` (`loadPendingRefunds`/`savePendingRefunds`, cli.js:4589), `attemptPendingRefund` (cli.js:4654), `drainPendingRefunds` interval (cli.js:3755), `getAgentSession` (cli.js:4303), `safeInterval` (cli.js:3281), financial allowlist (`loadFinancialAllowlist`/`isAddressInAllowlist`), `state.emitEvent` (cli.js:3800), SDK `isIAddress`.
- All refund amounts: `job.amount × refundPercent/100`. Platform fee never refunded by the agent.

---

### Task 1: `probeLLM` — LLM health probe (Pillar A primitive)

**Files:**
- Create: `src/llm-health.js`
- Test: `test/llm-health.test.js`

**Interfaces:**
- Produces: `async probeLLM(llmConfig, opts) → { ok:boolean, latencyMs:number, status:number|null, error:string|null }` where `llmConfig = { baseUrl, model, apiKey, customHeaders }`. `opts = { timeoutMs=5000, fetchImpl=globalThis.fetch }` (fetchImpl injectable for tests).

- [ ] **Step 1: Write failing tests** (`test/llm-health.test.js`)

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { probeLLM } = require('../src/llm-health.js');

const cfg = { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k', customHeaders: null };

test('ok:true on HTTP 200', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const r = await probeLLM(cfg, { fetchImpl });
  assert.equal(r.ok, true); assert.equal(r.status, 200);
});

test('ok:false and fail-closed on HTTP 500', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const r = await probeLLM(cfg, { fetchImpl });
  assert.equal(r.ok, false); assert.equal(r.status, 500);
});

test('ok:false on network throw', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await probeLLM(cfg, { fetchImpl });
  assert.equal(r.ok, false); assert.match(r.error, /ECONNREFUSED/);
});

test('ok:false on timeout/abort', async () => {
  const fetchImpl = async (_u, o) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const r = await probeLLM(cfg, { timeoutMs: 20, fetchImpl });
  assert.equal(r.ok, false);
});

test('sends minimal body (max_tokens:1) to /chat/completions with auth header', async () => {
  let seenUrl, seenBody, seenHeaders;
  const fetchImpl = async (u, o) => { seenUrl = u; seenBody = JSON.parse(o.body); seenHeaders = o.headers; return { ok: true, status: 200 }; };
  await probeLLM(cfg, { fetchImpl });
  assert.equal(seenUrl, 'https://x/v1/chat/completions');
  assert.equal(seenBody.max_tokens, 1);
  assert.equal(seenBody.model, 'm');
  assert.equal(seenHeaders.Authorization, 'Bearer k');
});

test('uses customHeaders when provided (no Authorization)', async () => {
  let seenHeaders;
  const fetchImpl = async (_u, o) => { seenHeaders = o.headers; return { ok: true, status: 200 }; };
  await probeLLM({ ...cfg, customHeaders: { 'x-api-key': 'z' } }, { fetchImpl });
  assert.equal(seenHeaders['x-api-key'], 'z');
  assert.equal(seenHeaders.Authorization, undefined);
});
```

- [ ] **Step 2: Run tests — expect FAIL** (`node --test test/llm-health.test.js`) — "Cannot find module '../src/llm-health.js'".

- [ ] **Step 3: Implement** (`src/llm-health.js`)

```js
'use strict';
/**
 * Minimal liveness probe for an OpenAI-compatible LLM endpoint. Fail-closed:
 * any non-2xx, network error, or timeout returns ok:false. Mirrors the
 * executor's fetch shape (local-llm.js:345/362) so "probe ok" ⇒ "executor can call".
 */
async function probeLLM(llmConfig, opts = {}) {
  const { baseUrl, model, apiKey, customHeaders } = llmConfig || {};
  const timeoutMs = opts.timeoutMs ?? 5000;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!baseUrl || !model) return { ok: false, latencyMs: 0, status: null, error: 'missing baseUrl/model' };
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'j41-agent/1.0' };
  if (customHeaders) Object.assign(headers, customHeaders);
  else headers['Authorization'] = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, temperature: 0 }),
    });
    return { ok: !!res.ok, latencyMs: Date.now() - start, status: res.status ?? null, error: res.ok ? null : `http ${res.status}` };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, status: null, error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { probeLLM };
```

- [ ] **Step 4: Run tests — expect PASS.** Then `node --check src/llm-health.js`.
- [ ] **Step 5: Commit** — `git add src/llm-health.js test/llm-health.test.js && git commit -m "feat(health): probeLLM fail-closed LLM liveness probe"`

---

### Task 2: `resolveRefundTarget` — the verified refund-address gate (SAFETY-CRITICAL)

**Files:**
- Create: `src/refund-target.js`
- Test: `test/refund-target.test.js`

**Interfaces:**
- Consumes: SDK `isIAddress` (`require('@junction41/sovagent-sdk/dist/index.js').isIAddress`).
- Produces: `resolveRefundTarget(job, dispute, ctx) → { address, displayName, checks, confident }`. `ctx = { selfAddresses:Set<string>, platformFeeAddress:string|null, resolveName?:(iaddr)=>{name,iaddress}|null }`. `dispute` may be `null` (crash-recovery, no dispute). `resolveName` may be omitted (then `nameRoundTrip` is not evaluated — treated as not-false).

**Global constraints for this task:** `disputeSigner` is MANDATORY when `dispute` is present (`dispute.raised_by === address`). `confident = isIAddress && notSelf && notPlatformFee && (dispute ? disputeSigner : true) && (nameRoundTrip !== false)`. Send target is `job.buyerVerusId` (i-address) — never a friendly name.

- [ ] **Step 1: Write failing tests** (`test/refund-target.test.js`)

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveRefundTarget } = require('../src/refund-target.js');

const BUYER = 'iC6bdkugcFbRuPXFsFcK3utr7custBw52i';           // valid i-address form
const SELF = 'iP7b8ubfmUGBf4Bv1G2dFZK18jBVWgKG5D';
const FEE  = 'RAWwNeTLRg9urgnDPQtPyZ6NRycsmSY2J2';
const baseCtx = { selfAddresses: new Set([SELF]), platformFeeAddress: FEE };
const job = { buyerVerusId: BUYER, amount: 0.5, currency: 'VRSCTEST' };
const dispute = { id: 'd1', raised_by: BUYER };

test('confident when i-address, not self, not fee, dispute signer matches', () => {
  const r = resolveRefundTarget(job, dispute, baseCtx);
  assert.equal(r.address, BUYER);
  assert.equal(r.confident, true);
  assert.equal(r.checks.disputeSigner, true);
});

test('NOT confident when dispute.raised_by mismatches buyer', () => {
  const r = resolveRefundTarget(job, { id: 'd', raised_by: 'iSomeoneElseXXXXXXXXXXXXXXXXXXXXXXX' }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.disputeSigner, false);
});

test('NOT confident when target is one of our own addresses', () => {
  const r = resolveRefundTarget({ ...job, buyerVerusId: SELF }, { id: 'd', raised_by: SELF }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.notSelf, false);
});

test('NOT confident when target is the platform fee address', () => {
  const r = resolveRefundTarget({ ...job, buyerVerusId: FEE }, { id: 'd', raised_by: FEE }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.notPlatformFee, false);
});

test('NOT confident when address is not a valid i-address', () => {
  const r = resolveRefundTarget({ ...job, buyerVerusId: 'not-an-iaddr' }, { id: 'd', raised_by: 'not-an-iaddr' }, baseCtx);
  assert.equal(r.confident, false);
  assert.equal(r.checks.isIAddress, false);
});

test('crash-recovery (dispute null) confident without signer check', () => {
  const r = resolveRefundTarget(job, null, baseCtx);
  assert.equal(r.confident, true);
  assert.equal(r.checks.disputeSigner, undefined);
});

test('name round-trip populates displayName; bad round-trip fails confident', () => {
  const good = resolveRefundTarget(job, dispute, { ...baseCtx, resolveName: () => ({ name: 'subid.agentplatform@', iaddress: BUYER }) });
  assert.equal(good.displayName, 'subid.agentplatform@');
  assert.equal(good.confident, true);
  const bad = resolveRefundTarget(job, dispute, { ...baseCtx, resolveName: () => ({ name: 'x@', iaddress: 'iDIFFERENTxxxxxxxxxxxxxxxxxxxxxxxxx' }) });
  assert.equal(bad.checks.nameRoundTrip, false);
  assert.equal(bad.confident, false);
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement** (`src/refund-target.js`)

```js
'use strict';
const { isIAddress } = require('@junction41/sovagent-sdk/dist/index.js');

/**
 * Establish and verify the destination for a refund. The ONLY place a refund
 * address is decided. Send target is the buyer's i-address (job.buyerVerusId);
 * a friendly name is displayed for human confirmation but never used as the
 * send destination. Returns confident:false (with the failing check) rather
 * than throwing, so callers hold the refund as needs_review.
 */
function resolveRefundTarget(job, dispute, ctx = {}) {
  const address = job && job.buyerVerusId;
  const selfAddresses = ctx.selfAddresses || new Set();
  const checks = {};
  checks.isIAddress = !!address && isIAddress(address);
  checks.notSelf = !!address && !selfAddresses.has(address);
  checks.notPlatformFee = !ctx.platformFeeAddress || address !== ctx.platformFeeAddress;
  if (dispute) checks.disputeSigner = !!address && dispute.raised_by === address;

  let displayName = null;
  if (typeof ctx.resolveName === 'function' && address) {
    try {
      const r = ctx.resolveName(address);
      if (r && r.name) {
        displayName = r.name;
        checks.nameRoundTrip = r.iaddress === address;
      }
    } catch { checks.nameRoundTrip = false; }
  }

  const confident =
    checks.isIAddress === true &&
    checks.notSelf === true &&
    checks.notPlatformFee === true &&
    (dispute ? checks.disputeSigner === true : true) &&
    (checks.nameRoundTrip !== false);

  return { address: address || null, displayName, checks, confident };
}
module.exports = { resolveRefundTarget };
```

- [ ] **Step 4: Run — expect PASS.** `node --check src/refund-target.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat(refund): resolveRefundTarget — verified refund-address gate (dispute-signer mandatory)"`

---

### Task 3: `dispute-sweep` — refundable selection + ledger entry shape (Pillar C primitives)

**Files:**
- Create: `src/dispute-sweep.js`
- Test: `test/dispute-sweep.test.js`

**Interfaces:**
- Consumes: `resolveRefundTarget` result (`target`) from Task 2.
- Produces:
  - `selectRefundableDisputes(jobs, disputeByJobId) → Job[]` — keep iff `status==='disputed'` && dispute exists && `dispute.action==='pending'` && `job.delivery == null` && no positive token count in `job.tokenUsage`.
  - `buildDisputeRefundEntry(job, dispute, agentInfoId, target, nowIso) → entry` — exact shape from the spec; `status` = `target.confident ? 'pending_approval' : 'needs_review'`.
  - `hasPositiveTokens(tokenUsage) → boolean` helper.

- [ ] **Step 1: Write failing tests** (`test/dispute-sweep.test.js`)

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { selectRefundableDisputes, buildDisputeRefundEntry } = require('../src/dispute-sweep.js');

const disp = { id: 'd1', action: 'pending', raised_by: 'iBUY' };
const undelivered = { id: 'j1', status: 'disputed', delivery: null, tokenUsage: null, amount: 0.5, currency: 'VRSCTEST', buyerVerusId: 'iBUY' };

test('selects undelivered + pending + no-tokens', () => {
  const out = selectRefundableDisputes([undelivered], { j1: disp });
  assert.equal(out.length, 1);
});
test('excludes delivered jobs', () => {
  const out = selectRefundableDisputes([{ ...undelivered, delivery: { hash: 'abc' } }], { j1: disp });
  assert.equal(out.length, 0);
});
test('excludes jobs with token usage', () => {
  const out = selectRefundableDisputes([{ ...undelivered, tokenUsage: { total: 42 } }], { j1: disp });
  assert.equal(out.length, 0);
});
test('excludes non-pending disputes', () => {
  const out = selectRefundableDisputes([undelivered], { j1: { ...disp, action: 'refund' } });
  assert.equal(out.length, 0);
});
test('excludes jobs with no dispute record', () => {
  assert.equal(selectRefundableDisputes([undelivered], {}).length, 0);
});
test('buildDisputeRefundEntry: confident target => pending_approval, verified address', () => {
  const target = { address: 'iBUY', displayName: 'buyer@', checks: { isIAddress: true }, confident: true };
  const e = buildDisputeRefundEntry(undelivered, disp, 'agent-5', target, '2026-07-16T00:00:00Z');
  assert.equal(e.status, 'pending_approval');
  assert.equal(e.buyerAddress, 'iBUY');
  assert.equal(e.refundAmount, 0.5);
  assert.equal(e.refundPercent, 100);
  assert.equal(e.disputeId, 'd1');
  assert.equal(e.orphan.buyerPayAddress, 'iBUY');
});
test('buildDisputeRefundEntry: unconfident target => needs_review with failing checks in reason', () => {
  const target = { address: 'iBUY', displayName: null, checks: { disputeSigner: false, isIAddress: true }, confident: false };
  const e = buildDisputeRefundEntry(undelivered, disp, 'agent-5', target, '2026-07-16T00:00:00Z');
  assert.equal(e.status, 'needs_review');
  assert.match(e.reason, /disputeSigner/);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** (`src/dispute-sweep.js`)

```js
'use strict';
function hasPositiveTokens(t) {
  if (!t) return false;
  return Number(t.total || t.totalTokens || t.input || t.output || 0) > 0;
}
function selectRefundableDisputes(jobs, disputeByJobId) {
  return (jobs || []).filter(j => {
    if (!j || j.status !== 'disputed') return false;
    const d = disputeByJobId[j.id];
    if (!d || d.action !== 'pending') return false;
    if (j.delivery != null) return false;
    if (hasPositiveTokens(j.tokenUsage)) return false;
    return true;
  });
}
function buildDisputeRefundEntry(job, dispute, agentInfoId, target, nowIso) {
  const amount = Number(job.amount) || 0;
  const currency = job.currency || 'VRSCTEST';
  const failing = Object.entries(target.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
  return {
    agentInfoId,
    orphan: { jobAmount: amount, buyerPayAddress: target.address, currency, agentInfoId },
    refundAmount: amount,
    refundPercent: 100,
    buyerAddress: target.address,
    buyerDisplayName: target.displayName || null,
    addressChecks: target.checks,
    disputeId: dispute ? dispute.id : null,
    status: target.confident ? 'pending_approval' : 'needs_review',
    reason: target.confident
      ? `LLM outage: paid ${amount} ${currency}, delivery:null, tokenUsage:null — dispute ${dispute && dispute.id} auto-opened by platform`
      : `ADDRESS UNVERIFIED — failing checks: ${failing.join(',')}`,
    enqueuedAt: nowIso,
  };
}
module.exports = { hasPositiveTokens, selectRefundableDisputes, buildDisputeRefundEntry };
```

- [ ] **Step 4: Run — expect PASS.** `node --check`.
- [ ] **Step 5: Commit** — `git commit -m "feat(refund): dispute-sweep selection + ledger-entry builder"`

---

### Task 4: Refund ledger status model + drain gating + submitRefundTxid on send

**Files:**
- Modify: `src/cli.js` — `attemptPendingRefund` (~4654), `drainPendingRefunds` (~4620-4700 region and the interval at ~3755).
- Test: `test/refund-queue.test.js` (drive `drainPendingRefunds`/`attemptPendingRefund` via an injected `state._testAgentSession` stub and a temp ledger).

**Interfaces:**
- Consumes: existing `loadPendingRefunds`/`savePendingRefunds`, `loadRefundedJobs`/`markJobRefunded`, `loadFinancialAllowlist`/`isAddressInAllowlist`, `getAgentSession`.
- Produces (behavior): `drainPendingRefunds` sends only entries with `status==='approved'`; `attemptPendingRefund` calls `agent.client.submitRefundTxid(jobId, txid)` when `entry.disputeId` is set, persists `refundTxid` before submit, sets `status:'refunded'`.

**Note for implementer:** read the current `attemptPendingRefund` (cli.js:4654) and `drainPendingRefunds` fully before editing. Preserve the allowlist check and the "mark refunded immediately after the irreversible send" ordering. The change is: (a) drain filters on status, (b) after a successful `sendCurrency`, store `entry.refundTxid`+save, then if `entry.disputeId` call `submitRefundTxid`, then set `status:'refunded'`.

- [ ] **Step 1: Write failing test** (`test/refund-queue.test.js`) — construct a `state` with `_testAgentSession` returning a stub `{ sendCurrency: async()=>'TXID', client:{ submitRefundTxid: async()=>{} } }`, a temp `pending-refunds.json` (point `PENDING_REFUNDS_PATH` via a test hook or `HOME` override), and assert:
  - an entry with `status:'pending_approval'` is NOT sent by `drainPendingRefunds` (stub.sendCurrency not called).
  - an entry with `status:'approved'` IS sent, `submitRefundTxid` called because `disputeId` set, resulting `status:'refunded'`, `refundTxid:'TXID'`.
  - a second drain does not re-send (de-dup via refunded-set).

  *(If `PENDING_REFUNDS_PATH` is not overridable, the implementer adds a minimal injection: `drainPendingRefunds(state, { ledgerPath })` defaulting to the constant — a small, test-only seam. Keep it backward compatible.)*

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the drain status-filter + `attemptPendingRefund` submit step per the note above.
- [ ] **Step 4: Run — expect PASS.** `node --check src/cli.js`. Run full suite `node --test test/*.js` to confirm no regression in existing refund/crash-recovery tests.
- [ ] **Step 5: Commit** — `git commit -m "feat(refund): gate drain on status:approved + submitRefundTxid on dispute refunds"`

---

### Task 5: `refunds` CLI commands — list / approve / reject / --all (Pillar D)

**Files:**
- Modify: `src/cli.js` — add Commander commands near the other `program.command(...)` definitions (pattern at cli.js:2574); reuse `attemptPendingRefund`, `resolveRefundTarget`, allowlist add.
- Test: `test/refund-cli.test.js` — unit-test the extracted handler functions (`refundsList`, `refundsApprove`, `refundsReject`) with a stub state + temp ledger, NOT the Commander wiring.

**Interfaces:**
- Produces: `refundsList(state, {all})`, `refundsApprove(state, jobId, {yes,all})`, `refundsReject(state, jobId, {reason})` — extracted so they're testable; the `program.command` actions are thin wrappers.
- Approve flow: refuse `needs_review`; **re-fetch job+dispute, re-run `resolveRefundTarget`, abort if not confident or address changed**; allowlist-add verified address (audited); `status:'approved'`; run `attemptPendingRefund`; print txid.

- [ ] **Step 1: Write failing tests** (`test/refund-cli.test.js`)
  - `refundsApprove` refuses an entry with `status:'needs_review'` (no send).
  - `refundsApprove` on a `pending_approval` entry whose re-resolved target is confident → calls send, becomes `refunded`.
  - `refundsApprove` aborts (no send) when the re-resolved target address differs from the stored `buyerAddress`.
  - `refundsReject` sets `status:'rejected'`, no send.
  - `refundsList` returns only `pending_approval`+`needs_review` by default, all with `{all:true}`.

  Use a stub `state` with `_testAgentSession` (send + client.getJob/getDispute/submitRefundTxid + resolveNames) and a temp ledger seam from Task 4.

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the three handlers + register `program.command('refunds ...')`. Approve builds `ctx` (selfAddresses from state.agents, platformFeeAddress, resolveName via client.resolveNames) and re-verifies before send. `--all` iterates `pending_approval` entries.
- [ ] **Step 4: Run — expect PASS.** `node --check src/cli.js`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): refunds list/approve/reject with re-verify at approve"`

---

### Task 6: `resolveAgentLLMConfig` + preflight accept-path gate (Pillar A integration)

**Files:**
- Modify: `src/cli.js` — extract `resolveAgentLLMConfig(agentInfo)` from the resolution `buildContainerEnv` does at cli.js:5842; insert preflight probe in the accept path before `acceptJob` (cli.js:5064).
- Test: `test/preflight-gate.test.js` — unit-test `resolveAgentLLMConfig` (given a fake agent config → correct `{baseUrl,model,apiKey}`) and a small extracted `shouldAcceptGivenHealth(agentInfo, health, cfgPresent)` decision helper.

**Interfaces:**
- Produces: `resolveAgentLLMConfig(agentInfo) → { baseUrl, model, apiKey, customHeaders } | null` (null for non-`local-llm` executors). `shouldAcceptGivenHealth(...)` returns `{ accept:boolean, reason }`.
- Accept-loop change: when `preflight_llm_check` on and executor is `local-llm`, probe (with the 30s ok-cache in `state.llmHealth`); if not ok, skip `acceptJob`, emit `job.declined_llm_down` + `agent.llm_down`, continue.

**Note:** keep the probe OUT of the hot path for non-LLM executors (return null → skip). Cache only `ok` results for 30s; never cache a `down` as pass.

- [ ] **Step 1: Write failing tests** (`test/preflight-gate.test.js`) — `resolveAgentLLMConfig` maps a sample per-agent config (`{executor:'local-llm',llmProvider:'kimi-nvidia',llmModel:'deepseek-ai/deepseek-v4-flash'}` + provider key) to the expected baseUrl (from preset) + model + apiKey; returns null for `{executor:'webhook'}`. `shouldAcceptGivenHealth`: cfg null ⇒ accept true (skipped); health.ok true ⇒ accept true; health.ok false ⇒ accept false.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `resolveAgentLLMConfig` (reuse `loadAgentConfig` + `LLM_PRESETS` + provider_keys), `shouldAcceptGivenHealth`, and wire the probe+cache into the accept loop before `acceptJob`. Emit events.
- [ ] **Step 4: Run — expect PASS.** `node --check src/cli.js`. Full suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(preflight): decline accept when agent LLM is down (buyer never charged)"`

---

### Task 7: `sweepDisputesForRefund` wiring — interval + boot + notify seam (Pillar C integration)

**Files:**
- Modify: `src/cli.js` — add `sweepDisputesForRefund(state)`; register a `safeInterval(() => sweepDisputesForRefund(state), 5*60*1000, 'DisputeSweep')` alongside the refund drain (~cli.js:3755); call once at boot after the initial drain; also invoke on an LLM-down→up transition detected in the accept-path cache (best-effort).
- Test: covered by Task 3's pure tests for selection/shape; add `test/dispute-sweep-wiring.test.js` only for the enqueue+emit orchestration using a stub state (getMyJobs/getDispute/respondToDispute stubs) asserting: refundable dispute ⇒ `respondToDispute(refund,100%)` called, ledger gains a `pending_approval` entry, `refund.pending_approval` emitted; unverified target ⇒ `needs_review` + `refund.needs_review` emitted, and `respondToDispute` still called (we acknowledge) but no `approved`/send.

**Interfaces:**
- Consumes: `getAgentSession`, `selectRefundableDisputes`, `resolveRefundTarget`, `buildDisputeRefundEntry`, ledger load/save, `state.emitEvent`, `markJobRefunded`/`loadRefundedJobs` for idempotency.
- Produces: `sweepDisputesForRefund(state)` (idempotent; skips jobs already in ledger or refunded).

- [ ] **Step 1: Write failing test** (`test/dispute-sweep-wiring.test.js`) with a stub `state` (agents + `_testAgentSession` exposing `client.getMyJobs`, `client.getDispute`, `respondToDispute`, `client.resolveNames`) and a temp ledger; assert the two paths above. Constant `OUTAGE_APOLOGY` string exists and is passed to `respondToDispute`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `sweepDisputesForRefund` + `OUTAGE_APOLOGY` constant + interval/boot wiring + emit seam.
- [ ] **Step 4: Run — expect PASS.** `node --check src/cli.js`. Full suite `node --test test/*.js` green.
- [ ] **Step 5: Commit** — `git commit -m "feat(refund): sweepDisputesForRefund — auto-respond + queue undelivered-job refunds"`

---

## Self-Review (author checklist)

- **Spec coverage:** A = Tasks 1,6. C = Tasks 3,7 (+2 for address). D = Tasks 4,5. Address gate = Task 2 (used by 3,5,7). B intentionally deferred. ✓
- **Type consistency:** `resolveRefundTarget` returns `{address,displayName,checks,confident}` used identically in Tasks 3/5/7. Ledger entry shape defined once in Task 3, consumed in 4/5. ✓
- **No placeholders:** every code step has real code; the `nowIso`/`OUTAGE_APOLOGY` are named constants defined in their tasks. ✓
- **Ordering:** pure modules (1,2,3) before cli.js integration (4,5,6,7); 4 before 5 (5 reuses the drain/attempt changes + ledger seam); 6/7 independent of 4/5 but share cli.js so run sequentially. ✓
