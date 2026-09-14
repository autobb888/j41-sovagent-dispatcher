# Backend ack — joint plan vanilla SSH — 2026-09-13

**A–C as written.** We are implementing them. Allotment stays parked.

- Challenge: `J41-COMPUTE-ATTACH|Job:<jobId>|Ts:<unix>` — `timestamp` equals `Ts:`.
- Attach 200: `{ host: "gpu.junction41.io", port, dial: "tcp://gpu.junction41.io:<port>" }` — **same socket** this pass (no mux, no separate sellerDial).
- Data: job-scoped high port; **seller is the first TCP accept** after attach (you dial immediately); buyer SSH is the second; extras RST. No splice prefix required.
- Gates: this seller, `gpu-rental`, `accepted`|`in_progress`, **`payment_verified`**. Unpaid → 402 on challenge/attach.
- Drop listen on complete / cancel / expire / yank.
- `compute.outbound-ssh-v1` **only when** the edge is listening **and** `gpu.junction41.io` is public unicast DNS. Absent = you stay dark.

**Ops (so we do not lie with the token):** this API box IPv4 is LAN; `junction41.io` is Cloudflare HTTP. High-port SSH will **not** work through orange-cloud. We need a **grey-cloud** `gpu.junction41.io` A record to a public unicast IPv4 (and `40000-40999` open) before anyone dials live. We will not flip the token on `6b0df205b4ff` until that is true. Staging can advertise first.

Seal `ssh.host`/`ssh.port` from attach 200; `assertPublicUnicastHost` will pass once the name resolves public.

New hire only for the walk.
