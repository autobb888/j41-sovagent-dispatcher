# Polish review fixes — design

**Date:** 2026-09-05
**Status:** implementing
**Against:** uncommitted world-bootstrap polish on `1e46c96` / 2.37.1
**Source:** review `/tmp/grok-mainn/grok-review-38eac378.md` (2 bugs).
Parent spec: `2026-09-05-world-bootstrap-polish-design.md`.

The polish closed the tester’s Darwin docker Next / listings / unpaid-start
paths. Review found two leftover holes of the **same class**. This spec is
only those two. Do not re-open buyer `pay` / `complete` / `review`.

Must not regress: `start` refuse-before-accept on local without
`--dev-unsafe`; TUI Start cannot pass `--dev-unsafe`; job-image preflight;
`HOME_GPU_NO_DISK_QUOTA`; fee-tank LOW vs EMPTY; `DATA_NOT_HIREABLE`; hire
`fail()` exit 1; Darwin docker Next `open -a Docker`; listings default 100;
`jobPaymentReady` on poll / `startJobOrRental` / webhook `job.started`.

---

## Order

1. Doctor Next fallback never English (`firstPasteCommand` + the two known
   null `nextCommand` fails).
2. `setup` / `register --finalize` must not `process.exit(1)` on indexer lag
   after a successful on-chain mint.

---

## 1. Next is argv, never a sentence

**Bug.** `pickNext` (`src/doctor.js:178`) uses
`hit.nextCommand || firstPasteCommand(hit.copyPasteBlock) || 'j41-dispatcher doctor'`.
`firstPasteCommand` (`:169`) skips `#`, `Install `/`Then `/`Open `, and
`Title: rest`. Any other English line is returned as Next.

Live cases this polish did not retarget:

| Fail | `nextCommand` today | copy first line | Next today |
|---|---|---|---|
| Darwin 22 OS (`:344`) | `null` | `macOS 14+ (Sonoma) and Docker Desktop are required…` | that sentence |
| Linux `gpu.storage` (`:632`) | `null` | `Linux NVIDIA hosts only. Do not auto-rewrite daemon.json from install.` | that sentence |

Same failure mode as tester `command not found: Start`. Darwin docker-fail
tests stay green and do not cover these.

**Rules**

`nextCommand` is always a token the operator can paste into the same shell.
Never a sentence. Never `null` on a fail after `pickNext`. Copy-paste prose
stays in `copyPasteBlock`.

1. **Pin the two known fails** (do not rely on the fallback):

   | Fail | `nextCommand` | `copyPasteBlock` |
   |---|---|---|
   | Darwin OS unsupported | `j41-dispatcher doctor` | keep the macOS 14+ prose |
   | Linux `gpu.storage` | `j41-dispatcher doctor` | keep the overlay2/XFS prose (not a pasteable rewrite of `daemon.json`) |

2. **`firstPasteCommand` allowlist.** A line is a command only if, after
   trim, it starts with one of:

   `j41-dispatcher `, `sudo `, `nvm `, `open -a `, `wsl.exe`, `newgrp `,
   `docker `

   Comments (`#`), empty, `Install `/`Then `/`Open `, and everything else
   are skipped. If no line matches: `null` → `pickNext` uses
   `j41-dispatcher doctor`.

   Do not invent a “looks like English” heuristic. Do not exec the line.
   Do not add `Start ` as a command.

3. Keep the docker-fail rewrite: if any `docker.*` is fail and Next would
   be `j41-dispatcher start`, use `j41-dispatcher doctor`.

`formatDoctorTable` already refuses `start` as the printed fallback. Leave
it. The bug is `report.nextCommand` itself.

**Tests** (fail first)

- Darwin 22 (`release: '22.6.0'`), docker present: `report.nextCommand` is
  `j41-dispatcher doctor`. `formatDoctorTable` Next section does not contain
  `macOS 14+` or `Start Docker`. Copy-paste may still contain the macOS 14
  prose.
- Linux overlayfs + compute configured (`gpu.storage` fail): Next is
  `j41-dispatcher doctor`, not `Linux NVIDIA hosts only`.
- Existing Darwin no-CLI / ENOENT sock / win32 no-CLI tests stay:
  `open -a Docker` / `wsl.exe -e docker info`.
- Unit: `firstPasteCommand('Linux NVIDIA hosts only.\nopen -a Docker')`
  returns `open -a Docker`.
  `firstPasteCommand('macOS 14+ (Sonoma) and Docker Desktop are required.')`
  returns `null`.

Export `firstPasteCommand` if the unit test needs it (already a sibling of
`pickNext`).

---

## 2. `setup` must not fail the mint on indexer lag

**Bug.** Spec said: after successful `agent.register`, indexer-lag
`registerWithJ41` retries 3×/5s and must **not** `process.exit(1)`; leave
profile registration for `finalize`.

What shipped: only the **direct** `registerWithJ41` in `register` / `setup`
is wrapped (`cli.js` ~1748 / ~3737). `retryRegisterWithJ41` never throws, so
those sites print `INDEXER_LAG_HINT` and continue.

Then:

- `setup` **always** runs SDK `finalizeOnboarding` (`cli.js` ~3775).
- SDK `finalize.ts:498` calls `registerWithJ41` again with no retry.
  Non-401 errors are rethrown. `Invalid request format` is not 401.
- `setup` catch (`cli.js` ~3785) prints `Setup INCOMPLETE` and
  `process.exit(1)`.
- `register --finalize` runs `finalizeOnboarding` inside the mint `try`
  (`cli.js` ~1781). The same 400 is caught as `Registration failed` and
  `process.exit(1)` (`:1802`) even though the identity is on-chain.

README recommended path is `setup`. Standalone `register` (no `--finalize`)
is already correct.

Do **not** patch `@junction41/sovagent-sdk`. Wrap at the CLI.

**Rules**

Define one outcome for “mint succeeded, platform profile not indexed yet”:

- Print `INDEXER_LAG_HINT` (existing, with the real `<agent-id>`).
- Do **not** `process.exit(1)`.
- Do **not** print `Setup INCOMPLETE` (that banner is for a failed on-chain
  VDXF write / no UTXOs — F1).
- Do **not** print `Setup Complete` either. Print that the identity is
  on-chain and `finalize` is the next command.
- Exit 0.

Concrete:

1. **`setup` step 3 indexer-lag → skip step 4.** If
   `retryRegisterWithJ41` returns `{ ok: false, indexerLag: true }`, do not
   call `finalizeOnboarding`. Hint + exit 0. Identity keys stay written.

2. **`setup` step 4 indexer-lag after a successful VDXF write → warn, exit 0.**
   Around `finalizeOnboarding`, if the throw is `isIndexerLagError`, print
   the hint and exit 0. Real VDXF failures (no UTXOs, broadcast reject,
   `publishVdxf` throw that is not lag) stay `Setup INCOMPLETE` + exit 1.
   Do not classify by `/invalid request format/` on every finalize error —
   only `isIndexerLagError(err)`.

3. **`register --finalize`.** If step-3 profile was indexer-lag, skip
   `finalizeOnboarding` (same as setup). If `finalizeOnboarding` throws
   `isIndexerLagError`, catch it **before** the mint `catch` that calls
   `process.exit(1)`. Hint + exit 0. Mint timeout / chain register failure
   still exit 1.

4. **Standalone `finalize`.** Unchanged: indexer lag on a later
   `registerWithJ41` inside the SDK still fails the command (operator
   asked to finalize; retry is the recovery). Optional same-catch warn is
   **out of this spec** — do not weaken `finalize` exit 1 without a test
   that the VDXF write already landed.

5. Do not wrap `registerService` in the retry helper. Service 400 is not
   this bug.

**Tests** (fail first)

- Helper already covers 3× retry. Add CLI/source pins:
  - `setup` action: if the profile `retryRegisterWithJ41` result is
    indexer-lag, the step-4 `finalizeOnboarding` call is skipped
    (source-order or a small extracted `shouldSkipFinalizeAfterProfileLag`).
  - Extracted function is enough if wiring `cli.js` 9k is painful:

    ```
    planOnboardingAfterProfile({ mintOk, profile }) →
      { runFinalize, exitCode, hint }
    mintOk true, profile { ok:false, indexerLag:true } →
      runFinalize false, exitCode 0, hint INDEXER_LAG_HINT
    mintOk true, profile { ok:true } → runFinalize true
    mintOk true, profile { ok:false, indexerLag:false } →
      runFinalize true (existing: still try finalize / existing warn)
    ```

    `setup` and `register --finalize` both call it.

- `isIndexerLagError` on a `finalizeOnboarding` throw with
  `Invalid request format` is true; on `VDXF publish skipped: … no
  spendable UTXOs` is false.
- Existing hire / doctor Darwin tests stay green.

No live chain. No 5s sleeps (`NODE_ENV=test` already zeros default delay).

---

## Out of scope

- Backend 409 `IDENTITY_NOT_INDEXED` (ask list already sent).
- Buyer `pay` / `complete` / `review`.
- Changing SDK `finalize.ts`.
- Making `finalize` itself exit 0 on lag.
- Home-gpu `assertPaidBeforePaidProvision` unpaid acquire (start is gated).

---

## Operator copy until shipped

- `setup` on a fresh identity may still print `Setup INCOMPLETE` + exit 1
  if the indexer is slow. Workaround: `register` then wait then `finalize`.
- `doctor` on macOS 13 / Linux overlayfs GPU: do not paste the Next
  sentence; run `j41-dispatcher doctor` after upgrading OS / fixing
  storage.
