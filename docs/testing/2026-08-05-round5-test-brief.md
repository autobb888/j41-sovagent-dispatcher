# Round 5 — test brief

**Date:** 2026-08-05
**Live:** dispatcher **2.11.0**, SDK **2.14.1**, MCP 2.2.3 — all on npm.
**Fleet:** 9/9 available, inbox clean, every fee tank funded.
**Runway:** the daily auth outage starts ~04:00 UTC and lasts 50–90 min. **Don't start a
run after ~03:00 UTC** — round 3's wave was swallowed by it and produced no signal.

Read time: 4 minutes.

---

## What changed since round 4

Round 4 ended with agent-6 unable to write anything on-chain and three valid inbox items
wrongly quarantined. Root cause: job payments land at an agent's **i-address**, but
transaction fees are payable only from its **R-address**, and nothing moved funds between
them. The R-address only drains. Three of nine agents had already hit zero.

Three releases came out of that:

- **2.9.0** — agents sweep their own earnings i→R automatically below ~100 writes.
- **2.10.0** — a `wallet` command, because when an agent *can't* self-fund (it has never
  earned, so there's nothing to sweep) there was previously no CLI path at all.
- **2.11.0** — six missing flags added to the mainnet security gate.

Plus a dead-letter classifier fix: a dry wallet is environmental, so it no longer strikes
the items that happen to be queued when it happens.

---

## The three that matter

### 1. A never-earned agent, end to end  ⟵ highest value

This is the path that had no product surface until yesterday, and it's the one a real
operator hits on day one.

`agent-8`, `agent-template-test` and `agent-test-1` are registered-but-unfunded — zero at
both addresses. Pick one and take it all the way:

```bash
j41-dispatcher wallet                                  # note it shows "— never queried"
j41-dispatcher wallet send agent-2 agent-8 0.5         # fund it from a funded agent
j41-dispatcher wallet show agent-8                     # confirm the tank
# then register/finalize it and put a job through it
```

- **PASS:** the table never shows `0.00000000` for an unqueried agent (it must show `—`),
  the send confirms, and the agent can then write on-chain.
- **FAIL / INTERESTING:** any `0` where you expected `—`. That distinction is deliberate —
  "we never looked" must not read as "the tank is empty", because that's how someone sends
  a second unnecessary transfer.

### 2. Let a tank actually run dry

The automatic sweep is the fix for round 4's outage and it has **never fired in anger** —
every agent is currently above the floor, so we've only seen it decline to act.

Force the situation:

```bash
j41-dispatcher start --fee-sweep-floor 200000    # floor above every real tank
```

Now every agent looks "low" and the sweep should fire on the next cycle (or 15s after
startup).

- **PASS:** `[FeeTank] <agent>: N writes left — sweeping X from M i-address UTXO(s)` then
  `✅ swept in <txid>`. The tank grows; `sweepable` goes to 0.
- **PASS also:** agents with nothing to sweep are left alone, not spammed.
- **FAIL:** a sweep that spends **R-address** inputs (it must only ever spend i-address
  ones), or one that runs twice for the same agent before the first confirms.

### 3. A dry tank must NOT quarantine inbox items

The round-4 defect, directly. Point an agent at an empty tank while a review is pending.

- **PASS:** `[Inbox] 💸 <agent>: FEE TANK EMPTY (Nx) — N item(s) stalled, none struck`,
  and `deadLettered` stays **0**. Items resume after funding.
- **FAIL:** any `☠️ DEAD-LETTER` line naming a review/attestation/job_record while the
  tank is empty. That's the exact regression.

---

## Secondary, if the run allows

4. **`wallet --json`** — satoshis must be integers, unqueried agents must be `null` (not
   `0`), and fleet totals must exclude them.
5. **`/health`** — each agent should carry a `feeTank` object, plus `summary.fee_tanks_empty`.
   An empty tank must **not** flip global `status` to degraded (an agent mid-onboarding
   legitimately has one).
6. **TUI `[13] Earnings Summary`** — should now show a tank figure per agent. **This is the
   only part of the release with no automated test** (the TUI can't be driven under
   `node --test`), so eyes on it are genuinely useful.
7. **`--dry-run` on both verbs** — must build and broadcast nothing, and must not write a
   pending stamp.
8. **A real conversation job.** Still true from round 4: most jobs have had zero buyer
   messages, so the executor path is barely exercised. Send several messages before ending.
9. **The mainnet security gate (2.11.0).** Six bypass flags now refuse a mainnet start.
   You can exercise this on testnet **without touching mainnet** — the check is pure:

   ```bash
   node -e "console.log(require('./src/mainnet-guard.js')
     .findMainnetSecurityViolations({J41_ALLOW_UNPRICED_JOBS:'1'},{}))"
   ```

   - **PASS:** each of `J41_DEPOSIT_ALLOW_AUTH_ONLY=1`, `J41_ALLOW_UNPRICED_JOBS=1`,
     `J41_SCAN_BUYER_CHAT=0`, `J41_ALLOW_INSECURE=1`, `J41_LOCAL_SIGNER_TEST_MODE=1`,
     `J41_TRUST_PLATFORM_RESOLUTION=1` yields exactly one violation naming the flag.
   - **PASS equally important:** the *safe* value of each (`=0`, or `=1` for
     `SCAN_BUYER_CHAT`) yields **zero** violations. A gate that fires on a safe value is
     worse than the gap — it teaches operators to switch it off.
   - **Do not** try this by pointing a real deployment at mainnet.

---

## Expected, not bugs

- **`— means never queried, NOT zero`** in the wallet footer. Deliberate.
- **A second `wallet` command refusing with "a wallet transaction is recorded as
  unconfirmed"** — the double-spend guard. It clears itself once the tx confirms; `--force`
  overrides. Only report it if it persists *after* confirmation.
- **`Transaction rejected by the network` right after startup** — `activate-all` and the
  startup activation pass write the same identities outside the pending-write gate.
  Harmless.
- **Several deletion attestations for one job** if it pauses and respawns — backend
  confirmed `POST /v1/me/attestations` is idempotent per container.

---

## Where I'd expect breakage

Ranked, and honest about what's thin.

1. **The TUI earnings screen (item 6).** Zero automated coverage. The formatting and the
   arithmetic were verified in isolation; the screen itself has never been rendered.
2. **The automatic sweep firing for real (item 2).** Proven manually and in unit tests,
   but the daemon's unattended path has only ever *declined* to sweep on this fleet.
3. **`wallet send` on a fresh install with encrypted keys.** The keystore-unlock guard is
   wired the same way as every other key command, but the encrypted path specifically is
   untested for `wallet`.
4. **Concurrent `wallet` invocations.** There's now a per-agent lock, but it has only unit
   coverage — two real terminals racing has never been tried.
5. **The daemon-busy check.** `wallet` tries to detect an in-flight identity write via the
   control socket and defer. That code has **never run live** — the pid file wasn't present
   in any test. If you see a spurious "another wallet command is spending", that's it.

---

## Reference

```bash
# fleet money at a glance
j41-dispatcher wallet

# watch the interesting lines
tail -f <log> | grep -E "FeeTank|FEE TANK|item\(s\) accepted|DEAD-LETTER|swept"

# health incl. fee tanks
curl -s http://127.0.0.1:9842/health | jq '.summary, .agents[] | {id, feeTank}'
```

Tests: 786 passing (669 before this work).

**One caution.** `wallet sweep` and `wallet send` broadcast irreversible transactions.
Use `--dry-run` first when you're unsure — but note the tool says so itself: *a successful
build proves nothing; the signer will happily sign what the daemon rejects*. Only a
broadcast settles it. That's testnet money, so the cost of finding out is zero.
