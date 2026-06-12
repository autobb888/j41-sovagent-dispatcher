# Dispatcher v3 — headless-first, buyer mode, and the brainbox seam

> **Who this doc is for.** The owner (autobb888), sitting down to rework
> `j41-sovagent-dispatcher` so it (1) works as the hosting/earning muscle for
> ANY agent system, (2) plugs into brainbox as a peer daemon with zero custom
> glue, and (3) gains the buyer-side hire flow that doesn't exist today.
> Companion context lives in the brainbox repo: `docs/VERBS.md`
> (complexity-budget rule 8 — rooms), `docs/fable/2026-06-10-spec-7-…workers.md`
> (the execution registry + `kind: j41` reserved seam),
> `docs/fable/2026-06-11-spec-8-monitor.md` (the monitor room — SHIPPED,
> `http-api` + `docker:<name>` probes live), and roadmap §8.15 + §8.7.

---

## 1. The thesis (read this even if you skip the rest)

The dispatcher today is a **seller-side, TUI-first** product: a human runs
`j41-dispatcher dashboard`, agents earn VRSC. Three structural changes make it
universal:

1. **Headless-first.** Everything the TUI can do becomes a versioned local
   HTTP API; the TUI becomes just another client of it. Then *any* agent
   system — brainbox, a cron script, n8n, somebody else's orchestrator — can
   run a dispatcher. This is what "plug and play" actually means: not a
   brainbox adapter, but a machine-first control surface anyone can drive.
2. **Buyer mode.** A `hirer` subsystem inside the same daemon: post jobs, pay,
   relay the chat, fetch deliverables, approve extensions under caps,
   accept/dispute. The SDK, the WIF custody, SovGuard, and the payment rails
   are already in this codebase — the buyer flow reuses ~70% of them.
3. **brainbox stays out of the container business.** brainbox gets a thin
   **`shop` room** (intent + catalog + cards); the dispatcher remains the
   muscle that registers agents, runs hardened containers, and moves money.
   The monitor room watches the dispatcher *from outside* via the probes that
   already shipped. No brainbox code ever execs docker.

The division of labor, end-state:

```
                 brainbox (Python, the brain + the face)
   ┌──────────────┬──────────────┬───────────────┬──────────────┐
   │ verbs        │ workers room │ monitor room  │ shop room    │  ← rooms
   │ (doors)      │ (spec 7,     │ (spec 8,      │ (NEW —       │
   │              │  hires LOCAL │  watches via  │  sells via   │
   │              │  claude -p)  │  probes)      │  dispatcher) │
   └──────┬───────┴──────┬───────┴───────┬───────┴──────┬───────┘
          │              │ kind: j41     │ http-api /   │ control API
          │              │ (rung 3b+)    │ docker probes│
          ▼              ▼               ▼              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │            j41-dispatcher daemon (Node, this repo)           │
   │  control API (NEW) · hirer (NEW) · seller pool (today)       │
   │  executors (today: local-llm/webhook/mcp/a2a/lang*)          │
   │  containers · WIF custody · SovGuard · payments · allowlists │
   └──────────────────────────┬───────────────────────────────────┘
                              ▼
                      Junction41 platform
```

---

## 2. The brainbox room landscape (context, so the seam is scoped right)

brainbox's complexity budget allows **two registries forever** (verbs +
execution backends) and a **closed set of rooms** — subsystems with standing
state, entered only through verb doors, surfacing only through fixed card
shapes. Current rooms: collections, mirror, plans, artifacts, **workers**
(spec 7, live), **monitors** (spec 8, live). The dispatcher work adds exactly
ONE new room on the brainbox side:

### The `shop` room (proposed name; alternatives: `stand`, `fleet`)

*What I sell on J41, and how it's doing.* Standing state that outlives any
utterance — offerings, their listing state, their earnings — therefore a room,
per rule 8. Scope it deliberately small:

- **Store:** `home/shop/` — one md file per **offering** (frontmatter =
  machine state: dispatcher agent id, service id, container name, state,
  price; body = the human-readable description + earnings history table).
  The plans/monitors store idiom exactly.
- **Doors (verbs):** `sell …` / shop-card taps (list / pause / resume /
  earnings / retire). Creation is a **card flow**, not a one-shot utterance:
  voice opens a prefilled offering card; **▶ Publish** is the consent tap
  that calls the dispatcher API. Propose-don't-perform throughout.
- **Surfaces:** a 🛒 web tab (list + card, the plans-tab pattern), 🔔 events
  (job completed, dispute filed, earnings milestone), a `today` line
  ("your shop: 3 jobs, 1.4 VRSC this week").
- **What it does NOT do:** run containers, hold the WIF, talk to J41, manage
  executors, restart anything. Every one of those is a dispatcher API call.
  The room is intent + catalog + filing what happened into the brain.
- **Monitoring is NOT this room's job either.** The monitor room already
  watches: `http-api` probe on the dispatcher's health endpoint (one watch,
  `extract: agents.0.status`-style paths), `docker:<name>` probes per
  offering container if on the same box, or `http-api` against the other
  server's exporter. The shop room can OFFER a chip at publish time —
  "watch this offering for errors?" — which creates a normal spec-8 watch.
  One engine, no second scheduler. (Rule 8: one scheduler, forever.)
- **Membrane law for selling:** an offering's dataset/SOUL/config is
  **published content** — it leaves the box by explicit Publish consent, and
  it is assembled in the artifacts dir (`home/artifacts/shop/<slug>/`), never
  read live from the vault. Curate in the brain → export an artifact →
  publish the artifact. The brain itself never mounts into a container.

The shop room needs its own owner-signed roadmap §8 entry before building
(rooms are added deliberately). This doc is the input to that entry; the
dispatcher work below is what makes the room thin enough to be worth having.

---

## 3. Dispatcher rework — the work packages

### WP-D1 — the control API (headless-first; the keystone)

Promote the control plane from the Unix-socket `ctl` + TUI to a versioned,
localhost-bound HTTP API. The socket and TUI stay, reimplemented as clients.

- **New module `src/control-api.js`** (HTTP server, bind `127.0.0.1`,
  configurable port, default e.g. `:9843` next to the existing `:9842`
  health server — or fold health/metrics into it and keep `:9842`).
- **Auth:** bearer token at `~/.j41/dispatcher/control.token`, mode 0600,
  auto-created at startup, localhost-exempt OPTIONAL but default OFF (unlike
  brainbox serve, this daemon moves money — require the token even from
  localhost; the file being 0600 makes same-user access trivial and
  other-user access impossible). This mirrors brainbox's `serve.token` /
  `auth.py` idiom so the two daemons feel the same to operate.
- **Surface (v1, all JSON):**
  - `GET  /v1/agents` · `POST /v1/agents` (the `setup` pipeline as an API:
    template, name, profile) · `POST /v1/agents/:id/activate|deactivate`
  - `GET  /v1/offerings` · `POST /v1/offerings` (service registration —
    see WP-D5 packaging) · `POST /v1/offerings/:id/pause|resume|retire`
  - `GET  /v1/jobs` (active + recent, the `ctl jobs`/`ctl history` data)
    · `GET /v1/jobs/:id` · `GET /v1/jobs/:id/log`
  - `GET  /v1/earnings` (per-agent, per-offering rollups)
  - `GET  /v1/status` (uptime, pool, queue, runtime, isolation score)
  - `POST /v1/disputes/:jobId/respond` (the `respond-dispute` CLI as API)
  - everything under `/v1/hire/*` from WP-D3
- **Rule:** no new feature lands TUI-only ever again. TUI screens call the
  API; if the API can't express it, fix the API.
- **Why this is the brainbox seam:** brainbox's shop room becomes ~nothing
  but verb doors + cards over these endpoints. And it's the "any agent
  system" answer — the API is the product; brainbox is one client.

### WP-D2 — the event surface (what brainbox's bubbles/🔔 subscribe to)

brainbox polls; it does not hold sockets open (the `/activity` + ready-bubble
idiom, 6s visible-tab polling). Match that shape:

- `GET /v1/events?since=<seq>` — monotonic `seq`, ring buffer (file-backed,
  survives restart), JSON events:
  `job.requested|accepted|started|delivered|completed`, `dispute.filed|resolved`,
  `extension.requested|approved|rejected` (both directions — see WP-D3/D4),
  `container.started|died`, `agent.online|offline`, `earnings.received`,
  `hire.*` mirror events for buyer-side jobs.
- Keep the existing outbound webhook mode for users who want push; the
  polling endpoint is the lowest-common-denominator contract.
- **Monitor-room contract:** every event also updates `GET /health` (extend,
  don't break): per-agent + per-container status array with stable dotted
  paths, e.g. `containers.0.name` / `containers.0.state` /
  `agents.0.lastError`. Spec-8 `http-api` probes extract dotted paths from
  JSON — design the health document so one probe + `condition: changed` or
  `matches:` can watch the whole fleet. Numeric rollups
  (`summary.containers_unhealthy: 0`) make `above:0` the canonical
  "tell me when anything is wrong" watch. **This field stability is a
  compatibility promise** — document it in README as such.

### WP-D3 — buyer mode: the `hirer` (the accessible hire flow)

New subsystem in the same daemon (shares SDK auth, sign-broker, allowlists):

- **Identity:** the hirer uses its own VerusID + WIF (`~/.j41/hirer/keys.json`,
  0600) — never an agent's. One custody point; brainbox never sees it.
- **API:**
  - `GET  /v1/hire/services?q=…&category=…&max_price=…` — discovery
    (platform search proxied, normalized).
  - `POST /v1/hire/jobs` — `{serviceId, brief, files?, budget: {max_vrsc,
    max_extensions, max_extension_vrsc}, auto_accept: bool}`. The **brief is
    the only content field** — the caller's membrane problem, by design; the
    hirer transmits it verbatim and nothing else.
  - `GET  /v1/hire/jobs/:id` — state machine:
    `quoted → accepted → paid → in_progress → delivered → completed|disputed`.
  - `POST /v1/hire/jobs/:id/pay` — explicit, separate from create. Payment
    is never implicit in job creation. (brainbox puts its consent tap here.)
  - `POST /v1/hire/jobs/:id/message` + `GET …/messages` — SovGuard chat
    relay, polled like events.
  - `GET  /v1/hire/jobs/:id/delivery` — the deliverable: files + text +
    attestation, fetched to a local job dir
    (`~/.j41/hirer/jobs/<id>/out/`).
  - `POST /v1/hire/jobs/:id/accept | /dispute | /extension/:extId/approve|reject`
- **Spend safety (deny-all heritage, non-negotiable):**
  - reuse the financial-allowlist machinery for outbound payments (the
    platform fee + seller pay addresses get the dynamic-lifecycle treatment
    jobs already get on the seller side);
  - hirer-level caps in `config.toml`: `max_vrsc_per_job`,
    `max_vrsc_per_day`, `max_open_jobs` — enforced in the daemon, **fail
    closed**, independent of whatever the client asks for;
  - extension requests NEVER auto-approve above the per-job
    `budget.max_extension_vrsc`; above it → `extension.requested` event and
    the job WAITS. (brainbox turns that event into a propose-don't-perform
    chip; a headless script can poll and decide; nobody's money moves on a
    seller's say-so.)
- **brainbox mapping (so the seam is exact):** spec-7's execution registry
  already reserves `kind: j41` (parses today, refuses at dispatch). Flipping
  it on = a `backends.md` row whose dispatch path is: write `brief.md` →
  `POST /v1/hire/jobs` → poll → fetch delivery into the SAME job-dir shape →
  the existing mechanical verification → artifacts → mirror manifest → 🔔.
  No new brainbox pipeline; the hirer is just a remote way to run a brief.

### WP-D4 — extension & token-budget hardening (the audit findings)

Confirmed gaps (2026-06-10 review of this repo) — fix on the seller side
*before* the hirer ships, because buyer mode makes them money-losing on both
sides of the same install:

1. **`isOverBudget()` has zero call sites** (`src/executors/base.js:53`).
   The budget never stops anything. Fix: the executor loop checks it before
   every LLM call; over budget → pause generation, notify
   (`extension_needed`), and hard-stop the session if no approval within a
   configurable window. Deliver partial + honest status, never silent burn.
2. **`setBudget` only fires on the rework path** (`src/job-agent.js:1054`).
   Initial jobs run unlimited. Fix: derive the initial budget from the job
   price via the SDK pricing calculator at `processJob` start, always.
3. **Currency confusion** in `_checkBudget`
   (`src/executors/local-llm.js:209-231`): a flat $0.001/1K-token USD
   estimate compared against `job.amount` in VRSC, plus magic numbers
   (`>10000` tokens, `*0.3`, `jobAmount < 5`). Fix: one conversion helper,
   one configurable rate source (platform-provided VRSC rate, cached, with
   a stale-rate fail-closed), zero inline constants.
4. **Extension pricing is guesswork** (`src/job-agent.js:1063-1071`):
   fallback model id `'claude-sonnet-4'` (not a real id), assumed 50/50
   input/output split, markup fallback 15, and a hardcoded VRSC↔USD `0.5`
   in the rework budget (`job-agent.js:1260`). Fix: price from the job's
   ACTUAL model + the session's observed input:output ratio.
5. **One-shot flags** (`_budgetWarningFired`, `_budgetRequested`): a second
   overrun never re-asks. Fix: re-arm on each granted extension (edge
   semantics — same law as spec-8 conditions).
6. **Usage is unauditable by the buyer.** Token counts exist only in the
   seller's meter. Fix: include cumulative `{promptTokens, completionTokens,
   llmCalls, extensions: [...]}` in the job-record/attestation payload so
   both sides sign over the same usage story. (You own the backend — add
   the field there too.) This is what makes extension requests *trustable*
   enough for any buyer-side auto-approve to ever be sane.

### WP-D5 — offering packaging (sell a workflow or a dataset, not a vibe)

Make "a thing I sell" a first-class, portable artifact instead of TUI state:

- **An offering = a directory** (`offering.json` + `SOUL.md` + optional
  `data/`): identity-less template + executor config + pricing + session
  params + an optional **read-only data volume** (the curated dataset,
  mounted into the job container at a fixed path, e.g. `/data`, ro).
- `POST /v1/offerings` (and `j41-dispatcher offer ./my-offering/`) takes the
  directory, validates (schema + the WP-D6 lint: declared executor vs
  config, declared egress vs network allowlist), binds it to an agent slot,
  registers the service. The existing templates/ become offerings v0.
- **Dataset-backed agents, v1 mechanism — keep it dumb:** the executor
  already supports `mcp` and `webhook`; a dataset offering is `local-llm`
  + a generated system-prompt preamble pointing at `/data` manifest, or
  `mcp` with a tiny read-only file server. Do NOT build a RAG engine into
  the dispatcher; if a seller wants retrieval, their offering ships it
  (webhook → their stack). The dispatcher's job is mounting, isolation,
  metering, payment.
- **brainbox flow:** curate in the brain → `sell` verb assembles the
  offering dir under `home/artifacts/shop/<slug>/` (the consented export
  moment — content review ON THE CARD before anything leaves) → Publish tap
  → `POST /v1/offerings`. The vault is never mounted; only the exported
  artifact is.

### WP-D6 — ops hardening for fleet-watching (small, do alongside D2)

- Per-container restart policy + crash counters surfaced in `/health`
  (monitor probes read them; the OWNER decides restarts via a chip/API call
  — the dispatcher may auto-restart per policy, but policy is config the
  operator set, never inference).
- `GET /metrics` gains per-offering job counts, error counts, earnings —
  Prometheus-compatible stays, since "any agent system" includes Grafana.
- PID/liveness: keep the PID file; add `GET /v1/status.scheduler_alive`
  -style self-checks so a wedged poller is *visible*, not just a silent
  stall (the announce-your-own-death law, applied to this daemon).

---

## 4. The contract card (the whole seam on one screen)

What brainbox consumes — and therefore what must stay stable:

| brainbox piece | dispatcher surface | direction |
|---|---|---|
| monitor room (spec 8, live) | `GET /health` (stable dotted paths), `GET /metrics` | read, polled |
| shop room (new, §2) | `/v1/agents`, `/v1/offerings`, `/v1/earnings`, `/v1/events` | read/write, consent-tapped |
| workers room `kind: j41` (spec 7 seam) | `/v1/hire/*` | write brief, poll, fetch delivery |
| 🔔 / ready bubble | `GET /v1/events?since=` | read, polled |
| auth | `control.token` file, bearer header | both daemons, same idiom |

Laws that hold on both sides of the seam:

1. **The brief is the only content that crosses.** The dispatcher never sees
   the brain; brainbox never sees the WIF. Custody and membrane are the two
   halves of the same wall.
2. **Money moves only on an explicit, separate call** (`/pay`, `/approve`),
   each gated by daemon-side caps that the *client cannot raise* per-request.
3. **Polling, not push,** is the baseline transport; push (webhooks) is an
   optional upgrade for non-brainbox users.
4. **Health-document field paths are versioned API.** Monitor watches break
   silently if paths drift — treat a renamed field like a removed endpoint.
5. **Everything the TUI can do, the API can do.** New features land
   API-first.

---

## 5. What this doc deliberately does NOT do

- Build the shop room (needs its roadmap §8 entry + owner sign-off on the
  name and card shapes; this doc is the input).
- Flip `kind: j41` on in brainbox (rung 3b+; do it only after WP-D3 ships
  AND the spec-7 verification path has a J41-shaped test).
- Reimplement Verus crypto in Python — settled: the JS daemon keeps all
  signing; brainbox stays a client.
- Decide VRSC pricing strategy for offerings (market discovery; §8.7's
  instrumentation answers it with data).
- Multi-box dispatcher federation (one daemon per box; the monitor room
  watches N of them via N watches — that's already enough).

## 6. Suggested build order

1. **WP-D1 control API skeleton** (status/agents/jobs read-only first) +
   **WP-D2 events + health-document** — immediately useful: the monitor
   room can watch a dispatcher the day this lands, zero brainbox changes.
2. **WP-D4 extension/budget hardening** — protects the seller you already
   are, and is prerequisite trust for any buyer.
3. **WP-D3 hirer** (discovery + jobs + pay + delivery; chat relay can lag).
4. **WP-D5 offering packaging** + **WP-D6 ops** — then the brainbox shop
   room's §8 entry, then the room itself (thin by construction).
5. Last: flip spec-7's `kind: j41` refusal into a dispatch path.

Each WP should land with: `node --check` clean, unit tests beside the
existing `test/*.test.js` set, README section, and — for anything touching
money — the same fail-closed test discipline as `credit-meter.js`
(invalid input must price to `Infinity`/deny, never to free).
