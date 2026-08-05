# TUI manual checklist

**Why this is a checklist and not a test suite.**

`src/dashboard.js` runs `main()` on require and drives Inquirer against a TTY, so
it cannot be imported under `node --test`. The obvious workaround — driving it
through a pseudo-terminal — was tried and abandoned: the harness hung for two
minutes without rendering, and a flaky test that everyone learns to ignore is
worse than an honest manual step.

What was worth automating has been automated. The Earnings screen's arithmetic
was extracted into `buildEarningsRow()` in `src/wallet.js` and is pinned by
`test/earnings-row.test.js` (13 cases). That is the part where a **wrong number**
could hide. A pty test would not have caught a wrong number anyway: in a sandbox
the agents are unregistered and unfunded, so every money path renders its
degraded branch and the assertion degenerates to `—` equals `—`.

So this checklist covers only what automation cannot: that each screen renders,
and that navigation behaves.

Run it once per release, against a real fleet.

---

## Before you start

Two menu items **act the moment you press Enter** — there is no confirmation step:

| item | what selecting it does immediately |
|---|---|
| **[7] Start Dispatcher** | spawns a detached daemon |
| **[8] Stop Dispatcher** | SIGTERMs the PID in the pid file |

`[15] Activate All` and `[16] Deactivate All` write on-chain for every agent and
cost fees.

**Confirm the highlighted label before every Enter.** Arrow keys navigate; the
bracketed numbers are label text, not shortcuts, and the list is interleaved with
separators — so counting positions is not reliable.

---

## Read-only screens

For each: open it, confirm it renders without an error, press **ESC**, confirm it
returns to the menu rather than exiting.

- [ ] **[1] View Agents** — pick one agent; VDXF keys, profile, services, SOUL.md all render
- [ ] **[10] Status & Health** — agent count matches `j41-dispatcher status`
- [ ] **[11] Inspect Agent (on-chain)** — matches `j41-dispatcher inspect <id>`
- [ ] **[12] Check Inbox** — matches `ctl inbox`
- [ ] **[14] Docker Containers** — matches `docker ps`
- [ ] **[17] Bounties** — browse only; do not post
- [ ] **⚡ Live Jobs** — auto-refreshes, ESC still exits cleanly

## [13] Earnings Summary — the money screen

- [ ] Each agent shows `Balance:`, `Jobs:` and `Tank:`
- [ ] **Cross-check one agent against `j41-dispatcher wallet`** — the tank figure and
      write count must match exactly. They share `buildEarningsRow`/`summarizeUtxos`,
      so a mismatch means the view drifted from the tested path.
- [ ] An agent with sweepable earnings shows `[N sweepable]`
- [ ] An agent with an empty tank shows `EMPTY — fund <address>` with the **full**
      address (it exists to be copied)
- [ ] If an agent's lookup fails it shows `Tank: (unavailable)` — **never `0.00000000`**.
      Zero means "we looked and it is empty"; unavailable means "we could not look".
      Reading one as the other is how an agent gets funded twice.

## Configuration screens

Open, confirm the current values render, ESC out **without saving**.

- [ ] **[3] Configure Agent Executor**
- [ ] **[4] Configure Global LLM Default**
- [ ] **[5] Configure Services**
- [ ] **[6] Security Setup**
- [ ] **[18] API Endpoint Setup**

## Navigation

- [ ] ESC from any screen returns to the menu; it never exits the process
- [ ] Quit exits cleanly with no stack trace
- [ ] The menu still renders correctly at a narrow terminal width (~80 cols)

---

## If you change the Earnings screen

Put the arithmetic in `buildEarningsRow()` and leave only layout in
`dashboard.js`. Anything computed inline in that file is untestable by
construction, which is how the fee-tank figures went unverified in the first
place.
