# four-kind — audit report

**Date:** 2026-09-15 · **HEAD:** `5ca8776` · **Domain:** NEW (not in
`AUDIT/state.md`). Read-only; files under `AUDIT/` only. No src edits, no
tests run, no dispatcher start, no commits.

Four kinds: agent (labour hire + `job-chat`), compute (gpu-rental hire, SSH
via edge), data (browse-only, `DATA_NOT_HIREABLE`), model (access + deposit
+ chat, `MODEL_NOT_A_LABOUR_JOB`). Mint stays `name.agentplatform@` +
`config.kind`. DeFi remint out of scope. Jail G2/G3 not mixed in except
where docs mention compute.

**Counts:** crit 0 · high 0 · med 2 · low 0 · **total 2**

Claims: `AUDIT/four-kind-claims.md` — 54 VERIFIED · 5 DRIFT (B8, B12–B14,
G4) · 4 MISSING (E10, F7, G8, H3) · 4 UNVERIFIED (U1–U3, G9 platform).

---

## Findings

| ID | Sev | Summary | Anchor |
|---|---|---|---|
| K1 | med | TUI `[2]` / CLI `setup` still `registerService` a labour listing on kind=data (and kind=model). TUI `[5]` is diverted; `setup` is the remaining door | `dashboard.js:1433-1454`; `cli.js:4845-4878`, `891`; `cli.js:1901-1905` |
| K2 | med | TUI `[18]` and CLI `api-setup` do not refuse kind=data; `assertAccessAllowed` then treats the listing as a model | `dashboard.js:3771-3773`, `3955-3968`; `cli.js:5010-5141`; `hire.js:47-56` |

Buyer `hire` of a data identity is still locally refused when
`getAgent.kind` is `data` (**G1**). Buyer `hire` of a model is refused
(**G2**). TUI Hire browse/type of data/model is print-argv only (**E7/E8**).
The holes are **seller write paths**, not the buyer hire gate.

---

### K1 — med — `setup` registers labour on a data listing

**Where:** `src/dashboard.js:1433-1435` (TUI `[2]` spawns `setup <id> <name>
--kind data` with no `--profile-name`). `src/cli.js:4845-4850` (`setup`
enters `interactiveProfileSetup` whenever `!options.profileName`).
`src/cli.js:891` (`yesNo('  Create a service listing?', 'Y')`).
`src/cli.js:4875-4878` (`profileAgent.registerService(svc)`). Same
`registerService` loop on `register` at `cli.js:1901-1905`.

**Path.** Newcomer TUI `[2]` → Kind: data → confirm setup → subprocess
`setup` has no `--profile-name` → ~15-prompt `interactiveProfileSetup` →
bare Enter on “Create a service listing?” is **Y** → labour
`registerService` + `finalizeOnboarding({ services })`. Only *after* that
returns does the TUI print “Next is data-setup, not `[5]`” and call
`dataSetupScreen` (`dashboard.js:1450-1454`).

TUI `[5]` itself is closed: `configureServicesScreen` returns into
`dataSetupScreen` before the add loop (`dashboard.js:1535-1539`). The
README claim “Do **not** use TUI `[5]`” is true and insufficient.

CLI twin: `setup data-1 mydata --kind data` (no `--profile-name`) is the
same prompt. `setup --kind data --template code-review` merges
`service.name` + `service.price` (`cli.js:729-770`,
`templates/code-review/config.json:12-20`) and `registerService`s without
asking. Headless `--profile-name` without `--service-name`/`--service-price`
is the one path that stays empty (`buildServiceFromOptions` `cli.js:1014`).

**Trigger.** First-run TUI `[2]` pick **data**, Enter through setup
defaults, name a service. Or CLI `setup --kind data` with the default-Y
prompt / a labour template.

**What does *not* happen.** Dispatcher `hire <buyer> <that-seller>` still
hits `assertHireAllowed` with `sellerKind` from `getAgent` (`cli.js:3047-3056`)
and returns `DATA_NOT_HIREABLE` when that field is `data`. TUI Hire browse
kind=data never calls `hire`. Platform `POST /v1/jobs` is documented to
refuse the same code (**G9**, unverified here).

**What does happen.** A labour **service record** is created on a
kind=data identity. `listingRowFromService` uses `s.kind || 'agent'`
(`hire.js:128`): if `GET /v1/services` omits kind (**U3**), default
`listings` can show `hireable: yes` next to a data seller. `start` only
skips data listings that fail `data.endpoint` (`cli.js:5911-5923`); a data
identity that also has a website **and** that labour service is pushed
into `readyAgents`. `pollForJobs` has no kind=data skip (**F7**).

**Proposed fix (not applied).** For `kind=data` (and `kind=model`): do not
call `interactiveProfileSetup`’s service prompt; do not
`registerService`; do not pass labour `services` into `finalizeOnboarding`.
TUI `[2]` should pass `--profile-name` (or `--no-service`) so `setup` stays
headless. Default the service question to N if it remains for labour only.

---

### K2 — med — `[18]` / `api-setup` / access ignore kind=data

**Where:** `src/dashboard.js:3771-3773` (`apiEndpointSetupScreen` filters
`a.kind !== 'compute'` only). `dashboard.js:3955-3968`
(`registerService({ serviceType: 'api-endpoint' })`). CLI `api-setup`
(`cli.js:5010-5141`) has `assertApiEligibleAgent` (gpu-rental slot) and no
listing-kind check. `assertAccessAllowed` (`hire.js:47-56`) is “has
api-endpoint → ok”, no `sellerKind === 'data'` refuse.

**Path.** TUI `[2]` kind=data (or CLI `setup --kind data`) → later `[18]
API Endpoint Setup` lists that identity → confirm → `registerService`
api-endpoint. Or `j41-dispatcher api-setup data-1 --upstream-url …`. Buyer
`access` / `chat` then pass `assertAccessAllowed` because a service exists.

`data-setup` *after* `[18]` is blocked (`DATA_SLOT_CONFLICT`,
`data-setup.js:30-33`). The other order is not: data-setup first, then
`[18]`, still registers.

**Trigger.** Newcomer who listed data, then followed README `[18]` / 
`api-setup` (or TUI `[2]` model copy that says “same metered api-endpoint
rail as compute”, B14) against the data folder.

**What does not happen.** `hire` of that identity is still
`DATA_NOT_HIREABLE` (kind is checked before `serviceType`, `hire.js:20-25`).
This is not a labour hire.

**What does happen.** A data listing becomes a metered model grant
(access/chat/deposit). Browse URL may still be missing if they never
finished `data-setup` without `--no-register`. Doctor `data.endpoint` and
`model.public_url` / `model.webhook` can both fire on the same id.

**Proposed fix (not applied).** Filter `kind === 'data'` out of
`apiEndpointSetupScreen` the same way compute is filtered. `api-setup`
refuse `DATA_SETUP_WRONG_KIND`-shaped (`API_SETUP_WRONG_KIND`).
`assertAccessAllowed` refuse `sellerKind === 'data'` even if an
api-endpoint was attached.

---

## Adversarial: shortest wrong-kind paths

Asked: newcomer picks the wrong kind (or TUI `[5]` on data) → hireable
labour on a data listing, **or** hire of a model, **or** missing browse
URL.

### 1. Hireable labour on a data listing

**TUI `[5]` on data: closed.** `configureServicesScreen` diverts at
`dashboard.js:1535-1539` before “Add agent service”.

**TUI `[2]` pick data: open (K1).** Shortest path is `[2]` → data → Enter
through `setup` → default-Y labour service. Dispatcher `hire` of that
*identity* is still G1-refused when `getAgent.kind` is `data`. The labour
*service* is what leaks onto `GET /v1/services` (U3 decides whether
listings show `hireable: yes`). Seller `start` will advertise if
`data.endpoint` later passes.

**TUI `[2]` pick agent when they meant data:** they get a hireable labour
listing by design. Not a rail bug.

**CLI omit `--kind`:** `setup`/`register` default `--kind agent` (A7). A
folder named `data-1` is still labour. Documented default.

### 2. Hire of a model

**Closed on the buyer verbs.** CLI `hire` → `MODEL_NOT_A_LABOUR_JOB`
(`hire.js:37-42`). TUI Hire browse `kindPick === 'model'` prints
access/chat/deposit argv and returns (`dashboard.js:2381-2393`). Typed
seller with `listing.kind === 'model'` same (`2460-2467`). Missing
top-level kind on CLI is `SELLER_KIND_UNKNOWN` (G3), not an agent default.

TUI typed-hire defaults missing kind to `'agent'` (G4) then
`runDispatcherCli(['hire', …])`, which fails closed. Confusing, not a
successful hire.

K1 on kind=model can attach a *labour* service to a model identity; buyer
`hire` of that identity is still `MODEL_NOT_A_LABOUR_JOB` if
`getAgent.kind` is `model`.

### 3. Missing browse URL

**Honest when `data-setup` is used.** No website/endpoints →
`DATA_SETUP_NO_ENDPOINT`. `--no-register` and VDXF-write failure both print
that browse will not see the URL (D7, D9). Doctor `data.endpoint` fails
and `pickNext` is `data-setup`, not `start` (F2–F4). `browse` never GETs
description (B5) — a trycloudflare in the blurb cannot become the URL.

**Skip `data-setup`:** TUI `[2]` offers `dataSetupScreen` after setup; CLI
`setup --kind data` Next is `data-setup --website`. If they skip, browse
is `BROWSE_NO_ENDPOINT`. Doctor says so. Not silent.

**Platform mapping (U1):** `data-setup` writes VDXF `profileWebsite`;
`browse` reads API `website` / `networkEndpoints`. If the indexer does not
copy those fields, browse is empty after a successful on-chain write.
Not traced past this repo.

K2 can leave a data listing with an api-endpoint and still no browse URL
if they never dropped `--no-register`.

---

## Focus checklist (as asked)

| Item | Result |
|---|---|
| README CLI table includes access, chat, deposit, browse, job-chat | **VERIFIED** `README.md:215-219` |
| CHANGELOG Unreleased must NOT say sovmodel coming soon / not mintable | **VERIFIED** Unreleased `225-229` “first-class” |
| CHANGELOG Unreleased must NOT say reviews shipped | **VERIFIED** (2.37.3 still fail-closed on `J41-REVIEW\|`) |
| `data-setup`: VDXF rind `profileWebsite`+`networkEndpoints`; no `registerService`; refuse unregistered; `--no-register` honest | **VERIFIED** |
| TUI `[2]` data/model must not say Use `[5]` | **VERIFIED** (copy). **K1:** `[2]` still runs labour `setup` |
| Hire data prints `browse <sellerId>`; hire model prints access/chat/deposit argv; print-argv only | **VERIFIED** `dashboard.js:2370-2393`, `2454-2467` |
| doctor `CHECK_IDS` `data.endpoint`; data-only fleet `pickNext` is listings not start | **VERIFIED** `doctor.js:22`, `345-360` |
| `api-setup` Next is `start --webhook-url`; poll does not bind proxy | **VERIFIED** `cli.js:5142-5143`, `6770-6812` |
| listings data footer `browse` | **VERIFIED** `cli.js:3298-3300` |

---

## Clean (in this domain)

- Mint is `name.agentplatform@` for all four kinds; `keys.kind` is written
  on `register`/`setup`; `listingsCollide` is same-leaf.
- Buyer hire gate: data → `DATA_NOT_HIREABLE`; model / api-endpoint →
  `MODEL_NOT_A_LABOUR_JOB`; missing kind → `SELLER_KIND_UNKNOWN`.
- TUI `[5]` data/model diversion; TUI Hire print-argv for data/model; no
  ECDH in TUI.
- `data-setup` module is a VDXF rind (no `registerService`, HTTP(S) only,
  ephemeral URLs refused, `--no-register` honest).
- `browse` never uses description.
- Doctor `data.endpoint` + data-only Next = `listings`/`browse`.
- Poll mode does not bind the proxy; `api-setup` Next names that.
- CHANGELOG Unreleased matches the live-kind story; no “reviews shipped”.
- Friend-boot docs in README/CLAUDE match `compute.outbound-ssh-v1` (G1
  from the gpu-jail pass is not re-opened).

---

## Deliberately NOT covered, and why

- **Platform `POST /v1/jobs` and indexer field mapping (U1–U3, G9).**
  Dispatcher is the client. Marked UNVERIFIED rather than guessed.
- **Jail G2/G3 / Cat-1 isolation.** Other domain; friend-boot docs only.
- **DeFi remint to sovdata@ / sovmodel@.** Out of scope by brief.
- **Dead `cli.js` `mainMenu` / `registerAgentIdentity`.** Unreachable
  (docs-truth D7). Its error string omits `model`; not operator-facing.
- **Review / `J41-REVIEW|` / `review-session`.** Changelog explicitly
  does not claim reviews; not this domain.
- **Running any code.** Read-only. No `node --test`, no `start`, no live
  API. Every finding is a static path to `file:line`.
