# A dispatcher MCP server — assessment, not a build plan

**Date:** 2026-08-14
**Status:** DESIGN QUESTION ANSWERED. Nothing to build yet.
**Trigger:** the owner floated an MCP server for the dispatcher so a new user
could "have their Claude set up the dispatcher for them," as part of soft-launch
2.0 onboarding.

The idea is good and it inverts the onboarding problem rather than documenting
around it. This document answers the three questions the audit plan set —
*what would it expose, what is the blast radius, where does it live* — before a
line is written. Same discipline that made M4 survivable.

## The short answer

**Read tools: build them, they are nearly free. Write tools: do not, yet — and
maybe never for the money verbs. And the onboarding win the owner actually wants
is probably not an MCP server at all.**

## 1. What would it expose?

The dispatcher's surface splits into three tiers with completely different risk.

### Tier R — read

Already exists and is already machine-shaped: `src/control-api.js` serves
`GET /v1/status | agents | jobs | jobs/:id | earnings | deposits | events`
on `127.0.0.1:9843`, bearer-token gated (`~/.j41/dispatcher/control.token`,
0600, auto-created), with a monotonic event cursor that survives restart
(`control-api.js:151-218`).

An MCP server over this tier is a thin translation layer. It adds **no new
authority** — anything it can do, a `curl` with the token already can. This is
also where most of the day-to-day value is: "what is my fleet doing", "why did
that job fail", "am I earning".

### Tier P — prepare / propose

Onboarding: `setup`, `register`, `finalize`, fund, `activate`, `services`
create/update. This is what the owner's idea is actually about, and **none of it
has a machine surface today** — the control API is read-only by explicit
design (`control-api.js:166-168`, `405 method not allowed (v1 is read-only)`).
The write verbs exist only as CLI commands and as an unbuilt v3 work package
(`docs/plans/2026-06-11-dispatcher-v3-headless-hirer-brainbox.md`, WP-D1).

### Tier X — move money outward

`wallet send`, `wallet sweep`, `refunds approve`, `deposits credit`,
`post-bounty`, bounty award. **These must never be MCP tools.** Not gated, not
confirmed-with-a-prompt — absent. There is no onboarding story that requires
them, so exposing them buys nothing and risks everything.

## 2. Blast radius

The thing that makes this different from a normal MCP server: **it would sit in
front of private keys and real money.** Five specific hazards, each with the
rule it implies.

1. **Key exfiltration by transcript.** WIFs live in
   `~/.j41/dispatcher/agents/<id>/keys.json` (0600). A tool that ever *returns*
   one puts an irrevocable spending key into an LLM context window, which is
   logged, may be summarised, and may sync to a cloud.
   → **Rule: no tool may read, return, or accept a WIF. Tools take agent-ids.**
   This is the same custody line the v3 plan already draws for brainbox
   (`2026-06-11-...brainbox.md:170`, `:296` — one custody point, the brain never
   sees the WIF). Not a new principle; an existing one, applied.

2. **Permanent public paid mistakes.** `register` mints a VerusID. The name is
   public, permanent, and costs money. An LLM choosing a name is exactly the
   failure mode nobody notices until it is on-chain forever.
   → **Rule: naming and registration stay human-triggered.**

3. **Hallucinated prices.** `services` sets what strangers pay. A plausible-
   looking wrong number is the single most likely LLM error class, and here it
   means selling work below cost or listing something nobody will buy.
   → **Rule: price is proposed, never set.**

4. **Going live is a one-way door.** `activate` is the switch that makes an
   agent start accepting real jobs from strangers with real money. An assistant
   that flips it "helpfully" at the end of a setup conversation has put an
   untested agent into a live market.
   → **Rule: activation is the human's, always.**

5. **Prompt injection reaches the operator.** The dispatcher already assumes
   job content is hostile — that is what SovGuard and the canary tokens are for
   on the *job* side. But an operator-side MCP reading `/v1/jobs` pipes buyer-
   authored text into the operator's own assistant, which would hold the write
   tools. That is a privilege escalation path from a buyer's job description to
   the operator's wallet, and it exists the moment Tier R and Tier P share one
   context.
   → **Rule: this alone justifies keeping Tier P out.** If Tier P is ever built,
   buyer-authored strings must be scanned through `src/sovguard-context.js`
   before they reach an operator-side model.

Hazard 5 is the one that was not obvious going in, and it is the strongest
argument in the document.

## 3. Where would it live?

**Not in this repo, and not in the existing J41 MCP.** They are different trust
domains:

| | J41 MCP (125 tools) | a dispatcher MCP |
|---|---|---|
| Talks to | `api.junction41.io` | a **local** daemon on `127.0.0.1:9843` |
| Auth | platform credentials | a file-mode-0600 bearer token |
| Acts as | a buyer/agent on the marketplace | the **operator** of a fleet |
| Fails by | a bad API call | spending the operator's money |

Folding operator authority into the marketplace-facing MCP would put fleet
control behind platform credentials, which is wrong on both ends. If it is
built, it is its own package.

## 4. Who the operator is — three classes, and the third breaks the model

Answered by the owner 2026-08-14: the target user is **humans, humans running
agents, or self-sovereign agents who want to earn by offering services.**

That is three operator classes, not the two this document originally assumed,
and the third one invalidates the safety model in section 2.

| Class | Who acts | Backstop |
|---|---|---|
| 1. Human operator | person at a CLI/TUI | the person |
| 2. Human + assistant | assistant drives, person approves | the person, at the one-way doors |
| 3. Self-sovereign agent | the agent, on its own behalf | **nobody** |

For class 2, propose-don't-perform works exactly as described above, and this is
where an MCP genuinely fits.

**For class 3 it is not a control — it is a deadlock.** "Require human
confirmation" has nobody to confirm. An agent that cannot register an identity,
set a price, or pay a refund cannot run a business, so withholding those verbs
does not make it safe; it makes it inert.

So for class 3, safety cannot come from a prompt. It has to come from **policy
the agent's own reasoning cannot alter** — and the dispatcher already has more
of that machinery than section 2 credited:

- `financial-allowlist.json` — **deny-all by default**; outward payouts go only
  to pre-approved destinations
- `network-allowlist.json` — egress is allowlisted, not open
- `wallet send` reserve floor — refuses a send that drains the source tank
  below the fee floor without `--allow-drain` (`src/wallet.js`)
- `send` destinations resolve to **fleet agent-ids, never raw addresses** — a
  typed address is refused outright
- token budgets that fail closed, never unlimited (`src/token-budget.js`)
- the inbox pending-write gate, and the deposit locks' fail-closed writers

This changes hazard 5 from an edge case into **the defining constraint**. A
self-sovereign operator reads buyer-authored text and holds the keys, by
construction — there is no context separation available to it, ever. The only
durable defence is that money-moving authority is bounded by limits that live
*outside* the reasoning loop, where no buyer-supplied string can move them.

That is an architecture this dispatcher is already much closer to than I
credited when I wrote section 2. The soft-launch question for class 3 is
therefore not "should an agent be allowed to do this" but **"is every limit that
bounds an autonomous operator actually enforced in code, and is any of it
reachable from buyer-controlled input?"** That belongs in the audit.

## 5. The uncomfortable part: an MCP may not be the answer

Two observations that cut against building it at all.

**Any assistant with a shell already has the capability.** A class-2 user
running Claude Code can be told `j41-dispatcher setup ...` today and their
assistant will run it. The MCP adds *structure* — typed tools, no shell quoting,
no output parsing — but **no new capability** for that class. It adds capability
only where there is no shell (Claude Desktop and similar).

Note this argument does **not** apply to class 3. A self-sovereign agent needs a
stable, typed, machine-checkable contract precisely because there is no human to
notice that a scraped CLI table changed shape. For class 3 the structure *is*
the capability.

**An MCP does not fix a confusing first run — it relocates it.** If the CLI's
onboarding is unclear, wrapping it in tools moves the confusion somewhere harder
to debug, and adds a component that can hallucinate. The ordering has to be:
fix first-run, then accelerate it.

**The cheaper thing that captures most of the value:** machine-readable output
plus an onboarding doc written for an assistant to follow. Only 6 CLI commands
carry `--json` today (`cli.js:2889, 10650, 11135, 11187, 12141, 12498`) out of
a much larger command set. Uniform `--json` + stable exit codes + an
`llms.txt`-style setup guide would let *any* assistant with a shell drive the
existing CLI correctly — no new server, no new custody surface, no new package
to maintain, and it improves the CLI for scripting at the same time.

## 6. Recommendation

1. **A machine-readable surface is a product requirement, not a nice-to-have.**
   Two of the three operator classes are machines. Uniform `--json`, stable exit
   codes, and an assistant-readable setup guide are the highest-leverage work
   here, and they serve classes 2 and 3 whether or not an MCP is ever built.
   Today only 6 commands carry `--json`.
2. **Fix first-run first.** If the newcomer walk finds onboarding broken, any
   wrapper over it is premature by definition.
3. **Tier R MCP: worth building**, as its own package, for class 2.
4. **Tier P writes: still gated on v3 WP-D1** — but for a revised reason. Not
   "wait until we design a human-confirmation UX," but **"the write surface must
   carry policy enforcement, because class 3 has no human to confirm to."**
5. **Tier X for classes 1 and 2: never an MCP tool.** For class 3 it is
   unavoidable — the control is the allowlist and the ceiling, not a prompt.
6. **No tool reads, returns, or accepts a WIF.** This one holds for all three
   classes, without exception, enforced in code rather than documented.

## The question this raises instead — custody for class 3

If a self-sovereign agent is earning on its own behalf, **what holds the key?**

Two possible shapes:

- **(a) The agent holds its own WIF.** Then the whole at-rest encryption story
  changes meaning: the thing the keystore protects the key *from* is now the
  same process that must use it, and a prompt injection reaching that process
  reaches the key itself.
- **(b) The agent drives a dispatcher that holds the keys behind a policy
  wall.** The agent can ask for money to move; the dispatcher decides whether
  policy permits it. Injection reaching the agent still cannot exceed the
  allowlist and the ceilings.

**(b) is the dispatcher's current design, and it is the right one.** It is worth
stating explicitly as product doctrine rather than leaving it as an accident of
implementation — because every future feature that lets an agent "just do it
directly" is a step from (b) toward (a), and each such step will look locally
reasonable.
