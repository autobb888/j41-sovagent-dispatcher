# Backend → dispatcher, 2026-08-12 — their reply, and what we did with it

Verbatim reply archived below. What changed on our side:

## 1. `TX_NOT_FOUND` exists — the docs were stale, not the API

The distinguishing code we asked them to *add* was already there
(`transactions.ts:359-405`). Their contract:

| case | HTTP | code |
|---|---|---|
| txid the chain has never seen | 404 | `TX_NOT_FOUND` |
| txid evicted/replaced from mempool | 404 | `TX_NOT_FOUND` (verusd cannot distinguish it from never-seen) |
| still in the mempool | 200 | `confirmations: 0, confirmed: false` |
| malformed txid | 400 | `INVALID_TXID` |
| Verus RPC node down | 502 | `RPC_ERROR` — **never** `TX_NOT_FOUND` |
| route missing (deploy/rename) | 404 | `NOT_FOUND` — **not** `TX_NOT_FOUND` |

So (a) "this tx does not exist" and (b) "the route is 404ing" are decidable by the
`code` field alone. Our `_classifyLookupFailure` already treats `TX_NOT_FOUND` as
`strong` and a bare `NOT_FOUND`/404 as `weak`, and a 502 `RPC_ERROR` as no evidence
at all — so the classifier is correct as written. **This lands on the M4 branch
(`feature/m4-deposit-reconcile`), not in 2.29.0**, since the reconciler was split out.

**Their caveat is the important part, and it is not yet handled:** `TX_NOT_FOUND`
reflects *that node's current view*. A node behind the tip returns `TX_NOT_FOUND` for
a transaction that really landed — node-DOWN is a safe 502, but node-LAG is a false
positive that would claw back a paying buyer. Before M4 ships, the reversal path must
also require a caught-up node (cross-check indexer lag or `/health`), not just the
grace window and the miss run. Recorded as a blocking item for that branch.

## 2 & 3. `platformStatus` is contract, and migration 058 is live

`transformAgent` always sets `platformStatus` (defaulting to `'active'` for pre-058
rows), so our absent-field fallback only ever triggers against a genuinely older
backend. Migration 058 verified on the live testnet DB, hire gate ANDs both axes,
indexer never writes the column.

Both are now advertised in `/v1/version` as `agent.platform-status-v1` and
`tx.status-notfound-code`, and migrations run to completion before the server accepts
traffic — so the flag's presence *is* proof the migration applied on whatever backend
you are talking to.

**What we changed:** the dispatcher no longer assumes it. At startup it reads
`/v1/version` and only defaults on-chain status writes OFF when
`agent.platform-status-v1` is advertised. No flag, no feature list, or an unreachable
platform → on-chain writes stay ON (the pre-2.29 behaviour, safe against any
backend). An explicit `J41_STATUS_TOGGLE_ONCHAIN=0/1` still overrides. This matters
because we publish to npm: "our backend has it" was never a safety argument for
someone else's install.

## 4. Heads-ups acknowledged

They will not relax `requireFunderIsParty` for test wallets, and they are right not
to — it is fail-closed by design. **Action is ours:** point the harness's extension
payments at the buyer identity's wallet.

---

## Their reply, verbatim

(pasted below for the record — see the thread archive for prior rounds)
