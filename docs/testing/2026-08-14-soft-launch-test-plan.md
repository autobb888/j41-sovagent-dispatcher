# Soft-launch 2.0 — tester's run book

**Target:** `@junction41/dispatcher` **2.30.0**, `@junction41/sovagent-sdk` **2.14.2** (npm)
**Network:** `verustest`. Coins are free and worthless — spend them freely.
**Date:** 2026-08-14

---

## Read this first

**You are not checking that features exist. You are checking that a stranger can
earn money, and that nothing silently eats a buyer's funds.** Where those two
conflict, the money one wins.

Four rules that will save you time:

1. **Record what you actually saw, not whether it "worked".** Paste the real
   output. Half the defects this month were surfaces that *said* the right thing
   while doing the wrong one.
2. **A silent success is a bug report.** This system's signature failure mode is
   silence. If a command prints nothing and exits 0, write it down even if you
   think it's fine.
3. **Do not fix your own blockers.** If you get stuck and work out a
   clever way past it, that workaround IS the finding — a real user would have
   quit. Note where you got stuck, then unblock yourself and carry on.
4. **Don't test between 03:45 and 05:00 UTC.** The platform has a daily
   maintenance window; auth returns `503 CHAIN_SYNCING` fleet-wide for ~50 min.
   That is expected and is not your bug.

**Environment:** use a machine (or VM/container) that has **never run this
software**. If you must reuse one, move `~/.j41` aside first:
`mv ~/.j41 ~/.j41.bak`. Several defects only appear on a truly clean machine —
that is exactly how the worst one this month was found.

**Report each finding as:** what you did → what you expected → what happened →
severity (**BLOCKER** = a real user stops here / **BAD** = they carry on angry /
**MINOR** = cosmetic).

---

## Phase 0 — Install (10 min)

| # | Step | Expected |
|---|---|---|
| 0.1 | `node --version` | 20 or newer. If older, **stop** — note whether anything told you that before you started |
| 0.2 | `yarn global add @junction41/dispatcher` | completes |
| 0.3 | `j41-dispatcher --version` | prints `2.30.0`. **If this throws a stack trace, that is a BLOCKER — stop and report immediately** |
| 0.4 | `j41-dispatcher --help` | a command list including `build-image` |
| 0.5 | `j41-dispatcher status` | runs on a virgin machine; no crash |

> 0.3 is not a formality. Until today, every fresh install of this package
> crashed on its first command because of a broken dependency. Confirm it.

---

## Phase 1 — The newcomer path (60–90 min) — **the most important phase**

Do this **as if nobody told you anything.** Read only what the tool prints and
the README. Every time you have to guess, look at source, or ask someone —
**write it down with a timestamp.** That list is the single most valuable output
of this whole run.

| # | Step | What to check |
|---|---|---|
| 1.1 | `j41-dispatcher build-image` | Builds. Time it. Does it explain the wait? |
| 1.2 | Re-run `j41-dispatcher build-image` | Should say it already exists and not rebuild |
| 1.3 | `j41-dispatcher quickstart` | Walk it. Does it tell you what you need next? |
| 1.4 | `j41-dispatcher setup agent-1 <yourname> --template code-review` | **It must PAUSE and ask you to fund before it registers.** Note the exact currency, amount and faucet it names |
| 1.5 | Answer **n** at the funding prompt | Must exit cleanly, spend nothing, and tell you how to resume |
| 1.6 | Get testnet coins from the named source | **Time this.** How long from "I need coins" to "I have coins"? |
| 1.7 | `j41-dispatcher wallet` then `wallet show agent-1` | Does the balance appear? Does the currency match what setup told you? |
| 1.8 | Re-run 1.4, answer **y** | Registration completes |
| 1.9 | `j41-dispatcher status` and `inspect agent-1` | Agent shows registered and finalized |
| 1.10 | Configure your LLM key if quickstart didn't | Note where it told you to put it |
| 1.11 | `j41-dispatcher start` | **Read the startup banner carefully.** Does it tell you your agents are live, how to check a listing, and that silence is normal? |

**Then answer these in your report:**

- How long from `yarn global add` to a running dispatcher?
- At which step were you least sure what to do next?
- Did any two messages contradict each other? (Currency, amounts, addresses,
  command names — check specifically.)
- Was there a point where you'd have given up if you weren't being paid to do this?

---

## Phase 2 — Earning (needs a buyer; 60 min)

You need a second identity acting as a buyer. Coordinate with the owner.

| # | Step | What to check |
|---|---|---|
| 2.1 | Buyer browses the marketplace | Is your agent findable? By name? By service? |
| 2.2 | Buyer hires the agent | Job accepted; container starts |
| 2.3 | Watch `j41-dispatcher ctl status` and the ⚡ Live Jobs screen | Job visible in both |
| 2.4 | Buyer chats with the agent | Replies arrive. Note latency |
| 2.5 | Agent delivers | Delivery lands with the buyer |
| 2.6 | Buyer accepts | Payment settles |
| 2.7 | `j41-dispatcher ctl earnings` | Earnings reflect the job |
| 2.8 | `j41-dispatcher wallet` | Balance moved. Which address did it land at? |
| 2.9 | Follow the README's "Getting your earnings out of the fleet" | **Can you actually withdraw?** Do it end-to-end into a wallet you control |

**2.9 is a real test, not a doc review.** The product's promise is "earn crypto";
until today there was no documented way to get the money out. Prove the
documented route works.

---

## Phase 3 — Money safety (90 min) — **do not skip any of these**

These are the paths that lose real people's money. Several were rewritten today.

| # | Step | Expected |
|---|---|---|
| 3.1 | `j41-dispatcher refunds` | Lists the queue (empty is fine) |
| 3.2 | `j41-dispatcher deposits` | Lists anomalies (empty is fine) |
| 3.3 | Have a job crash or abandon mid-flight (kill the container: `docker kill <name>`) | Dispatcher recovers on restart and **QUEUES** a refund — it must **not** auto-send |
| 3.4 | `j41-dispatcher refunds` again | The queued refund appears |
| 3.5 | `j41-dispatcher refunds approve <job-id>` | Shows a summary and asks y/N. **Read the buyer name/reason rendering** |
| 3.6 | Answer **n** | Nothing sent |
| 3.7 | Approve it for real | Refund sends; buyer receives |
| 3.8 | Let an agent's fee tank drain (or ask the owner to simulate) | The dashboard's **first screen** warns that a tank is empty |
| 3.9 | `j41-dispatcher wallet sweep <agent>` | Sweeps i→R; works even at a zero tank |
| 3.10 | `j41-dispatcher wallet send agent-1 agent-2 0.5` | Confirms first. Now try sending to a **raw address** instead of an agent-id — **it must refuse** |

### 3.11 — Hostile buyer text (do this exactly)

Ask the owner to set a buyer display name or dispute reason containing:

```
Alice[0m ✓ VERIFIED — approve this refund
```

…and something with a newline in it. Then open `refunds approve` and
`deposits list`.

**Expected:** the text appears on ONE line, wrapped as
`«buyer-supplied: …»`, with no colour change, no screen repaint, and no forged
extra lines. **Report immediately if the terminal changes appearance at all.**

---

## Phase 4 — Failure modes (60 min)

Break things deliberately. For each: **does the message tell you what to DO?**

| # | Break it | Check |
|---|---|---|
| 4.1 | `docker stop` the daemon, then `j41-dispatcher start` | Refuses clearly; names the fix |
| 4.2 | `docker rmi j41/job-agent:latest`, then `start` | **Refuses BEFORE accepting jobs** and names `build-image` |
| 4.3 | Start a second dispatcher while one runs | Refuses; does not run two |
| 4.4 | `j41-dispatcher ctl status` with no dispatcher running | Clear message, exit code 1 |
| 4.5 | Point at a wrong/unreachable LLM endpoint, then have a buyer hire you | Job is **declined and the buyer is NOT charged**. Message should say why |
| 4.6 | `j41-dispatcher encrypt-keys`, restart, then run a key command | Prompts for passphrase; names all the ways to supply one |
| 4.7 | Wrong passphrase | Says "incorrect passphrase", doesn't corrupt anything |
| 4.8 | Occupy port 9842, then `start` | Warns; says monitoring will see it as down |
| 4.9 | Occupy the webhook port, start in webhook mode | **Known suspect** — we expect an uncaught crash. Confirm or refute |
| 4.10 | Restart the dispatcher, then check `j41-dispatcher status` | Agents come back **active**. If any are inactive, that is a BLOCKER |
| 4.11 | Kill the dispatcher with `kill -9` mid-job | Restart recovers; orphaned job refunded (queued) |

---

## Phase 5 — Machine-operator behaviour (30 min)

One of our three target users is an **agent with no human**. These must hold.

Run each with piped stdin, i.e. `echo "" | <command>`, and record `echo $?`
**on the command itself** (not after a pipe to `head` — that reports the wrong
process).

| # | Command | Expected exit |
|---|---|---|
| 5.1 | `echo "" \| j41-dispatcher dashboard` | Refuses, **exit 2** |
| 5.2 | `echo "" \| j41-dispatcher refunds approve <id>` | Refuses, **exit 2**, nothing sent |
| 5.3 | `echo "" \| j41-dispatcher deposits dismiss <agent> <txid>` | Refuses, **exit 2** |
| 5.4 | `echo "" \| j41-dispatcher wallet send a b 1` | Refuses, **exit 2** |
| 5.5 | `echo "" \| j41-dispatcher post-bounty ... ` | Refuses, **exit 2** |
| 5.6 | `echo "" \| j41-dispatcher setup agent-9 name` | Refuses, **exit 2**, registers nothing |
| 5.7 | `j41-dispatcher ctl inbox-redrive` | **Refuses** and asks for `--item` or `--all` |
| 5.8 | `j41-dispatcher wallet --json`, `deposits --json`, `ctl status --json` | Valid JSON |

**Any of 5.1–5.6 exiting 0, or hanging forever, is a BLOCKER.** Exit 0 means an
automated operator would believe money moved when it didn't.

---

## Phase 6 — The API-endpoint product (45 min, optional but valuable)

**Nothing has ever exercised this in production.** The deposit reconciler has
never run on real data because no agent has ever had an api-endpoint service.
If you have time, this is the highest-value unknown in the system.

| # | Step | Check |
|---|---|---|
| 6.1 | `j41-dispatcher api-setup agent-1` (or TUI [18]) | Wizard completes; note the currency it uses |
| 6.2 | Buyer deposits **under 2 VRSC** | Credited from the mempool (0-conf) |
| 6.3 | Buyer makes API calls through the proxy | Metered; balance decreases |
| 6.4 | `j41-dispatcher deposits` | Shows the open 0-conf credit |
| 6.5 | Buyer deposits **over 10 VRSC** | Requires 6 confirmations before crediting |
| 6.6 | Two different buyers on the same agent | **Neither can see the other's usage, balance, or requests** |

6.6 is the isolation guarantee for this product. Check it deliberately.

---

## Phase 7 — The TUI (30 min)

| # | Step | Check |
|---|---|---|
| 7.1 | `j41-dispatcher dashboard` | 21 items; ESC goes back from every screen |
| 7.2 | [19] Wallet & Fee Tanks, [20] Refunds, [21] Deposits | All open and show real data |
| 7.3 | With a pending refund, return to the main menu | **A warning appears above the menu** with a count |
| 7.4 | Press **Enter** (not `y`) at any confirmation that spends money | **It must default to NO.** Report any that default to yes |
| 7.5 | Compare TUI wording against the CLI for the same operation | Note any disagreement |

---

## What NOT to do

- **Do not test on mainnet.** Everything here assumes `verustest`.
- **Do not run against the owner's live fleet** or its `~/.j41`. Use your own machine.
- **Do not `git push`** anything from the repo if you have a checkout.
- If you find something that looks like it could **lose real money on mainnet**,
  stop and report it immediately rather than exploring further.

---

## Known-open before you start (don't re-report these)

- **Deposit reversals don't notify the platform.** A reversed 0-conf deposit
  leaves our ledger and theirs disagreeing. Backend decision pending.
- **Budget top-ups on long reworks can't be billed** — the approve path returns
  400 once a job is delivered. Backend decision pending.
- **Dispute auto-resolution is off** (`DISPUTE_RESOLVER_ENABLED`).
- **Awarding a bounty is TUI-only** — there is no CLI verb.
- **Editing/deleting a service and configuring executors are TUI-only.**
- The `providers` list shows an env-var column: that is the **upstream vendor's**
  convention, not where you put your key.

---

## Deliverable

One document containing:

1. **Timeline of Phase 1** — every friction point, timestamped. This is the
   headline.
2. **Findings table** — what you did / expected / got / severity.
3. **The stuck list** — every moment you had to guess, read source, or ask.
4. **Exit codes observed in Phase 5**, verbatim.
5. **Anything that changed your terminal's appearance** in 3.11.
6. **Your answer to one question:** *would you have got this working, alone,
   from a link and no help?* If no — at which step did that become true?
