# Re-test plan — after the 2026-08-15 tester round

**Prior run:** 2026-08-15, backend `46a80a6` / dispatcher 2.31.0 / SDK 2.14.2.
Every buyer-executable item passed; 8.7 (budget top-up) confirmed fixed.

This is what still needs running, and why. Ordered by what would change a
soft-launch decision.

---

## Read this before trusting any prior result

**The dispatcher was restarted mid-run.** The tester's own note says so. That
means the results are split across two builds and nobody recorded which item
landed on which side:

| Job | Build | Notes |
|---|---|---|
| `98e0ea00` | **old** (2.29.0) | hired, delivered, first dispute — all pre-restart |
| `267f6bed` | **new** (2.31.0) | the 8.7 top-up success |
| `229d2c00` | new | 8.8 defer |
| `17396d09` | new | 8.9 XSS |

So **8.5 and 8.6 (payment → advertised address, delivery + review window) were
observed on the OLD build** and have not been confirmed on what we actually ship.
They are the two most fundamental money checks in the whole plan.

**R1 — re-run 8.5 and 8.6 end-to-end on 2.31.0 or later, single build, no
restart.** If only one thing gets re-tested, make it this.

The same caveat applies to the tester's remark that "on the new build a normal
rework fits budget". That comparison spans builds too.

---

## Blocked right now — seller auth is down

As of **15:10 UTC** every agent fails sign-in (`Sign-in temporarily unavailable
while the chain catches up`, 137–145 consecutive failures) while `/v1/version`
returns 200. Raised with the backend
(`docs/backend-responses/2026-08-15-tester-round-findings.md` §1).

**Nothing seller-side can be re-tested until that clears.** Check first:

```
node src/cli.js inspect agent-1        # should not error on sign-in
curl -s -o /dev/null -w '%{http_code}' https://api.junction41.io/v1/version
```

---

## R2 — the refund route, still never exercised

Two disputes are open and both are **paid-but-never-delivered**:

| Job | Agent | Amount | Cause |
|---|---|---|---|
| `937dedf6` | agent-6 | 0.005 VRSCTEST | LLM outage — `delivery:null`, `tokenUsage:null` |
| `130e47d5` | url2 | 0.6 VRSCTEST | seller never delivered |

I attempted `--action refund --refund-percent 100` on both and was blocked by the
auth outage. **Retry as soon as auth returns** — the command is ready:

```
node src/cli.js respond-dispute 937dedf6-b305-4d2c-ac1d-0b795d4a99ab \
  --agent agent-6 --action refund --refund-percent 100 --message "..."
```

This closes the last untested branch of the dispute system:

| Route | Status |
|---|---|
| rework, free | ✅ ×2 (`98e0ea00`, `267f6bed`) |
| rework, **paid** | ✅ (`229d2c00` — the 8.7 fix) |
| rejected | ✅ (`17396d09`) |
| **refund** | ⛔ **blocked, then untested** |

**Then the money actually has to move.** `respond-dispute --action refund` only
*declares* the outcome; the funds sit in the operator queue. Full test is:
respond → `refunds approve <job-id>` → on-chain send → txid submitted → platform
verifies. **Owner action — it spends real testnet funds.**

---

## R3 — what the platform said vs what we could see

My scan for disputed jobs returned **nothing** while two disputes were open. The
cause was the auth outage: the query failed and my script's `catch` swallowed it,
so "no disputes" and "could not ask" looked identical.

**That is the exact fail-silent pattern this cycle has been fixing, and I wrote
it.** Worth a check in its own right:

**R3a** — when auth is down, does `ctl agents` / the dashboard show agents as
healthy? If a fleet that cannot sign in still reads green locally, that is the
2026-08-06 incident shape again and it is a real finding.

**R3b** — there is no `disputes list` command. The operator's only view of open
disputes is the dispatcher's own log. Add one, or confirm `ctl` should carry it.

---

## R4 — the top-up expiry window

8.8 passed, with a flag: an **approved-but-unpaid** top-up disappeared *before*
the 120-minute defer grace. Backend has been asked for the real TTL.

Once they answer:

- **R4a** — re-run 8.8 timing the disappearance precisely. Approve, do not pay,
  poll `budget-requests` every minute, record the exact expiry.
- **R4b** — pay at ~80% of that window. The offer must still be payable at the
  edge, not silently gone.
- **R4c** — seller-side: once the TTL is known, the rework offer message should
  state it. A seller quoting a price the buyer cannot act on is a support ticket.

---

## R5 — rework budget size

The rework budget is derived from `reworkBudgetPercent` (default **50%**) of the
job amount — so a rework gets roughly half the tokens of the original attempt
(observed: 3599 → 1799).

That is a deliberate choice, not a bug, but it has a consequence: **a buyer
asking for "more detail" gets a budget that can produce less output than the
delivery they rejected.** The tester hit exactly this — a normal rework fits, an
expanded one does not, which is what forced the 8.7 top-up.

**R5a** — decide whether 50% is right. An argument for higher: the common rework
reason is "too thin", and the honest response needs *more* room, not less.
**Deliberately not changed mid-cycle** — altering token budgets now would
invalidate comparison with this run.

---

## R6 — carried hand-offs

- **8.1–8.3, cold-start identity mint** (QR + Verus Mobile, needs a phone). This
  is the only remaining answer to *can a stranger with no wallet get in* — the
  headline soft-launch question, still unanswered by anyone.
- **9.5–9.8** need DB/RPC/logs — handed to the backend.

---

## R7 — dispatcher changes since the run (three fixes, two need re-testing)

**R7a — `/health` reported `ok` while the fleet could not sign in.** Found live
during the outage above: 8 of 9 agents in auth backoff, `auth_backoff_agents: 8`
in the very same payload that said `ok`. Auth backoff sets no `lastError`, so no
existing degrade term caught it. Now degrades when a **majority** of the fleet is
in backoff.

**Re-test:** during the next auth outage — or by stopping network access to the
platform — confirm `/health` returns `degraded` and that a single agent flapping
does **not** trip it.

**R7b — an agent could sit in the available pool twice.** Same payload:
`agents_available: 10` against `agents_total: 9`. Four call sites returned agents
to the pool with no duplicate check. The count is the mild symptom — the pool is
what work is assigned from, so a duplicated agent can be handed **two jobs
concurrently**.

**Re-test:** run several jobs through failure paths (container start failure,
spawn error, timeout, pause/resume) and assert `agents_available` never exceeds
`agents_total`. That invariant should now hold under any sequence.

**R7c — refund drain overcounted.** Logged "24 awaiting owner approval" when 20
were, counting settled entries. **No re-test needed** — it never affected which
refunds were sent, only the number reported. Noted so nobody chases the
discrepancy in old logs.

---

## Priority

1. **R1** — 8.5/8.6 on a single build (fundamental, and currently split)
2. **R2** — the refund route, end to end including the on-chain send
3. **R3a** — does a fleet that cannot authenticate still read green?
4. **R7b** — the pool-duplicate invariant under failure paths (a duplicate means
   two buyers on one agent)
5. **R6** — the mobile mint; it is the actual cold-start question
6. R4, R5, R7a — after the backend answers / next outage
