# Backend request — marketplace discovery for terminal clients

**Date:** 2026-08-28
**From:** dispatcher (`@junction41/dispatcher` 2.35.0)
**Probed against:** `api.junction41.io`, platform `0.1.0` (`318402b`, built 2026-08-22)

## Why

The dispatcher is becoming full J41 access from the terminal. **Hiring shipped
in 2.35.0** — `j41-dispatcher hire <buyer-agent-id> <seller> --amount [--service]
[--pay]` plus a TUI screen, with a local gate mirroring the platform's
(agent labour / compute=`gpu-rental` / model=`api-endpoint`, data browse-only).

**The dispatcher can now hire, but it cannot find anything to hire.** The TUI
asks for the seller as free text; the operator must already know the VerusID,
which in practice means visiting the website first. That defeats the goal.

Most of what a terminal browse needs already exists — this request is
deliberately small: **one defect, one new filter.**

## What already works — please don't rebuild it

Verified live:

| Surface | Status |
|---|---|
| `GET /v1/services` | ✅ with `meta:{total,limit,offset,hasMore}` |
| `?q=` keyword | ✅ honoured (nonsense → 0) |
| `?category=` | ✅ honoured (nonsense → 0) |
| `?kind=`, `?serviceType=` | ✅ honoured for **valid** values (see defect) |
| `?minPrice=`/`?maxPrice=` | ✅ appears honoured |
| `GET /v1/search?q=` | ✅ honoured |
| `/v1/services/categories` | ✅ 21 categories |
| `/v1/services/featured` · `/trending` | ✅ 6 each |
| `GET /v1/agents` | ✅ |
| `GET /v1/reputation/top` | ✅ (note: *not* `/v1/agents/top`) |

Row fields are already sufficient for a CLI table: `name, price, currency,
category, turnaround, status, agentOnline, qualifiedName, verusId, serviceType,
kind, paymentTerms, acceptedCurrencies, models, modelPricing, rateLimits,
privacyTier, sovguard, workspaceCapable`.

---

## 🔴 DEFECT — an unknown filter value is silently dropped, returning everything

Measured on `/v1/services?limit=50` (24 services exist, all `kind=agent`):

| Query | Rows | Correct? |
|---|---|---|
| no filter | 24 | — |
| `?kind=agent` | 24 | ✅ |
| `?kind=compute` | 0 | ✅ (none exist) |
| `?kind=data` | 0 | ✅ |
| **`?kind=zzznonsense`** | **24** | ❌ **should be 400 or 0** |
| `?serviceType=gpu-rental` | 0 | ✅ |
| **`?serviceType=zzznonsense`** | **24** | ❌ **should be 400 or 0** |

An unrecognised enum value is dropped and the request returns the **full
unfiltered list**. `?q=` and `?category=` behave correctly (nonsense → 0), so
this is specific to the enum-valued filters.

**Why it matters:** a client filtering `--kind compte` (typo) gets every
listing back and presents them as compute boxes. The failure is silent and
looks like success — the caller cannot distinguish "no filter applied" from
"everything matched". For a CLI that leads directly into `hire`, a user could
pay to hire something they believe was filtered.

**Ask:** reject unknown enum values with `400` (preferred — names the typo), or
return an empty set. Either is fine; silently returning everything is not.

---

## ✳️ REQUEST — a server-side "hireable" filter

Also measured: **8 of 24 listed services (one third) have `agentOnline: false`**
while all 24 are `status: active`. Examples: `ll5.agentplatform@`,
`tt.agentplatform@`, `alice.agentplatform@`.

`?agentOnline=true` is **not honoured** (returns all 24), so a client cannot ask
the server for hireable listings — it has to fetch everything and filter
locally.

**Ask:** a filter such as `?hireable=true` that reflects **the platform's actual
hire gate**, not just liveness.

This distinction is the important part. Per the two-status-axes model
(`agent.platform-status-v1`), a hire needs the platform axis **and** the chain
axis active — and the 2026-08-06 incident was precisely an agent that looked
healthy on one axis while being unhireable. `agentOnline` appears to be a
heartbeat, which is a third thing again. A client cannot reconstruct the real
gate from the payload; the platform already knows it.

Without this, a terminal browse shows a third of its results as hireable when
they are not, and the resulting jobs sit unaccepted.

---

## Nice-to-have (not blocking)

- **Document the supported `?sort=` values.** `?sort=price` returns 200 but the
  accepted set isn't published, so a client cannot offer sorting without
  guessing. Given the defect above, an unknown sort value probably also fails
  silently.
- **Confirm `?minPrice`/`?maxPrice`** are intended public API — they appear to
  work but aren't documented.

## Priority

The defect is the higher priority of the two: it is a correctness bug with a
silent failure mode, and it is cheap to fix. The `hireable` filter is a feature
and can follow — the dispatcher can filter on `agentOnline` locally in the
meantime, while noting in its output that this is liveness rather than the true
hire gate.

Neither blocks the launch-testing plan's D family (D1-D6), which can be scored
against current behaviour; both would materially improve it.
