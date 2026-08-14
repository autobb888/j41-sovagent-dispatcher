# Soft-launch 2.0 readiness audit — plan

**Date:** 2026-08-14
**Status:** PLAN ONLY, not started. Written before a context compact so it survives.
**Trigger:** the owner is inviting real people onto testnet. The question stops
being "is it correct" and becomes "can a stranger use it without us."

## Why this audit is different from the last five

Every audit so far asked *is this code right*. Two asked *does this feature fit
the system*. **None asked whether a person who has never seen this software can
get from `yarn global add` to earning.** That is the question now.

The prior lesson applies directly ([[feedback_audit_scope]]): the fit audits found
a dashboard telling operators "confirmed" about unresolved deposits — a surface
lying because nobody had looked at it from the outside. A newcomer's path is the
biggest unlooked-at surface left.

## Scope, in priority order

### 1. Does the CLI match what the dispatcher actually offers?

The concrete test: enumerate every capability the dispatcher has (job selling,
api-endpoint reselling, bounties, services CRUD, wallet, refunds, deposits,
disputes, workspace, canary, VDXF profile, key encryption, activation) and, for
each, ask:

- Is there a CLI verb? Is it discoverable from `--help` alone?
- Does the TUI expose it, and does the TUI's wording match the CLI's?
- Is the *default* verb the safe one (the `wallet list` doctrine)?
- Do the noun/verb shapes agree across commands? (`refunds approve`,
  `deposits credit`, `wallet send` — same grammar? same confirmation model? same
  `--yes` semantics?)

Known-suspect going in: `deposits` was added yesterday and only reached README
after an audit caught it; `ctl deposits`/`ctl inbox` fall to raw JSON where other
`ctl` verbs pretty-print.

### 2. Is the spec aligned with J41 (the platform)?

Not "do the calls work" — that is covered. The question is whether the
**dispatcher's model of the marketplace matches the platform's**: service types,
status axes, confirmation tiering, dispute lifecycle, review/attestation
semantics, fee handling, the two `status` axes. Any place the dispatcher assumes
a shape the backend does not guarantee is a soft-launch incident waiting to
happen with a stranger's money.

Cross-check against `docs/backend-responses/` (the whole thread) and
`reference_backend_endpoints`.

### 3. First-run experience, end to end, as a stranger

**This has never been done on a clean machine** — `docs/RELEASE-READINESS.md`
says so explicitly, and it is the single largest untested surface in the project.

Walk: install → `setup` → `register` → `finalize` → fund → activate → take a job →
get paid → check earnings. At every step: is the next action obvious? Are errors
actionable? What happens when a step is done out of order, or twice, or
abandoned halfway? Is there any point where the user must read source, guess a
flag, or already know a concept nobody introduced?

Deliverable: the transcript of that walk with every friction point timestamped,
not a summary.

### 4. Concept load

Count what a newcomer must understand before earning: VerusID, i-address vs
R-address, fee tank, VDXF, executors, confirmation tiers, deposits vs jobs,
platform vs chain status axes. For each — is it *essential*, or is it our
implementation leaking? Anything in the second category is a docs or defaults
problem, and defaults are cheaper than docs.

### 5. Failure modes a stranger will actually hit

Wrong network, no funds, expired keys, platform down (the daily 04:00 window),
Docker missing or unprivileged, port already bound, encrypted keystore locked,
fleet deactivated after a restart. Each: does the message say what to DO?

## Deliverables

1. `docs/testing/2026-08-XX-soft-launch-readiness.md` — findings, prioritised by
   "how likely is this to lose a real user."
2. A CLI surface matrix: capability × CLI × TUI × docs, with the gaps visible.
3. A ranked fix list separating **blocks soft launch** from **embarrassing** from
   **later**.

## Method

Fable subagents, and this time scoped as: **one on CLI/UX coherence, one on
spec-vs-platform alignment, one walking first-run as a hostile newcomer.** Give
the newcomer agent NO prior context beyond the README — the point is to find what
only insiders know.

Constraints as always: read-only, no git writes, do not touch the live fleet or
the real `~/.j41`, do not run `start`.

## The MCP idea — assess, do not build yet

The owner floated an MCP server for the dispatcher so a new user could have their
own Claude set it up for them. Genuinely promising, and it inverts the onboarding
problem rather than documenting around it.

Treat as a **design question for this audit, not a build item**: what would it
need to expose, what is the blast radius of an LLM driving setup (it would hold
keys and move money), and does it belong in this repo or alongside the existing
125-tool J41 MCP? Answer before writing any of it — the same discipline that made
M4 survivable.

## Open items inherited (do not lose these)

- Backend must decide the `deposit-confirmed` / reversal divergence
  (`docs/backend-responses/2026-08-14-m4-shipped.md`). Neither option shipped.
- M4 has never run on real data — no agent has an api-endpoint service.
- npm HELD at 2.28.2 while `package.json` says 2.29.0.
- Docs sweep for the deposits work, deferred by the owner 2026-08-14.
