# Round 6 — test script

**Date:** 2026-08-06
**Live:** dispatcher **2.12.0** (`22170da`), SDK 2.14.1, MCP 2.2.3 — all on npm.
**Fleet:** 9/9 available, inbox clean, all tanks funded.
**Since round 5:** nine releases (2.11.1 → 2.12.0). Mostly bug fixes found by
adversarial review and fault injection; two new commands.

This is a **script**, not a brief — numbered steps, exact commands, explicit
pass/fail. Work top to bottom. **Step 1 is time-critical.**

> ⚠️ **Money.** `wallet sweep`, `wallet send` and `refunds unblock` broadcast
> irreversible transactions. It is testnet, so the cost of a mistake is zero, but
> the *behaviour* is real. Use `--dry-run` when a step says so.

---

## 1. Auth backoff during the 04:00 outage ⟵ DO THIS FIRST, IT IS TIME-BOUND

**Why it matters.** The platform goes `503 CHAIN_SYNCING` most days around
**04:00 UTC** for 50–90 minutes. Until 2.12.0 we had no backoff: every caller
re-authenticated every cycle, ~43 calls/min for 46 minutes, and the platform
eventually answered `429 Too many requests` — a ban that outlasted the outage
that caused it.

**This is the only claim in the release proven solely by simulation.** A real
outage is the proof, and one is due within the hour.

Start watching before 04:00:

```bash
tail -f <dispatcher.log> | grep -E "\[Auth\]|CHAIN_SYNCING|429|Backing off"
```

and sample health every few minutes:

```bash
watch -n 60 'curl -s localhost:9842/health | jq "{auth: .summary.auth_backoff_agents, status: .status}"'
```

- **PASS:** `[Auth] <agent>: platform unavailable … Backing off Ns (failure N)`
  appears, `auth_backoff_agents` rises above 0 during the outage, and — the point
  of the whole change — **no `429` appears anywhere in the log.**
- **PASS also:** within ~5 minutes of the platform recovering, `auth_backoff_agents`
  returns to 0 and jobs flow again. The delay is capped at 5 min precisely so
  recovery is not slow.
- **FAIL:** any `429`; or `auth_backoff_agents` stuck above 0 more than ~10
  minutes after the platform is demonstrably back (check with
  `curl -s https://api.junction41.io/v1/version`).
- **INTERESTING:** log-line volume. Backoff should log the *transition*, not every
  cycle. A flood is a defect even if the backoff itself works.

If no outage occurs today, say so — that is a useful data point too, and this step
carries to round 7.

---

## 2. `refunds unblock` — new command, money, never run live

**Why it matters.** A crash or a dropped connection between broadcasting a refund
and recording it leaves an *intent marker*. The drain then refuses to pay that job
again, because it cannot tell whether the first send landed. `unblock` is the
human override, and it has never been exercised outside unit tests.

There is currently nothing blocked, so create the state:

```bash
# 2a. Confirm the clean baseline
j41-dispatcher refunds list

# 2b. Fabricate a blocked refund. Safe: no money moves, these are two local files.
#     BOTH are needed — the list derives blocked entries from the ledger and
#     annotates them from the marker, so a marker alone shows nothing.
#     (Verified: marker-only prints "No pending refunds".)
mkdir -p ~/.j41/dispatcher/refund-locks

python3 - <<'PYEOF'
import json, os
d = os.path.expanduser('~/.j41/dispatcher')
led = os.path.join(d, 'pending-refunds.json')
cur = json.load(open(led)) if os.path.exists(led) else {}
cur['test-job-xyz'] = {"status": "approved", "refundAmount": 0.5,
                       "buyerAddress": "RTestBuyerAddressForRound6Testing",
                       "orphan": {"currency": "VRSCTEST"}}
json.dump(cur, open(led, 'w'), indent=2)
PYEOF

cat > ~/.j41/dispatcher/refund-locks/test-job-xyz.inflight.json <<'EOF'
{"jobId":"test-job-xyz","at":1785900000000,"pid":99999,
 "buyerAddress":"RTestBuyerAddressForRound6Testing","amount":0.5,"currency":"VRSCTEST",
 "failedAt":1785900001000,"lastError":"socket hang up"}
EOF
chmod 600 ~/.j41/dispatcher/refund-locks/test-job-xyz.inflight.json

# 2c. It must now be visible
j41-dispatcher refunds list

# 2d. Unblock it (this one is safe — the job id is fake, nothing will be sent)
j41-dispatcher refunds unblock test-job-xyz
```

- **PASS (2c):** the list is headed by `⛔ 1 refund(s) BLOCKED`, naming the amount,
  the payee and `last error: socket hang up`, and printing the exact unblock
  command. It must **not** say "No pending refunds".
- **PASS (2d):** it prints the amount, payee and error, warns that unblocking
  allows the refund to be **sent again**, and refuses to proceed until you type
  `yes`. Answering anything else leaves it blocked.
- **FAIL:** the list hides it; or `unblock` clears the marker without an explicit
  confirmation.

**Clean up both files** — the ledger entry outlives the marker:

```bash
rm -f ~/.j41/dispatcher/refund-locks/test-job-xyz.inflight.json
python3 -c "
import json, os
p = os.path.expanduser('~/.j41/dispatcher/pending-refunds.json')
d = json.load(open(p)); d.pop('test-job-xyz', None); json.dump(d, open(p,'w'), indent=2)"
j41-dispatcher refunds list        # must be back to the baseline from 2a
```

---

## 3. The Earnings screen — the only release surface with **zero** automated tests

**Why it matters.** `dashboard.js` runs `main()` on require and needs a TTY, so it
cannot be imported by the test runner. The arithmetic was extracted and is tested;
the *screen* is not. Eyes are the only coverage it has.

```bash
j41-dispatcher dashboard        # then select [13] Earnings Summary
```

> ⚠️ **[7] Start Dispatcher and [8] Stop Dispatcher act the moment you press
> Enter — there is no confirmation.** Arrow keys navigate; the bracketed numbers
> are labels, not shortcuts. Confirm the highlighted row before every Enter.

- **PASS:** every agent shows `Balance:`, `Jobs:` and `Tank:`.
- **PASS (cross-check):** pick one agent and compare its tank against
  `j41-dispatcher wallet` — the figure and write count must match **exactly**.
  They share the same tested function, so a mismatch means the view drifted.
- **PASS (precision):** an agent with small earnings shows real thousandths, e.g.
  `0.005`, not `0.01`. That rounding bug shipped and was fixed in 2.11.6.
- **PASS (null vs zero):** an agent whose lookup fails shows `Tank: (unavailable)` —
  **never `0.00000000`**. Zero means "we looked and it is empty"; unavailable means
  "we could not look". Reading one as the other is how an agent gets funded twice.
- **FAIL:** any crash; any `0.00000000` where `wallet` shows `—`; ESC exiting the
  process instead of returning to the menu.

Full list: `docs/testing/tui-manual-checklist.md`.

---

## 4. `encrypt-keys` — security-critical, only ever tested in a sandbox

**Why it matters.** In a non-TTY it used to print a prompt, read nothing, **exit 0**
and leave every WIF in plaintext. An operator scripting it would believe their keys
were encrypted. Separately, a crash mid-run left a master key plus plaintext
stragglers and the command then refused to run again — plaintext forever.

**Use a scratch HOME. Do not run this against the real fleet.**

```bash
export SB=$(mktemp -d)
HOME=$SB j41-dispatcher init -n 3

# 4a. Non-TTY must refuse loudly
HOME=$SB j41-dispatcher encrypt-keys < /dev/null; echo "exit=$?"

# 4b. Interactive must work
HOME=$SB j41-dispatcher encrypt-keys        # enter a passphrase twice

# 4c. Simulate an interrupted run: put one agent back to plaintext by hand,
#     then confirm the command finishes the job instead of refusing
HOME=$SB J41_KEYS_PASSPHRASE='<your passphrase>' j41-dispatcher encrypt-keys
```

- **PASS (4a):** exit **1**, and it says explicitly that **nothing was encrypted and
  the keys are still plaintext**. Silence or exit 0 is the original bug.
- **PASS (4b):** `🔐 Encrypted 3 agent key file(s)`; the files no longer contain
  `"wif"`.
- **PASS (4c):** it detects the straggler by name and completes it, rather than
  saying "already encrypted".
- **FAIL:** any path where the command reports success while a WIF stays in
  plaintext.

Clean up: `rm -rf $SB`

---

## 5. A never-earned agent, end to end (carried from round 5)

`agent-8`, `agent-template-test` and `agent-test-1` are registered-but-unfunded —
zero at **both** addresses, so they cannot self-fund. This is the day-one path for
a real operator and it is still unexercised.

```bash
j41-dispatcher wallet                              # note the "—" entries
j41-dispatcher wallet send agent-2 agent-8 0.5     # fund from a funded agent
j41-dispatcher wallet show agent-8
# then register/finalize it and put one real job through it
```

- **PASS:** unqueried agents show `—`, never `0.00000000`; the send confirms; the
  agent can then write on-chain.
- **FAIL:** any `0` where you expected `—`.

---

## 6. Force the automatic sweep to fire (carried from round 5)

The sweep is the fix for the outage that started all of this, and it has **never
fired in anger** — every tank is above the floor, so we have only seen it decline.

```bash
j41-dispatcher start --fee-sweep-floor 200000      # floor above every real tank
```

- **PASS:** `[FeeTank] <agent>: N writes left — sweeping X from M i-address UTXO(s)`
  then `✅ swept in <txid>`; tank grows, sweepable goes to 0.
- **PASS also:** agents with nothing to sweep are left alone, not spammed.
- **FAIL:** a sweep spending **R-address** inputs (it must only ever spend
  i-address ones), or two sweeps for one agent before the first confirms.

Restart normally afterwards.

---

## Secondary, if time allows

7. **`wallet --json`** — satoshis are integers; unqueried agents are `null`, not `0`;
   fleet totals exclude them.
8. **`/health` counters** — `auth_backoff_agents`, `poll_cycles_skipped`,
   `fee_tank_cycles_skipped` all present. An empty tank or a skipped cycle must
   **not** flip `status` to degraded; they are capacity signals, not faults.
9. **Two concurrent `wallet send`** for the same agent, in two terminals. The
   second must refuse with the lock message. Leave the first sitting at its
   confirmation prompt for **over two minutes** before answering — a slow human
   must not look like a crashed process. (This was a real bug: the lock used to be
   stolen after 120s.)
10. **A real conversation job.** Still true from round 4: most jobs have had zero
    buyer messages, so the executor path is barely exercised.

---

## Expected, not bugs

- `— means never queried, NOT zero` in the wallet footer. Deliberate.
- A second wallet command refusing with *"a wallet transaction is recorded as
  unconfirmed"* — the double-spend guard. It clears itself once the tx confirms.
  Only report it if it persists **after** confirmation.
- `Transaction rejected by the network` right after startup — `activate-all` and the
  startup activation pass write the same identities outside the pending-write gate.
- Several deletion attestations for one job that pauses and respawns — backend
  confirmed `POST /v1/me/attestations` is idempotent per container.

## Where I expect breakage, ranked

1. **The Earnings screen (step 3)** — zero automated coverage, by construction.
2. **Auth backoff under a real outage (step 1)** — proven only in simulation.
3. **`refunds unblock` (step 2)** — new, money-adjacent, unit-tested only.
4. **The automatic sweep firing unattended (step 6)** — proven manually and in
   units; the daemon's own path has only ever declined to act.
5. **The daemon-busy check in `wallet`** — has never run live; the pid file was
   absent in every test. A spurious *"another wallet command is spending"* is that.

## Reference

```bash
j41-dispatcher wallet                                    # fleet money at a glance
j41-dispatcher refunds list                              # incl. blocked refunds
curl -s localhost:9842/health | jq '.status, .summary'
tail -f <log> | grep -E "\[Auth\]|FeeTank|FEE TANK|DEAD-LETTER|swept|BLOCKED"
```

Tests: **866 passing** (669 before this work started).
Full history: `CHANGELOG.md`, entries 2.11.1 → 2.12.0.
