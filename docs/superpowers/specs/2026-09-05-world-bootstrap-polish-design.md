# World-bootstrap polish — design

**Date:** 2026-09-05
**Status:** implemented (uncommitted; review-fix follow-on in 2026-09-05-polish-review-fixes-design.md)
**Against:** dispatcher `1e46c96` / npm `@junction41/dispatcher@2.37.1`
**Source:** tester `docs/world-bootstrap-gap-report.md` (2026-09-05,
dispatcher CLI 2.37.1, live `api.junction41.io`, frontend
`junction41.io`). Buyer `j41grokbuyer.agentplatform@`. Seller fleet id
`j41grokseller@` (listed, no service).

This is the **dispatcher first-run / Darwin / listings / register-wait /
unpaid-start** half. Buyer verbs (`pay` / `complete` / `review`) live in
`2026-09-05-buyer-lifecycle-design.md`.

Must not regress: `start` refuse-before-accept on local without
`--dev-unsafe`; TUI Start cannot pass `--dev-unsafe`; job-image preflight;
`HOME_GPU_NO_DISK_QUOTA`; fee-tank LOW vs EMPTY; alias canary symlink;
hire exit 1; GPU fail-closed on overlayfs.

2.37.1 leftovers (EMPTY at 32 writes, CLI no `dispatcher.log`, alias
canary start-only, hire rc) are **closed**. Do not re-open them.

---

## Classification of the tester report

### Dispatcher — this spec

1. Doctor Darwin: Next is not a real command; sock path lie; three GPU skip lines.
2. TUI `[1] View listings (0 local)` is local keys, not the marketplace.
3. `listings --limit` default 20 (API had 27 services).
4. `registerWithJ41` immediately after mint → 400; first-run copy does not say wait.
5. `Failed to refresh identity from chain` on every finalize (warn vs fail).
6. GPU chapter: one English line on macOS, not three “linux NVIDIA chapter”.
7. Unpaid job `accepted` — never **start** work until payment verified.

### Dispatcher — the other spec

Pay later, sequential `--pay`, `complete`, `review`, buyer VDXF, hire copy.

### Not dispatcher (do not spec as our work)

| Hole | Owner |
|---|---|
| Kind-filtered website tabs empty while `/v1/services?kind=model` has duskseek + moonkimi | frontend / dashboard query |
| “All SovAgents 0” vs 24 agent-type services | frontend |
| Trending repeats the same agent | frontend |
| Review canonical message `Junction41 Review` not `J41-…` | backend |
| Indexer 400 on fresh identity instead of retryable 409 | backend |
| UTXO endpoint re-lists spent outputs until confirm | backend (we still stamp pending) |
| `getJobWitness` only after `completed`; no buyer-directed inbox `job_record` | backend |
| `GET /v1/me/privacy` 404 | backend |
| Frontend Sign In / Hire / Pay / Chat / Review | frontend (tester did not sign in) |
| Sovdata browse payload on the website | frontend (CLI already browse-only) |
| Windows `install.ps1` / Ubuntu bare-metal `curl \| bash` | already a 2.37.1 container smoke; bare-metal is the tester’s next wipe, not this spec |
| Encrypted keystore, jailbox, dispute, bounty, webhook mode | existing features, not this report’s dispatcher holes |

### Already true on 2.37.1 — do not “fix”

- `DATA_NOT_HIREABLE` for pippinapples.
- `submitReview` refuse-closed on non-`J41-` (keep).
- Mac cannot sell Cat-1 GPU (Linux NVIDIA only) — copy only, do not invent a Mac jail.
- `j41grokseller@` has a platform profile and **no service** — cannot be hired. Operator must `registerService` / TUI Configure Services. Doctor already warns LLM unconfigured. No code change except maybe copy on `start` when an agent has zero services (optional, below).
- Labour `start` refuse without LLM key.

---

## Order

1. Doctor Next / sock / GPU one-liner (tester said patched locally, **not** on npm 2.37.1).
2. TUI `[1]` label.
3. `listings` default + TUI browse limit.
4. Register / finalize wait copy (+ bounded retry).
5. Unpaid: never `startJobOrRental` unless paid.

Happy-path script (doctor → build-image → register → wait → finalize →
hire --pay → wait confirm → complete → review) is **documentation** in
this pass, not a new binary. Review still blocked on backend `J41-`.

---

## 1. Doctor Darwin / copy-paste is a real command

**Bugs (live on 2.37.1)**

- `docker.cli` fail on darwin/win32 sets `nextCommand: null`.
  `formatDoctorTable` then prints `Next: j41-dispatcher start`
  (`report.nextCommand || 'j41-dispatcher start'`). Tester ran Next and
  got `command not found: Start` when the English hint was used as a
  command (`Start Docker Desktop…`).
- `pickNext` on a docker fail with null `nextCommand` still returns that
  null. English belongs in `copyPasteBlock` **and** `nextCommand` must be
  a real argv.
- Sock pass/fail on darwin can still print `/var/run/docker.sock`. Real
  Desktop sock is `unix://$HOME/.docker/run/docker.sock`. Candidates
  already exist in `dockerCandidates()`; the printed detail does not use
  them on ENOENT.
- `formatDoctorTable` includes skip rows whose id starts with `gpu.`,
  then adds a third `GPU skipped (linux NVIDIA chapter)` on non-linux.
  Tester saw three linux-NVIDIA lines on macOS.

**Rules**

`nextCommand` is always a command the operator can paste into the same
shell. Never `null` on a fail. Never English (`Start Docker Desktop`).
Never `j41-dispatcher start` when any `docker.*` check is fail.

| Fail | `nextCommand` | `copyPasteBlock` |
|---|---|---|
| darwin, no Docker CLI | `open -a Docker` | Install URL + `open -a Docker` + wait until `docker info` works |
| darwin, CLI present, daemon/sock ENOENT | `open -a Docker` | `open -a Docker` then `docker info` |
| win32, no CLI / daemon down | `wsl.exe -e docker info` | Install Docker Desktop with the WSL2 backend. Start it, then retry `wsl.exe -e docker info`. Never `Start Docker Desktop` as argv. |
| linux, no CLI | `sudo apt install docker.io` (unchanged) | distro block unchanged |
| linux EACCES | `newgrp docker` (unchanged) | unchanged |

Sock detail:

- darwin: print the first existing candidate, else the first candidate
  path (`$HOME/.docker/run/docker.sock`), never a hardcoded
  `/var/run/docker.sock` as if it were the Desktop default.
- linux: keep `/var/run/docker.sock`.
- `dockerAdviceFromError` eacces message on darwin must not claim
  `/var/run/docker.sock` / group docker.

GPU table on non-linux: **one** line:

```
  GPU                skipped (Linux NVIDIA hosts only — Mac/Windows cannot sell Cat-1)
```

Do not emit `gpu.nvidia` / `gpu.storage` skip rows in the human table on
darwin/win32. JSON `--json` may still include those checks as `skip` for
stability of `CHECK_IDS`.

`pickNext` when the first fail has no `nextCommand` must not fall through
to `j41-dispatcher start`. If we ever miss a nextCommand, use the
copyPasteBlock’s first line, then `j41-dispatcher doctor` — never start.

**Tests**

- darwin, no docker CLI: `nextCommand` matches `/open -a Docker/`;
  formatted Next line does not contain `j41-dispatcher start`;
  formatted table does not contain `Start Docker Desktop` as the Next
  command (it may appear inside Copy-paste prose).
- darwin, ENOENT sock: sock detail contains `.docker/run/docker.sock`,
  not only `/var/run/docker.sock`.
- darwin GPU human table: exactly one `GPU` line; not three
  `linux NVIDIA chapter` lines.
- linux EACCES / missing CLI tests stay green.

---

## 2. TUI `[1]` is the local fleet, not marketplace listings

**Bug.** `dashboard.js` choices: `[1]  View listings (${formatIdentitySummary})`
with `value: 'agents'`. `formatIdentitySummary([])` is `0 local`. Tester
read this as J41 marketplace listings.

Marketplace browse is already `Hire a listing` under Marketplace.

**Rule.** Label:

```
[1]  View agents (<identity summary>)
```

`0 local` is correct for **no keys on this machine**. Keep
`formatIdentitySummary`. Do not fetch `/v1/services` for this row.

Test: dashboard source matches `/View agents \(/` and does not match
`/View listings \(/`.

---

## 3. Listings default shows the live marketplace

**Bug.** CLI `listings --limit` default `'20'`.
`fetchMarketplaceListings` clamps 1..100, default 20. TUI hire browse
uses `limit: 24`. Live API 2026-09-05: 27 services. Local clone that
paginated to 27/27 was not npm 2.37.1.

Human output already prints `N shown / total`.

**Rule.**

- Default `--limit` **100** (the existing clamp max). 27 services fit.
- TUI hire browse uses the same default (pass no limit, inherit 100).
- If `meta.total` > rows.length, keep `N shown / total` and print
  `listings --limit 100` is already the max this CLI fetches. Do not
  silently drop rows without the total line.
- Do not add offset pagination in this pass unless `--limit 100` still
  hides rows in tests against a stub with `total: 27`. If a stub with
  limit 100 returns 27, we are done.

Kind filter stays CLI `--kind`. Empty website tabs are not our bug.

---

## 4. Register / finalize wait

**Bug.** `registerWithJ41` immediately after on-chain mint →
`Invalid request format` (indexer lag). Operator lucked into retry via
`finalize`. First-run README / register stdout does not say wait.
`Failed to refresh identity from chain` on every finalize after a
successful VDXF write — noisy, looks like failure.

**Rules**

On `registerWithJ41` failure whose message matches `/invalid request format/i`
or HTTP 400 right after mint:

- Do **not** print a bare warning that looks like a broken profile.
- Print: `Platform indexer has not caught the new identity yet. Wait ~30s
  then: j41-dispatcher finalize <agent-id>`
- Bounded retry inside the same `register` / `setup` invocation: 3
  attempts, 5s apart. If all fail, exit 0 from the mint (identity is
  on-chain) but leave profile registration for `finalize`. Do not
  `process.exit(1)` on indexer lag after a successful `agent.register`.

On finalize, if the on-chain VDXF write succeeded and identity refresh
fails: **warn** `Could not refresh identity from chain (indexer). On-chain
write succeeded — inspect later.` Do not fail the command. If we cannot
tell write vs refresh apart without an SDK change, classify by existing
log strings; do not weaken a real write failure.

README first-run: after `register`, `wait until doctor identities are
on-chain, then finalize`. One sentence. No new wizard.

---

## 5. Unpaid job must not start work

**Live.** Compute `0339ee78-…` went `accepted` **without** payment. Paid
twin `423cd09c-…` sat `requested` until later `delivered`. Tester:
“Hire gate is wrong if unpaid work starts.”

**What 2.37.1 already does**

- Poll **accepts** unpaid jobs, then waits (`pendingPayment`) until
  `isPaid` before `startJobOrRental`.
- `isPaid` = `in_progress` OR `payment.verified` OR
  `payment.status` in `{confirmed,completed}` OR
  (`J41_ALLOW_UNPRICED_JOBS=1` AND no payment object).
- Bare `accepted` + missing payment object no longer starts work (M8).
- `accept-job` CLI signs accept and says “awaiting buyer payment” —
  stacked accept is intentional.

**Rule.** Keep stacked accept. **Never** call `startJobOrRental` (labour
container or gpu-jail) unless `isPaid`. Pin:

- `accepted` + `payment.verified !== true` + status not `in_progress` →
  no start.
- gpu-rental uses the same `isPaid` (already `VAST_PREPAY_REQUIRED` on
  Vast; home-gpu must not acquire/start the jail either).
- Log line for the unpaid accepted job stays `awaiting payment`, never
  `Starting job`.

If a home-gpu path starts the jail on accept-before-pay, that is the
fix. Do not refuse `accept-job` on unpaid jobs (seller may stack).

---

## 6. Seller loop copy (same PR, one log line)

`start` when a finalized agent has zero registered services: one line
`N has a profile but no service — buyers cannot hire it.` LLM warn
already exists. Do not auto-register a service. Do not add a wizard.

---

## Tests the world still needs (we will not claim)

Do not write “anyone can bootstrap” until the **other** spec’s `pay` /
`complete` and the backend `J41-REVIEW|` + frontend kind tabs exist.

This spec, once shipped, unblocks:

- [ ] macOS doctor copy-paste is a real command on npm (not only a local
      tester patch)
- [ ] `listings` default shows 27/27 on the live API shape
- [ ] TUI `[1]` is not mistaken for marketplace listings
- [ ] register → wait → finalize is written on stdout
- [ ] unpaid accepted compute does not spawn a jail

Still not this spec: Ubuntu/Windows install matrix, `/get-id` QR,
website Sign In, API-endpoint as OpenAI client, GPU SSH on a public
tunnel, fee-tank sweep live, happy-path including review.

---

## Operator copy until then

- Darwin Docker: `open -a Docker`, wait for the whale, `j41-dispatcher doctor`.
  Do not paste `Start Docker Desktop` as a shell command. Do not `start`
  without Docker.
- `listings` (after this ships) or `listings --limit 100` now.
- After `register`, wait, then `finalize`. 400 `Invalid request format`
  is indexer lag, not a dead identity.
- Mac cannot sell Cat-1. Labour needs an LLM key. A profile without a
  service cannot be hired.
- Pay two listings: wait a block (or the buyer-lifecycle `PAY_PENDING` gate).
