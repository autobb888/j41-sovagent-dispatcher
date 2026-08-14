# Soft-launch fixes — spec and acceptance criteria

**Date:** 2026-08-14
**Status:** written AFTER implementation, deliberately, to audit against.
**Scope:** `1a3d47e..6658aca` (dispatcher) + `52edfda..c54a396` (SDK).

## Why this exists

The fixes went findings → code with no spec in between. That is fine for
mechanical work and dangerous for anything with a contract, because there is
nothing to check the implementation *against* — only the implementer's memory of
what they meant. This document states what each change was supposed to
guarantee, so an auditor can test the claim rather than re-derive the intent.

Written from `docs/testing/2026-08-14-soft-launch-readiness.md`. Where a
criterion is weaker than the finding it answers, that is called out as a
deliberate partial rather than hidden.

## Operator classes (the axis everything below is judged on)

| Class | Who acts | Backstop |
|---|---|---|
| 1 | human at a CLI/TUI | the person |
| 2 | human + assistant | the person, at one-way doors |
| 3 | self-sovereign agent | **nobody** |

A control that only works for class 1 is not a control. Every criterion must
state its behaviour for a non-interactive caller.

---

## R1 — Dependency integrity (B0)

**Requirement.** A clean install from the registry must run.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R1.1 | `npm i @junction41/dispatcher` into an empty dir, then `--version`, exits 0 and prints a version | all |
| R1.2 | The SDK alone installs and imports without `MODULE_NOT_FOUND` | all |
| R1.3 | The pin survives a global install, where a nested package's own `overrides`/`resolutions` are ignored | all |
| R1.4 | The fix is durable upstream, not only in the dispatcher | all |

**Known limit.** `json-canonicalize` is pinned to an exact version, so a genuine
upstream fix in 2.0.2+ will not be picked up automatically. Accepted: the
alternative is a range that can resolve to a broken publish again.

---

## R2 — There is a path to money (B2, E5)

**Requirement.** A newcomer can determine, from the product alone, what to fund,
with what, how much, and where to get it — without being told to send the wrong
coin.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R2.1 | Every funding message names the currency **derived from the configured network**, never a literal | all |
| R2.2 | No two funding messages can disagree (single helper; enforced by a class-level test, not by review) | all |
| R2.3 | A funding message states the registration cost AND a recommended amount that leaves a working fee tank | 1, 2 |
| R2.4 | On testnet, a reachable source of coins is named | 1, 2 |
| R2.5 | On testnet, the message warns that testnet ≠ mainnet and the addresses are visually identical | 1, 2 |
| R2.6 | On mainnet, no faucet is offered and the message says it is real money | 1, 2 |
| R2.7 | Service-currency defaults derive from the network on **every** registration surface | all |
| R2.8 | `setup` shows funding details and does not register until the operator confirms | 1 |
| R2.9 | `setup` non-interactive and unfunded refuses with a distinct exit code rather than registering or hanging | 2, 3 |
| R2.10 | `setup --yes` preserves straight-through registration for a caller that funded ahead | 2, 3 |

**Deliberate partial.** R2.8 asks the operator to *assert* funding; it does not
query the chain balance. A balance check would be better and is not done — the
address may be funded in a way we cannot see yet (unconfirmed), and a false
"unfunded" refusal is worse than a confirmed lie. **Flag if the auditor
disagrees.**

---

## R3 — The job image is reachable and its absence is early (B3)

**Requirement.** The image can be built by whoever installed the package, and a
missing image is discovered before any buyer's money is involved.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R3.1 | A CLI verb builds the image, resolving the bundled script from the module's own location, not the cwd | all |
| R3.2 | The script it resolves to actually ships in the npm tarball | all |
| R3.3 | `start` refuses when the image is absent, naming the fix, before accepting any job | all |
| R3.4 | The refusal does NOT fire in `local` runtime, which does not use the image | all |
| R3.5 | The existence check never throws when Docker is missing or unreachable | all |
| R3.6 | Re-running the build when the image exists is a no-op unless forced | 1, 2 |

---

## R4 — Running is distinguishable from broken (B4)

**Requirement.** After `start`, an operator can tell that the fleet is listed and
knows what "nothing happening" means.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R4.1 | `start` prints the identities it is serving | 1, 2 |
| R4.2 | It names how to verify a listing is live, watch activity, and check earnings | 1, 2 |
| R4.3 | It states that silence is expected, since silence is also the failure mode | 1, 2 |
| R4.4 | It prints before the listener message, so it is visible in a scrollback | 1, 2 |

**Known gap.** No machine-readable equivalent — a class-3 operator gets none of
this. `ctl status` requires the daemon to be up, which it now is, so this is a
smaller gap than it looks, but it is a gap.

---

## R5 — Money waiting on a human is visible where humans are (B5)

**Requirement.** A dashboard-dwelling operator learns that buyers are owed money
or that a fee tank has drained, without navigating to find out.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R5.1 | The TUI exposes wallet, refunds and deposits | 1 |
| R5.2 | Counts of items awaiting a human appear on the first screen | 1 |
| R5.3 | The counter never throws; a corrupt or missing ledger degrades to zero and never blocks the menu | 1 |
| R5.4 | TUI money views are read-only and do not reimplement the mutating paths | 1 |
| R5.5 | The mutating verbs are named so the operator can run them | 1 |

**Deliberate partial.** R5.2 covers refunds and deposit anomalies. **It does NOT
surface a drained fee tank**, which was half the original finding — an agent
whose R-address empties goes silent on-chain and the menu still says nothing.
Recorded as open.

---

## R6 — Prompts are controls only where something can answer (B7, E12)

**Requirement.** No confirmation may be satisfied by a caller that cannot be
asked, and no money command may report success without acting.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R6.1 | No TUI confirm that commits money or an on-chain write defaults to yes | 1, 2 |
| R6.2 | Wizard confirms that commit nothing irreversible may keep yes, and each exemption is enumerated with a reason | 1 |
| R6.3 | The TUI refuses to start without a TTY, before it is constructed | 2, 3 |
| R6.4 | Every money confirmation refuses a non-TTY | 2, 3 |
| R6.5 | That refusal uses an exit code distinct from ordinary failure | 2, 3 |
| R6.6 | The rule is asserted over the CLASS, so a new confirm cannot quietly join | all |

---

## R7 — Buyer text cannot instruct the operator (B8)

**Requirement.** Buyer-authored strings rendered into money-decision screens
cannot control the terminal or masquerade as system text.

**Acceptance criteria**

| # | Criterion | Class |
|---|---|---|
| R7.1 | Control characters, DEL, zero-width, bidi overrides and BOM are removed or neutralised | all |
| R7.2 | Length is capped so one field cannot flood a screen | all |
| R7.3 | Ordinary text — including accents and emoji — passes through unchanged | all |
| R7.4 | Buyer-authored fields are labelled as buyer-supplied on screen | 2, 3 |
| R7.5 | Applied on every money-decision surface that renders buyer text | all |

**Known limit.** This neutralises *presentation*, not *content*. A buyer can
still write persuasive prose; the label is what a class-2/3 operator has to act
on. `scanUntrusted` is deliberately NOT called here — flag if that is wrong.

---

## Out of scope, explicitly

- **B6** deposit-confirmed/reversal divergence — backend's decision, unshipped.
- **B1** publishing — done (2.29.1), but 2.30.0 for the R2–R5 work is unpublished.
- The dead `mainMenu` in `cli.js` — a message inside it was fixed rather than
  deleting ~460 unreachable lines. Deliberate scope hold, still open.
- `network-allowlist.json` (E13), extension black hole (E2), `ctl inbox-redrive`
  (E3), `providers` env-var advice (E4), cash-out story (E6).

## How to audit this

For each criterion: find the evidence, judge MET / PARTIAL / NOT MET / UNTESTABLE,
cite `file:line`. A criterion met only by a test asserting on source text — rather
than on behaviour — is **PARTIAL**, and say so: this repo has shipped
assertions that passed while the behaviour was wrong.
