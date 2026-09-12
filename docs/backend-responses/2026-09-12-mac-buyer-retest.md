# Dispatcher: buyer pay, review, attestation (Mac retest 2026-09-11/12)

Retest from the Mac buyer, **not npm**. CLI git `execute-plan/ca3106a1-integrate` @ `8518d2a`. `package.json` still **2.37.3**. SDK 2.16.1. Buyer `j41grokbuyer.agentplatform@` / `agent-1`.

GPU seller was supposed to run this tree. `testgpu01@` **Offline**. Labour/model/data were live.

## Scoreboard vs 2.37.3 holes

| 2.37.3 hole | This tree live |
|---|---|
| `chat` 404 / NVIDIA URL | **Mostly fixed.** duskseek grant `endpointUrl` is seller `/j41/proxy/v1`. `chat` → `CHAT_NEEDS_DEPOSIT` (402). |
| no deposit CLI | **Shipped** `deposit --amount --wait`. Broadcast txid `4c288327…`. Report **`SENDER_MISMATCH`**. Credit 0. |
| labour unsigned chat | **Shipped** `job-chat` `signed: true`. `--wait` 180s no seller reply, exit 0 `timedOut`. |
| `browse` vs description URL | **Shipped.** pippinapples GET 200. |
| `PAY_PENDING` before create | Still good. |
| review fail-closed | **Unblocked by backend.** `review` on completed GPU **ok**. Buyer `inbox type=review` still `[]`. |
| GPU RFC1918 | **Not retested** — listing Offline. |
| `wallet-pending` leftover | Deposit stamp remains after `SENDER_MISMATCH`. |
| `access` NONCE_REPLAY | **Still.** duskseek + moonkimi `Nonce already used` on retry. |

## Live this run

| Kind | Result |
|---|---|
| data | `browse pippinapples@` 200, 10 rows. `hire` `DATA_NOT_HIREABLE`. |
| model duskseek | Proxy URL good. `deposit 0.05` txid `4c288327e61db9a955c5c38b0a3f9b4b72447a8f71fba899e4cef5140e11b16d` then **`SENDER_MISMATCH`**. Chat still 402. |
| model moonkimi | Disk grant still NVIDIA (2026-09-06). Fresh `access` `NONCE_REPLAY`. |
| labour dt3worker2 | Job `84a20fb7-08f0-4059-8191-199762473249` paid. `job-chat` signed. Status stayed **`requested`**. |
| compute testgpu01 | Offline. `HIRE_FAILED`. |

## Deposit `SENDER_MISMATCH` (blocker)

`deposit` spends the buyer **R** (`RE4dzh…`). Seller `/j41/deposit/report` wants on-chain sender = claiming **i-address** (`iDdjzsh…`). Coins moved; credit did not.

GET review canonical had `Agent:undefined` `Job:undefined` but `/^J41-/` so dispatcher signed. Bind fields are a backend miss on that GET (live template with real ids still worked for GPU `e70731db-…`).

Buyer inbox: 3 pending `job_record`; `type=review` `[]`.
