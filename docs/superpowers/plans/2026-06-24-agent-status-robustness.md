# Dispatcher Agent-Status Robustness — Implementation Plan (v2, post-audit)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the dispatcher honest and self-diagnosing about *why* an agent is/ isn't hireable, and stop activation flows from silently stranding agents or emitting confidently-wrong status — closing the class of problem that cost hours on 2026-06-24.

**Architecture:** One pure module (`src/agent-status.js`, no I/O, fully unit-testable) holds every decision: `diagnoseAgent`, `interpretActivation`, currency/payability helpers, and the pure formatters (`formatDoctorReport`, `hireCell`). The on-chain `status` VDXF key is the single source of truth; **no status is ever claimed unless it can be read back as active** (and an on-chain write that returned a null txid is treated as *not done*, never as success). All consumers (the `activate`/`activate-all` commands, a new `doctor` command, the `ctl agents` view, and boot/shutdown) call the pure module.

**Tech Stack:** Node CommonJS, no build. Tests: `node --test test/*.test.js`. SDK: `J41Agent.activate({onChain}) → {status, onChainTxid|null}` (agent.ts:918), `client.getAgent(id) → AgentDetail.status` (client/index.ts:1212), `client.refreshAgent(id) → {refreshed, agent, services}` (1729), `client.getMyServices()/getAgentServices(id) → {data: Service[]}`, `Service{status, currency, price, acceptedCurrencies?}` (2188–2209).

---

## Verified facts + audit corrections (3 audits, 2026-06-24)

- **Source of truth = on-chain `status` VDXF key**; the backend indexer mirrors it; a missing key defaults to `active` server-side. **Service currency is stored, never gated for status.**
- **The `--platform-only` footgun** AND a hidden twin: `agent.activate({onChain:true})` writes the platform DB to `active` **even when the on-chain broadcast failed** — `_updateOnChainStatus` swallows broadcast errors and returns `null`, and `activate()` proceeds anyway (agent.ts:~831–955). So **`result.onChainTxid === null` is the real "did the chain write happen" signal**, and any confirm that only reads `getAgent().status` can false-confirm off the optimistic DB value.
- **`getAgent`/`refreshAgent` read the indexer DB**, not the chain directly; `refreshAgent` forces a re-index (a *write/side-effect*, not a free read) and returns `{agent:bool, services:bool}` — `services:false` ⇒ no service VDXF on-chain (worker1's real blocker).
- **Constant is `J41_NETWORK`** (cli.js:71), values `'verus'|'verustest'`. There is **no `NETWORK`**.
- **`ctl agents` payload is built in `src/control.js buildAgents()` (197–211)**; its `status` field is **job-occupancy** (`busy`/`available`), NOT platform status, and `services` is a **count**. The dispatcher does **not** cache platform status in live `state` after the one-shot startup read (cli.js:3027). → Fix #4 must add that state.
- **`Service.acceptedCurrencies: Array<{currency, price}>`** exists (cli.js:740–749; SDK 2205). Payability must consider it.
- Line anchors: `activate` cmd 1971–2037 (call 1996); `activate-all` 2041–2104 (loop 2066–2101); startup skip 3022–3037; boot auto-activate 3812–3844 (`if NO_STATUS_TOGGLE` 3817 / `else` activate loop 3819–3844, call 3827); shutdown 3862–3889; capabilities snapshot 3219–3239; ctl renderer 6642–6650; inspect gather 2322–2404; api-endpoint handling `_isApiEndpoint` 3219–3235.

## Design decisions (operator-confirmed 2026-06-24)

- **#1 activate fail-mode:** tri-state confirm. `onChainTxid===null` ⇒ **FAILED, exit 1**. Confirmed active ⇒ exit 0. Still-pending after budget (testnet lag) ⇒ **exit 0 + loud "submitted, not yet confirmed — check `doctor`"** (never train re-broadcast). Budget ~3–4 min, env-tunable.
- **#3 churn:** **idempotent boot-activate** — skip the on-chain tx when the agent already reads `active` (kills the redundant per-boot tx, the real churn source); **keep shutdown-deactivate** (preserves the offline signal; no marketplace regression). Default lifecycle otherwise unchanged; `J41_NO_STATUS_TOGGLE=1` still honored.
- **#4 ctl:** **track real platform status** in `state.platformStatus` (populated at startup + on activate/deactivate + a periodic poller) and render a verdict labeled "as of last refresh"; never compute it from the occupancy `status` field.
- **`no_payable_service` is demoted:** *blockers* = `agent_inactive`, `stale_onchain_service`, and `no_active_service_at_all` (non-api-endpoint). *warnings* = `no_service_in_network_currency`, `zero_priced_only`, `status_unknown`. Hireability tracks what the backend actually uses (status + on-chain service freshness), so `doctor` won't disagree with the marketplace over currency.

## Post-approval adjustments (backend code review, 2026-06-24 — MUST fold in)

- **A1 — `/refresh` rate limit = 5 per 60s per IP** (agents.ts:430). `GET /v1/agents/:id` is 30/min (agents.ts:189). **Therefore: never poll `refreshAgent` in a loop.** Confirm = call `refreshAgent` **once** right after the activate broadcast (it is mempool-aware, so one re-index reflects the pending tx), then **poll the cheap `getAgent` status** for the flip. `activate-all`/`doctor --refresh` must **space the per-agent refreshes ≤5/min** (serialize ~12s apart) or skip refresh. **A 429 from refresh ⇒ treat as `pending`/unknown, NEVER `failed`.** (Backend ask available: higher dispatcher refresh limit / a batch-refresh endpoint.)
- **A2 — the optimistic DB write still lies.** Even on `onChainTxid===null`, the SDK already wrote platform DB → `active` (agent.ts:945). So `getAgent` returns a false `active` until the next indexer re-read. `doctor` (no `--refresh`, correctly side-effect-free) would then show ✅ for an agent that's really inactive on-chain. **Mitigations:** (a) after `interpretActivation` returns `failed`/`pending`, force **one** `refreshAgent` so the DB re-syncs to chain and stops lying; (b) label every no-refresh `doctor`/`ctl` verdict **"as last indexed"**. Real fix is in the SDK (don't `setAgentStatus(active)` when `onChainTxid===null`) — filed as a backend/SDK request, not done here.
- **A3 — no-WIF / signing-broker agents.** `_updateOnChainStatus` returns `null` immediately when `!this.wif` (agent.ts:802), so a broker-signed agent gets `onChainTxid===null` on **every** activate. Reporting "broadcast failed (funds/RPC)" would be the wrong cause. `interpretActivation` must take the agent's **signing capability** and emit a distinct `failed` reason: `no_signing_capability` (no local WIF / broker not wired for status) vs `broadcast_failed` (has WIF, tx didn't broadcast → funds/RPC). Also note: `setAgentStatus` needs a signed `J41-STATUS|…` message, so the on-chain activate path **may not work broker-side as written** — flag as a known limitation pending the signing-broker work.
- **A4 — line anchors:** the SDK anchors (agent.ts:801–955) are verified against the local 2.9.0; the **cli.js anchors were verified by the code-accuracy audit against this checkout** (activate 1971, startup 3022–3037, boot 3817, shutdown 3864, ctl 6647, control.js buildAgents 197). Re-confirm before each edit regardless.

## File Structure

- **Create** `src/agent-status.js` — all pure decision + formatting logic.
- **Create** `test/agent-status.test.js`.
- **Modify** `src/cli.js` — gather helper, `activate`/`activate-all` confirm, `doctor` cmd, idempotent boot-activate + `state.platformStatus` population + status poller + skip-hint.
- **Modify** `src/control.js` — `buildAgents()` adds `platformStatus`+`hireable`+`reason`+`statusAge`.
- **Modify** `src/cli.js` ctl renderer (6647) — `hireCell`.
- **Docs:** `CHANGELOG.md` + `README.md` — `doctor`, activate exit-code semantics, idempotent boot note.

No SDK changes. No new deps.

---

### Task 1: `agent-status.js` — currency + payability + `diagnoseAgent`

**Files:** Create `src/agent-status.js`, `test/agent-status.test.js`

- [ ] **Step 1: Failing tests** (cover: network map incl. unknown; currency case-fold; i-address indeterminate; acceptedCurrencies payable; active+payable→hireable; inactive→blocker; no-service non-api→blocker; api-endpoint no-service→hireable; stale service→blocker; mainnet-only-service on testnet→warning not blocker; 0-priced→warning; undefined status→status_unknown warning not blocker; revoked→fix text differs).

```js
const { test } = require('node:test'); const assert = require('node:assert');
const { networkCurrency, currencyMatches, servicePayable, diagnoseAgent } = require('../src/agent-status.js');

test('networkCurrency: known maps, unknown → null', () => {
  assert.equal(networkCurrency('verus'), 'VRSC');
  assert.equal(networkCurrency('verustest'), 'VRSCTEST');
  assert.equal(networkCurrency('pbaas-x'), null);
});
test('currencyMatches: case-insensitive; i-address is indeterminate (null)', () => {
  assert.equal(currencyMatches('vrsctest', 'VRSCTEST'), true);
  assert.equal(currencyMatches('VRSCTEST', 'VRSCTEST'), true);
  assert.equal(currencyMatches('VRSC', 'VRSCTEST'), false);
  assert.equal(currencyMatches('iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', 'VRSCTEST'), null); // can't resolve offline
});
test('servicePayable: direct OR acceptedCurrencies', () => {
  assert.equal(servicePayable({status:'active',currency:'VRSCTEST',price:0.5}, 'VRSCTEST'), true);
  assert.equal(servicePayable({status:'active',currency:'VRSC',price:0.5,acceptedCurrencies:[{currency:'VRSCTEST',price:0.5}]}, 'VRSCTEST'), true);
  assert.equal(servicePayable({status:'active',currency:'VRSC',price:0.5}, 'VRSCTEST'), false);
  assert.equal(servicePayable({status:'inactive',currency:'VRSCTEST',price:0.5}, 'VRSCTEST'), false);
});
test('active agent with payable testnet service is hireable', () => {
  const r = diagnoseAgent({ platformStatus:'active', network:'verustest', services:[{status:'active',currency:'VRSCTEST',price:0.5}], refresh:{agent:true,services:true} });
  assert.equal(r.hireable, true); assert.equal(r.blockers.length, 0);
});
test('inactive → blocker with on-chain (non --platform-only) fix', () => {
  const r = diagnoseAgent({ platformStatus:'inactive', network:'verustest', services:[{status:'active',currency:'VRSCTEST',price:0.5}], refresh:{agent:true,services:true} });
  assert.equal(r.hireable, false);
  assert.ok(r.blockers.some(b => b.code==='agent_inactive' && /activate/.test(b.fix) && !/platform-only/.test(b.fix)));
});
test('mainnet-only service on testnet is a WARNING, not a blocker', () => {
  const r = diagnoseAgent({ platformStatus:'active', network:'verustest', services:[{status:'active',currency:'VRSC',price:0.5}], refresh:{agent:true,services:true} });
  assert.equal(r.hireable, true); // backend doesn't gate on currency
  assert.ok(r.warnings.some(w => /no active service priced in VRSCTEST/i.test(w)));
});
test('no service at all (non api-endpoint) → blocker', () => {
  const r = diagnoseAgent({ platformStatus:'active', network:'verustest', services:[], refresh:{agent:true,services:true} });
  assert.equal(r.hireable, false); assert.ok(r.blockers.some(b => b.code==='no_active_service'));
});
test('api-endpoint agent with no marketplace service is hireable', () => {
  const r = diagnoseAgent({ platformStatus:'active', network:'verustest', services:[], isApiEndpoint:true, refresh:{agent:true,services:true} });
  assert.equal(r.hireable, true);
});
test('stale on-chain service (refresh.services=false) → blocker with a runnable fix', () => {
  const r = diagnoseAgent({ platformStatus:'active', network:'verustest', services:[{status:'active',currency:'VRSCTEST',price:0.5}], refresh:{agent:true,services:false} });
  assert.equal(r.hireable, false);
  assert.ok(r.blockers.some(b => b.code==='stale_onchain_service' && /node src\/cli\.js/.test(b.fix)));
});
test('undefined status → status_unknown WARNING, not a false inactive blocker', () => {
  const r = diagnoseAgent({ platformStatus:undefined, network:'verustest', services:[{status:'active',currency:'VRSCTEST',price:0.5}], refresh:{agent:true,services:true} });
  assert.ok(r.warnings.some(w => /status unknown/i.test(w)));
  assert.ok(!r.blockers.some(b => b.code==='agent_inactive'));
});
test('revoked status → fix text says cannot reactivate', () => {
  const r = diagnoseAgent({ platformStatus:'revoked', network:'verustest', services:[], refresh:{agent:true,services:true} });
  assert.ok(r.blockers.some(b => /revoked/i.test(b.problem) && !/run.*activate/i.test(b.fix)));
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** (key rules: `currencyMatches` returns `true|false|null`; `null` = indeterminate i-address ⇒ never used to *block* or warn against; `diagnoseAgent` blockers = `agent_inactive`(only for known non-active, payable-recoverable states inactive/disabled), `revoked`/`pending`(distinct fix text), `no_active_service`(only when services has zero active AND not `isApiEndpoint`), `stale_onchain_service`(refresh.services===false); warnings = `status_unknown`(platformStatus null/undefined), `no_service_in_network_currency`(no payable service in `cur` but ≥1 active service exists, and `cur!==null`), `zero_priced_only`(the only same-cur active services are price 0). `hireable = blockers.length===0`).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(status): pure currency/payability + diagnoseAgent (audit-hardened)`.

---

### Task 2: `interpretActivation` (tri-state) + `needsActivation`

**Files:** modify `src/agent-status.js`, `test/agent-status.test.js`

- [ ] **Step 1: Failing tests**

```js
const { interpretActivation, needsActivation } = require('../src/agent-status.js');
test('null txid + has WIF → failed/broadcast_failed (funds/RPC)', () => {
  const r = interpretActivation({ expected:'active', onChainTxid:null, getAgentStatus:'active', canSignOnChain:true });
  assert.equal(r.state, 'failed'); assert.equal(r.code, 'broadcast_failed');
});
test('null txid + no signing capability → failed/no_signing_capability (A3)', () => {
  const r = interpretActivation({ expected:'active', onChainTxid:null, getAgentStatus:'active', canSignOnChain:false });
  assert.equal(r.state, 'failed'); assert.equal(r.code, 'no_signing_capability');
  assert.ok(!/funds|RPC/i.test(r.reason)); // must NOT misattribute to funds
});
test('refresh threw 429 → pending, never failed (A1)', () => {
  assert.equal(interpretActivation({ expected:'active', onChainTxid:'ab12', getAgentStatus:'inactive', refreshError:429, canSignOnChain:true }).state, 'pending');
});
test('txid + status active → confirmed', () => {
  assert.equal(interpretActivation({ expected:'active', onChainTxid:'ab12', getAgentStatus:'active', refresh:{agent:true} }).state, 'confirmed');
});
test('txid but status still stale/undefined → pending (NOT failed)', () => {
  assert.equal(interpretActivation({ expected:'active', onChainTxid:'ab12', getAgentStatus:'inactive', refresh:{agent:true} }).state, 'pending');
  assert.equal(interpretActivation({ expected:'active', onChainTxid:'ab12', getAgentStatus:undefined, refresh:{agent:true} }).state, 'pending');
});
test('txid but refresh.agent=false → pending (indexer behind)', () => {
  assert.equal(interpretActivation({ expected:'active', onChainTxid:'ab12', getAgentStatus:undefined, refresh:{agent:false} }).state, 'pending');
});
test('needsActivation: only when not already active', () => {
  assert.equal(needsActivation('active'), false);
  assert.equal(needsActivation('inactive'), true);
  assert.equal(needsActivation(undefined), true); // unknown ⇒ attempt (safe)
});
```

- [ ] **Step 2–4:** implement `interpretActivation({expected, onChainTxid, getAgentStatus, refresh, refreshError, canSignOnChain})` returning `{state, code, reason}`. Precedence: (1) `onChainTxid==null` → `failed`, `code = canSignOnChain ? 'broadcast_failed' : 'no_signing_capability'` (A3 — the no-signing reason must NOT mention funds/RPC); (2) `getAgentStatus===expected` → `confirmed`; (3) otherwise → `pending` (covers stale/undefined status, `refresh.agent===false`, and `refreshError===429` per A1 — a throttled/lagging read is never `failed`). `needsActivation(status) = status !== 'active'`. Export both.
- [ ] **Step 5: Commit** `feat(status): tri-state interpretActivation + idempotent needsActivation`.

---

### Task 3: `activate` / `activate-all` confirm (tri-state, exit-0-on-lag)

**Files:** `src/cli.js` (`activate` 1996–2037; `activate-all` 2066–2101)

- [ ] **Step 1:** In `activate`, after the existing `agent.activate(...)` + service-reactivation: if `options.platformOnly` → print the loud "DB-only, indexer will revert" warning (no confirm). Else: **call `refreshAgent(keys.iAddress)` exactly once** (mempool-aware; capture a 429 as `refreshError`, don't throw), then run a **`getAgent`-only poll** (cheap, 30/min) for the status flip — feed `interpretActivation({expected:'active', onChainTxid: result.onChainTxid, getAgentStatus: detail.status, refresh, refreshError, canSignOnChain: !!keys.wif})`; **break on `confirmed`**; budget `Number(process.env.J41_ACTIVATE_CONFIRM_MS)||210000` across ~6 `getAgent` polls (5s then 20–45s steps). **Do NOT call `refreshAgent` inside the poll loop (A1).** Final: `confirmed`→ ✅ exit 0; `failed` → print the `interpretActivation` `code`-specific message (`broadcast_failed`→`❌ on-chain broadcast did not happen (check funds/RPC)`; `no_signing_capability`→`❌ no local signing capability (broker not wired for status updates)`), **and force one `refreshAgent` to stop the platform DB lying (A2)**, exit 1; `pending`→ force one `refreshAgent` (A2), print `⚠️ submitted but not confirmed within Ns — run: node src/cli.js doctor <id> in a few min`, **exit 0**.
- [ ] **Step 2:** `activate-all`: fire all activates first (existing 1s stagger), then a **single spaced refresh round** (one `refreshAgent` per agent, **~12s apart to stay ≤5/min, A1**), then poll `getAgent` **concurrently** (`Promise.allSettled`, shared deadline) for the flips. Per-agent result printed via `interpretActivation`; never `process.exit` mid-loop. (Note in output if a refresh 429'd → that agent is reported `pending`, not failed.)
- [ ] **Step 3: Manual verify:** `node --check src/cli.js`; `activate agent-6 --platform-only` prints the warning; document that full confirm needs a funded testnet identity (don't broadcast in CI).
- [ ] **Step 4: Commit** `fix(activate): tri-state on-chain confirm; exit-0 on lag, exit-1 only on null txid; concurrent activate-all confirm`.

---

### Task 4: `gatherAgentSnapshot` + `doctor` + `formatDoctorReport`

**Files:** `src/cli.js` (new `doctor [agent-id]`, shared gather); `src/agent-status.js` (+`formatDoctorReport`)

- [ ] **Step 1 (pure formatter test + impl):** `formatDoctorReport(rows)` where each row `{id, identity, diagnosis}` → array of printable lines + `{anyBlocked: bool}` for exit code. Unit-test: hireable row → `✅`; blocked row lists each blocker `✗ [code] problem → fix` and warnings `⚠`; `anyBlocked` true iff any row has blockers.
- [ ] **Step 2:** `gatherAgentSnapshot(keys, {refresh})` helper (extracted, also usable by startup/inspect): authenticate a tmpAgent, `getAgent` (→platformStatus), `getAgentServices(iAddress)` (→services), `isApiEndpoint` from local config/capabilities, and **only if `opts.refresh`** call `refreshAgent` (→{agent,services}); always `tmpAgent.stop()` in a `finally`. Returns the `diagnoseAgent` input shape (`network: J41_NETWORK`).
- [ ] **Step 3:** `doctor [agent-id]` command, `--refresh` option (default off — diagnosis must not side-effect via refreshAgent), `--json`. For all-agents: gather **concurrently** for the cheap `getAgent`/`getAgentServices` reads (`Promise.allSettled`); **but when `--refresh` is set, space the `refreshAgent` calls ≤5/min (serialize ~12s apart) and treat a 429 as "unknown, try again later," not a failure (A1)**. `diagnoseAgent` each, `formatDoctorReport`, print. **`formatDoctorReport` must footer-label a no-`--refresh` run as "verdict as of last indexer pass — pass --refresh to force a chain re-read" (A2)**, since the platform DB can hold a stale-optimistic `active` after a failed activate. `process.exit(anyBlocked ? 1 : 0)`.
- [ ] **Step 4: Manual verify:** `node src/cli.js doctor` shows ✅ for worker6/7, and for worker1 the real blockers (stale_onchain_service if `--refresh`) with copy-pasteable fixes. `node --check src/cli.js`.
- [ ] **Step 5: Commit** `feat(doctor): per-agent hireability diagnosis (shared gather, refresh opt-in, CI exit code)`.

---

### Task 5: Idempotent boot-activate + `state.platformStatus` population + skip-hint

**Files:** `src/cli.js` (startup skip 3022–3037; boot activate 3819–3844)

- [ ] **Step 1:** At the startup status check (3027), capture the fetched status onto the agent entry: `readyAgents.push({ id: agentId, ...keys, platformStatus: profile.status })`, and seed `state.platformStatus.set(agentId, { status: profile.status, at: Date.now() })`. Enrich the skip log: `⏸ … ${profile.status} on platform — skipping. Fix: node src/cli.js doctor ${agentId}`.
- [ ] **Step 2:** In the boot auto-activate loop (still gated by the existing `J41_NO_STATUS_TOGGLE`, default-on), wrap each agent with `needsActivation(agentInfo.platformStatus)`: if already `active`, log `↳ ${id}: already active on-chain — skipping activate (no tx)` and just `refreshAgent`; else `agent.activate({onChain:true})` and reuse the Task-3 `interpretActivation` confirm (log pending, don't fail boot). Update `state.platformStatus` after.
- [ ] **Step 3: Manual verify:** restart with all agents already active → log shows "already active — skipping activate (no tx)" for each (no on-chain txids fired); `node --check src/cli.js`.
- [ ] **Step 4: Commit** `feat(boot): idempotent activation (skip tx when already active) + cache platformStatus + skip fix-hint`.

---

### Task 6: `state.platformStatus` poller + ctl hireability column

**Files:** `src/cli.js` (new poller; `state.platformStatus` init; renderer 6647); `src/control.js` (`buildAgents` 197–211); `src/agent-status.js` (+`hireCell`)

- [ ] **Step 1 (pure):** `hireCell(entry)` → `entry.hireable===true ? '✅' : entry.hireable===false ? \`❌(${entry.reason||'?'})\` : '?'`. Unit-test the tri-state incl. `null`/`undefined` → `'?'`.
- [ ] **Step 2:** Init `state.platformStatus = new Map()`. Add `startPlatformStatusPoller(state)` (mirror `startVrscRatePoller`): every `Number(process.env.J41_STATUS_POLL_MS)||120000`, for each `state.agents` refresh `getAgent(id).status` (cheap read, NOT `refreshAgent`) into `state.platformStatus.set(id,{status,at})`. Also update on activate/deactivate paths.
- [ ] **Step 3:** `buildAgents(state)` (control.js): add `platformStatus`, `statusAge` (ms since `at`), and `hireable`/`reason` from `diagnoseAgent({platformStatus: ps.status, network: state.network, services: caps.services, isApiEndpoint: caps.isApiEndpoint, refresh: undefined})`. When `state.platformStatus` has no entry → `hireable: null`. Pass `state.network` (set from `J41_NETWORK` at startup) into state so control.js has it.
- [ ] **Step 4:** Renderer (6647): `… ${a.platformStatus||'?'} hire=${hireCell(a)}${a.statusAge!=null?\` (@${Math.round(a.statusAge/60000)}m)\`:''} svc=${a.activeServices ?? a.services} …` — and have `buildAgents` also emit `activeServices` = count of `status==='active'` services so the count is honest too.
- [ ] **Step 5: Manual verify:** `ctl agents` shows `hire=✅` for worker6/7, `hire=❌(<reason>)` where applicable, `(@Nm)` freshness; never derives the verdict from busy/available. `node --check src/cli.js src/control.js`.
- [ ] **Step 6: Commit** `feat(ctl): real platform-status tracking + honest hireability column (as-of-refresh)`.

---

### Task 7: Docs + full suite + final review

- [ ] **Step 1:** `CHANGELOG.md`: new `doctor`; `activate` confirms on-chain (exit-1 only on null txid; exit-0+warn on lag); idempotent boot; `ctl agents` hireability. `README.md`: `doctor` usage + note `--platform-only` does not persist.
- [ ] **Step 2:** `node --test test/*.test.js` (existing 268 + new) green; `node --check src/*.js`.
- [ ] **Step 3:** Final code-review subagent → superpowers:finishing-a-development-branch.

---

## Resolved decisions / parked
- Decisions #1/#3/#4 resolved above (operator, 2026-06-24).
- **Backend/SDK requests to file** (`docs/backend-requests`), none block this plan:
  - **SDK:** `activate()` must NOT call `setAgentStatus(active)` when `_updateOnChainStatus` returned `null` (no WIF / broadcast failed) — the optimistic DB write is the root of the lie this plan works around (A2). The real fix lives there.
  - **Backend:** raise the dispatcher `/v1/agents/:id/refresh` limit above 5/60s for the dispatcher IP, or add a **batch-refresh** endpoint, so confirm/doctor across N agents doesn't serialize on the rate limit (A1).
  - **Broker:** wire signed `J41-STATUS|…` status updates through the signing broker so no-WIF agents can actually be activated/deactivated on-chain (A3) — until then, broker-mode agents will report `no_signing_capability`.
- **Parked (needs backend):** a liveness **heartbeat/lease** so a *crashed* dispatcher (not a clean shutdown) de-lists agents without an on-chain flip — the only fully-correct fix for "offline signal." Out of scope here; candidate for `docs/backend-requests`. Idempotent boot + kept shutdown-deactivate covers the common cases meanwhile.
- **worker1's stale on-chain service** (refresh.services=false): Task-1 emits a runnable fix string; confirm the exact republish command (`finalize`/service-register) against the CLI before shipping so the `fix` text is copy-pasteable.
