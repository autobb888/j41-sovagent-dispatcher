# Broker Default-On + Mainnet Security Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the signing broker default-on and add a fail-closed mainnet gate that refuses to start the dispatcher on `network='verus'` when any insecure escape hatch is set.

**Architecture:** A new pure, fully-tested `src/mainnet-guard.js` (`findMainnetSecurityViolations(env, opts)`). `src/cli.js` flips the broker default, derives `IS_MAINNET` from config, calls the guard at `start` (exit 1 on violations), and hardens the per-job WIF gate to never honor the insecure ack on mainnet.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-06-21-mainnet-security-gate-design.md`

---

## File Structure

- **Create** `src/mainnet-guard.js` — pure `findMainnetSecurityViolations(env, opts)`. One responsibility: given env + start opts, list insecure flags. No I/O.
- **Create** `test/mainnet-guard.test.js` — unit tests for the guard.
- **Modify** `src/cli.js` — broker default (line 31), `IS_MAINNET` (after line 63), gate call in `start` (after `ensureDirs()`), WIF-gate hardening (line ~5421), and one top-level require.

No other files. No changes to `src/control-api.js` or the HTTP API.

---

## Task 1: pure `findMainnetSecurityViolations`

**Files:**
- Create: `src/mainnet-guard.js`
- Test: `test/mainnet-guard.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/mainnet-guard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { findMainnetSecurityViolations } = require('../src/mainnet-guard');

test('clean env + no opts → no violations', () => {
  assert.deepEqual(findMainnetSecurityViolations({}, {}), []);
  assert.deepEqual(findMainnetSecurityViolations({}, undefined), []); // tolerates missing opts
});

test('unrelated env var → no violations', () => {
  assert.deepEqual(findMainnetSecurityViolations({ HOME: '/x', J41_LOG_LEVEL: 'debug' }, {}), []);
});

test('each hatch individually produces exactly one violation naming the flag', () => {
  const cases = [
    [{ J41_SIGNING_BROKER: '0' }, {}, /J41_SIGNING_BROKER=0/],
    [{ J41_ALLOW_INSECURE_WIF_MOUNT: '1' }, {}, /J41_ALLOW_INSECURE_WIF_MOUNT=1/],
    [{}, { devUnsafe: true }, /--dev-unsafe/],
    [{ J41_DISABLE_BWRAP: '1' }, {}, /J41_DISABLE_BWRAP=1/],
    [{ J41_ALLOW_LOCAL_UPSTREAM: '1' }, {}, /J41_ALLOW_LOCAL_UPSTREAM=1/],
    [{ J41_SKIP_STATUS_CHECK: '1' }, {}, /J41_SKIP_STATUS_CHECK=1/],
    [{ J41_ALLOW_LEGACY_REVOKE: '1' }, {}, /J41_ALLOW_LEGACY_REVOKE=1/],
  ];
  for (const [env, opts, re] of cases) {
    const v = findMainnetSecurityViolations(env, opts);
    assert.equal(v.length, 1, `expected one violation for ${JSON.stringify({ env, opts })}`);
    assert.match(v[0], re);
  }
});

test('multiple hatches → multiple violations', () => {
  const v = findMainnetSecurityViolations(
    { J41_SIGNING_BROKER: '0', J41_DISABLE_BWRAP: '1' },
    { devUnsafe: true },
  );
  assert.equal(v.length, 3);
});

test('broker not set (undefined) is NOT a violation — only the literal "0" is', () => {
  assert.deepEqual(findMainnetSecurityViolations({}, {}), []);
  assert.deepEqual(findMainnetSecurityViolations({ J41_SIGNING_BROKER: '1' }, {}), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/mainnet-guard.test.js`
Expected: FAIL — `Cannot find module '../src/mainnet-guard'`.

- [ ] **Step 3: Write the implementation**

Create `src/mainnet-guard.js`:

```js
'use strict';

/**
 * List insecure flags that must not be set when running on mainnet.
 * Pure: depends only on its arguments; never throws; no I/O.
 * @param {object} env - process.env (or a test double)
 * @param {{devUnsafe?: boolean}} [opts] - parsed start options
 * @returns {string[]} human-readable violation messages (empty = safe)
 */
function findMainnetSecurityViolations(env, opts) {
  const e = env || {};
  const o = opts || {};
  const v = [];
  if (e.J41_SIGNING_BROKER === '0') v.push('J41_SIGNING_BROKER=0 — broker signing disabled; the agent WIF would be mounted into the job container');
  if (e.J41_ALLOW_INSECURE_WIF_MOUNT === '1') v.push('J41_ALLOW_INSECURE_WIF_MOUNT=1 — mounts the agent WIF into a prompt-injectable container');
  if (o.devUnsafe) v.push('--dev-unsafe — local mode with zero container isolation');
  if (e.J41_DISABLE_BWRAP === '1') v.push('J41_DISABLE_BWRAP=1 — disables the bwrap entrypoint sandbox');
  if (e.J41_ALLOW_LOCAL_UPSTREAM === '1') v.push('J41_ALLOW_LOCAL_UPSTREAM=1 — disables SSRF protection on the proxy');
  if (e.J41_SKIP_STATUS_CHECK === '1') v.push('J41_SKIP_STATUS_CHECK=1 — skips agent platform-status checks');
  if (e.J41_ALLOW_LEGACY_REVOKE === '1') v.push('J41_ALLOW_LEGACY_REVOKE=1 — accepts replayable legacy revoke webhooks');
  return v;
}

module.exports = { findMainnetSecurityViolations };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/mainnet-guard.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Lint + commit**

Run: `node --check src/mainnet-guard.js`
Expected: no output, exit 0.

```bash
git add src/mainnet-guard.js test/mainnet-guard.test.js
git commit -m "feat(security): pure findMainnetSecurityViolations guard"
```

---

## Task 2: Wire into cli.js (broker default + IS_MAINNET + gate + WIF hardening)

**Files:**
- Modify: `src/cli.js` (require near line 25; broker const line 31; `IS_MAINNET` after line 63; gate in `start` after `ensureDirs()` ~line 2911; WIF gate ~line 5421)

- [ ] **Step 1: Add the require**

In `src/cli.js`, immediately AFTER the line:

```js
const { defaultExecutors } = require('./broker-executors.js');
```

insert:

```js
const { findMainnetSecurityViolations } = require('./mainnet-guard.js');
```

- [ ] **Step 2: Flip the broker default**

In `src/cli.js`, replace this block:

```js
/** Feature flag: route in-container signing through the host-side broker
 *  instead of mounting the WIF into the container. Default OFF; flip to ON
 *  via env after Docker-validated end-to-end on testnet. See
 *  src/sign-broker.js / src/sign-channel-host.js / src/job-signer.js. */
const SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER === '1';
```

with:

```js
/** Feature flag: route in-container signing through the host-side broker
 *  instead of mounting the WIF into the container. Default ON; opt out only
 *  with an explicit J41_SIGNING_BROKER=0 (testnet only — blocked on mainnet
 *  by the mainnet security gate). See
 *  src/sign-broker.js / src/sign-channel-host.js / src/job-signer.js. */
const SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER !== '0';
```

- [ ] **Step 3: Derive `IS_MAINNET`**

In `src/cli.js`, find:

```js
const J41_NETWORK = cfg.platform.network;
```

and insert immediately AFTER it:

```js
const IS_MAINNET = J41_NETWORK === 'verus';
```

- [ ] **Step 4: Add the gate to the `start` action**

In `src/cli.js`, in the `start` command's `.action(async (options) => {`, find the first two lines of the body:

```js
    ensureDirs();

    const agents = listRegisteredAgents();
```

and replace with:

```js
    ensureDirs();

    // Mainnet security gate (fail-closed): on network=verus, refuse to start
    // if any insecure escape hatch is set. IS_MAINNET comes from config, not env.
    if (IS_MAINNET) {
      const violations = findMainnetSecurityViolations(process.env, { devUnsafe: !!options.devUnsafe });
      if (violations.length) {
        console.error('');
        console.error('  ══════════════════════════════════════════════════');
        console.error('  MAINNET SECURITY GATE — refusing to start');
        console.error('  ══════════════════════════════════════════════════');
        console.error('  These insecure flags are not allowed on mainnet (network=verus):');
        for (const msg of violations) console.error(`  - ${msg}`);
        console.error('');
        console.error('  Unset them, or run on testnet (network=verustest).');
        console.error('');
        process.exit(1);
      }
    }

    const agents = listRegisteredAgents();
```

- [ ] **Step 5: Harden the per-job WIF gate**

In `src/cli.js`, find:

```js
  const ALLOW_INSECURE_WIF = process.env.J41_ALLOW_INSECURE_WIF_MOUNT === '1';
```

and replace with:

```js
  // Defense-in-depth: the insecure WIF mount is never honored on mainnet,
  // even if the startup gate were somehow bypassed.
  const ALLOW_INSECURE_WIF = process.env.J41_ALLOW_INSECURE_WIF_MOUNT === '1' && !IS_MAINNET;
```

- [ ] **Step 6: Syntax-check**

Run: `node --check src/cli.js`
Expected: no output, exit 0.

- [ ] **Step 7: Confirm the edits are present**

Run: `grep -n "SIGNING_BROKER !== '0'\|const IS_MAINNET\|MAINNET SECURITY GATE\|&& !IS_MAINNET\|findMainnetSecurityViolations" src/cli.js`
Expected: 5 matches — the broker default, `IS_MAINNET` definition, the gate header, the WIF `&& !IS_MAINNET`, and the require (plus the gate call also matches `findMainnetSecurityViolations`, so ≥5).

- [ ] **Step 8: Full suite still green**

Run: `node --test test/*.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# fail 0` (count = previous 181 + 5 from Task 1 = 186).

- [ ] **Step 9: Commit**

```bash
git add src/cli.js
git commit -m "feat(security): broker default-on + mainnet gate wiring + WIF hardening"
```

NOTE: do NOT change `cfg.platform.network` to `verus` to test the gate — that is real mainnet and unsafe. The gate logic is unit-tested in Task 1; the live broker-default behavior is verified by the controller in Task 3.

---

## Task 3: Full suite, lint, and broker-default verification (controller-run)

**Files:** none (verification only). The dispatcher restart is operational; controller performs it.

- [ ] **Step 1: Full suite + lint**

Run: `npm test`
Expected: lint clean, all pass. Count = 186, 0 fail.

Run: `node --check src/cli.js src/mainnet-guard.js`
Expected: no output, exit 0.

- [ ] **Step 2: Verify the broker now defaults ON (testnet, no env flag)**

Restart the dispatcher WITHOUT setting `J41_SIGNING_BROKER` (keep `J41_NO_STATUS_TOGGLE=1` so shutdown doesn't deactivate agents):

Run: `J41_NO_STATUS_TOGGLE=1 node src/cli.js start > /tmp/j41-dispatcher.log 2>&1 &`
Wait for `✅ Dispatcher running`.

- [ ] **Step 3: Confirm broker mode is the default**

The signer prints its mode when a job starts (`[SIGNER] mode=broker`). Without a live job, confirm the default another way: the WIF gate no longer throws for lack of a signing mode. Run a focused check that the loaded default is broker:

Run: `node -e "process.env.J41_SIGNING_BROKER=''; console.log('broker default ON =', process.env.J41_SIGNING_BROKER !== '0')"`
Expected: `broker default ON = true` (mirrors the cli.js expression; documents the new default).

Also confirm the dispatcher started cleanly (no WIF-gate refusal at boot):
Run: `grep -iE "Refusing to mount|SIGNER|mode=broker|Dispatcher running" /tmp/j41-dispatcher.log | tail -5`
Expected: `✅ Dispatcher running` present; no "Refusing to mount" error.

- [ ] **Step 4: Confirm mainnet gate logic via the unit tests (not live)**

Run: `node --test test/mainnet-guard.test.js 2>&1 | grep -E "^# (tests|pass|fail)"`
Expected: `# pass 5 # fail 0`. (The gate's live behavior on mainnet is intentionally not exercised on this testnet box.)

---

## Notes for the implementer

- Tasks 1–2 are subagent work. Task 3 is controller-run (it restarts the live dispatcher).
- Do NOT set `cfg.platform.network`/config to `verus`. The mainnet gate is verified by `mainnet-guard` unit tests + code review only.
- `IS_MAINNET` derives from `cfg.platform.network` (config), never from an env var — do not change that.
- The broker default expression is `process.env.J41_SIGNING_BROKER !== '0'` (on unless the literal string `'0'`).
