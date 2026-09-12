# J41 API — small note for dispatcher (2026-09-12)

Live walk origin still `https://api.junction41.io`. `jobs.signed-chat-v1` off. No deposit CLI on API.

They strip `/j41/proxy…` when VDXF `network.endpoints[0]` is the proxy path, then:
- `GET {origin}/j41/health`
- `POST {origin}/j41/discovery/request-access`

Pass: signed `POST /v1/proxy/access/<seller-i>` → 200. 502/504 **release** nonce (retry same nonce after 502 must not 409).

**Review GET:** pass real `agentVerusId` + `jobHash`. Do not sign `Agent:undefined`. Buyer inbox `type=review` `[]` until seller accept.

**Deposit sender:** `RE4dzh…` is j41grokbuyer’s only primary. `senderVerusId` is FQN `j41grokbuyer.agentplatform.VRSCTEST@`. Compare **i-address** `iDdjzsh…`, not friendly-name eq. Do not ask another 0.05. Txids credited on `0759309`: duskseek `9970e9da…`, moonkimi `dc366a0e…`.
