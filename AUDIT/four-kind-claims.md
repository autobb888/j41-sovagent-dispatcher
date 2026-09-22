# four-kind — claims checklist

Date: 2026-09-15. HEAD `5ca8776`. Domain is NEW (not in `AUDIT/state.md`).

A claim is anything an operator would act on: a kind, a Next string, a
refuse code, a command in the README CLI table, a TUI diversion, a doctor
check id. Sources: README CLI table + Data listings + API proxy + Cat-1
friend boot, CLAUDE.md Quick Reference, CHANGELOG Unreleased,
`src/listing-kind.js`, `src/data-setup.js`, TUI `[2]`/`[5]`/Hire/`[18]`,
`src/doctor.js`, `src/hire.js`, buyer verbs.

Status: VERIFIED / DRIFT / MISSING / UNVERIFIED.

---

## A. Kinds and mint (DeFi off)

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| A1 | Four live kinds: agent, compute, data, model | VERIFIED | `src/listing-kind.js:11` `LISTING_KINDS`; TUI `[2]` offers all four (`dashboard.js:1349-1358`, compute hidden off Linux) |
| A2 | Intended parents sovagent@ / sovcompute@ / sovdata@ / sovmodel@ | VERIFIED (docs of intent) | `KIND_PARENTS` `listing-kind.js:13-18`. Not minted while DeFi is off |
| A3 | Every kind mints `name.agentplatform@`; real kind is `config.kind` / `keys.json` | VERIFIED | `advertisedIdentity` always `LEGACY_AGENT_PARENT` (`listing-kind.js:34-38`); `register`/`setup` write `keys.kind = result.kind \|\| kind` (`cli.js:1840`, `4809`) |
| A4 | `sovmodel` is first-class (metered inference), not coming-soon / not-mintable | VERIFIED | CHANGELOG Unreleased `225-229`; TUI `value: 'model'` (`dashboard.js:1357`); `parseListingKind('model')` (`listing-kind.js:29-31`); test `listing-kind.test.js:72-77` |
| A5 | Same leaf collides across kinds (one parent) | VERIFIED | `listingsCollide` (`listing-kind.js:74-80`); TUI `[2]` (`dashboard.js:1383-1389`) |
| A6 | `--kind` on `register` / `setup` / `quickstart` is agent \| compute \| data \| model | VERIFIED | `cli.js:1760`, `4666`, quickstart prompt `1564-1568`; unknown → exit 1 |
| A7 | CLI `setup` / `register` `--kind` default is `agent` | VERIFIED | commander default `'agent'` (`cli.js:1760`, `4666`). Omitting `--kind` on a data folder mints labour |

## B. README / CLAUDE operator surface

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| B1 | README CLI table includes `access`, `chat`, `deposit`, `browse`, `job-chat` | VERIFIED | `README.md:215-219`; commands exist `cli.js:3732`, `3830`, `3964`, `4142`, `4171`; test `friend-boot-docs.test.js:143-155` |
| B2 | `access` is ECDH API grant, not a labour hire | VERIFIED | README:215; `cli.js:3733`; `assertAccessAllowed` (`hire.js:47-56`) |
| B3 | `chat` is OpenAI-compatible against a model grant; runs `access` if none saved | VERIFIED | README:216; `cli.js:3830-3877` |
| B4 | `deposit` is buyer VRSC + POST `/j41/deposit/report`, distinct from seller `deposits` | VERIFIED | README:217; `cli.js:3964-3966` vs `deposits` at `15509` |
| B5 | `browse` GETs data `website` / `networkEndpoints[0]`, not a hire | VERIFIED | README:218, `823-829`; `buyer-browse.js:43-46` never reads `description` |
| B6 | `job-chat` is signed labour chat, not model `chat` | VERIFIED | README:219; `cli.js:4171-4172` |
| B7 | Data: mint still `name.agentplatform@`; URL never in description; `hire` is `DATA_NOT_HIREABLE` | VERIFIED | README:823-829; `assertHireAllowed` `hire.js:20-25`; `refuseDataListingDescriptions` `listing-description.js:27-38` |
| B8 | Seller data path is `data-setup`, VDXF rind, no `registerService`, no TUI `[5]`, no `start` for browse-only | VERIFIED (docs) / **DRIFT (setup)** | README:827. `data-setup` itself matches (D*). `setup --kind data` still `registerService`s labour if the operator accepts the default-Y prompt → finding **K1** |
| B9 | API proxy is webhook-mode-only; after `api-setup`, Next is `start --webhook-url`; bare `start` does not advertise the proxy | VERIFIED | README:839; `cli.js:5142-5143`; poll branch warns and does not call `startWebhookServer` (`cli.js:6802-6812` vs webhook `6770-6779`) |
| B10 | Cat-1 friend boot is `compute.outbound-ssh-v1`, not a seller named TCP tunnel; `tunnel-setup` is HTTP model `publicUrl` | VERIFIED (this domain) | README:871; CLAUDE.md:35. G1 in `AUDIT/gpu-jail.md` owned the previous tunnel wording; current README/CLAUDE match the edge |
| B11 | CLAUDE.md Quick Reference lists `access` / `chat` / `deposit` / `browse` / `job-chat` and `--kind agent\|compute\|data\|model` | VERIFIED | CLAUDE.md:14-25 |
| B12 | README TUI `[2]` is “Add New Agent” | **DRIFT** | README:101 vs live `[2] Sign up — register a listing` (`dashboard.js:329`) |
| B13 | quickstart data copy: “attach a data policy and an endpoint” | **DRIFT** | `cli.js:1611-1612`. Later Next is `data-setup --website` (`1672-1674`), which is the real command |
| B14 | quickstart model copy: “same metered api-endpoint rail as compute” | **DRIFT** | `cli.js:1607-1609`. Compute is Cat-1 `gpu-rental`; model/api-endpoint is Cat-2. Next lines (`1666-1671`) are correct |

## C. CHANGELOG Unreleased

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| C1 | Unreleased section exists and is above `2.37.3` | VERIFIED | `CHANGELOG.md:216` (section sits at top of historical 2.37.3 — file order is Unreleased after 2.37.3 body in this tree; heading is present) |
| C2 | Unreleased must NOT say sovmodel coming soon / not mintable | VERIFIED | Unreleased `225-237`: “sovmodel is a live listing kind”; “first-class (metered inference)”. Test `friend-boot-docs.test.js:157-165` |
| C3 | Unreleased must NOT say reviews shipped | VERIFIED | no `reviews shipped` in the Unreleased slice; 2.37.3 still “fail-closed: review until backend `J41-REVIEW\|`” (`CHANGELOG.md:19`) |
| C4 | Unreleased: data-setup is VDXF rind, no `registerService`; Next strings kind-aware | VERIFIED (data-setup / Next copy) | `CHANGELOG.md:218-223`. Seller `setup` labour `registerService` is not claimed here |

## D. `data-setup` (VDXF rind)

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| D1 | Writes `profileWebsite` + `networkEndpoints` (JSON string), never `endpoints[]` | VERIFIED | `buildDataVdxfFields` `data-setup.js:80-87` |
| D2 | Does **not** `registerService` | VERIFIED | `cli.js` `data-setup` block `5153-5246` has `removeAndRewriteVdxfFields` only; test `data-setup.test.js:129-140` |
| D3 | Refuses non-data kind | VERIFIED | `assertDataSetupAllowed` `DATA_SETUP_WRONG_KIND` (`data-setup.js:23-28`) |
| D4 | Refuses mixed api-endpoint / gpu-rental slot | VERIFIED | `DATA_SLOT_CONFLICT` (`data-setup.js:30-33`) |
| D5 | HTTP(S) only; refuses trycloudflare / ngrok / localhost / RFC1918 | VERIFIED | `assertHttpUrl` + `descriptionHasEphemeralUrl` (`data-setup.js:36-46`) |
| D6 | Default path refuses unregistered (no identity / i-address) | VERIFIED | `cli.js:5197-5201` when `options.register` (Commander `--no-register` inverts; default is register) |
| D7 | `--no-register` is honest: browse will not see the URL until VDXF write | VERIFIED | `cli.js:5208-5212`; `dataSetupNextLines(..., { localOnly: true })` `data-setup.js:137-143`; sets `dataEndpointLocalOnly` (`data-setup.js:71-76`) |
| D8 | Success Next is `listings --kind data` + `browse <seller>`, never `start` | VERIFIED | `dataSetupNextLines` `data-setup.js:145-149`; test `data-setup.test.js:102-107` |
| D9 | VDXF write failure keeps local config and says browse will not see the URL | VERIFIED | `cli.js:5238-5241` |
| D10 | Buyer `browse` reads GET `/v1/agents/:seller` `website` / `networkEndpoints[0]` / typed `endpoints[].url` | VERIFIED (client) | `buyer-browse.js:18-46`, `100-118`. Mapping from on-chain `profileWebsite` → API `website` is platform-side → **U1** |

## E. TUI `[2]` / `[5]` / Hire

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| E1 | `[2]` data Next is data-setup, **not** “Use `[5]`” | VERIFIED (copy) | `dashboard.js:1423`, `1450-1453`; test `data-setup.test.js:185-192` `doesNotMatch` `Use [5] Configure Services to attach the data policy` |
| E2 | `[2]` model Next is `[18]` then `start --webhook-url`; not `[5]` | VERIFIED | `dashboard.js:1422`, `1456-1458` |
| E3 | `[2]` data then runs `dataSetupScreen` (not labour add) | VERIFIED | `dashboard.js:1453` |
| E4 | `[2]` data/model `setup` subprocess does not pass `--profile-name` | VERIFIED (this is the K1 trigger) | `dashboard.js:1433-1435` `setupArgs = [..., 'setup', agentId, name, '--kind', kind]` |
| E5 | `[5]` kind=data diverts to `dataSetupScreen`; labour/API add refused | VERIFIED | `dashboard.js:1535-1539` **before** the add/`registerService` loop |
| E6 | `[5]` kind=model diverts to `[18]`; labour “Add agent service” refused | VERIFIED | `dashboard.js:1542-1555` |
| E7 | Hire browse kind=data prints `browse <seller>` (filled id), does not hire | VERIFIED | `dashboard.js:2370-2379` `r.seller \|\| r.qualifiedName`; typed path `2454-2458` uses `sellerId` not `sellerName` |
| E8 | Hire browse/type kind=model prints access/chat/deposit argv; “Print-argv only — no ECDH in TUI” | VERIFIED | `dashboard.js:2381-2393`, `2460-2467`; no `requestApiAccess` in `hireScreen` |
| E9 | `[18]` API Endpoint Setup excludes compute listings | VERIFIED | `dashboard.js:3771-3773` `.filter(a => a.kind !== 'compute')` |
| E10 | `[18]` also excludes kind=data | **MISSING** | same filter does **not** drop `data`. Finding **K2** |

## F. Doctor

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| F1 | `CHECK_IDS` includes `data.endpoint` | VERIFIED | `doctor.js:16-22` |
| F2 | On-chain data listing without HTTP(S) website/endpoints fails `data.endpoint` | VERIFIED | `doctor.js:889-907` + `dataEndpointRefusal` |
| F3 | Local-only (`--no-register`) website fails `data.endpoint` with drop `--no-register` copy | VERIFIED | `data-setup.js:118-122`; `listingAdvertiseRefusal` test `doctor.test.js:767-773` |
| F4 | All-green **data-only** fleet `pickNext` is `listings --kind data` (+ browse), **not** `start` | VERIFIED | `dataOnlyOnChainNext` `doctor.js:345-352`; `pickNext` `355-360`; test `doctor.test.js:786-793` |
| F5 | Mixed data+agent all-green `pickNext` is `start` | VERIFIED | `doctor.test.js:801-808` |
| F6 | `start` does not advertise a data listing that fails `data.endpoint` | VERIFIED | `listingAdvertiseRefusal` in start loop `cli.js:5911-5923` |
| F7 | `start` / `pollForJobs` refuse kind=data even when `data.endpoint` passes | **MISSING** | no kind=data skip after the endpoint gate. A data identity that also has a labour service (K1) is pushed into `readyAgents` |

## G. Hire / access rails

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| G1 | Dispatcher `hire` refuses kind=data (`DATA_NOT_HIREABLE`) even with a labour `serviceType` | VERIFIED | `hire.js:20-25`; CLI `cli.js:3047-3056`; test `hire.test.js:16-20` |
| G2 | Dispatcher `hire` refuses kind=model and `serviceType=api-endpoint` (`MODEL_NOT_A_LABOUR_JOB`) | VERIFIED | `hire.js:37-42`; test `hire.test.js:35-44` |
| G3 | Missing `sellerKind` fails closed (`SELLER_KIND_UNKNOWN`), no agent default on CLI hire | VERIFIED | `hire.js:13-18`; CLI passes `listing.kind \|\| listing.listingKind \|\| null` (`cli.js:3047`) |
| G4 | TUI typed-hire defaults missing kind to `'agent'` | **DRIFT** | `dashboard.js:2451` `\|\| 'agent'`. Then shells to CLI hire (`2500-2504`), which still fails closed (G3). Confusing, not a successful hire |
| G5 | Listings `--kind data` is browse-only; default browse includes 0-service data identities | VERIFIED | `fetchDataAgentRows` / default concat `hire.js:150-226`; footer `cli.js:3298-3300` |
| G6 | Listings data footer prints `browse <seller>` | VERIFIED | `cli.js:3300` |
| G7 | `assertAccessAllowed` requires an `api-endpoint` service | VERIFIED | `hire.js:47-56`; data with no api-endpoint → `ACCESS_NOT_API_ENDPOINT` |
| G8 | `assertAccessAllowed` also refuses kind=data even if an api-endpoint was attached | **MISSING** | no `sellerKind === 'data'` check. Finding **K2** |
| G9 | Platform `POST /v1/jobs` refuses kind=data / kind=model even if a labour service exists | UNVERIFIED (backend) | Dispatcher never sends the POST when G1/G2 fire. Live `DATA_NOT_HIREABLE` / `MODEL_NOT_A_LABOUR_JOB` are platform codes documented in CHANGELOG 2.37.2/2.37.3 |

## H. `api-setup` / poll proxy

| ID | Claim | Status | Anchor |
|----|--------|--------|--------|
| H1 | `api-setup` success Next is `start --webhook-url <publicUrl>` and names poll-mode | VERIFIED | `cli.js:5142-5143`; test `data-setup.test.js:173-177` |
| H2 | Poll mode does not bind the webhook/proxy HTTP server | VERIFIED | `startWebhookServer` only in the webhook branch (`cli.js:6770-6779`); poll `else` at `6802` |
| H3 | `api-setup` refuses kind=data / kind=compute | **MISSING** (data) / VERIFIED-adjacent (compute via slot) | no listing-kind check. Compute often hits `API_SLOT_CONFLICT` if `gpu-rental` already exists (`rental-job.js:13-16`). Data has no such slot until K2 writes one |

---

## UNVERIFIED (platform)

| ID | Question | Why not guessed |
|----|----------|-----------------|
| U1 | Does `GET /v1/agents/:id` expose VDXF `profileWebsite` as `website` (and JSON `networkEndpoints` as an array)? | `browse` looks at those JSON fields (`buyer-browse.js:18-32`). Indexer mapping lives on `api.junction41.io` |
| U2 | Does `GET /v1/agents/:id` put listing kind at top-level `.kind` / `.listingKind`, or only `platformConfig.kind`? | CLI hire reads only the former (G3 fails closed if absent). Not a hire hole |
| U3 | Does `GET /v1/services` copy identity kind onto `s.kind` for a labour service registered on a kind=data identity? | If omitted, `listingRowFromService` defaults `s.kind \|\| 'agent'` (`hire.js:128`) → listings can show `hireable: yes` while CLI `hire` of that seller still G1-refuses |

---

## Outcome

**VERIFIED:** A1–A7, B1–B7, B9–B11, C2–C4, D1–D9, E1–E3, E5–E9, F1–F6, G1–G3, G5–G7, H1–H2, D10-client, B8-docs, B10.

**DRIFT:** B8 (setup vs data-setup), B12, B13, B14, G4, E4 (documented diversion vs the `setup` subprocess).

**MISSING:** E10, F7, G8, H3-data — all load-bearing for findings K1/K2.

**UNVERIFIED:** U1–U3 (platform). C1 file-order of Unreleased vs 2.37.3 is cosmetic, not an operator claim.
