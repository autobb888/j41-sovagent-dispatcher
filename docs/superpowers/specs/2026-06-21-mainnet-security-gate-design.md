# Broker Default-On + Mainnet Security Gate — Design

**Date:** 2026-06-21
**Status:** Approved (design); pending implementation plan
**Component:** `@junction41/dispatcher` — `src/cli.js` + new `src/mainnet-guard.js`

## Problem

The launch-readiness review found the dispatcher's strongest protections are opt-in with no enforcement on mainnet:

1. **The signing broker defaults OFF** (`cli.js:31`: `process.env.J41_SIGNING_BROKER === '1'`). The broker keeps the agent WIF on the host; without it the WIF is mounted into a prompt-injectable, network-egressing container that can sign arbitrary transactions and drain the key. The secure mode being opt-in is backwards.
2. **No mainnet enforcement.** Every insecure escape hatch (`J41_ALLOW_INSECURE_WIF_MOUNT`, `--dev-unsafe`, `J41_DISABLE_BWRAP`, `J41_ALLOW_LOCAL_UPSTREAM`, `J41_SKIP_STATUS_CHECK`, `J41_ALLOW_LEGACY_REVOKE`) is reachable on `network === 'verus'` with only a warning string. On mainnet these risk real funds, irreversibly.

## Goal

- Make the signing broker the **default** (on unless explicitly disabled).
- Add a **fail-closed mainnet gate**: on `network === 'verus'`, the dispatcher refuses to start if any insecure hatch is set, naming the offending flag(s).
- Keep testnet (`verustest`) workflows unchanged: broker still defaultable-off there, insecure hatches still allowed for dev/debug.

Non-goals: changing the broker mechanism itself; touching the HTTP control API; altering testnet behavior beyond the broker default.

## Security rationale

Mainnet = real VRSC, irreversible transactions. The WIF-in-container path (audit C3) is catastrophic there: a prompt injection in a job container with network egress can sign and spend. The gate makes the insecure paths impossible to enable on mainnet *at startup* (not mid-job), and the broker becomes the only signing path. `IS_MAINNET` is derived from config (`cfg.platform.network`), not an env var, so it cannot be spoofed at runtime to bypass the gate.

## Architecture

### A. Broker default ON — `src/cli.js:31`

```js
// before
const SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER === '1';
// after
const SIGNING_BROKER_ENABLED = process.env.J41_SIGNING_BROKER !== '0';
```

Broker is on by default everywhere. Opt out only with explicit `J41_SIGNING_BROKER=0` (which is itself a mainnet-gated hatch — see C). Update the comment to reflect default-on.

### B. Mainnet detection — `src/cli.js` (near `J41_NETWORK`, ~line 63)

```js
const IS_MAINNET = J41_NETWORK === 'verus';
```

Derived from `cfg.platform.network` (config, not env) so it can't be faked at runtime.

### C. Mainnet gate — new pure module `src/mainnet-guard.js`

```js
'use strict';

/**
 * List insecure flags that must not be set when running on mainnet.
 * Pure: depends only on its arguments. Returns [] when safe.
 * @param {object} env  - process.env (or a test double)
 * @param {{devUnsafe?: boolean}} opts - parsed start options
 * @returns {string[]} human-readable violation messages (empty = safe)
 */
function findMainnetSecurityViolations(env, opts) {
  const v = [];
  if (env.J41_SIGNING_BROKER === '0') v.push('J41_SIGNING_BROKER=0 — broker signing disabled; the agent WIF would be mounted into the job container');
  if (env.J41_ALLOW_INSECURE_WIF_MOUNT === '1') v.push('J41_ALLOW_INSECURE_WIF_MOUNT=1 — mounts the agent WIF into a prompt-injectable container');
  if (opts && opts.devUnsafe) v.push('--dev-unsafe — local mode with zero container isolation');
  if (env.J41_DISABLE_BWRAP === '1') v.push('J41_DISABLE_BWRAP=1 — disables the bwrap entrypoint sandbox');
  if (env.J41_ALLOW_LOCAL_UPSTREAM === '1') v.push('J41_ALLOW_LOCAL_UPSTREAM=1 — disables SSRF protection on the proxy');
  if (env.J41_SKIP_STATUS_CHECK === '1') v.push('J41_SKIP_STATUS_CHECK=1 — skips agent platform-status checks');
  if (env.J41_ALLOW_LEGACY_REVOKE === '1') v.push('J41_ALLOW_LEGACY_REVOKE=1 — accepts replayable legacy revoke webhooks');
  return v;
}

module.exports = { findMainnetSecurityViolations };
```

`cli.js` `start` action, early (after `ensureDirs()`, before agent/poll setup):

```js
const { findMainnetSecurityViolations } = require('./mainnet-guard.js');
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
```

### D. WIF-mount gate hardening (defense-in-depth) — `src/cli.js:5421`

```js
// before
const ALLOW_INSECURE_WIF = process.env.J41_ALLOW_INSECURE_WIF_MOUNT === '1';
// after
const ALLOW_INSECURE_WIF = process.env.J41_ALLOW_INSECURE_WIF_MOUNT === '1' && !IS_MAINNET;
```

Even if the per-job path were somehow reached on mainnet, the insecure ack is never honored — broker is the only signing path. (The startup gate already prevents reaching here, so this is belt-and-suspenders.)

## Error handling

- The gate `process.exit(1)`s with a clear, flag-naming message. Fail-closed: any doubt → don't start.
- `findMainnetSecurityViolations` tolerates a missing `opts` (`opts && opts.devUnsafe`) and reads only string env values; it never throws.
- On testnet (`IS_MAINNET === false`) the gate is skipped entirely — no behavior change.

## Testing

- **`test/mainnet-guard.test.js`** (pure, no mocks): clean env → `[]`; each of the 7 hatches set individually → exactly one violation whose message names the flag; two set → two violations; missing `opts` → no throw; an unrelated env var → `[]`.
- The const flip (A), `IS_MAINNET` derivation (B), and the WIF-gate `&& !IS_MAINNET` (D) are module-level in `cli.js` and are **not** unit-tested (importing `cli.js` has heavy side effects). They are verified by the controller (see below) and by code review.

## Verification (controller, safe — does NOT flip this box to mainnet)

- `npm test` — new guard tests pass; full suite green.
- `node --check src/cli.js src/mainnet-guard.js`.
- **Broker default flip:** restart the dispatcher on testnet **without** any `J41_SIGNING_BROKER` env var and confirm the signer/log shows broker mode engaged by default.
- **Mainnet gate:** verified via the `mainnet-guard` unit tests and code review only. We deliberately do **not** set `cfg.platform.network = 'verus'` on this install (that is real mainnet and unsafe). `IS_MAINNET` derives from config, so the gate cannot be exercised here without actually configuring mainnet.

## Success criteria

- Starting the dispatcher with no broker env var uses broker signing (default-on).
- `findMainnetSecurityViolations` returns the correct violations for every hatch, with flag-naming messages; full unit coverage.
- On mainnet, any insecure hatch makes `start` refuse with a clear gate message (verified by unit tests + code review; not exercised live on this testnet box).
- Testnet behavior unchanged except the broker default; no changes to the HTTP control API.
