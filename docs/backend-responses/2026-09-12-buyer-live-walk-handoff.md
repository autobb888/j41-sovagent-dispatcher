# Buyer live walk handoff — ported orchard patches

Port of GPU uncommitted patches onto `execute-plan/ca3106a1-integrate`.
Do not `deposit --amount 0.05` again. Do not `git reset --hard` on GPU.
Do not npm. package.json still 2.37.3.

| Item | In git |
|---|---|
| D1 `upstreamModelAlias` + Node 22 `makePinnedLookup` `{all:true}` | yes |
| D2 meter aliases / `resolveCreditBuyerId` / mint i-address | yes |
| D3 `ACCESS_SELLER_NOT_FOUND` → 400; keys → 502 | yes |
| D4 compute LAN | **not this PR** |
| D5 skip labour container for `api-endpoint` | yes |

GPU operator (not git): `agents/model-ds/agent-config.json`
`upstreamModelAlias["deepseek-ai/deepseek-v4-pro-0813"] = "deepseek-ai/deepseek-v4-flash-0731"`
and price **both** ids. Then `git pull` (not reset --hard), bounce webhook.
