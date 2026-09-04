# Onboarding 2.0 leftovers — design

**Date:** 2026-09-04  
**Status:** implementing (operator: spec then do then audit)  
**Source:** `ONBOARDING-TEST-1.0.md` (closed) + `ONBOARDING-TEST-2.0.md` (2.37 retest)

2.37.0 fixed the advertised two-liner **when Node 22 and Docker already exist**.
This pass closes the leftovers the tester still hit on 2.37.0. It does not
re-open frozen `j41-dispatcher@2.0.0`, the 404 clone, or silent `runtime=local`.

Must not regress: `start` refuse-before-accept on local without `--dev-unsafe`;
TUI Start cannot pass `--dev-unsafe`; job-image preflight; `HOME_GPU_NO_DISK_QUOTA`.

---

## Order

1. Fee-tank LOW vs EMPTY + doctor snapshot wiring (health lies today)
2. CLI `start` writes `~/.j41/dispatcher/dispatcher.log` (changelog lie)
3. Alias nested `job-agent.js` visible to `@junction41/secure-setup` canary self-test
4. `hire` failure paths exit 1 (reproduce, then pin)
5. Clean-VM installer proof (containerized Ubuntu 24.04, fail-closed Docker)

Out of scope: minting sovdata/sovmodel; labour LLM; rewriting `daemon.json`;
publishing npm; `inspect` “No services registered”.

---

## 1. Fee-tank honesty

**Bug.** `planFeeSweep` returns `needs-external-funding` whenever the tank is
below the 100-write floor **and** `sweepableSats <= 0`, including 32 writes.
`checkFeeTanks` logs `FEE TANK EMPTY` and sets `_agentErrors`. After
`startupComplete`, `/health` degrades on any `lastError`. Doctor already
classifies `writes: 32` as `low` **if** `feeTankRows` is passed; CLI/TUI doctor
never load `fee-tank-status.json`, so they print `no snapshot yet` while
`wallet` shows 32.

**Rules**

| writes | sweepable | reason | log | `_agentErrors` | doctor |
| --- | --- | --- | --- | --- | --- |
| 0 | 0 | `needs-external-funding` | EMPTY | set | fail empty-unfunded |
| 0 < n < floor | 0 | `below-floor-unfunded` | LOW (`n/floor`) | **not** set (retract EMPTY) | warn low |
| n < floor | ≥ min sweep | `below-floor` (sweep) | sweep line | unchanged | low until snapshot |
| n ≥ floor | * | `above-floor` | silent / recover | retract EMPTY | pass |

**Doctor load.** `runDoctor` auto-loads `~/.j41/dispatcher/fee-tank-status.json`
when `feeTankRows` is omitted. Malformed file → treat as missing (warn, do not
throw). TUI doctor uses the same loader.

**Not EMPTY:** 32 writes is LOW. Health must not degrade from a LOW tank.

---

## 2. CLI dispatcher.log

**Bug.** Changelog 2.37: Start logs to `~/.j41/dispatcher/dispatcher.log`. TUI
Start redirects child stdio there. CLI `j41-dispatcher start` (what the tester
ran) never creates the file.

**Rule.** The `start` action always opens that path (`0700` dir, `0600` file,
`O_APPEND|O_CREAT|O_NOFOLLOW`). If stdout/stderr is already that inode (TUI
spawn), do not tee (no duplicate lines). Otherwise tee stdout+stderr to the
file **and** keep the terminal. Skip attach when `NODE_ENV=test`.

---

## 3. Alias canary path

**Bug.** `@junction41/secure-setup@0.3.0` looks only at
`$(npm prefix -g)/lib/node_modules/@junction41/dispatcher/src/job-agent.js`
(plus a few hardcoded prefixes). Unscoped `j41-dispatcher` nests the scoped
package: `…/j41-dispatcher/node_modules/@junction41/dispatcher/src/job-agent.js`.
Self-test `canary-injection` fails 8/10. We do not ship a new secure-setup in
this pass.

**Rule.** Before first-run `setup` / `quickCheck`, dispatcher resolves
`job-agent.js` from its own `__dirname` (the running CLI **is** the scoped
package even under the alias) and, if none of secure-setup’s search paths
exist, creates a **symlink** at
`$(npm prefix -g)/lib/node_modules/@junction41/dispatcher` → package root.
Never overwrite a real directory. Failure to symlink is a warning, not a start
refusal. `require.resolve` / nested alias paths are also tried.

---

## 4. hire exit codes

**Claim.** Tester: unregistered buyer and compute-without-`--service` print
correct copy and **exit 0**. Live `fail()` is `process.exit(1)`.

**Rule.** Pin with subprocess tests: local keys without `identity` →
`BUYER_NOT_REGISTERED`, human path, **status 1**. Missing `--amount` →
non-zero. If a path still exits 0, set `process.exitCode = 1` in `fail()`
before `process.exit(1)`. Do not change success or “Cancelled.” (`exit 0`).

---

## 5. Clean-VM installer

**Gap.** `install.sh` is unproven on stock Ubuntu 24.04. We will not claim a
bare-metal VM we did not run.

**Rule.** Automated `docker run ubuntu:24.04` with curl/ca-certificates/xz-utils
only (no Node, no Docker engine inside the guest): `J41_SKIP_NPM=1` must
install Node **v22.19.0** at `~/.local/node`, must **not** write `runtime=local`,
must **exit 1** on missing Docker, must print the sudo docker block. Skip the
container test only when the host has no Docker. Existing `install-sh.test.js`
guards stay.

---

## Copy

Start banner `Registered agents: N` → `formatIdentitySummary` (same as `status`).
