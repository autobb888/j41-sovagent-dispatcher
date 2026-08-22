# Dispatcher spend-policy consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the dispatcher's existing-but-diffused spend-policy into one explicit, un-widenable, ledgered gate, and close the two external-send bypasses — without changing refund behavior.

**Architecture:** Extract the allowlist + rate limiter + kill switch from `cli.js` into a new `src/spend-policy.js` behind a `gateExternalSend()` / `recordSendOutcome()` funnel; add compiled hard ceilings that clamp config, a unified append-only `spend-ledger.jsonl`, and mainnet-guard checks. The refund path (`attemptPendingRefund`) and the `pay-jobs.js` payment script both call the funnel; fleet-internal sends only ledger.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict`, no new dependencies. Spec: `docs/superpowers/specs/2026-08-18-dispatcher-spend-policy-consolidation-design.md`.

## Global Constraints

- **No behavior change in P1–P3 wiring beyond the two additions** (ledger append, absolute cap). Move-verbatim first; prove with the existing suites before layering.
- **Amount units:** the existing limiter arithmetic is **decimal VRSC** (`refundAmount`, `jobPrice` are JS numbers). Preserve that verbatim. Satoshi precision is added **only** at (a) the new absolute per-tx cap — convert the decimal amount to satoshis via `parseVrscAmount` (from `src/wallet.js`) for the comparison only — and (b) the ledger `amountSats` field. Never introduce `parseFloat(x) * 1e8`.
- **Fail-closed** (per repo doctrine): policy/ledger failure denies the send; a *pre-broadcast* deny is `retryable`, never a silent pass.
- **Re-export discipline (C5):** every name moved out of `cli.js` must stay aliased from `cli.js`'s test-mode `module.exports` (`cli.js:12934`), re-imported from `src/spend-policy.js`. Un-ported suites import these from `cli.js`.
- **Hard ceilings (Generous, approved):** `HARD_MAX_VALUE_MULTIPLIER=2.0`, `HARD_MAX_SENDS_PER_JOB=10`, `HARD_MAX_SENDS_PER_HOUR=100`, `HARD_MAX_SINGLE_SEND_SATS=1000 VRSC` (`100_000_000_000n`).
- **Absolute per-tx cap is terminal for external kinds only** (`refund`, `payment`); for `fleet_transfer`/`fee_sweep` it is advisory (ledger + WARN), never a deny (C1).
- **Test idiom:** every suite sets `process.env.NODE_ENV = 'test'`, sandboxes HOME (`process.env.HOME` + `os.homedir` override) **before** requiring `cli.js`, and imports from `cli.js` or `src/spend-policy.js`. Run a single suite with `node --test test/<file>.test.js`; full gate `npm test`.
- **Commits:** conventional commits; new commit per task (no amend/force-push). Co-author trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File structure

- **Create** `src/spend-policy.js` — the gate: moved allowlist + limiter + kill switch, `effectiveLimits()`, `gateExternalSend()`, `recordSendOutcome()`, hard-cap constants, ledger append.
- **Create** `test/spend-policy.test.js` — funnel + clamp + absolute-cap unit tests.
- **Create** `test/spend-ledger.test.js` — ledger append, denial line, fail-closed.
- **Modify** `src/cli.js` — remove moved bodies; import + re-export from `spend-policy.js`; rewire `attemptPendingRefund` to the funnel with the C3 ordering.
- **Modify** `scripts/pay-jobs.js` — BigInt amounts, gate-as-unit, delete invented fee, mainnet-refuse.
- **Modify** `src/wallet.js`, `src/fee-tank.js` — `recordSendOutcome` call (ledger + advisory cap).
- **Modify** `src/mainnet-guard.js` — clamped-config + ledger-writable violations (kept pure via `opts`).
- **Modify** `src/config-loader.js` — add `spend_policy.approval` default (P6).
- **Reference** existing tests: `test/refund-rate-limit.test.js`, `test/refund-rate-limit-wiring.test.js`, `test/send-lock-race.test.js`, `test/send-history-lock-race.test.js` (idiom + regression).

---

## Task 1: Extract `src/spend-policy.js` (move-verbatim + re-export)

**Files:**
- Create: `src/spend-policy.js`
- Modify: `src/cli.js` (remove bodies ~`246-316`, `575-698`, `700-790` sweep stays; add import + re-export at `:12934`)
- Test: existing `test/refund-rate-limit.test.js`, `test/send-history-lock-race.test.js` (regression, unchanged)

**Interfaces:**
- Produces (from `src/spend-policy.js`): `loadFinancialAllowlist()`, `isAddressInAllowlist(list, addr)`, `addActiveJobToAllowlist`, `removeActiveJobFromAllowlist`, `addToRefundAllowlist`, `dispatcherRateLimits()`, `checkDispatcherRateLimit(jobId, amount, jobPrice, now?)`, `recordDispatcherSend(jobId, amount, now?)`, `_resetDispatcherRateLimit(suspended?)`, `setFinancialSuspended(on, now?)`, `isFinanciallySuspended()`, `loadSendHistory()`, `withSendHistoryLock(fn)`, `SEND_HISTORY_PATH`, `FINANCIAL_SUSPENDED_PATH`, `ALLOWLIST_PATH`. Same signatures/behavior as today.
- Consumes: `loadDispatcherConfig` (`src/config-loader.js`), `untrusted` (`src/untrusted.js`), `os`/`fs`/`path`.

- [ ] **Step 1: Create `src/spend-policy.js` and move the bodies verbatim.** Cut `loadFinancialAllowlist`/`isAddressInAllowlist`/`addActiveJobToAllowlist`/`removeActiveJobFromAllowlist`/`addToRefundAllowlist` (cli.js:246-316), the send-lock + history helpers and `dispatcherRateLimits`/`checkDispatcherRateLimit`/`recordDispatcherSend`/`_recordDispatcherSendLocked`/`_resetDispatcherRateLimit`/`setFinancialSuspended`/`isFinanciallySuspended`/`loadSendHistory`/`saveSendHistory`/`withSendHistoryLock` and their path constants (`ALLOWLIST_PATH`, `SEND_HISTORY_PATH`, `FINANCIAL_SUSPENDED_PATH`) into the new module. Re-derive the `DISPATCHER_DIR`/HOME-based paths inside the module (same `os.homedir()` resolution). `module.exports` every name in the Interfaces block. **Do not move** `startDispatcherSweep` — it stays in `cli.js` and imports `setFinancialSuspended`/`loadFinancialAllowlist` from the new module.

- [ ] **Step 2: Wire `cli.js` to import + re-export.** At the top of `cli.js`, `const SP = require('./spend-policy.js')` and bind local names (`const { loadFinancialAllowlist, isAddressInAllowlist, checkDispatcherRateLimit, recordDispatcherSend, setFinancialSuspended, isFinanciallySuspended, loadSendHistory, withSendHistoryLock, SEND_HISTORY_PATH, FINANCIAL_SUSPENDED_PATH, ALLOWLIST_PATH, ... } = SP`). In the test-mode `module.exports` (cli.js:12934) keep every one of `checkDispatcherRateLimit, recordDispatcherSend, _resetDispatcherRateLimit, setFinancialSuspended, isFinanciallySuspended, loadSendHistory, SEND_HISTORY_PATH, FINANCIAL_SUSPENDED_PATH, acquireSendLock` present (now sourced from `SP`).

- [ ] **Step 3: Syntax + full suite (regression).**
  Run: `npm test`
  Expected: PASS — no test changed; the move is behavior-neutral. (`node --check` also covers the new file.)

- [ ] **Step 4: Add an explicit import-surface test.** Create `test/spend-policy.test.js`:

```js
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-sp-test-'));
process.env.HOME = TEST_HOME;
os.homedir = () => TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.j41', 'dispatcher'), { recursive: true });

const SP = require('../src/spend-policy.js');
const cli = require('../src/cli.js');

test('spend-policy exports the moved surface', () => {
  for (const n of ['checkDispatcherRateLimit','recordDispatcherSend','setFinancialSuspended','isFinanciallySuspended','loadFinancialAllowlist','isAddressInAllowlist']) {
    assert.equal(typeof SP[n], 'function', `${n} exported`);
  }
});

test('cli re-exports the same functions (identity preserved)', () => {
  assert.equal(cli.checkDispatcherRateLimit, SP.checkDispatcherRateLimit);
  assert.equal(cli.setFinancialSuspended, SP.setFinancialSuspended);
});
```

- [ ] **Step 5: Run the new test.**
  Run: `node --test test/spend-policy.test.js`
  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/spend-policy.js src/cli.js test/spend-policy.test.js
git commit -m "refactor(spend-policy): extract allowlist + limiter + kill switch to src/spend-policy.js (P1)

Move-verbatim, behavior-neutral; every moved name re-aliased from cli.js
test-mode exports so existing suites keep importing from cli.js.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: The `gateExternalSend` / `recordSendOutcome` funnel

**Files:**
- Modify: `src/spend-policy.js`
- Test: `test/spend-policy.test.js`

**Interfaces:**
- Produces: `gateExternalSend({ jobId, toAddress, amount, jobPrice, kind, expectedRecipients?, now? }) → { allowed, retryable, reason?, checks }`; `recordSendOutcome({ kind, jobId, toAddress, amount, txid?, denial?, now? }) → void`. `kind ∈ {'refund','payment','fleet_transfer','fee_sweep'}`. `amount`/`jobPrice` are decimal VRSC numbers (as today). `checks` is `{ suspension, counterparty, perJobCap, valueCeiling, hourlyCap, cooldown, absoluteCap }` each `'pass'|'fail'|'skip'`.
- Consumes: the Task 1 functions.

- [ ] **Step 1: Write failing tests** (append to `test/spend-policy.test.js`):

```js
const { gateExternalSend, _resetDispatcherRateLimit } = SP;

test('refund gate: allows an allowlisted address within limits', () => {
  _resetDispatcherRateLimit(false);
  // seed the allowlist with a buyer i-address
  const list = SP.loadFinancialAllowlist();
  list.permanent.push({ address: 'iBUYER', jobId: 'j1' });
  fs.writeFileSync(SP.ALLOWLIST_PATH, JSON.stringify(list));
  const r = gateExternalSend({ jobId: 'j1', toAddress: 'iBUYER', amount: 1, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, true);
  assert.equal(r.checks.counterparty, 'pass');
});

test('refund gate: denies a non-allowlisted address (terminal)', () => {
  _resetDispatcherRateLimit(false);
  const r = gateExternalSend({ jobId: 'j2', toAddress: 'iSTRANGER', amount: 1, jobPrice: 1, kind: 'refund' });
  assert.equal(r.allowed, false);
  assert.equal(r.retryable, false);
  assert.equal(r.checks.counterparty, 'fail');
});

test('payment gate: destination must be in expectedRecipients', () => {
  _resetDispatcherRateLimit(false);
  const ok = gateExternalSend({ jobId: 'p1', toAddress: 'iAGENT', amount: 1, jobPrice: 1, kind: 'payment', expectedRecipients: ['iAGENT','iFEE'] });
  assert.equal(ok.allowed, true);
  const bad = gateExternalSend({ jobId: 'p1', toAddress: 'iEVIL', amount: 1, jobPrice: 1, kind: 'payment', expectedRecipients: ['iAGENT','iFEE'] });
  assert.equal(bad.allowed, false);
  assert.equal(bad.checks.counterparty, 'fail');
});

test('fleet_transfer gate: skips counterparty + value checks', () => {
  _resetDispatcherRateLimit(false);
  const r = gateExternalSend({ jobId: null, toAddress: 'iOWN', amount: 5, jobPrice: 0, kind: 'fleet_transfer' });
  assert.equal(r.allowed, true);
  assert.equal(r.checks.counterparty, 'skip');
  assert.equal(r.checks.valueCeiling, 'skip');
});
```

- [ ] **Step 2: Run — expect FAIL** (`gateExternalSend is not a function`).
  Run: `node --test test/spend-policy.test.js`

- [ ] **Step 3: Implement `gateExternalSend` + `recordSendOutcome`** in `src/spend-policy.js`. `gateExternalSend` runs, in order (§4.1): suspension → counterparty (refund: `isAddressInAllowlist`; payment: `expectedRecipients.includes(toAddress)`; fleet/fee: `skip`) → per-job cap / value ceiling / hourly cap / cooldown by **delegating to `checkDispatcherRateLimit`** for external kinds (skip for fleet/fee) → absolute cap (Task 5 fills this; here leave `checks.absoluteCap='skip'`). Build `checks` from the sub-results and map `checkDispatcherRateLimit`'s `{allowed, retryable, reason}` through. `recordSendOutcome` calls `recordDispatcherSend` for external kinds and (Task 4) appends the ledger.

- [ ] **Step 4: Run — expect PASS.**
  Run: `node --test test/spend-policy.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/spend-policy.js test/spend-policy.test.js
git commit -m "feat(spend-policy): gateExternalSend + recordSendOutcome funnel (P1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Rewire `attemptPendingRefund` to the funnel (C3 ordering)

**Files:**
- Modify: `src/cli.js` (`attemptPendingRefund`, ~7181-7230)
- Test: `test/refund-rate-limit-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `gateExternalSend`, `recordSendOutcome` from `spend-policy.js`.

- [ ] **Step 1: Extend the wiring test** so it asserts the funnel is on the live path and the ordering holds. In `test/refund-rate-limit-wiring.test.js`, add a test that stubs `agent.sendCurrency` and asserts: (a) a non-allowlisted address never reaches `sendCurrency`; (b) on a denied gate, `markRefundInflight` is **not** called; (c) on an allowed gate the call order is `gate → markRefundInflight → sendCurrency → markJobRefunded → recordSendOutcome`. Use spies (wrap the functions on the required `cli` module object; follow the existing wiring test's stubbing pattern).

- [ ] **Step 2: Run — expect FAIL** (old inline path still used).
  Run: `node --test test/refund-rate-limit-wiring.test.js`

- [ ] **Step 3: Replace the inline allowlist+ratelimit block (cli.js:7181-7210)** with a single funnel call, keeping the retryable/terminal logging:

```js
    const _jobPrice = Number(orphan?.jobAmount ?? orphan?.amount);
    const _gate = gateExternalSend({ jobId, toAddress: buyerAddress, amount: refundAmount, jobPrice: _jobPrice, kind: 'refund' });
    if (!_gate.allowed) {
      if (_gate.retryable) {
        console.log(`  [refund] ⏸  ${jobId.substring(0,8)}: ${_gate.reason} — deferring to the next drain`);
      } else {
        console.error(`  [refund] ⛔ ${jobId.substring(0,8)}: BLOCKED — ${_gate.reason}`);
        console.error('  [refund]    Nothing was sent. Inspect, then: j41-dispatcher refunds reject ' + jobId);
      }
      return false;   // decision already ledgered inside gateExternalSend (Task 4)
    }
```

  Keep `markRefundInflight` (7216) → `sendCurrency` (7217) → `markJobRefunded` (7226) → `clearRefundInflight` (7227) exactly as-is, then **replace** `recordDispatcherSend(jobId, refundAmount)` (7230) with `recordSendOutcome({ kind:'refund', jobId, toAddress: buyerAddress, amount: refundAmount, txid })`.

- [ ] **Step 4: Run wiring + regression.**
  Run: `node --test test/refund-rate-limit-wiring.test.js && node --test test/refund-rate-limit.test.js`
  Expected: PASS (both).

- [ ] **Step 5: Commit.**

```bash
git add src/cli.js test/refund-rate-limit-wiring.test.js
git commit -m "refactor(refund): route attemptPendingRefund through gateExternalSend (P1, C3 ordering)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Unified append-only ledger (`spend-ledger.jsonl`, C3/C4)

**Files:**
- Modify: `src/spend-policy.js`
- Test: Create `test/spend-ledger.test.js`

**Interfaces:**
- Produces: internal `appendLedger(line)` (locked single `write()` to an `O_APPEND` fd under a dedicated `spend-ledger.lock`); `SPEND_LEDGER_PATH`. `gateExternalSend` appends a `gate_decision` line (allow **and** deny) before returning; `recordSendOutcome` appends a `broadcast_outcome` line. Pre-broadcast append failure → `gateExternalSend` returns `{allowed:false, retryable:true, reason:'ledger unwritable'}`.

- [ ] **Step 1: Write failing tests** (`test/spend-ledger.test.js`, same HOME-sandbox header as Task 1):

```js
const SP = require('../src/spend-policy.js');
const fs = require('node:fs');
function readLedger() {
  return fs.readFileSync(SP.SPEND_LEDGER_PATH,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('a denied send leaves a gate_decision line with allowed:false', () => {
  SP._resetDispatcherRateLimit(false);
  SP.gateExternalSend({ jobId:'d1', toAddress:'iSTRANGER', amount:1, jobPrice:1, kind:'refund' });
  const lines = readLedger();
  const l = lines.find(x => x.jobId==='d1');
  assert.equal(l.event,'gate_decision');
  assert.equal(l.allowed,false);
  assert.ok(l.reason);
});

test('fail-closed: unwritable ledger denies retryable', () => {
  SP._resetDispatcherRateLimit(false);
  // make the ledger path unwritable (dir replaced by a file, or chmod 000)
  fs.rmSync(SP.SPEND_LEDGER_PATH,{force:true});
  fs.writeFileSync(SP.SPEND_LEDGER_PATH+'.lockdir-block','x'); // simulate; see impl note
  const r = SP.gateExternalSend({ jobId:'d2', toAddress:'iBUYER', amount:1, jobPrice:1, kind:'refund', expectedRecipients:['iBUYER'] });
  assert.equal(r.allowed,false);
  assert.equal(r.retryable,true);
});
```
  (Implementation note: the fail-closed test forces an append error — pick a mechanism that reliably fails `appendLedger` on the target platform, e.g. pointing `SPEND_LEDGER_PATH` at a directory. Adjust the test to the chosen mechanism.)

- [ ] **Step 2: Run — expect FAIL** (`SPEND_LEDGER_PATH` undefined).
  Run: `node --test test/spend-ledger.test.js`

- [ ] **Step 3: Implement `appendLedger` + wire it.** `SPEND_LEDGER_PATH = ~/.j41/spend-ledger.jsonl`. `appendLedger(obj)`: acquire `spend-ledger.lock` (reuse the `acquireSendLock` stale-steal pattern with a fixed lock name), `fs.openSync(path,'a')`, one `fs.writeSync(fd, JSON.stringify(obj)+'\n')`, `fs.closeSync`, release lock. In `gateExternalSend`, build the line (schema in spec §5-P3, `amountSats` = `parseVrscAmount(String(amount))` as a decimal string) and append it **before returning**; if the append throws, return `{allowed:false, retryable:true, reason:'spend-ledger unwritable'}`. In `recordSendOutcome`, append the `broadcast_outcome` line best-effort (catch + WARN; the money already moved).

- [ ] **Step 4: Run — expect PASS.**
  Run: `node --test test/spend-ledger.test.js`

- [ ] **Step 5: Regression.**
  Run: `npm test`
  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/spend-policy.js test/spend-ledger.test.js
git commit -m "feat(spend-policy): unified append-only spend-ledger, fail-closed pre-broadcast (P3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Compiled hard ceilings + absolute per-tx cap (P2, C1)

**Files:**
- Modify: `src/spend-policy.js`
- Test: `test/spend-policy.test.js`

**Interfaces:**
- Produces: `effectiveLimits()` (config clamped to hard constants); the absolute per-tx cap inside `gateExternalSend` (terminal for external, advisory for fleet/fee); `_clampedKeys()` → `string[]` (which keys were clamped this process, for P5).

- [ ] **Step 1: Write failing tests:**

```js
test('effectiveLimits clamps config above the hard ceiling', () => {
  process.env.J41_REFUND_MAX_VALUE_MULT = '9.0';
  process.env.J41_REFUND_MAX_SENDS_PER_HOUR = '99999';
  const lim = SP.effectiveLimits();
  assert.ok(lim.maxValueMultiplier <= 2.0);
  assert.ok(lim.maxSendsPerHour <= 100);
  assert.ok(SP._clampedKeys().includes('max_value_multiplier'));
  delete process.env.J41_REFUND_MAX_VALUE_MULT; delete process.env.J41_REFUND_MAX_SENDS_PER_HOUR;
});

test('absolute per-tx cap denies an external send over 1000 VRSC (terminal)', () => {
  SP._resetDispatcherRateLimit(false);
  const list = SP.loadFinancialAllowlist(); list.permanent.push({address:'iBUYER',jobId:'big'});
  fs.writeFileSync(SP.ALLOWLIST_PATH, JSON.stringify(list));
  const r = SP.gateExternalSend({ jobId:'big', toAddress:'iBUYER', amount:1001, jobPrice:2000, kind:'refund' });
  assert.equal(r.allowed,false);
  assert.equal(r.retryable,false);
  assert.equal(r.checks.absoluteCap,'fail');
});

test('absolute per-tx cap is ADVISORY for fee_sweep (never denies)', () => {
  SP._resetDispatcherRateLimit(false);
  const r = SP.gateExternalSend({ jobId:null, toAddress:'iOWN', amount:5000, jobPrice:0, kind:'fee_sweep' });
  assert.equal(r.allowed,true);
  assert.equal(r.checks.absoluteCap,'warn');
});
```

- [ ] **Step 2: Run — expect FAIL.**
  Run: `node --test test/spend-policy.test.js`

- [ ] **Step 3: Implement.** Add the four `HARD_*` constants. `effectiveLimits()` = `dispatcherRateLimits()` then `Math.min` per field against the hard cap; record clamped keys in a module-level `Set` and WARN once per key. Have `checkDispatcherRateLimit` read `effectiveLimits()` instead of `dispatcherRateLimits()` directly (this is the only place the value-multiplier/hour/job caps are enforced — so clamping there closes the config-widen gap). In `gateExternalSend`, after the rate-limit checks, compute `sats = parseVrscAmount(String(amount))`; if `sats > HARD_MAX_SINGLE_SEND_SATS`: external kinds → `checks.absoluteCap='fail'`, return terminal deny; fleet/fee → `checks.absoluteCap='warn'`, WARN, continue.

- [ ] **Step 4: Run — expect PASS.**
  Run: `node --test test/spend-policy.test.js`

- [ ] **Step 5: Regression** (`npm test`).

- [ ] **Step 6: Commit.**

```bash
git add src/spend-policy.js test/spend-policy.test.js
git commit -m "feat(spend-policy): compiled hard ceilings + absolute per-tx cap (P2, C1)

Config is clamped to un-widenable ceilings; the absolute cap is terminal
for external sends and advisory-only for self-directed sweeps.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `scripts/pay-jobs.js` — gate + fix (P4, C2)

**Files:**
- Modify: `scripts/pay-jobs.js`
- Test: Create `test/pay-jobs.test.js`

**Interfaces:**
- Consumes: `gateExternalSend`, `recordSendOutcome`, `parseVrscAmount`, `findMainnetSecurityViolations`/`resolveIsMainnet`. Introduce a pure `planPayJob(job, { platformFeeAddress })` → `{ outputs:[{address, amountSats}], gate }` so it is unit-testable without the SDK/network.

- [ ] **Step 1: Write failing tests** (`test/pay-jobs.test.js`) for the pure planner:

```js
const { planPayJob } = require('../scripts/pay-jobs.js');
test('no stated fee → no fee output (never a computed 5%)', () => {
  const p = planPayJob({ amount:'10', payment:{ address:'iAGENT' } }, { platformFeeAddress:'iFEE' });
  assert.equal(p.outputs.length, 1);
  assert.equal(p.outputs[0].address, 'iAGENT');
});
test('stated fee → agent + fee outputs, BigInt sats', () => {
  const p = planPayJob({ amount:'10', payment:{ address:'iAGENT', feeAmount:'0.5' } }, { platformFeeAddress:'iFEE' });
  assert.equal(p.outputs.length, 2);
  assert.equal(p.outputs[1].address, 'iFEE');
  assert.equal(typeof p.outputs[0].amountSats, 'bigint');
});
test('destination not in expectedRecipients → whole tx denied', () => {
  const p = planPayJob({ amount:'10', payment:{ address:'iHIJACK' } }, { platformFeeAddress:'iFEE', expected:['iAGENT','iFEE'] });
  assert.equal(p.gate.allowed, false);
});
```

- [ ] **Step 2: Run — expect FAIL** (`planPayJob` not exported).
  Run: `node --test test/pay-jobs.test.js`

- [ ] **Step 3: Rewrite `scripts/pay-jobs.js`.** Export `planPayJob` (pure). Replace `parseFloat(job.amount)` with `parseVrscAmount(String(job.amount))`; **delete** the `|| amount * 0.05` fee fallback — a fee output exists only if `job.payment.feeAmount` is stated. Use `expectedRecipients = [job.payment.address, PLATFORM_FEE_ADDRESS]` where `PLATFORM_FEE_ADDRESS` is read from config/env constant (not per-call). Gate the tx **as a unit**: all outputs must be members of `expectedRecipients` and the summed amount within caps; if the gate denies, do not broadcast. In `main()`: after a successful `sendMultiPayment`, one `recordSendOutcome({kind:'payment', ...})`. At startup, if `resolveIsMainnet(...)` and any planned tx would be clamped/over-cap, refuse with a clear message. Update the header comment (no longer a bypass).

- [ ] **Step 4: Run — expect PASS.**
  Run: `node --test test/pay-jobs.test.js`

- [ ] **Step 5: Commit.**

```bash
git add scripts/pay-jobs.js test/pay-jobs.test.js
git commit -m "fix(pay-jobs): route through spend-policy gate, BigInt amounts, drop invented fee (P4, C2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Ledger fleet-internal sends (`wallet.js` / `fee-tank.js`) (P4)

**Files:**
- Modify: `src/wallet.js` (after `broadcast` at ~432), `src/fee-tank.js` (after `broadcast` at ~218)
- Test: `test/wallet.test.js` (extend) / `test/spend-ledger.test.js`

**Interfaces:**
- Consumes: `recordSendOutcome({kind:'fleet_transfer'|'fee_sweep', ...})`.

- [ ] **Step 1: Write a failing test** asserting a fee-sweep records a `fee_sweep` outcome line in the ledger, and that a >1000 VRSC sweep is **allowed** with `absoluteCap:'warn'` (never denied). Add to `test/spend-ledger.test.js`.

- [ ] **Step 2: Run — expect FAIL.**
  Run: `node --test test/spend-ledger.test.js`

- [ ] **Step 3: Implement.** After each successful fleet-internal `broadcast`, call `recordSendOutcome` with the corresponding kind. `wallet.js`/`fee-tank.js` are documented as pure-over-inputs; keep them so by injecting `recordSendOutcome` as a parameter (or calling at the `cli.js` call site right after broadcast) rather than importing fs into those pure modules. Prefer the call-site approach to preserve `wallet.js`'s "no fs, no side effects" contract (see `src/wallet.js:32-34`).

- [ ] **Step 4: Run — expect PASS**, then `npm test`.

- [ ] **Step 5: Commit.**

```bash
git add src/wallet.js src/fee-tank.js src/cli.js test/spend-ledger.test.js
git commit -m "feat(spend-policy): ledger fleet-internal sends, advisory cap only (P4)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Mainnet-guard extensions (P5)

**Files:**
- Modify: `src/mainnet-guard.js`, and the startup call site in `src/cli.js`
- Test: `test/mainnet-guard.test.js` (extend or create)

**Interfaces:**
- Produces: `findMainnetSecurityViolations(env, opts)` gains `opts.clampedConfigKeys?: string[]` and `opts.spendLedgerWritable?: boolean`. Stays **pure** (facts passed in via `opts`; no fs/cfg reads).

- [ ] **Step 1: Write failing tests:**

```js
const { findMainnetSecurityViolations } = require('../src/mainnet-guard.js');
test('clamped refund_limits is a mainnet violation', () => {
  const v = findMainnetSecurityViolations({}, { clampedConfigKeys:['max_value_multiplier'] });
  assert.ok(v.some(m => m.includes('max_value_multiplier')));
});
test('unwritable spend-ledger is a mainnet violation', () => {
  const v = findMainnetSecurityViolations({}, { spendLedgerWritable:false });
  assert.ok(v.some(m => m.toLowerCase().includes('spend-ledger')));
});
test('clean opts → no new violations', () => {
  const v = findMainnetSecurityViolations({}, { clampedConfigKeys:[], spendLedgerWritable:true });
  assert.equal(v.length, 0);
});
```

- [ ] **Step 2: Run — expect FAIL.**
  Run: `node --test test/mainnet-guard.test.js`

- [ ] **Step 3: Implement** two pushes in `findMainnetSecurityViolations`: for each key in `opts.clampedConfigKeys||[]`, push a message ("config asks above the compiled ceiling for `<key>` — someone edited it"); if `opts.spendLedgerWritable === false`, push a spend-ledger message. At the `cli.js` startup guard call site, compute `clampedConfigKeys = SP._clampedKeys()` and `spendLedgerWritable` (a probe write/`fs.accessSync`) and pass them in `opts`.

- [ ] **Step 4: Run — expect PASS**, then `npm test`.

- [ ] **Step 5: Commit.**

```bash
git add src/mainnet-guard.js src/cli.js test/mainnet-guard.test.js
git commit -m "feat(mainnet-guard): clamped-config + unwritable-ledger violations, pure via opts (P5)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Attended-mode formalization (P6, formalize only)

**Files:**
- Modify: `src/config-loader.js` (add default), `src/cli.js` (surface in `status`)
- Test: `test/spend-policy.test.js` or `test/config.test.js`

**Interfaces:**
- Produces: config `spend_policy.approval` default `'always'`; a documented, greppable setting. **No `auto_approve_below_sats`, no new send path.**

- [ ] **Step 1: Write a failing test** asserting `loadDispatcherConfig().spend_policy.approval === 'always'` by default, and that an env/file override to `'always'` is honored (there is only the one value today; the test pins the default and the shape).

- [ ] **Step 2: Run — expect FAIL.**
  Run: `node --test test/config.test.js`

- [ ] **Step 3: Implement.** Add `spend_policy: { approval: 'always' }` to the config defaults (near `refund_limits`, `config-loader.js:80`). Surface it in the `status` command output ("external-send approval: always (owner-approved)"). Document in the README's financial section that every external send is owner-approved by default.

- [ ] **Step 4: Run — expect PASS**, then `npm test`.

- [ ] **Step 5: Commit.**

```bash
git add src/config-loader.js src/cli.js test/config.test.js docs/ README.md
git commit -m "feat(spend-policy): formalize external-send approval as spend_policy.approval=always (P6)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Final regression + spec cross-check

- [ ] **Step 1: Full suite.**
  Run: `npm test`
  Expected: PASS (all suites, including the four regression suites and the new ones).

- [ ] **Step 2: Grep the bypass is closed.**
  Run: `grep -n "parseFloat" scripts/pay-jobs.js` → Expected: no hits. `grep -rn "amount \* 0.05" scripts/` → no hits.

- [ ] **Step 3: Confirm the seam.**
  Run: `grep -rn "sendCurrency\|sendMultiPayment" src/ scripts/` → Expected: `cli.js:7217` (now gated) and `pay-jobs.js` (now gated) only.

- [ ] **Step 4: Commit any doc updates, then hand off to the 3–5 pass Fable audit.**

---

## Self-review notes (author)

- **Spec coverage:** P1→Tasks 1-3; P2→Task 5; P3→Task 4; P4→Tasks 6-7; P5→Task 8; P6→Task 9. C1→Task 5 (advisory cap) + §4.3. C2→Task 6. C3→Task 3. C4→Task 4. C5→Task 1.
- **Amount-units reconciliation:** limiter stays decimal (Global Constraints); satoshis only at the absolute cap + ledger. This refines spec §4.1's `amountSats` to "decimal amount in, sats derived internally."
- **Ordering:** funnel introduced (Task 2) before it is wired live (Task 3); ledger (Task 4) before the absolute cap emits `warn`/`fail` lines (Task 5); mainnet-guard (Task 8) after `_clampedKeys()` exists (Task 5).
