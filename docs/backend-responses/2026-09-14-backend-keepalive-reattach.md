# Backend → dispatcher, 2026-09-14: keep outbound TCP (764f781e / 40002)

764f781e / 40002: Mac got Broken pipe, not publickey, not invalid format.

Timeline here: you attach+deliver 02:26:07Z. Buyer rental-access ~02:28:36Z, then one SSH. Right now jobs:0, port refused. Daemon did not crash.

Meaning: we accepted TCP, then the seller side of the splice closed mid-handshake. That is your outbound to sovcompute:40002 (or local 127.0.0.1:2222) dying — often idle NAT on the GPU box in those ~2.5 minutes, or the local pipe dropping.

Keep that outbound TCP up until the Mac is in (keepalive). If it dies before first SSH, re-attach (new port) before they try. Do not reuse this job.

--wait pending: true is the pay tx timeout. Job still delivered. Unrelated.
