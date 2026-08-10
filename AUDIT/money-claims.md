# Money domain — claims checklist

Source documents: `README.md` (Wallets & Fee Tank, Token Budget Enforcement,
Financial Allowlists, API Endpoint Proxy, Dispute Resolution), `CLAUDE.md`
(Fee Tank, `wallet`, `src/token-budget.js`, `src/wallet.js`, `src/fee-tank.js`).

Legend: **VERIFIED** = code does what is claimed · **DRIFT** = code differs
(how is stated) · **MISSING** = no implementation found · **UNVERIFIED** = could
not determine from code.

## A. Fee tank / automatic sweep

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| A1 | Job payments credit the i-address; identity-write fees debit the R-address only | README:243-244 | VERIFIED | `fee-tank.js:1-33` design note; `summarizeUtxos` splits on `u.address === rAddress` (`fee-tank.js:66-91`) |
| A2 | Sweep is **on by default** | README:252, CLAUDE.md | VERIFIED | `cli.js:3409-3411` — `enabled: options.feeSweep === false ? false : (cfg.fee_sweep?.enabled !== false)` |
| A3 | Sweep floor default = 100 writes | README:253 | VERIFIED | `fee-tank.js:39` `DEFAULT_FLOOR_WRITES = 100`; `cli.js:3412-3415` |
| A4 | Sweep interval default = 30 min | README:254 | VERIFIED | `cli.js:3416-3419` (`30 * 60000`, floored at 60000) |
| A5 | Precedence: CLI flag > config/env > default | README:256 | DRIFT (minor) | `cli.js:3412-3419` uses `\|\|` chains: `--fee-sweep-floor 0` is falsy after `parseInt`, so it silently falls through to config/default. Also `enabled` can only be turned *off* by CLI (already documented in the code comment at `cli.js:3403-3407`). See finding M10 |
| A6 | Self-funding by construction — works at a zero R-balance | README:248 | VERIFIED | `planFeeSweep` amount = `sweepableSats - txFeeSats` (`fee-tank.js:161`); the fee is paid out of the swept i-address inputs, never from `feeSats` |
| A7 | Never spends R-address inputs | README:248 | VERIFIED | `executeFeeSweep` hard refusal at `fee-tank.js:199-201` |
| A8 | Destination derived from our own key, not the platform | CLAUDE.md (implied), `wallet.js:443-470` | VERIFIED | `cli.js:7738-7748` calls `resolveOwnRAddress({derived: wifToAddress(...), platformAddress: u.address})`; disagreement is a hard refusal (`wallet.js:476-483`) |
| A9 | Agent that never earned logs `FEE TANK EMPTY and nothing to sweep — fund <R-addr> externally` | README:260 | VERIFIED | `cli.js:7776`, prefix constant `cli.js:68` |
| A10 | Pending-sweep backstop stops re-sweeping an unconfirmed sweep | `fee-tank.js:47-56` | VERIFIED (in-process only) | `cli.js:7756` reads `state._feeSweepPending`; set at `cli.js:7813`. In-memory only — not shared with the CLI. See finding M8 |
| A11 | Fails closed on unusable balances / malformed pending record | `fee-tank.js:120-149` | VERIFIED | `Number.isSafeInteger` guards; malformed `pending.at` → `sweep:false` |
| A12 | `fee_tank_cycles_skipped` reported in `/health` and a `[FeeTank]` warning | README:363-364 | VERIFIED | `cli.js:7714-7721` (`_feeSweepSkips` + warn); surfaced by `control.js` |
| A13 | Per-agent fee-tank read model in `/health`, null (not 0) when never sampled | README (Scale), `control.js:351-365` | VERIFIED | `control.js:366-385` `buildFeeTank` returns null when no sample |

## B. `wallet` CLI

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| B1 | Default action is `list`, read-only | README:269, CLAUDE.md | VERIFIED | `cli.js:10710-10715` |
| B2 | `send` destinations are fleet agent-ids; raw addresses refused | README:293-295, CLAUDE.md | VERIFIED | `walletResolveAgent` `cli.js:9975-9992`; address-shaped tokens rejected with a dedicated message |
| B3 | Agent-ids match **exactly** — no prefix resolution | CLAUDE.md | VERIFIED | `cli.js:9980` `state.agents.find(a => a.id === token)` |
| B4 | Mainnet `send` refuses `--yes` and requires retyping the exact amount | README:308-309, CLAUDE.md | VERIFIED | `cli.js:10467-10473`; `requireTypedAmount: mainnet` at `cli.js:10610`; `walletConfirm` `cli.js:10677-10685` |
| B5 | `sweep` keeps plain y/N even on mainnet (destination derived from own keys) | CLAUDE.md | VERIFIED | `walletSweepOne` passes no `requireTypedAmount` (`cli.js:10344`) |
| B6 | Manual sweep has **no floor gate** but keeps pending + dust gates | README:289-291, CLAUDE.md | VERIFIED | `planManualSweep` `wallet.js:274-312` — no `above-floor` branch; keeps `sweep-pending` and `below-min-sweep` |
| B7 | Reserve floor: `send` leaving source below `floor_writes` refused without `--allow-drain` | README:306-308 | VERIFIED | `planFleetSend` `wallet.js:367`; reserve read from the same config knob (`walletFloorWrites` `cli.js:9813-9816`) |
| B8 | Pending stamp at `agents/<id>/wallet-pending.json`, 0600, `{txid,at,kind}` | README:311-313, CLAUDE.md | VERIFIED | `saveWalletPending` `cli.js:9884-9890` (tmp→rename, mode 0600); records written at `cli.js:10388` and `cli.js:10658` |
| B9 | Younger than 30 min blocks unless `--force` | README:311-318 | VERIFIED | `SWEEP_PENDING_BACKSTOP_MS = 30*60*1000` (`fee-tank.js:56`), `isPendingBlocked` `wallet.js:250-255`, `--force` nulls the stamp (`cli.js:10313`, `cli.js:10556`) |
| B10 | Malformed stamp **fails closed** | README:316-317, CLAUDE.md | VERIFIED | `loadWalletPending` returns `{at:null,malformed:true}` (`cli.js:9840,9845,9848`); `isPendingBlocked` returns true for non-numeric `at` |
| B11 | Stamp clears automatically once the tx confirms; fails closed on lookup error | README:315-317 | VERIFIED | `resolveWalletPending` `cli.js:9866-9882` — unlinks only when `confirmations > 0`; any throw keeps the stamp |
| B12 | `--dry-run` builds and signs but never broadcasts, and says so | README:300, CLAUDE.md | VERIFIED | `walletDryRunBroadcast` `cli.js:10009-10014`; branch precedes `res.swept` so no stamp is written (`cli.js:10363-10377`); `DRY_RUN_CAVEAT` `cli.js:10016-10017` |
| B13 | `executeSend` refuses every input that is not the source R-address, address-less included | CLAUDE.md, `wallet.js:22-23` | VERIFIED | `wallet.js:413-415` |
| B14 | `--all` — one failure does not stop the rest | README:302 | VERIFIED | `walletSweepOne` never throws (`cli.js:10395-10399`); loop at `cli.js:10425-10427` |
| B15 | `--json`: satoshis as integers, never floats; `null` (not 0) for never-queried | README:299, CLAUDE.md | VERIFIED | `walletRowJson` `cli.js:10139-10152` passes raw ints/null; `buildWalletRow` returns nulls for `registered:false` (`wallet.js:175-184`) |
| B16 | Balances for an agent that could not be queried render as `—`, never `0` | README:320-322, CLAUDE.md | VERIFIED | `formatVrsc` returns `'—'` for non-integers incl. null (`wallet.js:135`); `summarizeFleet` adds only safe integers (`wallet.js:224-225`) |
| B17 | `parseVrscAmount`: decimal-string → satoshis with BigInt, never `parseFloat(x)*1e8` | CLAUDE.md | VERIFIED | `wallet.js:77-121` — regex + BigInt; rejects non-strings, exponent, sign, >8dp, >2^50 sat |
| B18 | Per-agent inter-process spend lock (audit S1) | `wallet.js`/`cli.js:10441-10460` | DRIFT | Held by `walletSend` (`cli.js:10522-10525`, released `cli.js:10668`) but **not** by `walletSweepOne`. See finding M9 |
| B19 | Defers to a running dispatcher's in-flight identity write | README (pending guard), `cli.js:9892-9944` | PARTIAL / DRIFT | `walletPendingWrites` reads only `state._inboxLastWrite` via `buildInboxSurface` (`control.js:330-335`); the daemon's fee-sweep in-flight map is not exposed. See finding M8 |

## C. Refunds / disputes

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| C1 | All outbound financial ops gated by `~/.j41/financial-allowlist.json` | README:815 | VERIFIED | `attemptPendingRefund` checks `isAddressInAllowlist` before every send (`cli.js:5822-5827`); it is the only `sendCurrency` call site (`cli.js:5834`) |
| C2 | Deny-all by default | README:817 | VERIFIED | `loadFinancialAllowlist` creates `{permanent:[],operator:[],active_jobs:[]}` and returns the same on any parse error (`cli.js:149-164`) |
| C3 | Dynamic lifecycle — buyer refund address added on accept, removed on complete | README:818 | VERIFIED | `addActiveJobToAllowlist` `cli.js:6772,7093,7373`; `removeActiveJobFromAllowlist` `cli.js:8703,8986` |
| C4 | Rate limiting — max 3 sends/job, max value = job price + 10%, max 10 sends/hour, 30s cooldown | README:819 | **MISSING** | `checkDispatcherRateLimit` (`cli.js:228`) and `recordDispatcherSend` (`cli.js:261`) have **no callers anywhere** in `src/`, `test/` or `scripts/`. See finding M3 |
| C5 | Fail-closed sweep — suspends all sends if API unreachable for 30 min | README:820 | **MISSING (half)** | The sweep runs and sets `dispatcherFinancialSuspended` (`cli.js:323-324`), but the flag is read only inside the uncalled `checkDispatcherRateLimit` (`cli.js:229`). The allowlist-pruning half of the sweep does work. See finding M3 |
| C6 | Refund destination is the buyer's i-address (`job.buyerVerusId`), never a friendly name | `refund-target.js:4-10` | VERIFIED | `refund-target.js:12-15`; `displayName` is display-only |
| C7 | Owner approval gate — only `status:'approved'` entries are ever sent | `cli.js:5913-5916` | VERIFIED | `drainPendingRefunds` filters `status === 'approved'` (`cli.js:5947`) |
| C8 | `needs_review` entries are refused by `approve` | `cli.js:6224-6227` | VERIFIED | `cli.js:6225-6234` |
| C9 | Re-verification at approve time; re-resolved address must equal the stored one | `cli.js:6208-6210` | VERIFIED | `cli.js:6274-6296` |
| C10 | Idempotency: a jobId in `refunded-jobs.json` is never paid again | `cli.js:5794-5798` | VERIFIED | `markJobRefunded` immediately after the send (`cli.js:5843`), checked inside the lock (`cli.js:5808`) |
| C11 | In-flight marker written before broadcast; a found marker never resolves by paying again | `cli.js:5528-5533` | VERIFIED | `markRefundInflight` `cli.js:5833`; drain refuses marked ids (`cli.js:5936-5947`); unreadable marker still blocks (`cli.js:5580`) |
| C12 | Inter-process send lock with liveness-based staleness (never robs a live holder) | `cli.js:5588-5623` | VERIFIED | `acquireSendLock` `cli.js:5594-5781` — `process.kill(pid,0)` first, age only as fallback, O_EXCL steal gate, read-back proof |
| C13 | Seller-agreed refund honours the agreed percentage (not a hardcoded 100) | `dispute-sweep.js:37-44` | VERIFIED-with-hole | `buildDisputeRefundEntry` uses `agreedRefundPercent` (`dispute-sweep.js:77`), **but** a percent outside `(0,100]` or absent makes `selectRefundableDisputes` drop the job silently. See finding M5 |
| C14 | `respond-dispute --refund-percent` range 1-100 | README:592-596, `cli.js:9114` help text | DRIFT | No range validation; `parseInt` result is passed straight through (`cli.js:9190`). See finding M6 |
| C15 | Only PAID jobs get crash-recovery refunds | `refund.js:29-30` | VERIFIED | `refund.js:44-52` — requires `jobAmount > 0` and a buyer address |

## D. Token budget (WP-D4)

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| D1 | Budget = job amount (VRSC) × rate × spend_fraction, converted for the actual model | README:450-451 | VERIFIED | `initialTokenBudget` `token-budget.js:167-208` (blended `(input+output)/2` per-1k rate) |
| D2 | Missing/stale rate or unknown model → conservative fallback; a job can never run unmetered | README:452-453 | VERIFIED | `token-budget.js:174-186` (fallback, proportionally capped below 0.01 VRSC); unknown model → `unknownModelCost` = most expensive (`token-budget.js:123-130`); `job-agent.js:1085-1090` always calls `setBudget` |
| D3 | `rate_max_age_ms` — a rate older than this counts as missing (fail closed) | README:477 | DRIFT | Enforced in `getVrscUsdRate` (`token-budget.js:141-146`), but `buildContainerEnv` re-stamps an **operator-configured** rate with `Date.now()` on every container start (`cli.js:8002-8004`), so the check can only ever fire for the polled source. See finding M7 |
| D4 | Defaults: spend_fraction 0.6, fallback 50000, warning 80%, extension wait 600000 | README:476-481 | VERIFIED | `token-budget.js:34-36`; `config-loader.js` budget block |
| D5 | Extension priced from the job's actual model and the session's observed input:output ratio | README:455-457 | VERIFIED | `priceExtension` `token-budget.js:219-259` (`inputShare = pt/(pt+ct)`) |
| D6 | With no usable rate the dispatcher will **not** auto-request money | README:456-457 | VERIFIED | `priceExtension` returns `amountVrsc: null` (`token-budget.js:249`); `requestBudgetExtension` bails and logs (`job-agent.js:952-958`) |
| D7 | Approved extension reaches the container in fork **and** Docker modes | README:461-462 | VERIFIED | `sendToJobAgent(extJob, {type:'budget_increased'})` `cli.js:7401`; handled at `job-agent.js:715` |
| D8 | Budget increase is additive, warning re-arms | README:462-463 | VERIFIED | `job-agent.js:1779-1792` (`alreadyUsed + tokenBudget`) |
| D9 | All conversions go through `src/token-budget.js`; no inline rates elsewhere | README:483-485, CLAUDE.md | VERIFIED | Only `token-budget.js` reads `J41_VRSC_USD_RATE`; only `cli.js:8002-8007` writes it |

## E. API-endpoint proxy money (deposits + credit meter)

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| E1 | Deposit reports must be signed by the buyer | README:646, `deposit-watcher.js:37-48` | VERIFIED | `webhook-server.js:171-175` (401 when unsigned); `verifyDepositReport` `deposit-watcher.js:51-95` |
| E2 | Freshness + single-use nonce on deposit reports | `deposit-watcher.js:57-67` | VERIFIED | 5-min window (`deposit-watcher.js:29,59`), `checkAndRecordNonce` (`deposit-watcher.js:64`) |
| E3 | `J41_DEPOSIT_ALLOW_AUTH_ONLY` default-off; without platform sender verification the credit is refused | README:757,774 | VERIFIED | `deposit-watcher.js:250-265` |
| E4 | Refused outright on mainnet | README:771-772 | VERIFIED | `mainnet-guard.js:40` |
| E5 | Double-credit prevented per (agent, txid) | `deposit-watcher.js:120-152` | VERIFIED | Synchronous `claimTxid` before any await + persisted `processed` re-check (`deposit-watcher.js:199-202, 291-295`); atomic `saveDeposits` (`deposit-watcher.js:162-172`) |
| E6 | Confirmation tiers `<2 VRSC → 0 conf`, `2-10 → 1`, `>10 → 6` | `deposit-watcher.js:9-13` (code doc only; not in README) | VERIFIED-as-written, but see M4 | `requiredConfirmations` `deposit-watcher.js:110-114`; there is **no** later reconciliation that debits a credited-at-0-conf tx that never confirms |
| E7 | Reservation pattern: estimate deducted upfront, corrected after the request | README:651 | VERIFIED | `reserveCredit`/`adjustCredit` `credit-meter.js`; all read-modify-write is synchronous, so single-process atomicity holds |
| E8 | Streaming responses parse `usage` line-by-line with `JSON.parse` | README:651 | VERIFIED | `proxy-handler.js:485-498` |
| E9 | Models not in `modelPricing` rejected with a 400 listing the supported set | README:651 | VERIFIED | `proxy-handler.js:277-285` |
| E10 | Settle charges actual usage | README:651 (implied) | DRIFT | Streaming with no usage frame settles at the **worst case** — including when the upstream returned an HTTP error (M1). Non-streaming with no `usage` settles at the **flat estimate**, in both directions (M2) |
| E11 | Verification is fully local and fail-closed; no bypass env var | README:649 | VERIFIED | `deposit-watcher.js:70-93`; no bypass flag found for the signature path |

## F. Control surfaces that expose money

| # | Claim | Source | Verdict | Evidence |
|---|---|---|---|---|
| F1 | Every `/v1/*` control-API endpoint requires a bearer token, even from localhost | README:679-683 | VERIFIED | `control-api.js:172-175`; constant-time compare `control-api.js:63-76`; token auto-created 0600 (`control-api.js:49-60`) |
| F2 | Container/agent cannot obtain a signature for a payment or identity update | `sign-broker.js:10-18` | VERIFIED | Default-deny switch `sign-broker.js:97-102`; brokered messages rebuilt from the authoritative job (`sign-broker.js:66-96`); generic path refuses protocol-shaped strings (`sign-broker.js:157-164`) |
| F3 | Jobs with no payment record are refused unless `J41_ALLOW_UNPRICED_JOBS=1` | README:758 | VERIFIED | `cli.js:6792-6805`; mainnet gate `mainnet-guard.js:41` |
