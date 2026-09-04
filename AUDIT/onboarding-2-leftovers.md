# Audit — onboarding-2 leftovers

**Date:** 2026-09-04  
**Domain:** tester 2.37.0 leftovers (fee-tank copy, CLI log, alias canary, hire rc, installer smoke)  
**Mode:** read-only of the implementation just landed. Claims in `AUDIT/onboarding-2-leftovers-claims.md`.

## Findings (severity order)

| Sev | ID | Finding | File:line | Trigger | Proposed fix (not applied) |
| --- | --- | --- | --- | --- | --- |
| med | O2-1 | Canary workaround ran only inside `j41-dispatcher start`. | ~~`cli.js` start-only~~ **FIXED** — scoped `scripts/postinstall.js`, alias `bin/postinstall.js`, TUI `securityScreen` before `selfTest`. secure-setup 0.3.0 still hardcodes paths; we satisfy them. |
| low | O2-2 | Empty dest dir blocked the symlink (`dest-exists`). | ~~`job-agent-path.js` dest-exists~~ **FIXED** — empty dir `rmdir` then symlink; non-empty dir still refused. |

No crit/high in this domain.

## Adversarial pass

Shortest untrusted path considered: buyer/job/LLM input cannot reach `planFeeSweep`, `attachDispatcherLog`, or the canary symlink (operator `start` only). Hire fail() is operator CLI.

- **Log symlink:** `O_NOFOLLOW` on `dispatcher.log` — a planted symlink is not followed; start continues without a log. Fail-closed for the file, fail-open for the daemon. Acceptable: logging must not block jobs.
- **Canary symlink:** writes under the invoking user’s npm prefix. Same tree npm would install. No extra secrets. If prefix is root-owned (`/usr/local`), symlink fails closed (warn) and canary still fails — O2-1.
- **Fee-tank:** LOW no longer sets `_agentErrors`, so a 32-write tank cannot degrade `/health` via the `lastError` term (`control.js:548`). EMPTY still can, after `startupComplete`. That is the documented EMPTY alert, not this pass.

## Checked and found clean

- 32 writes / floor 100 is LOW (`below-floor-unfunded`); EMPTY reserved for `feeSats < txFeeSats`.
- Doctor loads `fee-tank-status.json` when `feeTankRows` omitted (the 2.0 “no snapshot yet” bug).
- CLI start tees to `~/.j41/dispatcher/dispatcher.log` unless stdout is already that inode.
- Hire unregistered local keys: subprocess **exit 1** (tester exit 0 not reproduced).
- Ubuntu 24.04 container smoke: Node v22.19.0 + fail-closed Docker, no `runtime=local` (`J41_SKIP_NPM=1`).
- Start banner uses `formatIdentitySummary`.
- Local `--dev-unsafe` refuse, TUI Start, job-image preflight, `HOME_GPU_NO_DISK_QUOTA` not edited.

## Deliberate partials (not findings)

- Container smoke does not run `npm i -g` inside the guest (`J41_SKIP_NPM=1`). npm path remains script + `install-sh.test.js`.
- Not a bare-metal stock Ubuntu VM; docker `ubuntu:24.04` with curl/ca-certificates/xz-utils added.
- `@junction41/secure-setup` itself is not version-bumped (optionalDependency still 0.3.0).
- `hire` compute-without-`--service` still needs a registered buyer + network to print `COMPUTE_REQUIRES_GPU_RENTAL`; not a first-run two-liner path.
