# Upgrade checklist (2.8.x → 2.11.x)

**Why this is a checklist and not a test suite.**

An automated upgrade test needs a *realistic* old install to upgrade — one with
queue state, seen-jobs, finalize-state. Producing that means registering agents,
which means chain writes and real money. Without it a 2.8.x sandbox `start` exits
at "no agents registered" before writing any state, so the fixture would have to
be hand-authored — at which point the test is checking synthesized files rather
than a real upgrade, while also depending on npm being reachable. The honest
version is this: run it once per release, against a real install.

Run through it before telling anyone to upgrade.

---

## What actually changed since 2.8.x

New on-disk state (a 2.8.x install has none of it, and none is required):

| path | purpose | absent is fine? |
|---|---|---|
| `agents/<id>/wallet-pending.json` | wallet double-spend guard | yes — created on first send |
| `refund-locks/*.inflight.json` | crash-safe refund intent | yes |
| `seen-jobs.json` | now written atomically | yes — existing files read normally |
| `master-key.json` | at-rest encryption (opt-in) | yes |

New config, all optional:

```toml
[fee_sweep]
enabled = true          # default when the section is absent
floor_writes = 100
interval_ms = 1800000   # 30 min
```

**Verified:** a config with no `[fee_sweep]` section resolves to
`enabled: true, floorWrites: 100, intervalMs: 1800000`. An upgrading operator
gets the sweep switched on with sane defaults and no edit required.

Renamed env var: `J41_FEE_SWEEP_INTERVAL` → **`J41_FEE_SWEEP_INTERVAL_MS`**. The
old name is now ignored silently. If you set it, update it.

Six flags newly refused on **mainnet** (2.11.0): `J41_DEPOSIT_ALLOW_AUTH_ONLY`,
`J41_ALLOW_UNPRICED_JOBS`, `J41_SCAN_BUYER_CHAT=0`, `J41_ALLOW_INSECURE`,
`J41_LOCAL_SIGNER_TEST_MODE`, `J41_TRUST_PLATFORM_RESOLUTION`. **A mainnet
deployment setting any of these will refuse to start.** That is deliberate.
Testnet is unaffected.

---

## Before upgrading

- [ ] `j41-dispatcher --version` — record the version you are coming from
- [ ] `cp -a ~/.j41 ~/.j41.backup-$(date +%F)` — a real backup, not a snapshot in your head
- [ ] `j41-dispatcher wallet --json > /tmp/pre-upgrade-wallet.json` (2.11.0+ only;
      on 2.8.x record balances however you can)
- [ ] `curl -s localhost:9842/health > /tmp/pre-upgrade-health.json`
- [ ] `ctl inbox` — confirm `pendingWrites` is empty. Upgrading mid-write means the
      restart loses the in-memory pending-write gate.
- [ ] Stop the dispatcher cleanly and confirm the process is gone
- [ ] Check the clock: **not within 45 minutes of 04:00 UTC** (the platform's daily
      auth outage), or a failed start will be blamed on the upgrade

## Upgrade

- [ ] `yarn global upgrade @junction41/dispatcher` (or `npm i -g @junction41/dispatcher@latest`)
- [ ] `j41-dispatcher --version` shows the new version

## After upgrading, before starting

- [ ] `j41-dispatcher status` — agent count unchanged
- [ ] `j41-dispatcher wallet` — every agent's tank matches the pre-upgrade record.
      Unregistered agents must show `—`, **never `0.00000000`**.
- [ ] If keys were encrypted: `J41_KEYS_PASSPHRASE=… j41-dispatcher wallet` unlocks.
      *(If it does not, stop and restore the backup — do not run `encrypt-keys`.)*
- [ ] `j41-dispatcher inspect <agent>` on one agent — on-chain identity intact
- [ ] No new files in `~/.j41/dispatcher/` other than those in the table above
- [ ] Nothing named `*.corrupt.*` appeared — that means a state file failed to parse

## Start

- [ ] `j41-dispatcher start`
- [ ] Startup shows `Fee-tank sweep: every 30min, floor 100 writes` (or your config)
- [ ] `✅ Startup complete`
- [ ] `curl -s localhost:9842/health | jq '.status, .summary'` — `ok`, and
      `poll_cycles_skipped` / `fee_tank_cycles_skipped` are `0`
- [ ] Each agent carries a `feeTank` object within ~1 minute
- [ ] Diff against `/tmp/pre-upgrade-health.json`: agent count and availability unchanged
- [ ] Watch one full poll cycle for unexpected errors

## Rollback

Downgrading is **one-way-ish** and untested end to end. If you must:

- [ ] Stop the dispatcher
- [ ] `npm i -g @junction41/dispatcher@<old-version>`
- [ ] **Delete `agents/*/wallet-pending.json` and `refund-locks/*.inflight.json`** —
      older versions do not know about them and will not clean them up
- [ ] A `[fee_sweep]` section in `config.toml` is ignored by older versions; harmless
- [ ] If anything looks wrong, restore `~/.j41.backup-*` wholesale

**The one thing rollback cannot undo:** agents that swept i→R while on 2.11.x have
their earnings in the R-address now. That is correct and permanent, and older
versions handle it fine — they simply will not top the tank up again.

---

## If the upgrade goes wrong

Restore the backup, restart on the old version, and report:

- both version numbers
- the startup log
- `/health` before and after
- anything named `*.corrupt.*` in `~/.j41/dispatcher/`
